import type { LngLat } from './geo'

/** A rectangle in longitude and latitude degrees. */
export interface Extent {
  readonly minLng: number
  readonly minLat: number
  readonly maxLng: number
  readonly maxLat: number
}

/** The most tiles a lock may build. A larger view has to be zoomed in before it can be locked. */
export const MAX_LOCK_TILES = 100

const METRES_PER_DEGREE_LAT = 111_195

/**
 * The nearest centre at which a disc of `radiusM` lies inside `extent`, so every area stays on the locked network. A
 * disc wider than the extent is centred in it.
 */
export function fitDisc(center: LngLat, radiusM: number, extent: Extent): LngLat {
  const midLat = (extent.minLat + extent.maxLat) / 2
  const dLat = radiusM / METRES_PER_DEGREE_LAT
  const dLng = radiusM / (METRES_PER_DEGREE_LAT * Math.cos((midLat * Math.PI) / 180))
  const lng = fitAxis(center[0], extent.minLng + dLng, extent.maxLng - dLng, (extent.minLng + extent.maxLng) / 2)
  const lat = fitAxis(center[1], extent.minLat + dLat, extent.maxLat - dLat, midLat)
  return [lng, lat]
}

/** Why a lock must be refused, or null when it may go ahead. */
export function lockRefusal(tiles: number, graphIncomplete: boolean): string | null {
  if (tiles > MAX_LOCK_TILES) return `Zoom in: this view needs ${tiles} tiles, the limit is ${MAX_LOCK_TILES}.`
  if (graphIncomplete) return 'Some map tiles did not load, so the road network would be incomplete. Try again.'
  return null
}

function fitAxis(value: number, low: number, high: number, middle: number): number {
  if (low > high) return middle
  return Math.min(high, Math.max(low, value))
}
