import * as maplibregl from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { buildGraphForTiles, releaseGraph } from 'omt-router'
import { type Disc } from '../src/blocked'
import { fitDisc, type Extent, lockRefusal } from '../src/extent'
import { type LngLat, offsetM } from '../src/geo'
import { networkFromOmtGraph, type OmtGraphLike } from '../src/omt'
import type { LiveSettings, LiveStats } from '../src/live'
import { loadBasemap, ROUTING_ZOOM, tilesCovering } from './tiles'
import type { FromWorker, ToWorker } from './protocol'

maplibregl.setWorkerUrl(maplibreWorkerUrl)

/*
 * Interactive mode. The view is locked first: the road network is built for the tiles under the locked view, and the
 * areas stay inside it. Then vehicles spawn in the origin area, get a route when they spawn, and re-route as the
 * simulation runs. Routing runs in a worker; the page only draws.
 */

/** The scenario clock starts at this hour; the simulation counts seconds from it. */
const CLOCK_START_HOUR = 17
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron'
/** A frame is credited with at most this much simulated time, so a stall does not jump the clock. */
const MAX_WALL_STEP_S = 0.25
const DEFAULT_RATE_PER_MIN = 20
const DEFAULT_NOISE = 0.3
const DEFAULT_RATIO = 10
const DEFAULT_RADIUS_M = { origin: 1500, destination: 700, blocked: 800 }

// As the static demo does: the GeoJSON types come from maplibre-gl's own source declarations.
type GeoData = maplibregl.GeoJSONSourceSpecification['data']
type FeatureList = Extract<GeoData, { type: 'FeatureCollection' }>['features']

type Role = 'origin' | 'destination' | 'blocked'
const ROLES: Role[] = ['origin', 'destination', 'blocked']
const COLOURS: Record<Role, string> = { origin: '#f2b705', destination: '#2e9d4b', blocked: '#d62828' }
const VEHICLE_COLOUR = '#1f63e0'

interface Placed extends Disc {
  readonly role: Role
}

type GraphWithFlags = OmtGraphLike & { hasMissingTiles?: boolean }

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}
const num = (id: string): number => Number($<HTMLInputElement | HTMLSelectElement>(id).value)

const map = new maplibregl.Map({
  container: 'map',
  style: STYLE_URL,
  center: [9.765, 52.38],
  zoom: 12.2,
  maxPitch: 0,
  dragRotate: false,
  attributionControl: { compact: true },
})
// Rotation would make the view's bounds a bounding box of a tilted view, so the view is kept north-up.
map.touchZoomRotate.disableRotation()
map.keyboard.disable()

const lockButton = $<HTMLButtonElement>('lock')
const playButton = $<HTMLButtonElement>('play')
const statusLine = $('status')
const statsList = $('stats')

/** Set by a lock: the extent the areas must stay in, and the graph (kept so it can be released on unlock). */
let locked: { extent: Extent; graph: unknown } | null = null
let areas: Record<Role, Placed> | null = null
let worker: Worker | null = null
let playing = false
let inFlight = false
let seq = 0
let lastSentMs = 0
let settingsQueued = false
let drag: { role: Role; offset: LngLat } | null = null

function setStatus(text: string): void {
  statusLine.textContent = text
}

function clockLabel(t: number): string {
  const total = Math.floor(t)
  const h = CLOCK_START_HOUR + Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':')
}

/** A disc as a closed ring, for drawing. */
function ringOf(center: LngLat, radiusM: number, steps = 48): [number, number][] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const angle = (2 * Math.PI * i) / steps
    const p = offsetM(center, radiusM * Math.cos(angle), radiusM * Math.sin(angle))
    return [p[0], p[1]]
  })
}

function createWorker(): Worker {
  const created = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' })
  created.onmessage = (event: MessageEvent<FromWorker>) => onWorkerMessage(event.data)
  return created
}

function post(message: ToWorker): void {
  worker?.postMessage(message)
}

/** The settings the worker needs, from the areas and the panel. Null before a lock. */
function currentSettings(): LiveSettings | null {
  if (!areas) return null
  const { origin, destination, blocked } = areas
  return {
    origin: { kind: 'circle', center: origin.center, radiusM: origin.radiusM },
    destination: { kind: 'circle', center: destination.center, radiusM: destination.radiusM },
    blocked: { center: blocked.center, radiusM: blocked.radiusM },
    ratePerMin: num('rate'),
    routeNoise: num('noise'),
  }
}

