import type { LngLat } from './geo'
import { createNetwork, type LinkSpec, type Network } from './network'

/*
 * The adapter from an omt-router graph (what buildGraphForTiles returns) to a Network. It reads the graph by shape
 * and imports nothing from omt-router, so the engine stays free of that dependency; only code that builds the graph
 * needs it.
 */

export interface OmtGraphNode {
  readonly id: number
  readonly coords: readonly [number, number]
}

export interface OmtGraphEdge {
  readonly source: number
  readonly target: number
  /** Length in metres when the edge can be driven from source to target, -1 when it cannot. */
  readonly cost: number
  /** Length in metres when the edge can be driven from target to source, -1 when it cannot. */
  readonly reverseCost: number
  readonly length: number
  /** Speed in km/h from the tags, or the class default. */
  readonly speed: number
  readonly properties?: { readonly class?: unknown }
}

export interface OmtGraphLike {
  readonly nodes: ReadonlyMap<number, OmtGraphNode>
  readonly edges: readonly OmtGraphEdge[]
}

/**
 * Vehicles per hour in one direction that a road of each OpenMapTiles class carries at full load. Illustrative
 * defaults for a demo, not calibrated values.
 */
export const CAPACITY_VPH_BY_CLASS: Readonly<Record<string, number>> = {
  motorway: 4000,
  motorway_link: 1500,
  trunk: 3000,
  trunk_link: 1200,
  primary: 2000,
  primary_link: 1000,
  secondary: 1200,
  secondary_link: 800,
  tertiary: 900,
  tertiary_link: 600,
  residential: 600,
  unclassified: 600,
  living_street: 300,
  service: 300,
  track: 200,
}

export const DEFAULT_CAPACITY_VPH = 600

/**
 * The network of a graph. A two-way edge becomes two links, a one-way edge one; edges without length or speed are
 * dropped, as are edges that loop back onto their own node.
 */
export function networkFromOmtGraph(
  graph: OmtGraphLike,
  capacityVphByClass: Readonly<Record<string, number>> = CAPACITY_VPH_BY_CLASS,
): Network {
  const indexOf = new Map<number, number>()
  const nodes: LngLat[] = []
  const nodeIndex = (node: OmtGraphNode): number => {
    let index = indexOf.get(node.id)
    if (index === undefined) {
      index = nodes.length
      indexOf.set(node.id, index)
      nodes.push([node.coords[0], node.coords[1]])
    }
    return index
  }

  const specs: LinkSpec[] = []
  for (const edge of graph.edges) {
    if (edge.source === edge.target || !(edge.length > 0) || !(edge.speed > 0)) continue
    const a = graph.nodes.get(edge.source)
    const b = graph.nodes.get(edge.target)
    if (!a || !b) continue
    const capacityVph = capacityVphByClass[String(edge.properties?.class ?? '')] ?? DEFAULT_CAPACITY_VPH
    const ia = nodeIndex(a)
    const ib = nodeIndex(b)
    const pa: LngLat = [a.coords[0], a.coords[1]]
    const pb: LngLat = [b.coords[0], b.coords[1]]
    if (edge.cost !== -1) {
      specs.push({ from: ia, to: ib, geometry: [pa, pb], freeSpeedKmh: edge.speed, capacityVph })
    }
    if (edge.reverseCost !== -1) {
      specs.push({ from: ib, to: ia, geometry: [pb, pa], freeSpeedKmh: edge.speed, capacityVph })
    }
  }
  return createNetwork(nodes, specs)
}
