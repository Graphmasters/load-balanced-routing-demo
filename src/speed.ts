import type { Link, Network } from './network'

/**
 * How the speed of a link follows the vehicles that entered it. The speed of a link in one time slot is the BPR curve
 * (Bureau of Public Roads) applied to the flow of the previous slot: the vehicles that entered the link in that slot,
 * scaled to vehicles per hour, over the link's capacity.
 */
export interface SpeedModel {
  /** Length of a time slot in seconds. */
  readonly slotSeconds: number
  /** BPR alpha: how strongly a full link slows down. */
  readonly alpha: number
  /** BPR beta: how sharply the slow-down rises with the load. */
  readonly beta: number
  /** Lowest speed in km/h a link can drop to, so a jammed link still lets vehicles through. */
  readonly minKmh: number
  /** Lowest speed as a fraction of the free-flow speed. */
  readonly minFraction: number
}

export const DEFAULT_SPEED_MODEL: SpeedModel = {
  slotSeconds: 10,
  alpha: 0.15,
  beta: 4,
  minKmh: 2,
  minFraction: 0.05,
}

/** Speed in km/h of a link at a flow of `flowVph` vehicles per hour. Never above the free-flow speed. */
export function linkSpeedKmh(
  link: Pick<Link, 'freeSpeedKmh' | 'capacityVph'>,
  flowVph: number,
  model: SpeedModel,
): number {
  const load = flowVph / link.capacityVph
  const congested = link.freeSpeedKmh / (1 + model.alpha * load ** model.beta)
  const floor = Math.min(link.freeSpeedKmh, Math.max(model.minKmh, model.minFraction * link.freeSpeedKmh))
  return Math.max(congested, floor)
}

/**
 * The speed of every link in the next slot, in km/h, given how many vehicles entered each link in the slot before
 * (`enteredBefore`, undefined before the first slot). Writes into `out` when given.
 */
export function speedsKmh(
  network: Network,
  enteredBefore: Uint32Array | undefined,
  model: SpeedModel,
  out: Float64Array = new Float64Array(network.links.length),
): Float64Array {
  const perHour = 3600 / model.slotSeconds
  const links = network.links
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!
    const entered = enteredBefore ? enteredBefore[i]! : 0
    out[i] = entered === 0 ? link.freeSpeedKmh : linkSpeedKmh(link, entered * perHour, model)
  }
  return out
}