/** Sends the settings once per frame at most, however many inputs change in that frame. */
function queueSettings(): void {
  if (settingsQueued) return
  settingsQueued = true
  requestAnimationFrame(() => {
    settingsQueued = false
    const settings = currentSettings()
    if (settings) post({ type: 'configure', settings })
  })
}

function drawAreas(): void {
  if (!areas) return
  const placed = ROLES.map((role) => areas![role])
  setSource('areas', {
    type: 'FeatureCollection',
    features: placed.map((a) => ({
      type: 'Feature',
      properties: { role: a.role },
      geometry: { type: 'Polygon', coordinates: [ringOf(a.center, a.radiusM)] },
    })),
  })
  setSource('handles', {
    type: 'FeatureCollection',
    features: placed.map((a) => ({
      type: 'Feature',
      properties: { role: a.role },
      geometry: { type: 'Point', coordinates: a.center },
    })),
  })
}

function setSource(id: string, data: GeoData): void {
  const source = map.getSource(id) as maplibregl.GeoJSONSource | undefined
  source?.setData(data)
}

function drawVehicles(positions: Float32Array): void {
  const features: FeatureList = []
  for (let i = 0; i < positions.length; i += 2) {
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [positions[i]!, positions[i + 1]!] },
    })
  }
  setSource('vehicles', { type: 'FeatureCollection', features })
}

function showStats(s: LiveStats): void {
  const ms = (v: number | null) => (v === null ? '–' : `${v.toFixed(1)} ms`)
  const seconds = (v: number | null) => (v === null ? '–' : `${v.toFixed(0)} s`)
  const rows: [string, string | number][] = [
    ['Clock', clockLabel(s.timeS)],
    ['Vehicles on the road', s.active],
    ['Spawn attempts', s.spawnAttempts],
    ['No route at spawn', s.unreachable],
    ['Arrived', s.arrived],
    ['Stranded (no route at re-plan)', s.stranded],
    ['Re-plans', s.replans],
    ['Average gap between re-plans', seconds(s.replanIntervalS)],
    ['Search time (route found)', ms(s.searchMs)],
    ['Search time (no route)', ms(s.failedSearchMs)],
    ['Routing budget left', `${(s.creditS * 1000).toFixed(0)} ms`],
  ]
  statsList.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
}

function onWorkerMessage(message: FromWorker): void {
  if (message.type === 'error') {
    inFlight = false
    setStatus(`Simulation error: ${message.message}`)
    return
  }
  inFlight = false
  if (!locked) return
  drawVehicles(message.positions)
  showStats(message.stats)
}

/** Lays the three areas out inside the locked extent, each at its default radius. */
function placeAreas(extent: Extent): Record<Role, Placed> {
  const w = extent.maxLng - extent.minLng
  const h = extent.maxLat - extent.minLat
  const at = (fx: number, fy: number): LngLat => [extent.minLng + w * fx, extent.minLat + h * fy]
  const place = (role: Role, centre: LngLat): Placed => {
    const radiusM = DEFAULT_RADIUS_M[role]
    return { role, center: fitDisc(centre, radiusM, extent), radiusM }
  }
  return {
    origin: place('origin', at(0.25, 0.5)),
    destination: place('destination', at(0.75, 0.5)),
    blocked: place('blocked', at(0.5, 0.78)),
  }
}

function syncRadiusInputs(): void {
  if (!areas) return
  $<HTMLInputElement>('origin-radius').value = String(areas.origin.radiusM)
  $<HTMLInputElement>('destination-radius').value = String(areas.destination.radiusM)
  $<HTMLInputElement>('blocked-radius').value = String(areas.blocked.radiusM)
}

/** Freezes the view while locked: pan and zoom off, so the network stays the one that was built. */
function freezeView(on: boolean): void {
  for (const handler of [map.dragPan, map.scrollZoom, map.boxZoom, map.doubleClickZoom]) {
    if (on) handler.disable()
    else handler.enable()
  }
  if (on) {
    map.touchZoomRotate.disable()
  } else {
    map.touchZoomRotate.enable()
    map.touchZoomRotate.disableRotation()
  }
  // Keeps a touch drag on a handle from scrolling the page on phones.
  map.getCanvas().style.touchAction = on ? 'none' : ''
}

