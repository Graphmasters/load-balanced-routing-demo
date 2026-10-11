import { describe, expect, it } from 'vitest'
import { haversineM, offsetM, type LngLat } from './geo'
import { createNetwork } from './network'
import type { Trip } from './demand'
import { positionAt } from './playback'
import { simulate, type SimulatedRoute } from './simulate'
import { gridNetwork, lineNetwork, oneWayLine, TEST_ORIGIN } from './testing/networks'

const trip = (id: string, origin: LngLat, destination: LngLat, departureS: number): Trip => ({
  id,
  origin,
  destination,
  departureS,
})

describe('simulate: timing', () => {
  it('drives a short link at free-flow speed', () => {
    // 40 m at 36 km/h (10 m/s) from 1 s: arrives at 5 s, within the first slot, so no speed change applies.
    const network = lineNetwork({ count: 2, lengthM: 40, freeSpeedKmh: 36, capacityVph: 360 })
    const result = simulate({
      network,
      trips: [trip('a', TEST_ORIGIN, network.nodes[1]!, 1)],
      routeNoise: 0,
    })
    const [route] = result.routes
    expect(route!.arrivalS).toBeCloseTo(5, 9)
    const times = route!.points.map((p) => p[2])
    expect(times).toHaveLength(2)
    expect(times[0]).toBeCloseTo(1, 9)
    expect(times[1]).toBeCloseTo(5, 9)
    expect(route!.links).toEqual([0])
    expect(route!.lengthM).toBeCloseTo(40, 6)
  })

  it('slows a vehicle by the entries of the previous slot only', () => {
    // 100 m at 10 m/s. A enters at 1 s (slot 0). Its last 10 m fall in slot 1, where the speed is set by the one vehicle
    // that entered in slot 0 (360 vph on a 360 vph link, BPR 1 + 0.15): 10 / 1.15 m/s. So A arrives at 10 + 10 / (10 / 1.15) = 11.15 s.
    // B enters at 15 s (slot 1) and is slowed for its whole trip, since slot 1 sees A's entry and so does slot 2 (B's own).
    const network = lineNetwork({ count: 2, lengthM: 100, freeSpeedKmh: 36, capacityVph: 360 })
    const result = simulate({
      network,
      trips: [trip('a', TEST_ORIGIN, network.nodes[1]!, 1), trip('b', TEST_ORIGIN, network.nodes[1]!, 15)],
      routeNoise: 0,
    })
    const a = result.routes.find((r) => r.id === 'a')!
    const b = result.routes.find((r) => r.id === 'b')!
    expect(a.arrivalS).toBeCloseTo(11.15, 6)
    // B: 100 m at 10 / 1.15 m/s = 11.5 s from 15 s.
    expect(b.arrivalS).toBeCloseTo(26.5, 6)
    expect(b.arrivalS - b.departureS).toBeGreaterThan(10)
  })

  it('does not slow a vehicle within the slot in which another one enters', () => {
    // C enters the same link at 9 s, in the slot where A is driving. A's position at 9.5 s must not change.
    const network = lineNetwork({ count: 2, lengthM: 100, freeSpeedKmh: 36, capacityVph: 360 })
    const alone = simulate({
      network,
      trips: [trip('a', TEST_ORIGIN, network.nodes[1]!, 1)],
      routeNoise: 0,
    })
    const withC = simulate({
      network,
      trips: [trip('a', TEST_ORIGIN, network.nodes[1]!, 1), trip('c', TEST_ORIGIN, network.nodes[1]!, 9)],
      routeNoise: 0,
    })
    const a1 = alone.routes.find((r) => r.id === 'a')!
    const a2 = withC.routes.find((r) => r.id === 'a')!
    const p1 = positionAt(a1, 9.5)!
    const p2 = positionAt(a2, 9.5)!
    expect(p2[0]).toBeCloseTo(p1[0], 12)
    expect(p2[1]).toBeCloseTo(p1[1], 12)
    // The next slot does feel C: A arrives later.
    expect(a2.arrivalS).toBeGreaterThan(a1.arrivalS)
  })

  it('reports the same routes for the same inputs and seed', () => {
    const network = gridNetwork({ rows: 6, cols: 6, spacingM: 200 })
    const trips = [0, 1, 2, 3, 4, 5].map((i) =>
      trip(`t${i}`, network.nodes[i]!, network.nodes[35 - i]!, 10 * i),
    )
    const run = () => simulate({ network, trips, seed: 3, routeNoise: 0.2 })
    expect(run()).toEqual(run())
  })

  it('reports each trip in the slot statistics', () => {
    const network = gridNetwork({ rows: 4, cols: 4, spacingM: 150 })
    const trips = Array.from({ length: 20 }, (_, i) => trip(`t${i}`, network.nodes[i % 4]!, network.nodes[15 - (i % 3)]!, 3 * i))
    const result = simulate({ network, trips })
    expect(result.slots.reduce((sum, s) => sum + s.departures, 0)).toBe(trips.length)
    expect(result.slots.reduce((sum, s) => sum + s.arrivals, 0) + result.unreachable).toBe(trips.length)
    expect(result.unfinished).toBe(0)
  })
})

