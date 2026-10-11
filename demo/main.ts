import * as maplibregl from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { buildGraphForTiles } from 'omt-router'
import {
  generateTrips,
  networkFromOmtGraph,
  offsetM,
  routesToGeoJSON,
  simulate,
  timedRoutesFromGeoJSON,
  vehiclesAt,
  vehiclesToGeoJSON,
  type Area,
  type LngLat,
  type OmtGraphLike,
  type SimulationResult,
  type TimedRoute,
} from '../src/index'
import { loadBasemap, ROUTING_ZOOM, tilesCovering, type Bounds } from './tiles'
import { applyTheme, currentTheme, onSystemThemeChange, rememberTheme, type Theme } from './theme'

maplibregl.setWorkerUrl(maplibreWorkerUrl)

/*
 * Two ways in. Static: the page shows precomputed routes (sample-routes.geojson, or ?routes=<url> for a file written by
 * "Export GeoJSON"), with no computation. Live: "Run" builds the road network from OpenFreeMap's tiles in the browser
 * and simulates on it. Both animate the same way: a dot per vehicle at the clock, interpolated from the timestamps.
 */

/** The scenario clock starts at this hour; the simulation counts seconds from it. */
const CLOCK_START_HOUR = 17
/** The basemap style and the overlay colours of each theme. */
interface Palette {
  readonly style: string
  readonly origin: string
  readonly destination: string
  readonly route: string
  readonly vehicle: string
}
const PALETTES: Record<Theme, Palette> = {
  light: {
    style: 'https://tiles.openfreemap.org/styles/positron',
    origin: '#2f6fdb',
    destination: '#d6453d',
    route: '#1f3b8a',
    vehicle: '#ff5a1f',
  },
  dark: {
    style: 'https://tiles.openfreemap.org/styles/dark',
    origin: '#6b9bff',
    destination: '#ff6f66',
    route: '#a9c2ff',
    vehicle: '#ff7a3d',
  },
}

/** The precomputed routes the page shows until a live run replaces them. */
const SAMPLE_ROUTES = 'sample-routes.geojson'
const MARGIN_M = 1500
const METRES_PER_DEGREE_LAT = 111_195

type GeoData = maplibregl.GeoJSONSourceSpecification['data']
// As the web app does: the style-spec types come from maplibre-gl's own layer declarations.
type LayerSpec = Exclude<maplibregl.AddLayerObject, maplibregl.CustomLayerInterface>
type LineColor = NonNullable<NonNullable<Extract<LayerSpec, { type: 'line' }>['paint']>['line-color']>

/** A colour by the role of an area: the origin's colour, else the destination's. */
const byRole = (origin: string, destination: string): LineColor => [
  'case',
  ['==', ['get', 'role'], 'origin'],
  origin,
  destination,
]

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}
const input = (id: string): string => $<HTMLInputElement>(id).value
const num = (id: string): number => Number(input(id))

let theme: Theme = currentTheme()
applyTheme(theme)
const map = new maplibregl.Map({
  container: 'map',
  style: PALETTES[theme].style,
  center: [9.765, 52.38],
  zoom: 12.2,
  maxPitch: 0,
  attributionControl: { compact: true },
})

/** The routes the animation draws, with their timestamps, and the end of the clock. */
let routes: TimedRoute[] = []
let endS = 0
let clockS = 0
let playing = false
let lastFrame = 0
let exportable: object | null = null
/** Set by a live run: a static load that finishes later must not overwrite the run's status. */
let liveRunStarted = false

function circleArea(prefix: 'o' | 'd'): Area {
  return { kind: 'circle', center: [num(`${prefix}-lng`), num(`${prefix}-lat`)], radiusM: num(`${prefix}-r`) }
}

/** A disc as a closed ring, for drawing. A radius of 0 gives a degenerate ring at the centre. */
function ringOf(area: Area, steps = 48): LngLat[] {
  if (area.kind !== 'circle') return area.ring.slice()
  const { center, radiusM } = area
  return Array.from({ length: steps + 1 }, (_, i) => {
    const angle = (2 * Math.PI * i) / steps
    return offsetM(center, radiusM * Math.cos(angle), radiusM * Math.sin(angle))
  })
}

/** The bounds of the areas plus a margin, in degrees. */
function boundsOf(areas: Area[]): Bounds {
  const points = areas.flatMap((area) => ringOf(area, 8))
  const lngs = points.map((p) => p[0])
  const lats = points.map((p) => p[1])
  const dLat = MARGIN_M / METRES_PER_DEGREE_LAT
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2
  const dLng = MARGIN_M / (METRES_PER_DEGREE_LAT * Math.cos((midLat * Math.PI) / 180))
  return {
    minLng: Math.min(...lngs) - dLng,
    maxLng: Math.max(...lngs) + dLng,
    minLat: Math.min(...lats) - dLat,
    maxLat: Math.max(...lats) + dLat,
  }
}

