import { describe, expect, it } from 'vitest'
import { createNetwork } from './network'
import { DEFAULT_SPEED_MODEL, linkSpeedKmh, speedsKmh } from './speed'
import { gridNetwork } from './testing/networks'

const link = { freeSpeedKmh: 50, capacityVph: 1800 }

describe('linkSpeedKmh', () => {
  it('is the free-flow speed without flow', () => {
    expect(linkSpeedKmh(link, 0, DEFAULT_SPEED_MODEL)).toBe(50)
  })

  it('follows the BPR curve at capacity: v0 / (1 + alpha)', () => {
    expect(linkSpeedKmh(link, 1800, DEFAULT_SPEED_MODEL)).toBeCloseTo(50 / 1.15, 10)
  })

  it('falls as the flow rises', () => {
    const speeds = [0, 0.25, 0.5, 1, 1.5, 2, 3].map((load) =>
      linkSpeedKmh(link, load * link.capacityVph, DEFAULT_SPEED_MODEL),
    )
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]!).toBeLessThanOrEqual(speeds[i - 1]!)
  })

  it('never drops below the floor, and never above the free-flow speed', () => {
    const jammed = linkSpeedKmh(link, 1e6, DEFAULT_SPEED_MODEL)
    expect(jammed).toBeCloseTo(Math.max(2, 0.05 * 50), 10)
    expect(jammed).toBeGreaterThan(0)
    expect(linkSpeedKmh(link, 1, DEFAULT_SPEED_MODEL)).toBeLessThanOrEqual(50)
  })
})

describe('speedsKmh', () => {
  const network = gridNetwork({ rows: 2, cols: 2, spacingM: 100, capacityVph: 360 })

  it('uses the free-flow speed before the first slot', () => {
    const speeds = speedsKmh(network, undefined, DEFAULT_SPEED_MODEL)
    for (const l of network.links) expect(speeds[l.id]).toBe(l.freeSpeedKmh)
  })

  it('takes the entries of the previous slot as flow per hour (one per 10 s slot is 360 vph)', () => {
    const entered = new Uint32Array(network.links.length)
    entered[0] = 1
    const speeds = speedsKmh(network, entered, DEFAULT_SPEED_MODEL)
    expect(speeds[0]).toBeCloseTo(50 / 1.15, 10)
    expect(speeds[1]).toBe(50)
  })
})

describe('createNetwork', () => {
  it('rejects a link without length', () => {
    expect(() =>
      createNetwork([[0, 0]], [{ from: 0, to: 0, geometry: [[0, 0], [0, 0]], freeSpeedKmh: 30, capacityVph: 600 }]),
    ).toThrow(/no length/)
  })

  it('rejects a link without a positive speed or capacity', () => {
    const geometry: [number, number][] = [[0, 0], [0.001, 0]]
    expect(() => createNetwork([[0, 0], [0.001, 0]], [{ from: 0, to: 1, geometry, freeSpeedKmh: 0, capacityVph: 600 }])).toThrow(
      /positive free speed/,
    )
  })
})