describe('simulate: routes', () => {
  it('gives every route ascending times from its departure to its arrival', () => {
    const network = gridNetwork({ rows: 8, cols: 8, spacingM: 180, capacityVph: 400 })
    const trips = Array.from({ length: 80 }, (_, i) =>
      trip(`t${i}`, network.nodes[(i * 7) % 64]!, network.nodes[(i * 13 + 5) % 64]!, 2 * i),
    ).filter((t) => t.origin !== t.destination)
    const result = simulate({ network, trips, routeNoise: 0.15 })
    expect(result.routes.length).toBeGreaterThan(40)
    for (const route of result.routes) {
      const times = route.points.map((p) => p[2])
      expect(times[0]).toBe(route.departureS)
      expect(times[times.length - 1]).toBeCloseTo(route.arrivalS, 9)
      for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!)
      // The route cannot beat the free-flow speed of the network.
      const maxSpeedMs = 50 / 3.6
      expect(route.arrivalS - route.departureS).toBeGreaterThanOrEqual(route.lengthM / maxSpeedMs - 1e-6)
    }
  })

  it('starts and ends its points at the nearest nodes, with the trip recorded as asked', () => {
    const network = gridNetwork({ rows: 3, cols: 3, spacingM: 300 })
    const origin: LngLat = [network.nodes[0]![0] + 0.0001, network.nodes[0]![1]]
    const destination = network.nodes[8]!
    const [route] = simulate({ network, trips: [trip('a', origin, destination, 0)], routeNoise: 0 }).routes
    expect(route!.origin).toEqual(origin)
    expect(route!.points[0]!.slice(0, 2)).toEqual(network.nodes[0])
    const end = route!.points[route!.points.length - 1]!
    expect([end[0], end[1]]).toEqual(network.nodes[8])
  })

  it('gives one OD pair several routes when vehicles disagree about travel times', () => {
    // Corner to corner of a grid has many equally long paths. Departures 400 s apart keep the vehicles from sharing
    // slots, so without route noise every vehicle sees the same costs and takes the same path.
    const network = gridNetwork({ rows: 6, cols: 6, spacingM: 200 })
    const trips = Array.from({ length: 10 }, (_, i) => trip(`t${i}`, network.nodes[0]!, network.nodes[35]!, 400 * i))
    const distinct = (noise: number) =>
      new Set(simulate({ network, trips, routeNoise: noise, seed: 5 }).routes.map((r) => r.links.join(','))).size
    expect(distinct(0)).toBe(1)
    expect(distinct(0.2)).toBeGreaterThan(1)
  })

  it('returns a single point for a trip whose origin and destination share a node', () => {
    const network = gridNetwork({ rows: 2, cols: 2, spacingM: 100 })
    const [route] = simulate({ network, trips: [trip('a', network.nodes[0]!, network.nodes[0]!, 7)] }).routes
    expect(route!.links).toEqual([])
    expect(route!.points).toEqual([[network.nodes[0]![0], network.nodes[0]![1], 7]])
    expect(route!.arrivalS).toBe(7)
  })

  it('snaps trips to the largest part of the network, so a trip to an island is not lost', () => {
    // Nodes 0 and 1 are two-way; node 2 feeds node 1 but cannot be reached from it.
    const nodes = [offsetM(TEST_ORIGIN, 0, 0), offsetM(TEST_ORIGIN, 100, 0), offsetM(TEST_ORIGIN, 200, 0)]
    const spec = (from: number, to: number) => ({
      from,
      to,
      geometry: [nodes[from]!, nodes[to]!],
      freeSpeedKmh: 30,
      capacityVph: 600,
    })
    const network = createNetwork(nodes, [spec(0, 1), spec(1, 0), spec(2, 1)])
    const island = [trip('a', nodes[0]!, nodes[2]!, 0)]

    const snapped = simulate({ network, trips: island, routeNoise: 0 })
    expect(snapped.unreachable).toBe(0)
    expect(snapped.coverage).toBeCloseTo(2 / 3, 9)
    expect(snapped.routes[0]!.links).toEqual([0])

    const whole = simulate({ network, trips: island, routeNoise: 0, restrictToLargestComponent: false })
    expect(whole.unreachable).toBe(1)
    expect(whole.coverage).toBe(1)
  })

  it('counts the vehicles entering the busiest link in each slot', () => {
    // Two vehicles enter the same link in slot 0 (at 1 s and 5 s), so the peak of that slot is 2.
    const network = lineNetwork({ count: 2, lengthM: 40, freeSpeedKmh: 36, capacityVph: 3600 })
    const result = simulate({
      network,
      trips: [trip('a', TEST_ORIGIN, network.nodes[1]!, 1), trip('c', TEST_ORIGIN, network.nodes[1]!, 5)],
      routeNoise: 0,
    })
    expect(result.slots[0]!.entries).toBe(2)
    expect(result.slots[0]!.peakLinkEntries).toBe(2)
  })

  it('counts trips without a path as unreachable', () => {
    const network = oneWayLine({ count: 3, lengthM: 100, freeSpeedKmh: 30, capacityVph: 600 })
    const result = simulate({
      network,
      trips: [trip('back', network.nodes[2]!, network.nodes[0]!, 0)],
      restrictToLargestComponent: false,
    })
    expect(result.unreachable).toBe(1)
    expect(result.routes).toEqual([])
  })

  it('cuts off vehicles still driving at maxDurationS', () => {
    // 1 km at 5 km/h takes 720 s; the run stops at 60 s.
    const network = lineNetwork({ count: 2, lengthM: 1000, freeSpeedKmh: 5, capacityVph: 600 })
    const result = simulate({ network, trips: [trip('slow', TEST_ORIGIN, network.nodes[1]!, 0)], maxDurationS: 60 })
    expect(result.unfinished).toBe(1)
    expect(result.routes).toEqual([])
  })

  it('rejects a route noise that would make costs non-positive', () => {
    const network = lineNetwork({ count: 2, lengthM: 100, freeSpeedKmh: 30, capacityVph: 600 })
    expect(() => simulate({ network, trips: [], routeNoise: 1 })).toThrow(/routeNoise/)
  })
})

describe('simulate: the points of a route', () => {
  it('hold the origin, each node passed, and a point at each slot boundary while driving', () => {
    // 80 m links at 10 m/s: node 1 is reached at 8 s (inside slot 0), then slot 1 starts 2 s into the second link.
    const network = lineNetwork({ count: 3, lengthM: 80, freeSpeedKmh: 36, capacityVph: 600 })
    const [route]: SimulatedRoute[] = simulate({
      network,
      trips: [trip('a', TEST_ORIGIN, network.nodes[2]!, 0)],
      routeNoise: 0,
    }).routes
    const times = route!.points.map((p) => p[2])
    expect(times.slice(0, 3)).toEqual([0, expect.closeTo(8, 9), 10])
    expect(haversineM(route!.origin, network.nodes[0]!)).toBeLessThan(1e-6)
    const at8 = route!.points[1]!
    expect([at8[0], at8[1]]).toEqual(network.nodes[1])
  })
})
