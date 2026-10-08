/**
 * Host half of dsh-safe-stop.
 *
 * Mounts the pause gate — the per-session hold at the model-request waterfall —
 * the activity fold the park predicate reads, the durable park registry, and
 * the session control the browser half drives. The registry is read before
 * anything is gated, so a session a previous process left parked is held again
 * by this one without any user action; a registry this build cannot read fails
 * the mount loudly rather than silently resuming every session it named.
 * @module dsh-safe-stop
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSessionControl } from './control.js'
import { PauseGate } from './gate.js'
import { mountParkWatch } from './park.js'
import { openParkRegistry } from './registry.js'

/** Plugin name; the Loader row and the bundle patch both use it. */
export const name = 'dsh-safe-stop'

/**
 * Required host services: the model runtime to gate, the stores the control
 * needs, the projection registry the park predicate reads turn state from, and
 * the profile's storage, which holds the pause registry.
 */
export const inject = ['llm', 'commands', 'agents', 'sessions', 'sessionProjections', 'storageDomain']

/**
 * Mount the durable pause registry, the pause gate, the activity fold, and
 * their session control.
 *
 * The registry opens first on purpose: if it cannot be read, nothing else is
 * registered, so a failed mount leaves no half-installed control behind.
 * @param ctx - the plugin's host context.
 */
export async function apply(ctx: Context): Promise<void> {
  const registry = await openParkRegistry(ctx)
  const lifetime = new AbortController()
  // The gate races this signal, so unloading releases every held request
  // instead of stranding a generator no one can reach again.
  ctx.effect(() => () => { lifetime.abort(new Error('safe-stop: plugin unloaded')) }, 'safe-stop: lifetime')
  const gate = new PauseGate({ lifetime: lifetime.signal })
  ctx.effect(
    () => ctx.on('llm/stream', (request, next) => gate.stream(request, next)),
    'safe-stop: pause gate',
  )
  const control = installSessionControl(ctx, gate, mountParkWatch(ctx), registry)
  await control.adopt()
}
