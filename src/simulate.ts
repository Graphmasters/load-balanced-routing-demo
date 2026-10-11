import { largestStronglyConnectedNodes } from './components'
import type { Trip } from './demand'
import { type LngLat, nearestIndex, pointAlong } from './geo'
import type { Link, Network } from './network'
import { hash32 } from './random'
import { findLinkPath, SearchSpace } from './routing'
import { DEFAULT_SPEED_MODEL, type SpeedModel, speedsKmh } from './speed'

export interface SimulationOptions {
  readonly network: Network
  readonly trips: readonly Trip[]
  /** Seeds the route choice. The same seed and inputs give the same routes. Default 1. */
  readonly seed?: number
  /**
   * How much vehicles disagree about travel times when they choose a route. Each vehicle perceives each link's travel
   * time with a factor in [1 - routeNoise, 1 + routeNoise], drawn per vehicle and link; the physics do not use it. 0 means
   * every vehicle takes the same shortest path. Default 0.1.
   */
  readonly routeNoise?: number
  readonly speedModel?: Partial<SpeedModel>
  /**
   * Snap trips to the largest strongly connected part of the network, so that a trip never starts or ends on an island
   * with no way out. Default true; false snaps to the nearest node of the whole network.
   */
  readonly restrictToLargestComponent?: boolean
  /** Simulated seconds after which vehicles still driving are cut off. Default 6 hours. */
  readonly maxDurationS?: number
}

/** A position with its time on the simulation clock: [longitude, latitude, seconds]. */
export type TimedPoint = readonly [number, number, number]

export interface SimulatedRoute {
  /** The id of the trip it belongs to. */
  readonly id: string
  /** The origin and destination the trip asked for; `points` start and end at the nodes the trip snapped to. */
  readonly origin: LngLat
  readonly destination: LngLat
  readonly departureS: number
  readonly arrivalS: number
  readonly lengthM: number
  /** The links driven, in order. */
  readonly links: readonly number[]
  /**
   * The route as coordinates with timestamps, ascending in time: the origin at departure, every vertex passed, a point
   * at every slot boundary while driving, and the destination at arrival.
   */
  readonly points: readonly TimedPoint[]
}

export interface SlotStats {
  readonly index: number
  readonly startS: number
  readonly departures: number
  readonly arrivals: number
  /** Vehicles that entered a link in this slot, over all links. */
  readonly entries: number
  /** Vehicles that entered the busiest link in this slot. The more vehicles, the more that link slows in the next slot. */
  readonly peakLinkEntries: number
  /** Vehicles still driving at the end of the slot. */
  readonly active: number
}

export interface SimulationResult {
  readonly slotSeconds: number
  /** Simulation clock time of the first slot's start. */
  readonly startS: number
  /** Routes of the trips that arrived, by departure. */
  readonly routes: SimulatedRoute[]
  /** Trips with no path between their nodes. */
  readonly unreachable: number
  /** Vehicles still driving when the run was cut off by `maxDurationS`. */
  readonly unfinished: number
  /** Share of the network's nodes that trips can snap to. */
  readonly coverage: number
  readonly slots: SlotStats[]
}

interface Vehicle {
  readonly trip: Trip
  readonly seed: number
  readonly links: readonly number[]
  readonly lengthM: number
  readonly points: [number, number, number][]
  linkIndex: number
  /** Metres driven on the current link. */
  offsetM: number
  /** Simulation clock time the vehicle has reached. */
  timeS: number
}

/**
 * Runs the simulation in time slots of `slotSeconds`.
 *
 * A vehicle plans its route when it departs, with the speeds of the slot it departs in (the speed of every link
 * is known at the start of its slot). It then drives the planned links at the speed of each slot it is in, and the
 * number of vehicles that enter a link in a slot sets that link's speed in the next slot. The speeds of a slot
 * therefore depend only on earlier slots, so the run is causal and deterministic.
 */
