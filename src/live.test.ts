import { describe, expect, it } from 'vitest'
import { type Area, generateTrips, type Trip } from './demand'
import { haversineM, offsetM, type LngLat } from './geo'
import { LiveSimulation, type VehicleFinish } from './live'
import { gridNetwork, lineNetwork, TEST_ORIGIN } from './testing/networks'
import { simulate } from './simulate'

const circle = (center: LngLat, radiusM: number): Area => ({ kind: 'circle', center, radiusM })

/** A clock that moves 1 ms per call, so every search takes 1 ms of budget. */
function steppingClock(): () => number {
  let ms = 0
  return () => (ms += 1)
}

describe('LiveSimulation: agrees with simulate() when vehicles are not re-planned', () => {
  it('gives the same arrival times on a line where entries fall on slot boundaries', () => {
    // 100 m at 36 km/h takes exactly 10 s per link, so every entry is on a 10 s slot boundary.
    const network = lineNetwork({ count: 6, lengthM: 100, freeSpeedKmh: 36, capacityVph: 360 })
    const trips: Trip[] = Array.from({ length: 12 }, (_, i) => ({
      id: `trip-${i}`,
      origin: network.nodes[0]!,
      destination: network.nodes[5]!,
      departureS: 10 * i,
    }))
    const batch = simulate({ network, trips, seed: 3, routeNoise: 0.2 })

    const finished = new Map<number, number>()
    const live = new LiveSimulation({
      network,
      seed: 3,
      replanIntervalS: Infinity,
      budgetShare: 0,
      onFinish: (f: VehicleFinish) => finished.set(f.id, f.timeS),
    })
    live.configure({ routeNoise: 0.2 })
    for (const trip of trips) {
      live.advance(trip.departureS - live.stats().timeS, 0)
      live.spawnTrip(trip)
    }
    live.advance(10_000, 0)

    expect(finished.size).toBe(batch.routes.length)
    for (const route of batch.routes) {
      const index = trips.findIndex((t) => t.id === route.id)
      expect(finished.get(index)).toBeCloseTo(route.arrivalS, 6)
    }
  })

  it('gives the same arrival times for random trips on a congested grid', () => {
    const network = gridNetwork({ rows: 5, cols: 5, spacingM: 150, freeSpeedKmh: 40, capacityVph: 500 })
    const trips = generateTrips({
      count: 80,
      origin: circle(network.nodes[0]!, 200),
      destination: circle(network.nodes[24]!, 200),
      departure: { fromS: 0, toS: 300 },
      seed: 9,
    })
    const batch = simulate({ network, trips, seed: 9, routeNoise: 0.2 })

    const finished = new Map<number, number>()
    const live = new LiveSimulation({
      network,
      seed: 9,
      replanIntervalS: Infinity,
      budgetShare: 0,
      onFinish: (f) => finished.set(f.id, f.timeS),
    })
    live.configure({ routeNoise: 0.2 })
    for (const trip of trips) {
      live.advance(trip.departureS - live.stats().timeS, 0)
      live.spawnTrip(trip)
    }
    live.advance(10_000, 0)

    expect(finished.size).toBe(batch.routes.length)
    for (const route of batch.routes) {
      const index = trips.findIndex((t) => t.id === route.id)
      expect(finished.get(index)).toBeCloseTo(route.arrivalS, 5)
    }
  })
})

