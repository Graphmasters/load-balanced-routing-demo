import type { TimedPoint } from './simulate'
import type { TimedRoute, VehicleAt } from './playback'
import type { SimulatedRoute } from './simulate'

/*
 * GeoJSON for MapLibre and other map libraries. Times are not part of the coordinates (GeoJSON positions are
 * [lng, lat] only), so a route's times ride along in `properties.times`, one per coordinate.
 */

export interface FeatureCollection<G> {
  readonly type: 'FeatureCollection'
  readonly features: readonly Feature<G>[]
}

export interface Feature<G> {
  readonly type: 'Feature'
  readonly properties: Record<string, unknown>
  readonly geometry: G
}

export interface LineStringGeometry {
  readonly type: 'LineString'
  readonly coordinates: [number, number][]
}

export interface PointGeometry {
  readonly type: 'Point'
  readonly coordinates: [number, number]
}

/**
 * Routes as LineStrings. Coordinates are rounded to 1e-6 degrees (about 0.1 m) and times to 0.1 s, which no viewer can
 * show, and which keeps a file of hundreds of routes in the low megabytes.
 */
export function routesToGeoJSON(routes: readonly SimulatedRoute[]): FeatureCollection<LineStringGeometry> {
  return {
    type: 'FeatureCollection',
    features: routes.map((route) => ({
      type: 'Feature',
      properties: {
        id: route.id,
        departureS: round(route.departureS, 1),
        arrivalS: round(route.arrivalS, 1),
        lengthM: round(route.lengthM, 1),
        times: route.points.map((p) => round(p[2], 1)),
      },
      geometry: {
        type: 'LineString',
        coordinates: route.points.map((p): [number, number] => [round(p[0], 6), round(p[1], 6)]),
      },
    })),
  }
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/**
 * The timed routes of a `routesToGeoJSON` collection, read back from a file. Anything that is not a LineString with one
 * time per coordinate is skipped, so a hand-edited or foreign file cannot put NaN into the animation.
 */
export function timedRoutesFromGeoJSON(collection: unknown): TimedRoute[] {
  const features = isRecord(collection) && Array.isArray(collection.features) ? collection.features : []
  const routes: TimedRoute[] = []
  features.forEach((feature: unknown, index) => {
    if (!isRecord(feature) || !isRecord(feature.geometry) || !isRecord(feature.properties)) return
    const { geometry, properties } = feature
    if (geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates)) return
    const times = properties.times
    if (!Array.isArray(times) || times.length !== geometry.coordinates.length) return
    const points: TimedPoint[] = []
    for (let i = 0; i < times.length; i++) {
      const c: unknown = geometry.coordinates[i]
      const t = times[i]
      if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number' || typeof t !== 'number') return
      if (!Number.isFinite(c[0]) || !Number.isFinite(c[1]) || !Number.isFinite(t)) return
      points.push([c[0], c[1], t])
    }
    if (points.length === 0) return
    const id = typeof properties.id === 'string' ? properties.id : `route-${index}`
    routes.push({ id, points })
  })
  return routes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The vehicles of `vehiclesAt` as points. */
export function vehiclesToGeoJSON(vehicles: readonly VehicleAt[]): FeatureCollection<PointGeometry> {
  return {
    type: 'FeatureCollection',
    features: vehicles.map((vehicle) => ({
      type: 'Feature',
      properties: { id: vehicle.id },
      geometry: { type: 'Point', coordinates: vehicle.position },
    })),
  }
}
