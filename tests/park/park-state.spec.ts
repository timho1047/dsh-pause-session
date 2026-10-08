/**
 * Task 04 acceptance at the seam the browser uses: after a pause press the
 * control reports what the session is doing, says "safe to close" only once the
 * session is parked AND the session-level flush has resolved, and can be taken
 * back at any point before that.
 *
 * Every spec drives the plugin through the same host entry points the browser
 * half uses — `ctx.commands.execute` on the real registry, plus `commands.list`
 * to see what the host published.
 * @module dsh-safe-stop/test/park/park-state
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import {
  decodeParkStatus, PAUSE_COMMAND, RESUME_COMMAND, RESUME_DEFINITION_ID, STATUS_COMMAND,
  STATUS_DEFINITION_ID,
} from '../../src/shared.ts'
import type { ParkStatus } from '../../src/shared.ts'
import { textResponse } from '../assumptions/fake-provider.ts'
import { control, mountGatedLoop, until } from '../gate/loop.ts'
import type { GatedLoop } from '../gate/loop.ts'

const ask = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

/** One assistant response carrying a single tool call. */
function toolCallResponse(id: string, name: string, args: object): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) },
    },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * What the host published about one session, read the way the browser reads it:
 * the resume definition's presence is the pause, and the companion status
 * command answers with the park state as of this read.
 */
async function published(ctx: Context, agent: Agent): Promise<ParkStatus | undefined> {
  const listed = ctx.commands.list(agent)
  if (!listed.some(descriptor => descriptor.definitionId === RESUME_DEFINITION_ID)) return undefined
  const execution = await ctx.commands.execute(agent, `/${STATUS_COMMAND}`, [], new AbortController().signal)
  if (execution === undefined) throw new Error('safe-stop: the status command is not registered')
  if (execution.result.kind !== 'success') throw new Error(`safe-stop: status read failed: ${execution.result.text}`)
  const text = execution.result.text
  const decoded = text === undefined ? undefined : decodeParkStatus(text)
  if (decoded === undefined) throw new Error(`safe-stop: status read answered in an unknown vocabulary: ${String(text)}`)
  return decoded
}

/**
 * Wait for a predicate that is only true once a moving part settles. Written
 * out rather than `vi.waitFor`: that helper does not await an async predicate,
 * so it would pass without ever looking at the answer.
 */
