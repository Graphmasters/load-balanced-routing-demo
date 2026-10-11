import { haversineM } from './geo'
import type { Network } from './network'

/** Scratch arrays for searches on one network, reused from search to search (a search id marks what is current). */
export class SearchSpace {
  readonly cost: Float64Array
  readonly via: Int32Array
  readonly seen: Uint32Array
  readonly closed: Uint32Array
  private current = 0

  constructor(nodeCount: number) {
    this.cost = new Float64Array(nodeCount)
    this.via = new Int32Array(nodeCount)
    this.seen = new Uint32Array(nodeCount)
    this.closed = new Uint32Array(nodeCount)
  }

  /** Starts a new search and returns its id. */
  begin(): number {
    this.current++
    return this.current
  }
}

/** A binary min-heap of (key, node) pairs; stale entries are skipped by the caller. */
class MinHeap {
  private readonly keys: number[] = []
  private readonly items: number[] = []

  get size(): number {
    return this.keys.length
  }

  push(key: number, item: number): void {
    const keys = this.keys
    const items = this.items
    let i = keys.length
    keys.push(key)
    items.push(item)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (keys[parent]! <= key) break
      keys[i] = keys[parent]!
      items[i] = items[parent]!
      i = parent
    }
    keys[i] = key
    items[i] = item
  }

  pop(): number {
    const keys = this.keys
    const items = this.items
    const top = items[0]!
    const lastKey = keys.pop()!
    const lastItem = items.pop()!
    const n = keys.length
    if (n > 0) {
      let i = 0
      for (;;) {
        const left = 2 * i + 1
        if (left >= n) break
        const right = left + 1
        const child = right < n && keys[right]! < keys[left]! ? right : left
        if (keys[child]! >= lastKey) break
        keys[i] = keys[child]!
        items[i] = items[child]!
        i = child
      }
      keys[i] = lastKey
      items[i] = lastItem
    }
    return top
  }
}

/**
 * The cheapest path from `origin` to `destination` (node indices) as a list of link ids, or null when none exists.
 *
 * A* with the straight-line distance as the heuristic: `secondsPerMetreFloor` must not exceed the smallest cost per
 * metre any link can have, so the heuristic never overestimates and the path is optimal.
 */
export function findLinkPath(
  network: Network,
  space: SearchSpace,
  origin: number,
  destination: number,
  linkCostS: (linkId: number) => number,
  secondsPerMetreFloor: number,
): number[] | null {
  if (origin === destination) return []
  const nodes = network.nodes
  const links = network.links
  const goal = nodes[destination]!
  const heuristic = (node: number): number => haversineM(nodes[node]!, goal) * secondsPerMetreFloor

  const id = space.begin()
  const heap = new MinHeap()
  space.cost[origin] = 0
  space.via[origin] = -1
  space.seen[origin] = id
  heap.push(heuristic(origin), origin)

  while (heap.size > 0) {
    const node = heap.pop()
    if (space.closed[node] === id) continue
    space.closed[node] = id
    if (node === destination) return reconstruct(space, links, origin, destination)

    const base = space.cost[node]!
    for (const linkId of network.outgoing[node]!) {
      const to = links[linkId]!.to
      if (space.closed[to] === id) continue
      const cost = base + linkCostS(linkId)
      if (space.seen[to] !== id || cost < space.cost[to]!) {
        space.seen[to] = id
        space.cost[to] = cost
        space.via[to] = linkId
        heap.push(cost + heuristic(to), to)
      }
    }
  }
  return null
}

function reconstruct(
  space: SearchSpace,
  links: Network['links'],
  origin: number,
  destination: number,
): number[] {
  const path: number[] = []
  let node = destination
  while (node !== origin) {
    const linkId = space.via[node]!
    path.push(linkId)
    node = links[linkId]!.from
  }
  return path.reverse()
}
