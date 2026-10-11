import { type LngLat, offsetM } from '../geo'
import { createNetwork, type LinkSpec, type Network } from '../network'

const ORIGIN: LngLat = [9.74, 52.37]

/** Two-way grid of rows × cols nodes, `spacingM` apart, with every neighbouring pair linked in both directions. */
export function gridNetwork(options: {
  rows: number
  cols: number
  spacingM: number
  freeSpeedKmh?: number
  capacityVph?: number
}): Network {
  const { rows, cols, spacingM } = options
  const freeSpeedKmh = options.freeSpeedKmh ?? 50
  const capacityVph = options.capacityVph ?? 1800
  const nodes: LngLat[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) nodes.push(offsetM(ORIGIN, c * spacingM, r * spacingM))
  }
  const id = (r: number, c: number) => r * cols + c
  const specs: LinkSpec[] = []
  const pair = (a: number, b: number) => {
    const pa = nodes[a]!
    const pb = nodes[b]!
    specs.push({ from: a, to: b, geometry: [pa, pb], freeSpeedKmh, capacityVph })
    specs.push({ from: b, to: a, geometry: [pb, pa], freeSpeedKmh, capacityVph })
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols) pair(id(r, c), id(r, c + 1))
      if (r + 1 < rows) pair(id(r, c), id(r + 1, c))
    }
  }
  return createNetwork(nodes, specs)
}

/**
 * A straight road of `count` nodes, `lengthM` metres apart, driven one way only (from node 0 towards the last node).
 * Each link has the given free speed and capacity.
 */
export function oneWayLine(options: {
  count: number
  lengthM: number
  freeSpeedKmh: number
  capacityVph: number
}): Network {
  const nodes: LngLat[] = []
  for (let i = 0; i < options.count; i++) nodes.push(offsetM(ORIGIN, i * options.lengthM, 0))
  const specs: LinkSpec[] = []
  for (let i = 0; i + 1 < options.count; i++) {
    specs.push({
      from: i,
      to: i + 1,
      geometry: [nodes[i]!, nodes[i + 1]!],
      freeSpeedKmh: options.freeSpeedKmh,
      capacityVph: options.capacityVph,
    })
  }
  return createNetwork(nodes, specs)
}

/**
 * A straight road of `count` nodes, `lengthM` metres apart, driven both ways. Strongly connected, so every node is a
 * valid trip end, unlike `oneWayLine`.
 */
export function lineNetwork(options: { count: number; lengthM: number; freeSpeedKmh: number; capacityVph: number }): Network {
  const nodes: LngLat[] = []
  for (let i = 0; i < options.count; i++) nodes.push(offsetM(ORIGIN, i * options.lengthM, 0))
  const specs: LinkSpec[] = []
  for (let i = 0; i + 1 < options.count; i++) {
    const geometry: LngLat[] = [nodes[i]!, nodes[i + 1]!]
    const reversed: LngLat[] = [nodes[i + 1]!, nodes[i]!]
    specs.push({ from: i, to: i + 1, geometry, freeSpeedKmh: options.freeSpeedKmh, capacityVph: options.capacityVph })
    specs.push({ from: i + 1, to: i, geometry: reversed, freeSpeedKmh: options.freeSpeedKmh, capacityVph: options.capacityVph })
  }
  return createNetwork(nodes, specs)
}

export const TEST_ORIGIN = ORIGIN
