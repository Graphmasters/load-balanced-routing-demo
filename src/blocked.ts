import type { LngLat } from './geo'
import type { Network } from './network'

/** A disc on the map: a centre and a radius in metres. */
export interface Disc {
  readonly center: LngLat
  readonly radiusM: number
}

const EARTH_RADIUS_M = 6_371_008.8
const DEG = Math.PI / 180

/**
 * Which links a disc blocks. A link is blocked when its segment comes within the disc's radius of the centre. Links are
 * two-point segments (see `omt.ts`), so the distance is exact. The links are bucketed into a grid once, so moving the
 * disc only tests the links near it. The mask is what `findLinkPath` reads: 1 for a blocked link.
 */
export class BlockedLinks {
  /** 1 for each blocked link, by link id. */
  readonly mask: Uint8Array

  private readonly cellM: number
  private readonly originLng: number
  private readonly originLat: number
  private readonly cosLat: number
  private readonly ax: Float64Array
  private readonly ay: Float64Array
  private readonly bx: Float64Array
  private readonly by: Float64Array
  private readonly columns: number
  private readonly rows: number
  private readonly cellStart: Int32Array
  private readonly cellLinks: Int32Array
  private readonly seen: Uint32Array
  private stamp = 0
  private lit: number[] = []

  constructor(network: Network, cellM = 500) {
    const links = network.links
    const count = links.length
    this.mask = new Uint8Array(count)
    this.seen = new Uint32Array(count)
    this.cellM = cellM

    let minLng = Infinity
    let minLat = Infinity
    let maxLat = -Infinity
    for (const link of links) {
      for (const p of [link.geometry[0]!, link.geometry[link.geometry.length - 1]!]) {
        minLng = Math.min(minLng, p[0])
        minLat = Math.min(minLat, p[1])
        maxLat = Math.max(maxLat, p[1])
      }
    }
    this.originLng = Number.isFinite(minLng) ? minLng : 0
    this.originLat = Number.isFinite(minLat) ? minLat : 0
    this.cosLat = Math.cos(((Number.isFinite(maxLat) ? (minLat + maxLat) / 2 : 0) * Math.PI) / 180)

    this.ax = new Float64Array(count)
    this.ay = new Float64Array(count)
    this.bx = new Float64Array(count)
    this.by = new Float64Array(count)
    let maxX = 0
    let maxY = 0
    for (let id = 0; id < count; id++) {
      const geometry = links[id]!.geometry
      const a = this.project(geometry[0]!)
      const b = this.project(geometry[geometry.length - 1]!)
      this.ax[id] = a[0]
      this.ay[id] = a[1]
      this.bx[id] = b[0]
      this.by[id] = b[1]
      maxX = Math.max(maxX, a[0], b[0])
      maxY = Math.max(maxY, a[1], b[1])
    }

    // Bucket every link into the cells its bounding box touches (CSR layout: a count pass, then a fill pass).
    this.columns = Math.floor(maxX / cellM) + 1
    this.rows = Math.floor(maxY / cellM) + 1
    const cellCount = this.columns * this.rows
    const occupancy = new Int32Array(cellCount + 1)
    const span = (id: number) => ({
      x0: Math.floor(Math.min(this.ax[id]!, this.bx[id]!) / cellM),
      x1: Math.floor(Math.max(this.ax[id]!, this.bx[id]!) / cellM),
      y0: Math.floor(Math.min(this.ay[id]!, this.by[id]!) / cellM),
      y1: Math.floor(Math.max(this.ay[id]!, this.by[id]!) / cellM),
    })
    for (let id = 0; id < count; id++) {
      const s = span(id)
      for (let y = s.y0; y <= s.y1; y++) {
        for (let x = s.x0; x <= s.x1; x++) {
          const next = y * this.columns + x + 1
          occupancy[next] = occupancy[next]! + 1
        }
      }
    }
    for (let c = 0; c < cellCount; c++) occupancy[c + 1] = occupancy[c + 1]! + occupancy[c]!
    this.cellStart = occupancy
    this.cellLinks = new Int32Array(occupancy[cellCount]!)
    const fill = occupancy.slice(0, cellCount)
    for (let id = 0; id < count; id++) {
      const s = span(id)
      for (let y = s.y0; y <= s.y1; y++) {
        for (let x = s.x0; x <= s.x1; x++) {
          const cell = y * this.columns + x
          this.cellLinks[fill[cell]!] = id
          fill[cell] = fill[cell]! + 1
        }
      }
    }
  }

  /** Blocks the links within `disc` and unblocks the ones that were blocked before. `null` unblocks everything. */
  set(disc: Disc | null): void {
    for (const id of this.lit) this.mask[id] = 0
    this.lit = []
    if (!disc) return

    const [cx, cy] = this.project(disc.center)
    const r = disc.radiusM
    const x0 = Math.max(0, Math.floor((cx - r) / this.cellM))
    const x1 = Math.min(this.columns - 1, Math.floor((cx + r) / this.cellM))
    const y0 = Math.max(0, Math.floor((cy - r) / this.cellM))
    const y1 = Math.min(this.rows - 1, Math.floor((cy + r) / this.cellM))
    this.stamp++
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const cell = y * this.columns + x
        for (let k = this.cellStart[cell]!; k < this.cellStart[cell + 1]!; k++) {
          const id = this.cellLinks[k]!
          if (this.seen[id] === this.stamp) continue
          this.seen[id] = this.stamp
          if (segmentDistanceM(cx, cy, this.ax[id]!, this.ay[id]!, this.bx[id]!, this.by[id]!) <= r) {
            this.mask[id] = 1
            this.lit.push(id)
          }
        }
      }
    }
  }

  /** Metres east and north of the grid origin, on a flat map (exact enough across a city). */
  private project(p: LngLat): [number, number] {
    return [(p[0] - this.originLng) * this.cosLat * DEG * EARTH_RADIUS_M, (p[1] - this.originLat) * DEG * EARTH_RADIUS_M]
  }
}

/** Distance from the point (px, py) to the segment (ax, ay)–(bx, by), in the same units. */
function segmentDistanceM(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}
