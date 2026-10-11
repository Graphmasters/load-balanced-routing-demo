import { describe, expect, it } from 'vitest'
import { haversineM, offsetM, pointAlong, cumulativeM, nearestIndex, type LngLat } from './geo'
import { routesToGeoJSON, timedRoutesFromGeoJSON, vehiclesToGeoJSON } from './geojson'
import { positionAt, vehiclesAt } from './playback'
import type { SimulatedRoute } from './simulate'

const route = (id: string, points: [number, number, number][]): SimulatedRoute => ({
  id,
  origin: [points[0]![0], points[0]![1]],
  destination: [points[points.length - 1]![0], points[points.length - 1]![1]],
  departureS: points[0]![2],
  arrivalS: points[points.length - 1]![2],
  lengthM: 0,
  links: [],
  points,
})

describe('positionAt', () => {
  const r = route('a', [
    [0, 0, 10],
    [1, 0, 20],
    [1, 1, 40],
  ])

  it('interpolates between timed points', () => {
    expect(positionAt(r, 15)).toEqual([0.5, 0])
    expect(positionAt(r, 30)).toEqual([1, 0.5])
  })

  it('is null before departure and after arrival', () => {
    expect(positionAt(r, 9.9)).toBeNull()
    expect(positionAt(r, 40.1)).toBeNull()
  })

  it('is the end coordinates at the first and last times', () => {
    expect(positionAt(r, 10)).toEqual([0, 0])
    expect(positionAt(r, 40)).toEqual([1, 1])
  })

  it('handles a route that stands still between two points', () => {
    const still = route('s', [
      [5, 5, 0],
      [5, 5, 10],
    ])
    expect(positionAt(still, 4)).toEqual([5, 5])
  })
})

describe('vehiclesAt and GeoJSON', () => {
  const a = route('a', [
    [0, 0, 0],
    [1, 0, 10],
  ])
  const b = route('b', [
    [0, 1, 20],
    [1, 1, 30],
  ])

  it('lists only the vehicles on the road', () => {
    expect(vehiclesAt([a, b], 5).map((v) => v.id)).toEqual(['a'])
    expect(vehiclesAt([a, b], 25).map((v) => v.id)).toEqual(['b'])
  })

  it('writes routes as LineStrings with one time per coordinate', () => {
    const fc = routesToGeoJSON([a])
    const [feature] = fc.features
    expect(feature!.geometry.coordinates).toEqual([
      [0, 0],
      [1, 0],
    ])
    expect(feature!.properties['times']).toEqual([0, 10])
  })

  it('writes vehicles as Points', () => {
    const fc = vehiclesToGeoJSON(vehiclesAt([a], 5))
    expect(fc.features[0]!.geometry).toEqual({ type: 'Point', coordinates: [0.5, 0] })
  })
})

describe('geo helpers', () => {
  const origin: LngLat = [9.74, 52.37]

  it('measures one degree of latitude as about 111.2 km', () => {
    expect(haversineM([9.74, 52], [9.74, 53])).toBeCloseTo(111_195, -2)
  })

  it('offsets a point by the metres asked for', () => {
    const east = offsetM(origin, 1000, 0)
    const north = offsetM(origin, 0, 1000)
    expect(haversineM(origin, east)).toBeCloseTo(1000, 0)
    expect(haversineM(origin, north)).toBeCloseTo(1000, 0)
  })

  it('places points along a geometry by distance', () => {
    const geometry: LngLat[] = [origin, offsetM(origin, 100, 0), offsetM(origin, 100, 100)]
    const cumulative = cumulativeM(geometry)
    expect(pointAlong(geometry, cumulative, 50)[0]).toBeCloseTo(offsetM(origin, 50, 0)[0], 9)
    expect(pointAlong(geometry, cumulative, 150)[1]).toBeCloseTo(offsetM(origin, 100, 50)[1], 9)
    expect(pointAlong(geometry, cumulative, 1e6)).toEqual(geometry[2])
  })

  it('finds the nearest point', () => {
    const points: LngLat[] = [origin, offsetM(origin, 500, 0), offsetM(origin, 0, 500)]
    expect(nearestIndex(points, offsetM(origin, 480, 30))).toBe(1)
  })
})

describe('timedRoutesFromGeoJSON', () => {
  it('reads back what routesToGeoJSON wrote', () => {
    const routes = [
      route('a', [
        [0, 0, 10],
        [1, 0, 20],
      ]),
      route('b', [
        [0, 1, 30],
        [2, 1, 60],
        [2, 2, 90],
      ]),
    ]
    const back = timedRoutesFromGeoJSON(routesToGeoJSON(routes))
    expect(back).toEqual(routes.map((r) => ({ id: r.id, points: r.points })))
  })

  it('skips features that are not timed linestrings', () => {
    const file = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { id: 'no-times' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 0]] } },
        { type: 'Feature', properties: { times: [0] }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 0]] } },
        { type: 'Feature', properties: { times: [0, NaN] }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 0]] } },
        { type: 'Feature', properties: { times: [0, 5] }, geometry: { type: 'Point', coordinates: [0, 0] } },
        { type: 'Feature', properties: { id: 'ok', times: [0, 5] }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 0]] } },
      ],
    }
    expect(timedRoutesFromGeoJSON(file)).toEqual([{ id: 'ok', points: [[0, 0, 0], [1, 0, 5]] }])
  })

  it('reads nothing from something that is not a collection', () => {
    expect(timedRoutesFromGeoJSON(null)).toEqual([])
    expect(timedRoutesFromGeoJSON('routes')).toEqual([])
    expect(timedRoutesFromGeoJSON({ features: 'many' })).toEqual([])
  })
})

describe('routesToGeoJSON rounding', () => {
  it('rounds coordinates to 1e-6 degrees and times to 0.1 s', () => {
    const r = route('x', [
      [9.1234567891, 52.1, 0.123456],
      [9.2, 52.2, 10],
    ])
    const [feature] = routesToGeoJSON([r]).features
    expect(feature!.geometry.coordinates[0]).toEqual([9.123457, 52.1])
    expect(feature!.properties['times']).toEqual([0.1, 10])
  })
})
