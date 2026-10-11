import { BlockedLinks, type Disc } from './blocked'
import { largestStronglyConnectedNodes } from './components'
import { type Area, samplePoint, type Trip } from './demand'
import { type LngLat, nearestIndex, pointAlong } from './geo'
import type { Network } from './network'
import { createRandom, hash32 } from './random'
import { findLinkPath, SearchSpace } from './routing'
import { DEFAULT_SPEED_MODEL, type SpeedModel, speedsKmh } from './speed'

/*
 * The live engine: the model of simulate(), advanced in time instead of run as a batch. A route is planned when a
 * vehicle appears and re-planned from the end of its current link while the budget allows. The engine keeps no
 * trajectory history, only where each vehicle is, so it can run for as long as the page is open.
 *
 * The speed rules are simulate()'s: the speed of a slot is set by the entries of the slot before, and an entry at the
 * exact end of a slot counts in that slot. advanceTo() splits at every slot boundary for that reason.
 */

/** A wall-clock tick is credited with at most this much, so a background tab does not flood the budget. */
const MAX_WALL_DT_S = 0.1
/** Unspent budget carries over up to this much, so an idle stretch cannot pay for a burst of re-routing. */
const MAX_CREDIT_S = 0.25
/** Weight of the newest sample in the running averages of search time and re-plan gaps. */
const EMA_WEIGHT = 0.1

export interface LiveSettings {
  /** Where vehicles spawn. Read at each spawn, so moving it affects only later spawns. */
  readonly origin: Area
  /** Where spawned vehicles go. A vehicle keeps the destination it was given at its spawn. */
  readonly destination: Area
  /** Links whose segment comes within this disc are closed to routing. Null for no blocked area. */
  readonly blocked: Disc | null
  /** Vehicles per simulated minute spawned from the origin area. */
  readonly ratePerMin: number
  /** As in simulate(): each vehicle perceives link costs with a factor in [1 - routeNoise, 1 + routeNoise]. */
  readonly routeNoise: number
}

export interface LiveOptions {
  readonly network: Network
  /** Seeds spawns and route noise. Default 1. */
  readonly seed?: number
  readonly speedModel?: Partial<SpeedModel>
  /** Simulated seconds between re-plans of one vehicle, when the budget allows. Default 120. Infinity turns re-planning off. */
  readonly replanIntervalS?: number
  /** Share of wall-clock time spent on routing, in [0, 1]. Default 0.5. */
  readonly budgetShare?: number
  /** Clock for timing searches, in milliseconds. Tests inject one. Default performance.now. */
  readonly nowMs?: () => number
  /** Called when a vehicle leaves: it arrived, or it was stranded and removed at the end of its link. */
  readonly onFinish?: (finish: VehicleFinish) => void
}

export interface VehicleFinish {
  /** The order in which the vehicle was planned, counted from 0 (unreachable attempts count too). */
  readonly id: number
  readonly timeS: number
  readonly stranded: boolean
}

export interface LiveStats {
  readonly timeS: number
  /** Vehicles on the road now. */
  readonly active: number
  /** Spawn attempts, routed or not. */
  readonly spawnAttempts: number
  /** Vehicles that got a route at spawn. */
  readonly spawned: number
  /** Spawn attempts with no route. */
  readonly unreachable: number
  readonly arrived: number
  readonly stranded: number
  /** Successful re-plans. */
  readonly replans: number
  /** Re-plans that found no route; the vehicle is stranded. */
  readonly failedReplans: number
  /** Average simulated gap between re-plans of one vehicle. Null before the first re-plan. */
  readonly replanIntervalS: number | null
  /** Average wall-clock milliseconds of a successful search, and of a failed one. Null until one has run. */
  readonly searchMs: number | null
  readonly failedSearchMs: number | null
  /** Unspent routing budget in wall-clock seconds. Negative after an expensive search. */
  readonly creditS: number
}

interface Vehicle {
  readonly id: number
  readonly seed: number
  /** The node the vehicle was assigned at its spawn. Re-plans keep it. */
  readonly destinationNode: number
  /** The links still to drive, starting with the one it is on. */
  links: number[]
  linkIndex: number
  /** Metres driven on the current link. */
  offsetM: number
  nextReplanS: number
  lastReplanS: number
  stranded: boolean
  finishedAtS: number
}

