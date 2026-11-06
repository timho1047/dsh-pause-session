/**
 * Mounting for the gate specs.
 *
 * The spike's harness (`tests/assumptions/loop-harness.ts` + its scripted fake
 * provider) is reused as-is; this module only adds what a gate spec needs on
 * top — the real command registry the browser half calls, the storage the
 * plugin's park registry opens through (it cannot mount without it), and a
 * recorder upstream of the gate that captures the request the loop built.
 * Listeners are registered before the plugin, so the recorder sits closer to
 * the loop than the gate does.
 * @module dsh-pause-session/test/gate/loop
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply, inject, name } from '../../src/index.ts'
import { ensureOk, press } from '../native-driver.ts'
import type { PauseVerb } from '../native-driver.ts'
import type { ScriptEntry } from '../assumptions/fake-provider.ts'
import { mountFakeLoop } from '../assumptions/loop-harness.ts'
import type { FakeLoop } from '../assumptions/loop-harness.ts'
import { mountHeldParkStorage } from '../registry/held.ts'
import type { HeldWrites } from '../registry/held.ts'
import { mountParkStorage } from '../registry/storage.ts'

/** The spike's loop plus the plugin under test and the registry it drives. */
export interface GatedLoop extends FakeLoop {
  /** Every request the loop handed to the waterfall, in order. */
  readonly seen: GenerateOptions[]
  /** Resolves once `count` requests have reached the waterfall; needs no timer, so fake timers stay usable. */
  requestSeen(count: number): Promise<void>
  /** The plugin's own fiber, so a spec can unload exactly it. */
  readonly plugin: { dispose(): Promise<void> }
  /** Directory this loop's durable park registry lives in. */
  readonly storageRoot: string
  /** The registry's write queue, when the spec asked to hold writes open. */
  readonly held?: HeldWrites
}

/** Mount the loop, the storage the plugin needs, and the plugin under test. */
export async function mountGatedLoop(
  id: string,
  script: ScriptEntry[],
  options: { idleTimeoutMs?: number; heldWrites?: boolean } = {},
): Promise<GatedLoop> {
  const loop = await mountFakeLoop(id, script, options)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-pause-session-loop-'))
  loop.ctx.effect(() => () => rmSync(storageRoot, { recursive: true, force: true }), 'spec: registry root')
  const held = options.heldWrites === true ? await mountHeldParkStorage(loop.ctx, storageRoot) : undefined
  if (held === undefined) await mountParkStorage(loop.ctx, storageRoot)
  const seen: GenerateOptions[] = []
  const waiters = new Map<number, () => void>()
  // Upstream of the gate: the request is recorded when the loop builds it, not
  // when the gate releases it.
  loop.ctx.on('llm/stream', (request, next) => {
    seen.push(request)
    waiters.get(seen.length)?.()
    return next()
  })
  const plugin = await loop.ctx.plugin({ name, inject, apply })
  return {
    ...loop,
    seen,
    plugin,
    storageRoot,
    ...held === undefined ? {} : { held },
    requestSeen: async (count: number) => {
      if (seen.length >= count) return
      await new Promise<void>((resolve) => { waiters.set(count, resolve) })
    },
  }
}

/** Press one native action the way the browser half does. */
export async function control(ctx: Context, agent: Agent, verb: PauseVerb): Promise<void> {
  ensureOk(await press(ctx, agent, verb, new AbortController().signal), verb)
}

/** Poll until `predicate` holds, letting microtasks drain between checks. */
export async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 0))
  if (!predicate()) throw new Error('until: condition never held')
}

/** The last turn ending recorded on the session, if any. */
export function turnEnd(agent: { session: { snapshotEvents: () => readonly { type: string; data: unknown }[] } }): unknown {
  return agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data
}