async function lock(): Promise<void> {
  if (locked) return
  lockButton.disabled = true
  try {
    setStatus('Reading the view…')
    if (!map.loaded() || !map.areTilesLoaded()) await new Promise<void>((resolve) => map.once('idle', () => resolve()))
    const bounds = map.getBounds()
    const extent: Extent = {
      minLng: bounds.getWest(),
      minLat: bounds.getSouth(),
      maxLng: bounds.getEast(),
      maxLat: bounds.getNorth(),
    }
    const basemap = await loadBasemap()
    const tiles = tilesCovering(extent, ROUTING_ZOOM, basemap.template)
    const tooMany = lockRefusal(tiles.length, false)
    if (tooMany) {
      setStatus(tooMany)
      return
    }

    setStatus(`Building the road network from ${tiles.length} tiles…`)
    const started = performance.now()
    const graph = (await buildGraphForTiles(tiles, 'car', { zoom: ROUTING_ZOOM })) as GraphWithFlags
    const incomplete = lockRefusal(tiles.length, Boolean(graph.hasMissingTiles))
    if (incomplete) {
      releaseGraph(graph)
      setStatus(incomplete)
      return
    }
    const network = networkFromOmtGraph(graph)
    const buildMs = performance.now() - started

    worker ??= createWorker()
    post({ type: 'network', network })
    areas = placeAreas(extent)
    locked = { extent, graph }
    syncRadiusInputs()
    drawAreas()
    freezeView(true)
    const settings = currentSettings()
    if (settings) post({ type: 'configure', settings })
    setStatus(
      `Locked: ${tiles.length} tiles, ${network.nodes.length.toLocaleString()} nodes, ` +
        `${network.links.length.toLocaleString()} links, built in ${(buildMs / 1000).toFixed(1)} s. ` +
        'Drag the areas; Play to start.',
    )
  } catch (error) {
    console.error(error)
    setStatus(`Failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    lockButton.disabled = false
    updateButtons()
  }
}

function unlock(): void {
  if (!locked) return
  const confirmed = window.confirm(
    'Unlock the view? This discards the road network, every vehicle, the origin, destination and blocked areas. ' +
      'You can lock a new view afterwards.',
  )
  if (!confirmed) return
  post({ type: 'reset' })
  inFlight = false
  releaseGraph(locked.graph)
  locked = null
  areas = null
  playing = false
  freezeView(false)
  setSource('areas', { type: 'FeatureCollection', features: [] })
  setSource('handles', { type: 'FeatureCollection', features: [] })
  setSource('vehicles', { type: 'FeatureCollection', features: [] })
  statsList.innerHTML = ''
  setStatus('Unlocked. Pan and zoom to a new view, then lock it.')
  updateButtons()
}

function updateButtons(): void {
  lockButton.textContent = locked ? 'Unlock view' : 'Lock view'
  playButton.disabled = !locked
  playButton.textContent = playing ? 'Pause' : 'Play'
  for (const id of ['origin-radius', 'destination-radius', 'blocked-radius']) {
    $<HTMLInputElement>(id).disabled = !locked
  }
}

/** One tick per frame, sent only when the previous tick's frame has come back. */
function frame(now: number): void {
  if (worker && locked && !inFlight) {
    const wallDtS = Math.min(Math.max((now - lastSentMs) / 1000, 0), MAX_WALL_STEP_S)
    lastSentMs = now
    inFlight = true
    post({ type: 'tick', seq: ++seq, simDeltaS: playing ? wallDtS * num('ratio') : 0, wallDtS })
  }
  requestAnimationFrame(frame)
}

// Handles: drag a centre with the mouse or a finger. The map is frozen while locked, so the drag has no pan to fight.
function startDrag(role: Role, at: LngLat): void {
  if (!areas) return
  const center = areas[role].center
  drag = { role, offset: [center[0] - at[0], center[1] - at[1]] }
}

function moveDrag(at: LngLat): void {
  if (!drag || !areas || !locked) return
  const { role, offset } = drag
  const current = areas[role]
  const center = fitDisc([at[0] + offset[0], at[1] + offset[1]], current.radiusM, locked.extent)
  areas[role] = { ...current, center }
  drawAreas()
  queueSettings()
}

function endDrag(): void {
  drag = null
}

function roleAt(features: maplibregl.MapGeoJSONFeature[] | undefined): Role | null {
  const role = features?.[0]?.properties?.role
  return role === 'origin' || role === 'destination' || role === 'blocked' ? role : null
}

map.on('load', () => {
  map.addSource('areas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  map.addLayer({
    id: 'areas-fill',
    type: 'fill',
    source: 'areas',
    paint: {
      'fill-color': ['match', ['get', 'role'], 'origin', COLOURS.origin, 'destination', COLOURS.destination, COLOURS.blocked],
      'fill-opacity': ['match', ['get', 'role'], 'blocked', 0.28, 0.12],
    },
  })
  map.addLayer({
    id: 'areas-line',
    type: 'line',
    source: 'areas',
    paint: {
      'line-color': ['match', ['get', 'role'], 'origin', COLOURS.origin, 'destination', COLOURS.destination, COLOURS.blocked],
      'line-width': 1.5,
      'line-dasharray': [2, 2],
    },
  })
  map.addSource('handles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  // A wide, nearly invisible circle: the hit area is about 44 px across, which is a comfortable touch target.
  map.addLayer({
    id: 'handles-hit',
    type: 'circle',
    source: 'handles',
    paint: { 'circle-radius': 22, 'circle-color': '#000', 'circle-opacity': 0.01 },
  })
  map.addLayer({
    id: 'handles-dot',
    type: 'circle',
    source: 'handles',
    paint: {
      'circle-radius': 7,
      'circle-color': ['match', ['get', 'role'], 'origin', COLOURS.origin, 'destination', COLOURS.destination, COLOURS.blocked],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  })
  map.addSource('vehicles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  map.addLayer({
    id: 'vehicles-dot',
    type: 'circle',
    source: 'vehicles',
    paint: { 'circle-radius': 3.5, 'circle-color': VEHICLE_COLOUR, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 },
  })
  lockButton.disabled = false
  setStatus('Move the map to the area you want, then lock the view.')
  requestAnimationFrame(frame)
})

map.on('mousedown', 'handles-hit', (e) => {
  const role = roleAt(e.features)
  if (!role || !locked) return
  e.preventDefault()
  startDrag(role, [e.lngLat.lng, e.lngLat.lat])
})
map.on('touchstart', 'handles-hit', (e) => {
  const role = roleAt(e.features)
  if (!role || !locked) return
  startDrag(role, [e.lngLat.lng, e.lngLat.lat])
})
map.on('mousemove', (e) => {
  if (drag) moveDrag([e.lngLat.lng, e.lngLat.lat])
})
map.on('touchmove', (e) => {
  if (drag) moveDrag([e.lngLat.lng, e.lngLat.lat])
})
map.on('mouseup', endDrag)
map.on('touchend', endDrag)
// Touch drags must not scroll the page. The listener has to be non-passive for preventDefault to work.
map.getCanvas().addEventListener(
  'touchmove',
  (e) => {
    if (drag) e.preventDefault()
  },
  { passive: false },
)

function onRadiusInput(role: Role, id: string): void {
  if (!areas || !locked) return
  const radiusM = Math.max(0, num(id))
  const current = areas[role]
  areas[role] = { ...current, radiusM, center: fitDisc(current.center, radiusM, locked.extent) }
  drawAreas()
  queueSettings()
}

lockButton.addEventListener('click', () => (locked ? unlock() : void lock()))
playButton.addEventListener('click', () => {
  if (!locked) return
  playing = !playing
  updateButtons()
})
$<HTMLInputElement>('origin-radius').addEventListener('change', () => onRadiusInput('origin', 'origin-radius'))
$<HTMLInputElement>('destination-radius').addEventListener('change', () => onRadiusInput('destination', 'destination-radius'))
$<HTMLInputElement>('blocked-radius').addEventListener('change', () => onRadiusInput('blocked', 'blocked-radius'))
$<HTMLInputElement>('rate').addEventListener('change', queueSettings)
$<HTMLInputElement>('noise').addEventListener('change', queueSettings)

$<HTMLInputElement>('rate').value = String(DEFAULT_RATE_PER_MIN)
$<HTMLInputElement>('noise').value = String(DEFAULT_NOISE)
$<HTMLSelectElement>('ratio').value = String(DEFAULT_RATIO)
updateButtons()
