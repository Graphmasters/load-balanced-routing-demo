import type { Network } from './network'

/**
 * The nodes of the largest strongly connected part of the network: every node in it can reach every other one by
 * driving. A road extract often has small islands (a dead-end estate, a one-way loop cut off by the tile edge), and a
 * trip that starts or ends on one of them has no path. Trips snap to this part instead. Iterative Tarjan's algorithm.
 */
export function largestStronglyConnectedNodes(network: Network): number[] {
  const n = network.nodes.length
  const index = new Int32Array(n).fill(-1)
  const low = new Int32Array(n)
  const onStack = new Uint8Array(n)
  const component = new Int32Array(n).fill(-1)
  const sizes: number[] = []
  const stack: number[] = []
  let counter = 0

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue
    // Each frame is a node and how many of its outgoing links have been looked at.
    const frames: [node: number, next: number][] = [[root, 0]]
    index[root] = low[root] = counter++
    stack.push(root)
    onStack[root] = 1

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!
      const node = frame[0]
      const outgoing = network.outgoing[node]!
      if (frame[1] < outgoing.length) {
        const to = network.links[outgoing[frame[1]!]!]!.to
        frame[1]++
        if (index[to] === -1) {
          index[to] = low[to] = counter++
          stack.push(to)
          onStack[to] = 1
          frames.push([to, 0])
        } else if (onStack[to]) {
          low[node] = Math.min(low[node]!, index[to]!)
        }
        continue
      }

      frames.pop()
      const parent = frames[frames.length - 1]
      if (parent) low[parent[0]] = Math.min(low[parent[0]]!, low[node]!)
      if (low[node] === index[node]) {
        const id = sizes.length
        let size = 0
        let member: number
        do {
          member = stack.pop()!
          onStack[member] = 0
          component[member] = id
          size++
        } while (member !== node)
        sizes.push(size)
      }
    }
  }

  if (sizes.length === 0) return []
  let largest = 0
  for (let i = 1; i < sizes.length; i++) if (sizes[i]! > sizes[largest]!) largest = i
  const nodes: number[] = []
  for (let v = 0; v < n; v++) if (component[v] === largest) nodes.push(v)
  return nodes
}
