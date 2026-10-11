import { LiveSimulation } from '../src/live'
import type { FromWorker, ToWorker } from './protocol'

/*
 * Runs the live simulation off the page's thread, so that routing never stalls the map. The worker holds one
 * simulation at a time: `network` starts one, `reset` drops it.
 */

// The DOM typings make `self` a Window; this worker only needs the message channel, so describe that.
const scope = self as unknown as {
  postMessage(message: FromWorker, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null
}

let sim: LiveSimulation | null = null

scope.onmessage = (event) => {
  const message = event.data
  try {
    switch (message.type) {
      case 'network':
        sim = new LiveSimulation({ network: message.network })
        break
      case 'configure':
        sim?.configure(message.settings)
        break
      case 'tick': {
        if (!sim) break
        sim.advance(message.simDeltaS, message.wallDtS)
        const positions = sim.positions()
        scope.postMessage({ type: 'frame', seq: message.seq, positions, stats: sim.stats() }, [positions.buffer])
        break
      }
      case 'reset':
        sim = null
        break
    }
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