type Outcome = 'moving' | 'arrived' | 'stranded'

export class LiveSimulation {
  private readonly network: Network
  private readonly model: SpeedModel
  private readonly seed: number
  private readonly replanIntervalS: number
  private readonly budgetShare: number
  private readonly nowMs: () => number
  private readonly onFinish: ((finish: VehicleFinish) => void) | undefined
  private readonly random: () => number
  private readonly snapNodes: number[]
  private readonly snapCoords: LngLat[]
  private readonly space: SearchSpace
  private readonly maxFreeMs: number
  private readonly blocked: BlockedLinks
  /** Speed of every link in km/h, for the current slot. */
  private readonly speeds: Float64Array
  /** Vehicles that entered each link in the current slot. Read at the slot's end, then cleared. */
  private readonly counts: Uint32Array

  private settings: LiveSettings
  private vehicles: Vehicle[] = []
  private clockS = 0
  private slotEndS: number
  private nextSpawnS = Infinity
  private credit = 0
  private attempts = 0
  private spawned = 0
  private unreachable = 0
  private arrived = 0
  private stranded = 0
  private replans = 0
  private failedReplans = 0
  private replanGapS: number | null = null
  private searchMs: number | null = null
  private failedSearchMs: number | null = null

  constructor(options: LiveOptions) {
    const network = options.network
    this.network = network
    this.model = { ...DEFAULT_SPEED_MODEL, ...options.speedModel }
    this.seed = options.seed ?? 1
    this.replanIntervalS = options.replanIntervalS ?? 120
    this.budgetShare = options.budgetShare ?? 0.5
    this.nowMs = options.nowMs ?? (() => performance.now())
    this.onFinish = options.onFinish
    if (!(this.replanIntervalS > 0)) throw new Error('replanIntervalS must be positive')
    if (!(this.budgetShare >= 0 && this.budgetShare <= 1)) throw new Error('budgetShare must be in [0, 1]')

    this.random = createRandom(this.seed)
    this.snapNodes = largestStronglyConnectedNodes(network)
    if (this.snapNodes.length === 0) throw new Error('network has no strongly connected part to drive on')
    this.snapCoords = this.snapNodes.map((i) => network.nodes[i]!)
    this.space = new SearchSpace(network.nodes.length)
    this.maxFreeMs = network.links.reduce((max, link) => Math.max(max, link.freeSpeedKmh), 0) / 3.6
    this.blocked = new BlockedLinks(network)
    this.speeds = new Float64Array(network.links.length)
    speedsKmh(network, undefined, this.model, this.speeds)
    this.counts = new Uint32Array(network.links.length)
    this.slotEndS = this.model.slotSeconds

    const home = this.snapCoords[0]!
    this.settings = {
      origin: { kind: 'circle', center: home, radiusM: 0 },
      destination: { kind: 'circle', center: home, radiusM: 0 },
      blocked: null,
      ratePerMin: 0,
      routeNoise: 0.1,
    }
  }

  /**
   * Changes the settings. Changes apply from now on: to spawns and to re-plans that run later. Passing a setting the
   * same as before changes nothing, so the page can send its whole state on every frame.
   */
  configure(next: Partial<LiveSettings>): void {
    const previous = this.settings
    const settings = { ...previous, ...next }
    if (!(settings.routeNoise >= 0 && settings.routeNoise < 1)) throw new Error('routeNoise must be in [0, 1)')
    if (!(settings.ratePerMin >= 0)) throw new Error('ratePerMin must be zero or more')
    this.settings = settings
    if (!sameDisc(previous.blocked, settings.blocked)) this.blocked.set(settings.blocked)
    // A new rate redraws the next spawn; the same rate keeps the spawn that is already scheduled.
    if (settings.ratePerMin !== previous.ratePerMin) this.nextSpawnS = this.clockS + this.nextGap()
  }

