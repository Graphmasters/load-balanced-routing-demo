import { describe, expect, it } from 'vitest'
import { fitDisc, lockRefusal, MAX_LOCK_TILES, type Extent } from './extent'
import { haversineM, type LngLat } from './geo'

const extent: Extent = { minLng: 9.7, minLat: 52.36, maxLng: 9.8, maxLat: 52.4 }

describe('fitDisc', () => {
  it('leaves a centre alone when its disc already lies inside the extent', () => {
    expect(fitDisc([9.75, 52.38], 500, extent)).toEqual([9.75, 52.38])
  })

  it('moves a centre inside, keeping the whole disc within the extent', () => {
    const fitted = fitDisc([9.9, 52.3], 1_000, extent)
    expect(fitted[0]).toBeGreaterThan(extent.minLng)
    expect(fitted[0]).toBeLessThan(extent.maxLng)
    expect(fitted[1]).toBeGreaterThan(extent.minLat)
    expect(fitted[1]).toBeLessThan(extent.maxLat)
    // The nearest such centre sits on the shrunk edges: 1 km in from the west edge would be too far in.
    expect(haversineM(fitted, [extent.maxLng, fitted[1]])).toBeGreaterThanOrEqual(1_000 - 2)
    expect(haversineM(fitted, [fitted[0], extent.minLat])).toBeGreaterThanOrEqual(1_000 - 2)
  })

  it('centres the disc when it is wider than the extent', () => {
    const middle: LngLat = [(extent.minLng + extent.maxLng) / 2, (extent.minLat + extent.maxLat) / 2]
    expect(fitDisc([9.1, 52.9], 50_000, extent)).toEqual(middle)
  })
})

describe('lockRefusal', () => {
  it('lets a view of up to the tile limit lock', () => {
    expect(lockRefusal(MAX_LOCK_TILES, false)).toBeNull()
  })

  it('refuses a view above the tile limit, and says how many tiles it needs', () => {
    expect(lockRefusal(MAX_LOCK_TILES + 1, false)).toContain('Zoom in')
    expect(lockRefusal(MAX_LOCK_TILES + 1, false)).toContain(String(MAX_LOCK_TILES + 1))
  })

  it('refuses a graph built from missing tiles', () => {
    expect(lockRefusal(20, true)).toContain('did not load')
  })
})