function areasGeoJSON(): GeoData {
  return {
    type: 'FeatureCollection',
    features: (['o', 'd'] as const).map((prefix) => {
      const area = circleArea(prefix)
      return {
        type: 'Feature',
        properties: { role: prefix === 'o' ? 'origin' : 'destination' },
        geometry: { type: 'Polygon', coordinates: [ringOf(area).map((p) => [p[0], p[1]])] },
      }
    }),
  }
}

/** The data of each source. A style change drops the sources, so they are added again with this data. */
const sourceData = new Map<string, GeoData>()

function setSource(id: string, data: object): void {
  sourceData.set(id, data as GeoData)
  // Absent while a style is loading: addOverlays adds the stored data when the style is ready.
  ;(map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(data as GeoData)
}

function setStatus(text: string): void {
  $('status').textContent = text
}

function clockLabel(t: number): string {
  const total = Math.floor(t)
  const h = CLOCK_START_HOUR + Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':')
}

/** Shows `timed` as the routes of the animation and of the map, and rewinds the clock. */
function setRoutes(timed: TimedRoute[], lines: object): void {
  routes = timed
  exportable = lines
  endS = timed.reduce((max, route) => Math.max(max, route.points[route.points.length - 1]?.[2] ?? 0), 0) + 1
  clockS = 0
  setSource('routes', lines)
  $<HTMLInputElement>('scrub').max = String(Math.ceil(endS))
  $<HTMLButtonElement>('play').disabled = timed.length === 0
  $<HTMLButtonElement>('export').disabled = timed.length === 0
}

