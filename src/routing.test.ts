import { describe, expect, it } from 'vitest'
import { createNetwork, type Network } from './network'
import { findLinkPath, SearchSpace } from './routing'
import { createRandom } from './random'
import { gridNetwork } from './testing/networks'

/** Reference answer: plain Dijkstra over the same costs, O(n²), for comparison only. */
function dijkstraCostS(network: Network, origin: number, destination: number, cost: (id: number) => number): number | null {
  const dist = network.nodes.map(() => Infinity)
  const done = network.nodes.map(() => false)
  dist[origin] = 0
  for (;;) {
    let node = -1
    for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i]! < Infinity && (node < 0 || dist[i]! < dist[node]!)) node = i
    if (node < 0) return null
    if (node === destination) return dist[node]!
    done[node] = true
    for (const id of network.outgoing[node]!) {
      const to = network.links[id]!.to
      dist[to] = Math.min(dist[to]!, dist[node]! + cost(id))
    }
  }
}

function pathCostS(path: number[], cost: (id: number) => number): number {
  return path.reduce((sum, id) => sum + cost(id), 0)
}

describe('findLinkPath', () => {
  it('finds the same cost as Dijkstra on a grid with random speeds', () => {
    const base = gridNetwork({ rows: 7, cols: 7, spacingM: 150 })
    const random = createRandom(7)
    const speeds = base.links.map(() => 10 + 50 * random())
    const cost = (id: number) => base.links[id]!.lengthM / (speeds[id]! / 3.6)
    const floor = 1 / (Math.max(...speeds) / 3.6)
    const space = new SearchSpace(base.nodes.length)

    for (let trial = 0; trial < 60; trial++) {
      const from = Math.floor(random() * base.nodes.length)
      const to = Math.floor(random() * base.nodes.length)
      const path = findLinkPath(base, space, from, to, cost, floor)
      const reference = dijkstraCostS(base, from, to, cost)
      if (reference === null) {
        expect(path).toBeNull()
        continue
      }
      expect(path).not.toBeNull()
      expect(pathCostS(path!, cost)).toBeCloseTo(reference, 9)
      // The links chain up from origin to destination.
      let node = from
      for (const id of path!) {
        expect(base.links[id]!.from).toBe(node)
        node = base.links[id]!.to
      }
      expect(node).toBe(to)
    }
  })

  it('respects one-way links', () => {
    const nodes: [number, number][] = [[9.7, 52.37], [9.701, 52.37], [9.702, 52.37]]
    const network = createNetwork(nodes, [
      { from: 0, to: 1, geometry: [nodes[0]!, nodes[1]!], freeSpeedKmh: 30, capacityVph: 600 },
      { from: 1, to: 2, geometry: [nodes[1]!, nodes[2]!], freeSpeedKmh: 30, capacityVph: 600 },
    ])
    const space = new SearchSpace(3)
    const cost = (id: number) => network.links[id]!.lengthM
    expect(findLinkPath(network, space, 0, 2, cost, 0)).toEqual([0, 1])
    expect(findLinkPath(network, space, 2, 0, cost, 0)).toBeNull()
  })

  it('returns an empty path for the same node', () => {
    const network = gridNetwork({ rows: 2, cols: 2, spacingM: 100 })
    expect(findLinkPath(network, new SearchSpace(4), 1, 1, () => 1, 0)).toEqual([])
  })

  it('uses the search space again without leftovers', () => {
    const network = gridNetwork({ rows: 4, cols: 4, spacingM: 100 })
    const space = new SearchSpace(16)
    const cost = (id: number) => network.links[id]!.lengthM
    const first = findLinkPath(network, space, 0, 15, cost, 0)
    const second = findLinkPath(network, space, 0, 15, cost, 0)
    expect(second).toEqual(first)
    // Corner to corner of a 4 × 4 grid: three steps down and three across.
    expect(second!.length).toBe(6)
  })
})