  /** Plans and starts `trip` at the current simulation time. Returns false when it has no route. */
  spawnTrip(trip: Trip): boolean {
    if (Math.abs(trip.departureS - this.clockS) > 1e-9) {
      throw new Error('spawnTrip: advance the simulation to the trip’s departure time first')
    }
    return this.planTrip(trip.origin, trip.destination)
  }

  /**
   * Moves the simulation forward by `simDeltaS` simulated seconds. `wallDtS` is the wall-clock time since the last call,
   * which the routing budget is paid from, clamped to MAX_WALL_DT_S.
   */
  advance(simDeltaS: number, wallDtS: number): void {
    const wall = Math.min(Math.max(wallDtS, 0), MAX_WALL_DT_S)
    this.credit = Math.min(MAX_CREDIT_S, this.credit + this.budgetShare * wall)
    const target = this.clockS + Math.max(simDeltaS, 0)
    while (this.clockS < target) {
      const end = Math.min(target, this.slotEndS)
      while (this.nextSpawnS < end) {
        this.driveAll(this.nextSpawnS)
        this.spawnFromAreas()
        this.nextSpawnS = this.clockS + this.nextGap()
      }
      this.driveAll(end)
      if (this.clockS === this.slotEndS) this.startSlot()
    }
  }

  /** Lng/lat pairs of the vehicles on the road, in no particular order. */
  positions(): Float32Array {
    const out = new Float32Array(this.vehicles.length * 2)
    const links = this.network.links
    this.vehicles.forEach((v, i) => {
      const link = links[v.links[v.linkIndex]!]!
      const [lng, lat] = pointAlong(link.geometry, link.cumulativeM, v.offsetM)
      out[2 * i] = lng
      out[2 * i + 1] = lat
    })
    return out
  }

  stats(): LiveStats {
    return {
      timeS: this.clockS,
      active: this.vehicles.length,
      spawnAttempts: this.attempts,
      spawned: this.spawned,
      unreachable: this.unreachable,
      arrived: this.arrived,
      stranded: this.stranded,
      replans: this.replans,
      failedReplans: this.failedReplans,
      replanIntervalS: this.replanGapS,
      searchMs: this.searchMs,
      failedSearchMs: this.failedSearchMs,
      creditS: this.credit,
    }
  }

  private nextGap(): number {
    const ratePerS = this.settings.ratePerMin / 60
    return ratePerS > 0 ? -Math.log(1 - this.random()) / ratePerS : Infinity
  }

  private spawnFromAreas(): void {
    const origin = samplePoint(this.settings.origin, this.random)
    const destination = samplePoint(this.settings.destination, this.random)
    this.planTrip(origin, destination)
  }

  /** Plans a trip from `origin` to `destination` at the current time and starts it if a route exists. */
  private planTrip(origin: LngLat, destination: LngLat): boolean {
    const id = this.attempts++
    const seed = hash32(this.seed, id)
    const from = this.snapTo(origin)
    const to = this.snapTo(destination)
    const started = this.nowMs()
    const path = this.findPath(seed, from, to)
    this.spend(started, path !== null)
    if (path === null) {
      this.unreachable++
      return false
    }
    if (path.length === 0) {
      this.arrived++
      this.onFinish?.({ id, timeS: this.clockS, stranded: false })
      return true
    }
    this.vehicles.push({
      id,
      seed,
      destinationNode: to,
      links: path,
      linkIndex: 0,
      offsetM: 0,
      nextReplanS: this.clockS + this.replanIntervalS,
      lastReplanS: this.clockS,
      stranded: false,
      finishedAtS: 0,
    })
    this.enter(path[0]!)
    this.spawned++
    return true
  }

  /**
   * Moves every vehicle from the current time to `to`, counting link entries in the current slot. A vehicle that
   * arrives or is stranded is removed. Stranded vehicles leave at the end of their current link, not in the middle.
   */
  private driveAll(to: number): void {
    const from = this.clockS
    const kept: Vehicle[] = []
    for (const v of this.vehicles) {
      const outcome = this.drive(v, from, to)
      if (outcome === 'moving') kept.push(v)
      else this.finish(v, outcome)
    }
    this.vehicles = kept
    this.clockS = to
  }

