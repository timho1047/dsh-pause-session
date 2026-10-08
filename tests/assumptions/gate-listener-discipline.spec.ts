/**
 * Premise 4 — the gate listener can be made cancellable and single-shot.
 *
 * The loop awaits the waterfall with no abort race, so a listener that holds a
 * request must race its own gate against the request's phase signal and a
 * plugin-lifetime signal, delegate at most once, and never delegate after an
 * abort. This suite installs exactly that listener over the real loop and
 * checks the discipline from the outside: delegation counts and the requests
 * that reached the provider.
 * @module dsh-safe-stop/test/assumptions/gate-listener-discipline
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { textResponse } from './fake-provider.ts'
import { mountFakeLoop } from './loop-harness.ts'

const ask = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

/** The pause gate as the plugin must shape it: cancellable, single-shot. */
interface ModelRequestGate {
  /** Times the chain was delegated downstream; must never exceed one per request. */
  readonly delegations: () => number
  /** Resolves once a request is held. */
  readonly entered: Promise<void>
  /** Release held requests; idempotent. */
  release(): void
}

/** Resolve when the gate opens or any signal aborts, without leaking listeners. */
function raceGate(gate: Promise<void>, signals: readonly (AbortSignal | undefined)[]): Promise<void> {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  const opened = Promise.withResolvers<void>()
  const onAbort = (): void => { opened.resolve() }
  for (const signal of active) {
    if (signal.aborted) {
      opened.resolve()
      break
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  return Promise.race([gate, opened.promise]).finally(() => {
    for (const signal of active) signal.removeEventListener('abort', onAbort)
  })
}

/**
 * Hold every model request until released. The listener must be a generator:
 * `ctx.waterfall` composes listeners synchronously, so an `async` listener
 * would return a promise where the loop iterates a stream. "Delegate at most
 * once" needs no shared flag — one generator body reaches `yield* next()` at
 * most once — and a flag shared across requests would wrongly swallow every
 * request issued after the release.
 */
function installGate(ctx: Context, lifetime: AbortSignal): ModelRequestGate {
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let count = 0
  ctx.on('llm/stream', (request: GenerateOptions, next: () => AsyncIterable<StreamChunk>) =>
    (async function* held(): AsyncIterable<StreamChunk> {
      entered.resolve()
      await raceGate(gate.promise, [request.signal, lifetime])
      // The race decides when to stop waiting; the signals decide whether
      // delegating is still allowed at this exact moment.
      if (request.signal?.aborted === true) throw request.signal.reason
      if (lifetime.aborted) throw new Error('safe-stop: plugin lifetime ended while a request was held')
      count += 1
      yield* next()
    })())
  return { delegations: () => count, entered: entered.promise, release: () => { gate.resolve() } }
}

const turnEnd = (agent: { session: { snapshotEvents: () => readonly { type: string; data: unknown }[] } }): unknown =>
  agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data

describe('premise 4: the gate listener is cancellable and single-shot', () => {
  it('releases exactly once per held request, and later requests still get through', async () => {
    const { ctx, provider, agent } = await mountFakeLoop('premise-4-release', [
      textResponse('released answer'),
      textResponse('later answer'),
    ])
    try {
      const lifetime = new AbortController()
      const modelGate = installGate(ctx, lifetime.signal)
      agent.followup(ask('hold me'))
      await modelGate.entered
      expect(modelGate.delegations()).toBe(0)

      modelGate.release()
      await agent.whenIdle()
      expect(modelGate.delegations()).toBe(1)
      expect(provider.requests).toHaveLength(1)
      expect(turnEnd(agent)).toEqual({ turn: 1, reason: { kind: 'completed' } })

      // The released gate must not swallow what comes after the wake.
      agent.followup(ask('carry on'))
      await agent.whenIdle()
      expect(modelGate.delegations()).toBe(2)
      expect(provider.requests).toHaveLength(2)
      expect(turnEnd(agent)).toEqual({ turn: 2, reason: { kind: 'completed' } })

      // A repeat release and a late abort add nothing.
      modelGate.release()
      lifetime.abort(new Error('plugin disposed'))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(modelGate.delegations()).toBe(2)
      expect(provider.requests).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('an abort during the hold delegates nothing, and a later release still delegates nothing', async () => {
    const { ctx, provider, agent } = await mountFakeLoop('premise-4-abort', [textResponse('never sent')])
    try {
      const lifetime = new AbortController()
      const modelGate = installGate(ctx, lifetime.signal)
      agent.followup(ask('hold me'))
      await modelGate.entered

      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      expect(modelGate.delegations()).toBe(0)
      expect(provider.requests).toHaveLength(0)
      expect(turnEnd(agent)).toEqual({ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
      expect(agent.status).toBe('idle')

      // The stranded gate now opens: the request is long gone, so nothing may
      // delegate and nothing may reach the provider.
      modelGate.release()
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(modelGate.delegations()).toBe(0)
      expect(provider.requests).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('a plugin-lifetime abort during the hold also delegates nothing', async () => {
    const { ctx, provider, agent } = await mountFakeLoop('premise-4-lifetime', [textResponse('never sent')])
    try {
      const lifetime = new AbortController()
      const modelGate = installGate(ctx, lifetime.signal)
      agent.followup(ask('hold me'))
      await modelGate.entered

      lifetime.abort(new Error('plugin disposed'))
      await agent.whenIdle()
      expect(modelGate.delegations()).toBe(0)
      expect(provider.requests).toHaveLength(0)
      expect(turnEnd(agent)).toMatchObject({
        turn: 1,
        reason: { kind: 'error', error: { code: 'UNKNOWN', message: expect.stringContaining('plugin lifetime ended') } },
      })
      expect(agent.status).toBe('idle')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('control: an async listener that awaits before returning fails at this seam', async () => {
    // Why the generator form is mandatory rather than stylistic.
    const { ctx, provider, agent } = await mountFakeLoop('premise-4-negative', [textResponse('never sent')])
    try {
      ctx.on('llm/stream', async (_request, next) => {
        await Promise.resolve()
        return next()
      })
      agent.followup(ask('hold me'))
      await agent.whenIdle()
      expect(provider.requests).toHaveLength(0)
      expect(turnEnd(agent)).toMatchObject({
        turn: 1,
        reason: { kind: 'error', error: { code: 'UNKNOWN', message: expect.stringMatching(/not async iterable/u) } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