export function simulate(options: SimulationOptions): SimulationResult {
  const network = options.network
  const links = network.links
  const model: SpeedModel = { ...DEFAULT_SPEED_MODEL, ...options.speedModel }
  const slot = model.slotSeconds
  const seed = options.seed ?? 1
  const noise = options.routeNoise ?? 0.1
  const maxDuration = options.maxDurationS ?? 6 * 3600
  if (!(slot > 0)) throw new Error('slotSeconds must be positive')
  if (!(noise >= 0 && noise < 1)) throw new Error('routeNoise must be in [0, 1)')

  const snapNodes =
    options.restrictToLargestComponent === false
      ? network.nodes.map((_, i) => i)
      : largestStronglyConnectedNodes(network)
  if (snapNodes.length === 0) throw new Error('network has no strongly connected part to drive on')
  const snapCoords = snapNodes.map((i) => network.nodes[i]!)
  const snapTo = (p: LngLat): number => snapNodes[nearestIndex(snapCoords, p)]!

  const trips = [...options.trips].sort((a, b) => a.departureS - b.departureS)
  const startS = trips.length > 0 ? Math.floor(trips[0]!.departureS / slot) * slot : 0
  const maxFreeMs = links.reduce((max, link) => Math.max(max, link.freeSpeedKmh), 0) / 3.6
  // A link's perceived cost is at least length / maxFreeMs * (1 - noise), which bounds the A* heuristic from below.
  const secondsPerMetreFloor = (1 - noise) / maxFreeMs
  const space = new SearchSpace(network.nodes.length)

  // Vehicles entering each link, per slot index. Only the previous slot (for speeds) and the current one are kept.
  const entered = new Map<number, Uint32Array>()
  const enteredIn = (slotIndex: number): Uint32Array => {
    let counts = entered.get(slotIndex)
    if (!counts) {
      counts = new Uint32Array(links.length)
      entered.set(slotIndex, counts)
    }
    return counts
  }

  const speeds = new Float64Array(links.length)
  let active: Vehicle[] = []
  const finished: Vehicle[] = []
  const slots: SlotStats[] = []
  let unreachable = 0
  let next = 0
  let entriesInSlot = 0
  let peakInSlot = 0

  // Counts a vehicle entering `linkId` in the slot whose counts are `counts`.
  const enter = (counts: Uint32Array, linkId: number): void => {
    const count = ++counts[linkId]!
    entriesInSlot++
    if (count > peakInSlot) peakInSlot = count
  }

  const plan = (trip: Trip, index: number): Vehicle | null => {
    const origin = snapTo(trip.origin)
    const destination = snapTo(trip.destination)
    const vehicleSeed = hash32(seed, index)
    const linkCostS = (linkId: number): number => {
      const link = links[linkId]!
      const u = hash32(vehicleSeed, linkId) / 4294967296
      return (link.lengthM / (speeds[linkId]! / 3.6)) * (1 + noise * (2 * u - 1))
    }
    const path = findLinkPath(network, space, origin, destination, linkCostS, secondsPerMetreFloor)
    if (!path) return null
    const start = network.nodes[origin]!
    return {
      trip,
      seed: vehicleSeed,
      links: path,
      lengthM: path.reduce((sum, linkId) => sum + links[linkId]!.lengthM, 0),
      points: [[start[0], start[1], trip.departureS]],
      linkIndex: 0,
      offsetM: 0,
      timeS: trip.departureS,
    }
  }

  // Adds the vertices of `link` passed between `fromM` and `toM`, timed at `speedMs` from the vehicle's current time.
  const passVertices = (v: Vehicle, link: Link, fromM: number, toM: number, speedMs: number): void => {
    const cumulative = link.cumulativeM
    for (let j = 1; j < cumulative.length; j++) {
      const c = cumulative[j]!
      if (c <= fromM) continue
      if (c > toM) break
      const p = link.geometry[j]!
      v.points.push([p[0], p[1], v.timeS + (c - fromM) / speedMs])
    }
  }

  // Drives `v` up to `slotEnd`, counting each link it enters. Returns true when it has arrived.
  const drive = (v: Vehicle, slotEnd: number, counts: Uint32Array): boolean => {
    for (;;) {
      const linkId = v.links[v.linkIndex]!
      const link = links[linkId]!
      const speedMs = speeds[linkId]! / 3.6
      const reachS = v.timeS + (link.lengthM - v.offsetM) / speedMs
      if (reachS <= slotEnd) {
        passVertices(v, link, v.offsetM, link.lengthM, speedMs)
        v.timeS = reachS
        v.offsetM = 0
        v.linkIndex++
        if (v.linkIndex === v.links.length) return true
        enter(counts, v.links[v.linkIndex]!)
        continue
      }
      if (slotEnd > v.timeS) {
        const toM = v.offsetM + (slotEnd - v.timeS) * speedMs
        passVertices(v, link, v.offsetM, toM, speedMs)
        v.offsetM = toM
        v.timeS = slotEnd
        const [lng, lat] = pointAlong(link.geometry, link.cumulativeM, toM)
        v.points.push([lng, lat, slotEnd])
      }
      return false
    }
  }

  for (let k = 0; ; k++) {
    const slotStart = startS + k * slot
    const slotEnd = slotStart + slot
    if (slotStart - startS >= maxDuration) break
    if (next >= trips.length && active.length === 0) break

    speedsKmh(network, entered.get(k - 1), model, speeds)
    const counts = enteredIn(k)
    let departures = 0
    let arrivals = 0
    entriesInSlot = 0
    peakInSlot = 0

    while (next < trips.length && trips[next]!.departureS < slotEnd) {
      const index = next++
      const vehicle = plan(trips[index]!, index)
      departures++
      if (!vehicle) {
        unreachable++
        continue
      }
      if (vehicle.links.length === 0) {
        finished.push(vehicle)
        arrivals++
        continue
      }
      enter(counts, vehicle.links[0]!)
      active.push(vehicle)
    }

    const stillDriving: Vehicle[] = []
    for (const vehicle of active) {
      if (drive(vehicle, slotEnd, counts)) {
        finished.push(vehicle)
        arrivals++
      } else {
        stillDriving.push(vehicle)
      }
    }
    active = stillDriving
    entered.delete(k - 1)
    slots.push({
      index: k,
      startS: slotStart,
      departures,
      arrivals,
      entries: entriesInSlot,
      peakLinkEntries: peakInSlot,
      active: active.length,
    })
  }

  const routes = finished
    .sort((a, b) => a.trip.departureS - b.trip.departureS)
    .map((v): SimulatedRoute => {
      const last = v.points[v.points.length - 1]!
      return {
        id: v.trip.id,
        origin: v.trip.origin,
        destination: v.trip.destination,
        departureS: v.trip.departureS,
        arrivalS: last[2],
        lengthM: v.lengthM,
        links: v.links,
        points: monotone(v.points),
      }
    })

  return {
    slotSeconds: slot,
    startS,
    routes,
    unreachable,
    unfinished: active.length,
    coverage: snapNodes.length / network.nodes.length,
    slots,
  }
}

/**
 * Makes the times non-decreasing (floating-point steps can dip by a hair) and merges points that share a time, keeping
 * the later coordinate.
 */
function monotone(points: readonly (readonly [number, number, number])[]): TimedPoint[] {
  const out: TimedPoint[] = []
  for (const [lng, lat, t] of points) {
    const last = out[out.length - 1]
    const time = last ? Math.max(t, last[2]) : t
    if (last && time === last[2]) out[out.length - 1] = [lng, lat, time]
    else out.push([lng, lat, time])
  }
  return out
}
