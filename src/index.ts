/**
 * Host half of dsh-safe-stop.
 *
 * Mounts the pause gate — the per-session hold at the model-request waterfall —
 * the activity fold the park predicate reads, and the session control the
 * browser half drives. Pause state is in-memory for now: the durable park
 * registry is a later task, and nothing here survives the process.
 * @module dsh-safe-stop
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSessionControl } from './control.js'
import { PauseGate } from './gate.js'
import { mountParkWatch } from './park.js'

/** Plugin name; the Loader row and the bundle patch both use it. */
export const name = 'dsh-safe-stop'

/**
 * Required host services: the model runtime to gate, the stores the control
 * needs, and the projection registry the park predicate reads turn state from.
 */
export const inject = ['llm', 'commands', 'agents', 'sessions', 'sessionProjections']

/** Mount the pause gate, the activity fold, and their session control. */
export function apply(ctx: Context): void {
  const lifetime = new AbortController()
  // The gate races this signal, so unloading releases every held request
  // instead of stranding a generator no one can reach again.
  ctx.effect(() => () => { lifetime.abort(new Error('safe-stop: plugin unloaded')) }, 'safe-stop: lifetime')
  const gate = new PauseGate({ lifetime: lifetime.signal })
  ctx.effect(
    () => ctx.on('llm/stream', (request, next) => gate.stream(request, next)),
    'safe-stop: pause gate',
  )
  installSessionControl(ctx, gate, mountParkWatch(ctx))
}