describe('LiveSimulation: time', () => {
  it('gives the same vehicle positions however the time is split into steps', () => {
    const network = gridNetwork({ rows: 4, cols: 4, spacingM: 150, freeSpeedKmh: 40, capacityVph: 500 })
    const settings = {
      origin: circle(network.nodes[0]!, 100),
      destination: circle(network.nodes[15]!, 100),
      ratePerMin: 30,
      routeNoise: 0.2,
    }
    const one = new LiveSimulation({ network, seed: 4, replanIntervalS: Infinity, budgetShare: 0 })
    one.configure(settings)
    one.advance(600, 0)

    const many = new LiveSimulation({ network, seed: 4, replanIntervalS: Infinity, budgetShare: 0 })
    many.configure(settings)
    for (let t = 0; t < 600; ) {
      const step = Math.min(0.7, 600 - t)
      many.advance(step, 0)
      t += step
    }

    expect(many.stats().spawnAttempts).toBe(one.stats().spawnAttempts)
    expect(many.stats().arrived).toBe(one.stats().arrived)
    expect(many.stats().active).toBe(one.stats().active)
    const a = one.positions()
    const b = many.positions()
    expect(b.length).toBe(a.length)
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i]!, 6)
  })

  it('places a vehicle along its link at the speed of the link', () => {
    // 10 m/s: after 5 s a vehicle that left node 0 is 50 m along the first link.
    const network = lineNetwork({ count: 3, lengthM: 100, freeSpeedKmh: 36, capacityVph: 1800 })
    const live = new LiveSimulation({ network, replanIntervalS: Infinity, budgetShare: 0 })
    expect(live.spawnTrip({ id: 'a', origin: network.nodes[0]!, destination: network.nodes[2]!, departureS: 0 })).toBe(true)
    live.advance(5, 0)
    const [lng, lat] = live.positions()
    expect(haversineM(network.nodes[0]!, [lng!, lat!])).toBeCloseTo(50, 0)
  })

  it('refuses a trip whose departure time is not the current time', () => {
    const network = lineNetwork({ count: 3, lengthM: 100, freeSpeedKmh: 36, capacityVph: 1800 })
    const live = new LiveSimulation({ network })
    expect(() =>
      live.spawnTrip({ id: 'a', origin: network.nodes[0]!, destination: network.nodes[2]!, departureS: 5 }),
    ).toThrow()
  })
})

describe('LiveSimulation: spawning', () => {
  it('spawns at about the configured rate', () => {
    const network = gridNetwork({ rows: 4, cols: 4, spacingM: 150 })
    const live = new LiveSimulation({ network, seed: 2, replanIntervalS: Infinity, budgetShare: 0 })
    live.configure({ origin: circle(network.nodes[0]!, 100), destination: circle(network.nodes[15]!, 100), ratePerMin: 60 })
    live.advance(600, 0)
    // 60 per minute for 10 minutes: 600 expected, Poisson spread about ±25.
    expect(live.stats().spawnAttempts).toBeGreaterThan(520)
    expect(live.stats().spawnAttempts).toBeLessThan(680)
  })

  it('keeps the scheduled spawn when the same settings are sent again', () => {
    // The page sends its whole state on every frame. Repeating a setting must not push back the next spawn.
    const network = gridNetwork({ rows: 4, cols: 4, spacingM: 150 })
    const settings = {
      origin: circle(network.nodes[0]!, 100),
      destination: circle(network.nodes[15]!, 100),
      blocked: null,
      ratePerMin: 60,
      routeNoise: 0.2,
    }
    const once = new LiveSimulation({ network, seed: 6, replanIntervalS: Infinity, budgetShare: 0 })
    once.configure(settings)
    once.advance(300, 0)

    const repeated = new LiveSimulation({ network, seed: 6, replanIntervalS: Infinity, budgetShare: 0 })
    repeated.configure(settings)
    for (let t = 0; t < 300; t++) {
      repeated.advance(1, 0)
      repeated.configure(settings)
    }
    expect(repeated.stats().spawnAttempts).toBe(once.stats().spawnAttempts)
    expect(repeated.stats().spawnAttempts).toBeGreaterThan(0)
  })

  it('does not spawn a vehicle that has no route, and says so', () => {
    const network = lineNetwork({ count: 3, lengthM: 100, freeSpeedKmh: 36, capacityVph: 1800 })
    const live = new LiveSimulation({ network, replanIntervalS: Infinity, budgetShare: 0 })
    // Closing the disc on node 0 closes the only way out of it.
    live.configure({ blocked: { center: network.nodes[0]!, radiusM: 10 } })
    expect(live.spawnTrip({ id: 'a', origin: network.nodes[0]!, destination: network.nodes[2]!, departureS: 0 })).toBe(false)
    expect(live.stats()).toMatchObject({ unreachable: 1, active: 0, spawned: 0 })
  })
})

