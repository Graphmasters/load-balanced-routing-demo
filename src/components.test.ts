import { describe, expect, it } from 'vitest'
import { largestStronglyConnectedNodes } from './components'
import { createNetwork, type LinkSpec } from './network'
import { gridNetwork } from './testing/networks'
import { offsetM, type LngLat } from './geo'

const ORIGIN: LngLat = [9.74, 52.37]
const link = (from: number, to: number, nodes: LngLat[]): LinkSpec => ({
  from,
  to,
  geometry: [nodes[from]!, nodes[to]!],
  freeSpeedKmh: 30,
  capacityVph: 600,
})

describe('largestStronglyConnectedNodes', () => {
  it('is every node of a two-way grid', () => {
    const network = gridNetwork({ rows: 4, cols: 5, spacingM: 100 })
    expect(largestStronglyConnectedNodes(network).sort((a, b) => a - b)).toEqual(network.nodes.map((_, i) => i))
  })

  it('leaves out a node that cannot be left', () => {
    // A two-way pair of nodes 0 and 1, and node 2, which can be entered from 1 but never left.
    const nodes = [offsetM(ORIGIN, 0, 0), offsetM(ORIGIN, 100, 0), offsetM(ORIGIN, 200, 0)]
    const network = createNetwork(nodes, [link(0, 1, nodes), link(1, 0, nodes), link(1, 2, nodes)])
    expect(largestStronglyConnectedNodes(network).sort()).toEqual([0, 1])
  })

  it('finds a one-way cycle, and not the tail that feeds it', () => {
    // Tail 0 → cycle 1 → 2 → 3 → 1.
    const nodes = [offsetM(ORIGIN, 0, 0), offsetM(ORIGIN, 100, 0), offsetM(ORIGIN, 100, 100), offsetM(ORIGIN, 0, 100)]
    const network = createNetwork(nodes, [link(0, 1, nodes), link(1, 2, nodes), link(2, 3, nodes), link(3, 1, nodes)])
    expect(largestStronglyConnectedNodes(network).sort()).toEqual([1, 2, 3])
  })

  it('picks the larger of two parts', () => {
    // A pair (0, 1) and a triangle (2, 3, 4), each two-way or cyclic and with no link between them.
    const nodes = Array.from({ length: 5 }, (_, i) => offsetM(ORIGIN, i * 100, 0))
    const network = createNetwork(nodes, [
      link(0, 1, nodes),
      link(1, 0, nodes),
      link(2, 3, nodes),
      link(3, 4, nodes),
      link(4, 2, nodes),
    ])
    expect(largestStronglyConnectedNodes(network).sort()).toEqual([2, 3, 4])
  })

  it('keeps one node when no two nodes connect', () => {
    const nodes = [offsetM(ORIGIN, 0, 0), offsetM(ORIGIN, 100, 0)]
    expect(largestStronglyConnectedNodes(createNetwork(nodes, []))).toHaveLength(1)
  })
})
