import { type LngLat, offsetM, pointInRing } from './geo'
import { createRandom } from './random'

/** Where trips start or end: a disc (radius 0 is a single point) or a polygon. */
export type Area =
  | { readonly kind: 'circle'; readonly center: LngLat; readonly radiusM: number }
  | { readonly kind: 'polygon'; readonly ring: readonly LngLat[] }

export interface Trip {
  readonly id: string
  readonly origin: LngLat
  readonly destination: LngLat
  /** Departure in seconds on the simulation clock. */
  readonly departureS: number
}

export interface DemandSpec {
  readonly count: number
  readonly origin: Area
  readonly destination: Area
  /** Departures are drawn uniformly from [fromS, toS). */
  readonly departure: { readonly fromS: number; readonly toS: number }
  readonly seed: number
}

/** A uniformly drawn position inside an area. */
export function samplePoint(area: Area, random: () => number): LngLat {
  if (area.kind === 'circle') {
    const radius = area.radiusM * Math.sqrt(random())
    const angle = 2 * Math.PI * random()
    if (radius === 0) return area.center
    return offsetM(area.center, radius * Math.cos(angle), radius * Math.sin(angle))
  }
  const ring = area.ring
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  for (const [lng, lat] of ring) {
    minLng = Math.min(minLng, lng)
    minLat = Math.min(minLat, lat)
    maxLng = Math.max(maxLng, lng)
    maxLat = Math.max(maxLat, lat)
  }
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const p: LngLat = [minLng + (maxLng - minLng) * random(), minLat + (maxLat - minLat) * random()]
    if (pointInRing(p, ring)) return p
  }
  throw new Error('samplePoint: polygon has no inside points in its bounding box')
}

/** `count` trips with random origins, destinations and departures, sorted by departure. Same spec, same trips. */
export function generateTrips(spec: DemandSpec): Trip[] {
  const random = createRandom(spec.seed)
  const trips: Trip[] = []
  for (let i = 0; i < spec.count; i++) {
    const origin = samplePoint(spec.origin, random)
    const destination = samplePoint(spec.destination, random)
    const departureS = spec.departure.fromS + (spec.departure.toS - spec.departure.fromS) * random()
    trips.push({ id: `trip-${i}`, origin, destination, departureS })
  }
  return trips.sort((a, b) => a.departureS - b.departureS)
}
