import type { Tile } from 'omt-router'

/**
 * OpenFreeMap's planet tileset: OpenMapTiles schema, anonymous, CORS *. Its tile URLs carry a build version
 * (planet/<version>/{z}/{x}/{y}.pbf) that changes over time, so the template is read from this TileJSON at run time.
 */
export const BASEMAP_TILESET = 'https://tiles.openfreemap.org/planet'
/** The zoom the routing graph is built at: the OpenMapTiles road network, and the basemap's maximum. */
export const ROUTING_ZOOM = 14

export interface Basemap {
  readonly template: string
  readonly maxZoom: number
}

let basemap: Promise<Basemap> | undefined

/** The tile template and maximum zoom of the basemap, read once from its TileJSON. */
export function loadBasemap(): Promise<Basemap> {
  basemap ??= fetch(BASEMAP_TILESET).then(async (response) => {
    if (!response.ok) throw new Error(`basemap TileJSON: HTTP ${response.status}`)
    const json = (await response.json()) as { tiles?: unknown; maxzoom?: unknown }
    const template = Array.isArray(json.tiles) ? json.tiles[0] : undefined
    if (typeof template !== 'string' || !['{z}', '{x}', '{y}'].every((part) => template.includes(part))) {
      throw new Error('basemap TileJSON has no {z}/{x}/{y} tile template')
    }
    return { template, maxZoom: typeof json.maxzoom === 'number' ? json.maxzoom : ROUTING_ZOOM }
  })
  // A failed read is not kept: the next run asks again.
  basemap.catch(() => {
    basemap = undefined
  })
  return basemap
}

export interface Bounds {
  readonly minLng: number
  readonly minLat: number
  readonly maxLng: number
  readonly maxLat: number
}

/** The tiles of `zoom` that cover `bounds`, each with its URL from `template`. */
export function tilesCovering(bounds: Bounds, zoom: number, template: string): Tile[] {
  const n = 2 ** zoom
  const clamp = (v: number) => Math.min(n - 1, Math.max(0, v))
  const xOf = (lng: number) => clamp(Math.floor(((lng + 180) / 360) * n))
  const yOf = (lat: number) => {
    const rad = (lat * Math.PI) / 180
    return clamp(Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n))
  }
  const tiles: Tile[] = []
  for (let x = xOf(bounds.minLng); x <= xOf(bounds.maxLng); x++) {
    for (let y = yOf(bounds.maxLat); y <= yOf(bounds.minLat); y++) {
      const url = template.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y))
      tiles.push({ z: zoom, x, y, url })
    }
  }
  return tiles
}
