/**
 * Premise 2 — holding the model-request waterfall arms no timer and releases
 * cleanly.
 *
 * The hold is a real `llm/stream` waterfall listener that awaits a gate before
 * calling `next()`, driven over the real agent loop. Timers are observed with
 * fake timers, and the contrast case uses the harness's own `idleWatchdog` —
 * the timer both shipped adapters arm around an outstanding provider pull — to
 * show that the only timer in play appears with the pull, never with the hold.
 * @module dsh-safe-stop/test/assumptions/held-request-timers
 */

import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { textResponse } from './fake-provider.ts'
import { mountFakeLoop } from './loop-harness.ts'

const ask = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

/** A one-shot release handle for the waterfall gate. */
function gate(): { opened: Promise<void>; open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { opened: promise, open: resolve }
}

describe('premise 2: a held model request arms no timer and releases cleanly', () => {
  it('starts no timer while held, and the session completes normally once released', async () => {
    const { ctx, provider, agent } = await mountFakeLoop('premise-2-held', [textResponse('held answer')], { idleTimeoutMs: 100 })
    try {
      const entered = Promise.withResolvers<void>()
      const release = gate()
      let delegations = 0
      ctx.on('llm/stream', (_options, next) => (async function* held(): AsyncIterable<never> {
        entered.resolve()
        await release.opened
        delegations += 1
        yield* next()
      })())

      vi.useFakeTimers()
      let timersWhileHeld: number
      try {
        expect(vi.getTimerCount()).toBe(0)
        agent.followup(ask('park me'))
        await entered.promise
        // The loop is parked inside a real turn, with the request built and
        // handed to the waterfall, and the adapter has not been reached.
        expect(agent.status).toBe('running')
        expect(delegations).toBe(0)
        expect(provider.requests).toHaveLength(0)
        // Five windows of a 100ms idle watchdog would have fired by now.
        await vi.advanceTimersByTimeAsync(500)
        timersWhileHeld = vi.getTimerCount()
      } finally {
        vi.useRealTimers()
      }

      expect(timersWhileHeld).toBe(0)
      expect(provider.requests).toHaveLength(0)
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(false)

      // Release: the same request reaches the adapter and the turn completes.
      release.open()
      await agent.whenIdle()
      expect(delegations).toBe(1)
      expect(provider.requests).toHaveLength(1)
      expect(agent.status).toBe('idle')
      const logged = agent.session.snapshotEvents()
      expect(logged.findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'completed' })
      const answer = logged.filter(event => event.type === 'assistant/message').at(-1)
      expect(answer?.data.message.content).toEqual([{ type: 'text', text: 'held answer' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('contrast: the idle watchdog timer exists, and only while a pull is outstanding', async () => {
    // 100ms watchdog, a provider that stalls on its first pull: the timer is
    // observable exactly while the adapter is being pulled.
    const { ctx, provider, agent } = await mountFakeLoop('premise-2-watchdog', ['hang'], { idleTimeoutMs: 100 })
    try {
      vi.useFakeTimers()
      try {
        agent.followup(ask('stall the provider'))
        for (let tick = 0; tick < 50 && provider.pulls === 0; tick += 1) {
          await vi.advanceTimersByTimeAsync(0)
        }
        expect(provider.requests).toHaveLength(1)
        expect(provider.pulls).toBe(1)
        // Exactly one timer: the watchdog guarding the outstanding pull.
        expect(vi.getTimerCount()).toBe(1)

        await vi.advanceTimersByTimeAsync(100)
        expect(vi.getTimerCount()).toBe(0)
        await agent.whenIdle()
        const reason = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason
        expect(reason).toMatchObject({ kind: 'error', error: { code: 'TIMEOUT' } })
      } finally {
        vi.useRealTimers()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
