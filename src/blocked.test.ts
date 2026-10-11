import { describe, expect, it } from 'vitest'
import { BlockedLinks } from './blocked'
import { haversineM, offsetM, type LngLat } from './geo'
import { createRandom } from './random'
import { gridNetwork, lineNetwork, TEST_ORIGIN } from './testing/networks'

// lineNetwork with 4 nodes, 100 m apart, driven both ways: link 0 is 0→1, 1 is 1→0, 2 is 1→2, 3 is 2→1, 4 is 2→3, 5 is 3→2.
const line = () => lineNetwork({ count: 4, lengthM: 100, freeSpeedKmh: 36, capacityVph: 360 })
const at = (metresEast: number): LngLat => offsetM(TEST_ORIGIN, metresEast, 0)

describe('BlockedLinks', () => {
  it('blocks the links that touch a node the disc covers', () => {
    const blocked = new BlockedLinks(line())
    blocked.set({ center: at(200), radiusM: 10 })
    expect([...blocked.mask]).toEqual([0, 0, 1, 1, 1, 1])
  })

  it('blocks a link by its distance to the segment, not by its ends', () => {
    // The centre is 150 m east, between nodes 1 and 2. Links 2 and 3 (100–200 m) pass under it. Links 0, 1, 4 and 5
    // end 50 m away, outside a 40 m radius.
    const blocked = new BlockedLinks(line())
    blocked.set({ center: at(150), radiusM: 40 })
    expect([...blocked.mask]).toEqual([0, 0, 1, 1, 0, 0])
  })

  it('unblocks the previous disc when it moves, and everything on null', () => {
    const blocked = new BlockedLinks(line())
    blocked.set({ center: at(0), radiusM: 10 })
    expect([...blocked.mask]).toEqual([1, 1, 0, 0, 0, 0])
    blocked.set({ center: at(300), radiusM: 10 })
    expect([...blocked.mask]).toEqual([0, 0, 0, 0, 1, 1])
    blocked.set(null)
    expect([...blocked.mask]).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('agrees with a brute-force scan on a grid, away from the disc edge', () => {
    const network = gridNetwork({ rows: 8, cols: 8, spacingM: 120 })
    const blocked = new BlockedLinks(network)
    const random = createRandom(3)
    const centre = offsetM(TEST_ORIGIN, 300, 300)
    for (let trial = 0; trial < 30; trial++) {
      const center = offsetM(centre, (random() - 0.5) * 900, (random() - 0.5) * 900)
      const radiusM = 20 + random() * 250
      blocked.set({ center, radiusM })
      network.links.forEach((link, id) => {
        const d = distanceToSegmentM(center, link.geometry[0]!, link.geometry[link.geometry.length - 1]!)
        // Skip links within 1 m of the edge, where the flat approximation and the exact distance may disagree.
        if (Math.abs(d - radiusM) < 1) return
        expect(blocked.mask[id]).toBe(d <= radiusM ? 1 : 0)
      })
    }
  })
})

/**
 * Distance in metres from `p` to the segment a–b. Each point is put on a local east/north axis at `p` with haversine
 * distances along the two axes, which is independent of the flat projection `BlockedLinks` uses. Fine at city scale.
 */
function distanceToSegmentM(p: LngLat, a: LngLat, b: LngLat): number {
  const east = (q: LngLat): number => Math.sign(q[0] - p[0]) * haversineM(p, [q[0], p[1]])
  const north = (q: LngLat): number => Math.sign(q[1] - p[1]) * haversineM(p, [p[0], q[1]])
  const ax = east(a)
  const ay = north(a)
  const dx = east(b) - ax
  const dy = north(b) - ay
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.min(1, Math.max(0, (-ax * dx - ay * dy) / len2)) : 0
  return Math.hypot(ax + t * dx, ay + t * dy)
}