function showStats(
  r: SimulationResult,
  timings: { graphMs: number; simMs: number },
  network: { nodes: number; links: number },
  tiles: number,
): void {
  const travel = r.routes.map((route) => route.arrivalS - route.departureS)
  const mean = travel.length ? travel.reduce((a, b) => a + b, 0) / travel.length : 0
  const busiest = r.slots.reduce((best, s) => (s.peakLinkEntries > best.peakLinkEntries ? s : best), r.slots[0]!)
  const rows: [string, string | number][] = [
    ['Tiles', tiles],
    ['Network', `${network.nodes} nodes, ${network.links} links`],
    ['Used by trips', `${(r.coverage * 100).toFixed(0)}% of nodes`],
    ['Routes arrived', r.routes.length],
    ['Unreachable', r.unreachable],
    ['Unfinished', r.unfinished],
    ['Mean travel time', `${(mean / 60).toFixed(1)} min`],
    ['Busiest link', `${busiest.peakLinkEntries} vehicles in 10 s, at ${clockLabel(busiest.startS)}`],
    ['Graph build', `${timings.graphMs.toFixed(0)} ms`],
    ['Simulation', `${timings.simMs.toFixed(0)} ms`],
  ]
  $('stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
}

async function run(): Promise<void> {
  const runButton = $<HTMLButtonElement>('run')
  liveRunStarted = true
  runButton.disabled = true
  playing = false
  $<HTMLButtonElement>('play').textContent = 'Play'
  try {
    const origin = circleArea('o')
    const destination = circleArea('d')
    const bounds = boundsOf([origin, destination])
    const basemap = await loadBasemap()
    const zoom = Math.min(ROUTING_ZOOM, basemap.maxZoom)
    const tiles = tilesCovering(bounds, zoom, basemap.template)
    setStatus(`Loading ${tiles.length} tiles…`)

    const t0 = performance.now()
    const graph = (await buildGraphForTiles(tiles, 'car', { zoom })) as OmtGraphLike & {
      hasMissingTiles?: boolean
    }
    const network = networkFromOmtGraph(graph)
    const t1 = performance.now()
    if (graph.hasMissingTiles) setStatus('Some tiles are missing: the network is partial')

    setStatus('Simulating…')
    const seed = num('seed')
    const trips = generateTrips({
      count: num('count'),
      origin,
      destination,
      departure: { fromS: 0, toS: num('window') * 60 },
      seed,
    })
    const sim = simulate({ network, trips, seed, routeNoise: num('noise') })
    const t2 = performance.now()

    setRoutes(sim.routes, routesToGeoJSON(sim.routes))
    setSource('areas', areasGeoJSON())
    showStats(sim, { graphMs: t1 - t0, simMs: t2 - t1 }, { nodes: network.nodes.length, links: network.links.length }, tiles.length)
    map.fitBounds(
      [
        [bounds.minLng, bounds.minLat],
        [bounds.maxLng, bounds.maxLat],
      ],
      { padding: 40, duration: 600 },
    )
    setStatus(`${sim.routes.length} routes from ${trips.length} trips`)
  } catch (error) {
    console.error(error)
    setStatus(`Failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    runButton.disabled = false
  }
}

/** Shows precomputed routes from a GeoJSON file ("?routes=<url>"). */
async function loadStatic(url: string): Promise<void> {
  setStatus('Loading routes…')
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const json: unknown = await response.json()
    const timed = timedRoutesFromGeoJSON(json)
    setRoutes(timed, json as object)
    const bounds = routeBounds(timed)
    if (bounds) map.fitBounds(bounds, { padding: 40, duration: 0 })
    if (!liveRunStarted) setStatus(`${timed.length} precomputed routes`)
  } catch (error) {
    if (!liveRunStarted) setStatus(`Could not load ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function routeBounds(timed: TimedRoute[]): [[number, number], [number, number]] | null {
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  for (const route of timed) {
    for (const [lng, lat] of route.points) {
      minLng = Math.min(minLng, lng)
      minLat = Math.min(minLat, lat)
      maxLng = Math.max(maxLng, lng)
      maxLat = Math.max(maxLat, lat)
    }
  }
  return Number.isFinite(minLng) ? [[minLng, minLat], [maxLng, maxLat]] : null
}

/** One animation frame: advance the clock while playing, and draw every vehicle at the clock. */
function frame(ts: number): void {
  const dt = lastFrame ? (ts - lastFrame) / 1000 : 0
  lastFrame = ts
  if (playing) {
    clockS += dt * num('speed')
    if (clockS > endS) clockS = 0
  }
  setSource('vehicles', vehiclesToGeoJSON(vehiclesAt(routes, clockS)))
  $<HTMLInputElement>('scrub').value = String(Math.floor(clockS))
  $('clock').textContent = clockLabel(clockS)
  requestAnimationFrame(frame)
}

function exportRoutes(): void {
  if (!exportable) return
  const blob = new Blob([JSON.stringify(exportable)], { type: 'application/geo+json' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = 'routes.geojson'
  link.click()
  URL.revokeObjectURL(link.href)
}

const EMPTY: GeoData = { type: 'FeatureCollection', features: [] }

/** The sources and layers the demo draws, in the colours of the current theme, with the data they last had. */
function addOverlays(): void {
  const { origin, destination, route, vehicle } = PALETTES[theme]
  const dataOf = (id: string): GeoData => sourceData.get(id) ?? EMPTY
  map.addSource('areas', { type: 'geojson', data: dataOf('areas') })
  map.addLayer({
    id: 'areas-fill',
    type: 'fill',
    source: 'areas',
    paint: { 'fill-color': byRole(origin, destination), 'fill-opacity': 0.12 },
  })
  map.addLayer({
    id: 'areas-line',
    type: 'line',
    source: 'areas',
    paint: { 'line-color': byRole(origin, destination), 'line-width': 1.5, 'line-dasharray': [2, 2] },
  })
  map.addSource('routes', { type: 'geojson', data: dataOf('routes') })
  map.addLayer({
    id: 'routes-line',
    type: 'line',
    source: 'routes',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': route, 'line-width': 1.4, 'line-opacity': 0.3 },
  })
  map.addSource('vehicles', { type: 'geojson', data: dataOf('vehicles') })
  map.addLayer({
    id: 'vehicles-dot',
    type: 'circle',
    source: 'vehicles',
    paint: { 'circle-radius': 3.5, 'circle-color': vehicle, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 },
  })
}

// Runs for the first style and again after each theme change, which replaces the style and drops the overlay. The
// animation and the static routes start once, with the first style.
let started = false
map.on('style.load', () => {
  addOverlays()
  if (started) return
  started = true
  requestAnimationFrame(frame)
  $<HTMLButtonElement>('run').disabled = false
  void loadStatic(new URLSearchParams(window.location.search).get('routes') ?? SAMPLE_ROUTES)
})

$<HTMLButtonElement>('run').addEventListener('click', () => void run())
$<HTMLButtonElement>('one-od').addEventListener('click', () => {
  $<HTMLInputElement>('o-r').value = '0'
  $<HTMLInputElement>('d-r').value = '0'
  setStatus('One OD pair: both radii set to 0. Run to see the routes.')
})
$<HTMLButtonElement>('play').addEventListener('click', () => {
  if (routes.length === 0) return
  playing = !playing
  $<HTMLButtonElement>('play').textContent = playing ? 'Pause' : 'Play'
})
$<HTMLInputElement>('scrub').addEventListener('input', (e) => {
  clockS = Number((e.target as HTMLInputElement).value)
})
$<HTMLButtonElement>('export').addEventListener('click', exportRoutes)

const themeButton = $<HTMLButtonElement>('theme')
/** The button names the theme that a click switches to. */
const toggleLabel = (t: Theme): string => (t === 'dark' ? 'Light mode' : 'Dark mode')
themeButton.textContent = toggleLabel(theme)
/** Switches the page and the map to `next`. The style change drops the overlay, which addOverlays adds again. */
function setTheme(next: Theme): void {
  if (next === theme) return
  theme = next
  applyTheme(theme)
  themeButton.textContent = toggleLabel(theme)
  map.setStyle(PALETTES[theme].style, { diff: false })
}
themeButton.addEventListener('click', () => {
  const next: Theme = theme === 'dark' ? 'light' : 'dark'
  rememberTheme(next)
  setTheme(next)
})
onSystemThemeChange(setTheme)
