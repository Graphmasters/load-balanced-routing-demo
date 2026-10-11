import { cumulativeM, type LngLat } from './geo'

/**
 * One directed piece of road a vehicle can enter. It is the unit of congestion: a two-way road is two links, one per
 * direction, and a one-way road is one link. The geometry runs in the direction of travel.
 */
export interface Link {
  /** Index in `Network.links`. */
  readonly id: number
  /** Node index at the start of the link. */
  readonly from: number
  /** Node index at the end of the link. */
  readonly to: number
  /** Vertices from the start to the end, at least two. */
  readonly geometry: readonly LngLat[]
  /** Distance in metres from the start to each vertex; the first entry is 0. */
  readonly cumulativeM: readonly number[]
  readonly lengthM: number
  /** Speed of a vehicle on the link when nothing else is on it, in km/h. */
  readonly freeSpeedKmh: number
  /** Vehicles per hour in this direction that the link carries at full load. */
  readonly capacityVph: number
}

/** A road network as a directed graph of links. */
export interface Network {
  /** Coordinates of every node, by node index. */
  readonly nodes: readonly LngLat[]
  readonly links: readonly Link[]
  /** Ids of the links leaving each node, by node index. */
  readonly outgoing: readonly (readonly number[])[]
}

export interface LinkSpec {
  readonly from: number
  readonly to: number
  readonly geometry: readonly LngLat[]
  readonly freeSpeedKmh: number
  readonly capacityVph: number
}

/** Builds a network. Links get their ids in the order of `specs`. Throws on a link without length or speed. */
export function createNetwork(nodes: readonly LngLat[], specs: readonly LinkSpec[]): Network {
  const outgoing: number[][] = nodes.map(() => [])
  const links = specs.map((spec, id): Link => {
    const cumulative = cumulativeM(spec.geometry)
    const lengthM = cumulative[cumulative.length - 1] ?? 0
    if (!(lengthM > 0)) throw new Error(`link ${id} has no length`)
    if (!(spec.freeSpeedKmh > 0) || !(spec.capacityVph > 0)) {
      throw new Error(`link ${id} needs a positive free speed and capacity`)
    }
    outgoing[spec.from]!.push(id)
    return {
      id,
      from: spec.from,
      to: spec.to,
      geometry: spec.geometry,
      cumulativeM: cumulative,
      lengthM,
      freeSpeedKmh: spec.freeSpeedKmh,
      capacityVph: spec.capacityVph,
    }
  })
  return { nodes, links, outgoing }
}
