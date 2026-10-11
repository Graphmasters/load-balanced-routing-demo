import type { LiveSettings, LiveStats } from '../src/live'
import type { Network } from '../src/network'

/*
 * Messages between the page and the simulation worker. The page sends one tick per animation frame and waits for its
 * frame before sending the next, so the worker never has a backlog.
 */

export type ToWorker =
  /** Starts a simulation on a network. Sent once per lock. */
  | { readonly type: 'network'; readonly network: Network }
  | { readonly type: 'configure'; readonly settings: Partial<LiveSettings> }
  /** Advances the simulation by `simDeltaS` simulated seconds; `wallDtS` is the wall time since the last tick. */
  | { readonly type: 'tick'; readonly seq: number; readonly simDeltaS: number; readonly wallDtS: number }
  /** Drops the simulation and its network (unlock). */
  | { readonly type: 'reset' }

export type FromWorker =
  | { readonly type: 'frame'; readonly seq: number; readonly positions: Float32Array; readonly stats: LiveStats }
  | { readonly type: 'error'; readonly message: string }