  private drive(v: Vehicle, from: number, end: number): Outcome {
    const links = this.network.links
    let t = from
    for (;;) {
      const linkId = v.links[v.linkIndex]!
      const link = links[linkId]!
      const speedMs = this.speeds[linkId]! / 3.6
      const reachS = t + (link.lengthM - v.offsetM) / speedMs
      if (reachS > end) {
        v.offsetM += (end - t) * speedMs
        return 'moving'
      }
      t = reachS
      v.offsetM = 0
      v.linkIndex++
      if (v.linkIndex === v.links.length) {
        v.finishedAtS = t
        return 'arrived'
      }
      if (v.stranded) {
        v.finishedAtS = t
        return 'stranded'
      }
      this.enter(v.links[v.linkIndex]!)
    }
  }

  private finish(v: Vehicle, outcome: Exclude<Outcome, 'moving'>): void {
    if (outcome === 'arrived') this.arrived++
    else this.stranded++
    this.onFinish?.({ id: v.id, timeS: v.finishedAtS, stranded: outcome === 'stranded' })
  }

  /** The slot ended at the current time: its entries set the next slot's speeds, then re-plans may run. */
  private startSlot(): void {
    speedsKmh(this.network, this.counts, this.model, this.speeds)
    this.counts.fill(0)
    this.slotEndS += this.model.slotSeconds
    this.replanDue()
  }

  /** Re-plans the vehicles that are due, earliest first, while the budget has credit left. */
  private replanDue(): void {
    const due = this.vehicles.filter((v) => !v.stranded && v.nextReplanS <= this.clockS)
    due.sort((a, b) => a.nextReplanS - b.nextReplanS)
    for (const v of due) {
      if (this.credit <= 0) break
      this.replan(v)
    }
  }

  /**
   * Plans a new route from the end of the vehicle's current link to its stored destination. A vehicle has no route
   * when the search finds none; it is then stranded and leaves at the end of its link.
   */
  private replan(v: Vehicle): void {
    const origin = this.network.links[v.links[v.linkIndex]!]!.to
    const started = this.nowMs()
    const path = this.findPath(v.seed, origin, v.destinationNode)
    this.spend(started, path !== null)
    if (path === null) {
      v.stranded = true
      v.nextReplanS = Infinity
      this.failedReplans++
      return
    }
    v.links = v.links.slice(0, v.linkIndex + 1).concat(path)
    this.replans++
    this.replanGapS = ema(this.replanGapS, this.clockS - v.lastReplanS)
    v.lastReplanS = this.clockS
    v.nextReplanS = this.clockS + this.replanIntervalS
  }

  private findPath(seed: number, origin: number, destination: number): number[] | null {
    const links = this.network.links
    const speeds = this.speeds
    const noise = this.settings.routeNoise
    const cost = (linkId: number): number => {
      const u = hash32(seed, linkId) / 4294967296
      return (links[linkId]!.lengthM / (speeds[linkId]! / 3.6)) * (1 + noise * (2 * u - 1))
    }
    // The same bound simulate() uses: the cheapest any link can cost per metre, so A* never overestimates.
    const secondsPerMetreFloor = (1 - noise) / this.maxFreeMs
    return findLinkPath(this.network, this.space, origin, destination, cost, secondsPerMetreFloor, this.blocked.mask)
  }

  /** Charges a search to the budget and records its time. */
  private spend(startedMs: number, found: boolean): void {
    const elapsedMs = this.nowMs() - startedMs
    this.credit -= elapsedMs / 1000
    if (found) this.searchMs = ema(this.searchMs, elapsedMs)
    else this.failedSearchMs = ema(this.failedSearchMs, elapsedMs)
  }

  private enter(linkId: number): void {
    this.counts[linkId] = this.counts[linkId]! + 1
  }

  private snapTo(p: LngLat): number {
    return this.snapNodes[nearestIndex(this.snapCoords, p)]!
  }
}

function ema(previous: number | null, sample: number): number {
  return previous === null ? sample : previous + EMA_WEIGHT * (sample - previous)
}

function sameDisc(a: Disc | null, b: Disc | null): boolean {
  if (a === null || b === null) return a === b
  return a.radiusM === b.radiusM && a.center[0] === b.center[0] && a.center[1] === b.center[1]
}