describe('LiveSimulation: re-planning around blocked roads', () => {
  it('removes a vehicle at the end of its link when a re-plan finds no route', () => {
    // 100 m at 30 km/h is 12 s per link: the vehicle enters link 1→2 at 12 s and reaches node 2 at 24 s. Its re-plan
    // at the 20 s boundary starts from node 2, the end of the link it is on. Nothing leaves node 2 towards node 4
    // (node 3, at 300 m, is inside the disc along with both ways out of it), so the vehicle leaves at node 2.
    const network = lineNetwork({ count: 5, lengthM: 100, freeSpeedKmh: 30, capacityVph: 1800 })
    const finished: VehicleFinish[] = []
    const live = new LiveSimulation({
      network,
      replanIntervalS: 15,
      budgetShare: 1,
      nowMs: steppingClock(),
      onFinish: (f) => finished.push(f),
    })
    expect(live.spawnTrip({ id: 'a', origin: network.nodes[0]!, destination: network.nodes[4]!, departureS: 0 })).toBe(true)
    live.advance(0, 0.1) // the spawn's search used the budget; this pays some back
    live.configure({ blocked: { center: offsetM(TEST_ORIGIN, 300, 0), radiusM: 50 } })

    live.advance(15, 0) // the re-plan is due at 15 s but runs at the next slot boundary, 20 s
    live.advance(5, 0)
    expect(live.stats()).toMatchObject({ timeS: 20, active: 1, stranded: 0, failedReplans: 1 })

    live.advance(3, 0) // 23 s: still on link 1→2
    expect(live.stats()).toMatchObject({ active: 1, stranded: 0 })

    live.advance(2, 0) // 25 s: the vehicle left at node 2, a little after 24 s
    expect(live.stats()).toMatchObject({ active: 0, stranded: 1 })
    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({ id: 0, stranded: true })
    expect(finished[0]!.timeS).toBeCloseTo(24, 0)
  })

  it('defers a re-plan with no budget and keeps the vehicle due', () => {
    const network = gridNetwork({ rows: 3, cols: 3, spacingM: 200, freeSpeedKmh: 36, capacityVph: 1800 })
    const live = new LiveSimulation({
      network,
      replanIntervalS: 10,
      budgetShare: 0.5,
      nowMs: steppingClock(),
    })
    expect(live.spawnTrip({ id: 'a', origin: network.nodes[0]!, destination: network.nodes[8]!, departureS: 0 })).toBe(true)
    // The spawn's search has used the budget, so the re-plan due at 10 s is deferred at the 10 s boundary.
    live.advance(15, 0)
    expect(live.stats()).toMatchObject({ timeS: 15, replans: 0, failedReplans: 0, stranded: 0, active: 1 })

    live.advance(0, 0.1) // credit 0.5 × 0.1 s, so there is budget again
    live.advance(5, 0) // 20 s boundary: the deferred re-plan runs now
    expect(live.stats()).toMatchObject({ replans: 1, stranded: 0, active: 1, replanIntervalS: 20 })
  })

  it('caps the budget, and clamps the wall time it is paid from', () => {
    const network = gridNetwork({ rows: 2, cols: 2, spacingM: 100 })
    const live = new LiveSimulation({ network, budgetShare: 0.5 })
    live.advance(0, 100) // clamped to 0.1 s of wall time, so 0.05 s of budget
    expect(live.stats().creditS).toBeCloseTo(0.05, 9)
    for (let i = 0; i < 10; i++) live.advance(0, 100)
    expect(live.stats().creditS).toBeCloseTo(0.25, 9)
  })
})
