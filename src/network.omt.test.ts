import { describe, expect, it } from 'vitest'
import { networkFromOmtGraph, type OmtGraphLike } from './omt'

/*
 * A hand-made graph in omt-router's shape: node 1 — node 2 two-way (primary), node 2 → node 3 one-way (class unknown),
 * one self-loop and one edge without speed, both to be dropped.
 */
const graph: OmtGraphLike = {
  nodes: new Map([
    [1, { id: 1, coords: [9.7, 52.37] }],
    [2, { id: 2, coords: [9.701, 52.37] }],
    [3, { id: 3, coords: [9.702, 52.37] }],
  ]),
  edges: [
    { source: 1, target: 2, cost: 111, reverseCost: 111, length: 111, speed: 50, properties: { class: 'primary' } },
    { source: 2, target: 3, cost: 111, reverseCost: -1, length: 111, speed: 30 },
    { source: 3, target: 3, cost: 0, reverseCost: 0, length: 0, speed: 30 },
    { source: 1, target: 3, cost: 111, reverseCost: 111, length: 111, speed: 0 },
  ],
}

describe('networkFromOmtGraph', () => {
  const network = networkFromOmtGraph(graph)

  it('makes two links for a two-way edge and one for a one-way edge', () => {
    expect(network.links).toHaveLength(3)
    const pairs = network.links.map((l) => [network.nodes[l.from], network.nodes[l.to]])
    expect(pairs).toEqual([
      [[9.7, 52.37], [9.701, 52.37]],
      [[9.701, 52.37], [9.7, 52.37]],
      [[9.701, 52.37], [9.702, 52.37]],
    ])
  })

  it('drops self-loops and edges without a speed', () => {
    expect(network.links.every((l) => l.from !== l.to)).toBe(true)
    expect(network.links.every((l) => l.freeSpeedKmh > 0)).toBe(true)
  })

  it('takes the capacity from the road class, with a default for unknown classes', () => {
    expect(network.links[0]!.capacityVph).toBe(2000)
    expect(network.links[2]!.capacityVph).toBe(600)
  })

  it('lists the outgoing links of each node', () => {
    const index = (coords: [number, number]) => network.nodes.findIndex((n) => n[0] === coords[0] && n[1] === coords[1])
    expect(network.outgoing[index([9.701, 52.37])]!.length).toBe(2)
  })

  it('drops edges between coincident nodes instead of rejecting the whole graph', () => {
    // Nodes 1 and 2 sit at the same place, as they can at a tile seam. The edge between them claims 111 m.
    const seam: OmtGraphLike = {
      nodes: new Map([
        [1, { id: 1, coords: [9.7, 52.37] }],
        [2, { id: 2, coords: [9.7, 52.37] }],
        [3, { id: 3, coords: [9.701, 52.37] }],
      ]),
      edges: [
        { source: 1, target: 2, cost: 111, reverseCost: 111, length: 111, speed: 50, properties: { class: 'primary' } },
        { source: 2, target: 3, cost: 111, reverseCost: 111, length: 111, speed: 50, properties: { class: 'primary' } },
      ],
    }
    const network = networkFromOmtGraph(seam)
    expect(network.links).toHaveLength(2)
    expect(network.links.every((l) => l.lengthM > 0)).toBe(true)
  })
})
