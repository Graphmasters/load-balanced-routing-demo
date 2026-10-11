import { describe, expect, it } from 'vitest'
import { generateTrips, samplePoint, type Area } from './demand'
import { haversineM, pointInRing, type LngLat } from './geo'
import { createRandom } from './random'

const CENTER: LngLat = [9.74, 52.37]
const disc: Area = { kind: 'circle', center: CENTER, radiusM: 2000 }
const ring: LngLat[] = [
  [9.8, 52.4],
  [9.85, 52.4],
  [9.85, 52.45],
  [9.8, 52.45],
]
const square: Area = { kind: 'polygon', ring }

describe('samplePoint', () => {
  it('draws inside a disc', () => {
    const random = createRandom(11)
    for (let i = 0; i < 300; i++) expect(haversineM(CENTER, samplePoint(disc, random))).toBeLessThanOrEqual(2000 * 1.0005)
  })

  it('returns the centre for a disc of radius 0', () => {
    const point = samplePoint({ kind: 'circle', center: CENTER, radiusM: 0 }, createRandom(1))
    expect(point).toEqual(CENTER)
  })

  it('draws inside a polygon', () => {
    const random = createRandom(12)
    for (let i = 0; i < 300; i++) expect(pointInRing(samplePoint(square, random), ring)).toBe(true)
  })
})

describe('generateTrips', () => {
  const spec = {
    count: 50,
    origin: disc,
    destination: square,
    departure: { fromS: 3600, toS: 5400 },
    seed: 99,
  }

  it('makes the number of trips asked for, sorted by departure, inside the window', () => {
    const trips = generateTrips(spec)
    expect(trips).toHaveLength(50)
    for (let i = 0; i < trips.length; i++) {
      const t = trips[i]!
      expect(t.departureS).toBeGreaterThanOrEqual(3600)
      expect(t.departureS).toBeLessThan(5400)
      if (i > 0) expect(t.departureS).toBeGreaterThanOrEqual(trips[i - 1]!.departureS)
    }
  })

  it('is the same for the same spec', () => {
    expect(generateTrips(spec)).toEqual(generateTrips(spec))
    expect(generateTrips({ ...spec, seed: 100 })).not.toEqual(generateTrips(spec))
  })
})
