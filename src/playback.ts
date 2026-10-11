import type { LngLat } from './geo'
import type { TimedPoint } from './simulate'

/** What playback needs of a route: an id and its timed points. Simulated routes have both. */
export interface TimedRoute {
  readonly id: string
  readonly points: readonly TimedPoint[]
}

/**
 * Where the vehicle of `route` is at `timeS` on the simulation clock, interpolated between its timed points. Null
 * before its departure and after its arrival.
 */
export function positionAt(route: TimedRoute, timeS: number): LngLat | null {
  const points = route.points
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last || timeS < first[2] || timeS > last[2]) return null

  // The last point at or before timeS.
  let lo = 0
  let hi = points.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (points[mid]![2] <= timeS) lo = mid
    else hi = mid - 1
  }
  const a = points[lo]!
  const b = points[lo + 1]
  if (!b) return [a[0], a[1]]
  const span = b[2] - a[2]
  const f = span > 0 ? (timeS - a[2]) / span : 0
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
}

export interface VehicleAt {
  readonly id: string
  readonly position: LngLat
}

/** Every vehicle on the road at `timeS`, with its position. */
export function vehiclesAt(routes: readonly TimedRoute[], timeS: number): VehicleAt[] {
  const out: VehicleAt[] = []
  for (const route of routes) {
    const position = positionAt(route, timeS)
    if (position) out.push({ id: route.id, position })
  }
  return out
}