async function settles(predicate: () => boolean, describe: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`safe-stop: never settled: ${describe}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The status descriptor the browser would see, if any. */
function statusDescriptor(ctx: Context, agent: Agent): { definitionId?: string } | undefined {
  return ctx.commands.list(agent).find(descriptor => descriptor.definitionId === STATUS_DEFINITION_ID)
}

/** Wait for one exact published phase, re-reading it as we go. */
async function phaseBecomes(ctx: Context, agent: Agent, wanted: ParkStatus['phase']): Promise<void> {
  let seen: string | undefined
  await settles(() => {
    void published(ctx, agent).then(status => { seen = status?.phase })
    return seen === wanted
  }, `phase ${wanted} (last seen: ${String(seen)})`)
}

/** A tool that blocks until the spec releases it, so "in flight" is a controlled fact. */
function blockingTool(): { tool: ReturnType<typeof defineContentToolFixture>; started: () => boolean; release: () => void } {
  let release: () => void = () => {}
  let started = false
  const tool = defineContentToolFixture({
    name: 'gated',
    description: 'blocks until the spec releases it',
    parameters: { id: { type: 'string', required: true } },
    async execute() {
      started = true
      await new Promise<void>((resolve) => { release = resolve })
      return [{ type: 'text', text: 'tool done' }]
    },
  })
  return { tool, started: () => started, release: () => { release() } }
}

/** A durability peer that holds every checkpoint open until the spec lets go. */
function heldFlush(ctx: Context): { calls: () => number; release: () => void } {
  let release: () => void = () => {}
  let calls = 0
  const flushing = new Promise<void>((resolve) => { release = resolve })
  ctx.effect(() => ctx.on('session/flush', async () => {
    calls += 1
    await flushing
  }), 'spec: slow flush')
  return { calls: () => calls, release }
}

/**
 * The live session behind an agent. A spec that installs a flush peer must take
 * one: `ctx.sessions.flush` is the only entry point that reaches it, so holding
 * the peer is what tells us the plugin came through the session level rather
 * than through a handle's own flush.
 */
function liveSession(loop: GatedLoop, agent: Agent): void {
  if (loop.ctx.sessions.get(agent.id) === undefined) {
    throw new Error(`safe-stop: no live session for "${agent.id}"`)
  }
}

describe('park state: what the control reports between the press and the park', () => {
  it('reports the running tool, then parks once its result lands and the next request is held', async () => {
    const loop = await mountGatedLoop('park-tool', [
      toolCallResponse('call-1', 'gated', { id: '1' }),
      textResponse('after the tool'),
    ])
    const { ctx, provider, agent } = loop
    const blocking = blockingTool()
    ctx.tools.register(blocking.tool)
    liveSession(loop, agent)
    const flush = heldFlush(ctx)
    try {
      agent.followup(ask('run the tool'))
      await until(() => blocking.started())

      await control(ctx, agent, PAUSE_COMMAND)
      expect(await published(ctx, agent)).toEqual({ phase: 'draining', safe: false, runningTools: ['gated'] })
      // Only the response that asked for the tool has been sent; the request
      // that follows the tool is not built yet, let alone sent.
      expect(provider.requests).toHaveLength(1)

      // The tool's result lands; the loop builds its next request and stops at
      // the gate. That — and only that — is the park.
      blocking.release()
      await loop.requestSeen(1)
      await until(() => flush.calls() === 1)
      expect(await published(ctx, agent)).toEqual({ phase: 'parking', safe: false, runningTools: [] })
      // Nothing was sent while the session was on its way to the park.
      expect(provider.requests).toHaveLength(1)

      flush.release()
      await phaseBecomes(ctx, agent, 'safe')

      await control(ctx, agent, RESUME_COMMAND)
      await agent.whenIdle()
      expect(provider.requests).toHaveLength(2)
    } finally {
      blocking.release()
      flush.release()
      await ctx.fiber.dispose()
    }
  })

  it('reports safe when the drain ends without another request to hold', async () => {
    const loop = await mountGatedLoop('park-decided', [toolCallResponse('call-1', 'gated', { id: '1' })])
    const { ctx, provider, agent } = loop
    let started = false
    let release: () => void = () => {}
    ctx.tools.register(defineContentToolFixture({
      name: 'gated',
      description: 'blocks until the spec releases it',
      parameters: { id: { type: 'string', required: true } },
      async execute() {
        started = true
        await new Promise<void>((resolve) => { release = resolve })
        return [{ type: 'text', text: 'tool done' }]
      },
    }))
    try {
      agent.followup(ask('run the tool'))
      await until(() => started)
      await control(ctx, agent, PAUSE_COMMAND)
      expect((await published(ctx, agent))?.phase).toBe('draining')

      // The turn is cancelled, so it ends without ever building another
      // request. Nothing is left to hold and the session is standing still — a
      // control waiting for a hold that can never come would claim "draining"
      // forever, which is exactly the lie this predicate exists to avoid.
      release()
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      await phaseBecomes(ctx, agent, 'safe')
      expect(provider.requests).toHaveLength(1)
    } finally {
      release()
      await ctx.fiber.dispose()
    }
  })

  it('parks an idle session with nothing to drain', async () => {
    const loop = await mountGatedLoop('park-idle', [])
    const { ctx, agent } = loop
    liveSession(loop, agent)
    const flush = heldFlush(ctx)
    try {
      // No turn is open, so there is no next request to hold: the press has
      // nothing to wait for, and the only remaining gate is the flush.
      await control(ctx, agent, PAUSE_COMMAND)
      await until(() => flush.calls() === 1)
      expect(await published(ctx, agent)).toEqual({ phase: 'parking', safe: false, runningTools: [] })

      flush.release()
      await phaseBecomes(ctx, agent, 'safe')
    } finally {
      flush.release()
      await ctx.fiber.dispose()
    }
  })

  it('never reports "safe" before the session-level flush resolves', async () => {
    const loop = await mountGatedLoop('park-flush', [])
    const { ctx, agent } = loop
    liveSession(loop, agent)
    const flush = heldFlush(ctx)
    try {
      await control(ctx, agent, PAUSE_COMMAND)
      await until(() => flush.calls() === 1)

      // Parked, and the checkpoint is still open: the durable promise is not
      // kept yet, so neither phase nor `safe` may say otherwise.
      expect(await published(ctx, agent)).toEqual({ phase: 'parking', safe: false, runningTools: [] })
      expect(statusDescriptor(ctx, agent)).toBeDefined()

      flush.release()
      await phaseBecomes(ctx, agent, 'safe')
    } finally {
      flush.release()
      await ctx.fiber.dispose()
    }
  })

  it('reports a failed flush instead of calling the session clean', async () => {
    const loop = await mountGatedLoop('park-flush-failed', [])
    const { ctx, agent } = loop
    liveSession(loop, agent)
    // A durability peer whose checkpoint always fails. A failed flush is the
    // one case where "parked" and "safe to close" must not be the same answer.
    ctx.effect(() => ctx.on('session/flush', () => Promise.reject(new Error('disk full'))), 'spec: failing flush')
    try {
      await control(ctx, agent, PAUSE_COMMAND)
      await phaseBecomes(ctx, agent, 'flush-failed')
      expect(await published(ctx, agent)).toEqual({ phase: 'flush-failed', safe: false, runningTools: [] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('cancels a pause while its tool is still in flight and lets the request through', async () => {
    const loop = await mountGatedLoop('park-cancel', [
      toolCallResponse('call-1', 'gated', { id: '1' }),
      textResponse('after the tool'),
    ])
    const { ctx, provider, agent } = loop
    const blocking = blockingTool()
    ctx.tools.register(blocking.tool)
    try {
      agent.followup(ask('run the tool'))
      await until(() => blocking.started())
      await control(ctx, agent, PAUSE_COMMAND)
      expect((await published(ctx, agent))?.phase).toBe('draining')

      // Pressed again while the tool is still in flight: the pause is taken
      // back, and nothing about the session is left in a stopped state.
      await control(ctx, agent, RESUME_COMMAND)
      expect(await published(ctx, agent)).toBeUndefined()
      expect(ctx.commands.list(agent).map(descriptor => descriptor.name)).not.toContain(RESUME_COMMAND)

      blocking.release()
      await agent.whenIdle()
      // The request that would have been held was issued normally.
      expect(provider.requests).toHaveLength(2)
      expect(agent.status).toBe('idle')
    } finally {
      blocking.release()
      await ctx.fiber.dispose()
    }
  })

  it('cancels a pause whose flush is still settling', async () => {
    const loop = await mountGatedLoop('park-cancel-flush', [])
    const { ctx, agent } = loop
    liveSession(loop, agent)
    const flush = heldFlush(ctx)
    try {
      // An idle session parks at once and starts flushing; the pause is taken
      // back while that checkpoint is still open.
      await control(ctx, agent, PAUSE_COMMAND)
      await until(() => flush.calls() === 1)
      expect((await published(ctx, agent))?.phase).toBe('parking')

      await control(ctx, agent, RESUME_COMMAND)
      expect(await published(ctx, agent)).toBeUndefined()

      // The late completion of that flush must not resurrect the park's
      // published state.
      flush.release()
      await settles(
        () => !ctx.commands.list(agent).some(descriptor => descriptor.definitionId === RESUME_DEFINITION_ID),
        'the late flush must not re-register the park commands',
      )
      expect(await published(ctx, agent)).toBeUndefined()
    } finally {
      flush.release()
      await ctx.fiber.dispose()
    }
  })
})
