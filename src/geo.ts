/** A position as GeoJSON orders it: [longitude, latitude] in degrees. */
export type LngLat = [number, number]

const EARTH_RADIUS_M = 6_371_008.8
const DEG = Math.PI / 180
const METRES_PER_DEGREE_LAT = EARTH_RADIUS_M * DEG

/** Great-circle distance in metres. */
export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * DEG
  const dLng = (b[0] - a[0]) * DEG
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Distance in metres from the start of a geometry to each of its vertices; the first entry is 0. */
export function cumulativeM(geometry: readonly LngLat[]): number[] {
  const out = [0]
  for (let i = 1; i < geometry.length; i++) {
    out.push(out[i - 1]! + haversineM(geometry[i - 1]!, geometry[i]!))
  }
  return out
}

/** The position `distanceM` metres along a geometry, clamped to its ends. */
export function pointAlong(geometry: readonly LngLat[], cumulative: readonly number[], distanceM: number): LngLat {
  const last = geometry.length - 1
  if (distanceM <= 0) return geometry[0]!
  if (distanceM >= cumulative[last]!) return geometry[last]!
  let i = 1
  while (cumulative[i]! < distanceM) i++
  const span = cumulative[i]! - cumulative[i - 1]!
  const f = span > 0 ? (distanceM - cumulative[i - 1]!) / span : 0
  const a = geometry[i - 1]!
  const b = geometry[i]!
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
}

/** The position `eastM` metres east and `northM` metres north of `origin`. Accurate for offsets of a few km. */
export function offsetM(origin: LngLat, eastM: number, northM: number): LngLat {
  return [
    origin[0] + eastM / (METRES_PER_DEGREE_LAT * Math.cos(origin[1] * DEG)),
    origin[1] + northM / METRES_PER_DEGREE_LAT,
  ]
}

/** Index of the point nearest to `target`, by a flat approximation that is exact enough at city scale. */
export function nearestIndex(points: readonly LngLat[], target: LngLat): number {
  const cosLat = Math.cos(target[1] * DEG)
  let best = -1
  let bestSquared = Infinity
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    const dx = (p[0] - target[0]) * cosLat
    const dy = p[1] - target[1]
    const squared = dx * dx + dy * dy
    if (squared < bestSquared) {
      bestSquared = squared
      best = i
    }
  }
  if (best < 0) throw new Error('nearestIndex: no points')
  return best
}

/** Even-odd rule: whether `p` lies inside the polygon `ring` (its closing edge is implied). */
export function pointInRing(p: LngLat, ring: readonly LngLat[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!
    const b = ring[j]!
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside
    }
  }
  return inside
}
