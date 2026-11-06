/**
 * Task 03 acceptance at the model-request seam: a paused session issues no
 * further model request, the request it sends after the resume is the one that
 * was built before the pause, a tool call already running is never interrupted,
 * background work in the same session is never frozen, and every release path
 * (resume, request abort, plugin unload) delegates at most once.
 *
 * Every spec drives the plugin through the same host entry point the browser
 * half uses — the mounted `ctx.pauseSession` Remote actions.
 * @module dsh-pause-session/test/gate/pause-gate
 */

import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { textResponse } from '../assumptions/fake-provider.ts'
import { control, mountGatedLoop, turnEnd, until } from './loop.ts'

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

/** One hand-built background model call in a session's own scope. */
function backgroundCall(
  sessionId: SessionId,
  purpose: NonNullable<GenerateOptions['purpose']>,
): GenerateOptions {
  return { provider: 'fake', model: 'fake', messages: [], sessionId, purpose }
}

/** Collect a stream to its chunks. */
async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('pause gate: a paused session issues no model request', () => {
  it('holds the built request and sends that very request once resumed', async () => {
    const loop = await mountGatedLoop('gate-hold', [
      textResponse('first answer'),
      textResponse('second answer'),
      textResponse('third answer'),
    ])
    const { ctx, provider, agent } = loop
    try {
      agent.followup(ask('first'))
      await agent.whenIdle()
      expect(provider.requests).toHaveLength(1)

      await control(ctx, agent, 'pause')
      agent.followup(ask('second'))
      await loop.requestSeen(2)
      // The loop is parked inside a real turn with the request already built.
      expect(agent.status).toBe('running')
      expect(provider.requests).toHaveLength(1)

      await control(ctx, agent, 'pause-resume')
      await agent.whenIdle()
      expect(provider.requests).toHaveLength(2)
      // Criterion: the request sent after the pause IS the one built before it.
      expect(provider.requests[1]).toBe(loop.seen[1])
      expect(turnEnd(agent)).toEqual({ turn: 2, reason: { kind: 'completed' } })

      // Criterion: the release is per held request, so later requests still flow.
      agent.followup(ask('third'))
      await agent.whenIdle()
      expect(provider.requests).toHaveLength(3)
      expect(provider.requests[2]).toBe(loop.seen[2])
      expect(turnEnd(agent)).toEqual({ turn: 3, reason: { kind: 'completed' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('arms no timer while a request is held', async () => {
    const loop = await mountGatedLoop('gate-timers', [textResponse('held answer')], { idleTimeoutMs: 100 })
    const { ctx, provider, agent } = loop
    try {
      await control(ctx, agent, 'pause')
      vi.useFakeTimers()
      let timersWhileHeld: number
      try {
        expect(vi.getTimerCount()).toBe(0)
        agent.followup(ask('park me'))
        await loop.requestSeen(1)
        expect(agent.status).toBe('running')
        // Five windows of the 100ms stream-idle watchdog would have fired here.
        await vi.advanceTimersByTimeAsync(500)
        timersWhileHeld = vi.getTimerCount()
      } finally {
        vi.useRealTimers()
      }
      expect(timersWhileHeld).toBe(0)
      expect(provider.requests).toHaveLength(0)

      await control(ctx, agent, 'pause-resume')
      await agent.whenIdle()
      expect(provider.requests).toHaveLength(1)
      expect(turnEnd(agent)).toEqual({ turn: 1, reason: { kind: 'completed' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lets a tool call that already started finish before holding the next request', async () => {
    const loop = await mountGatedLoop('gate-tool', [
      toolCallResponse('call-1', 'gated', { id: '1' }),
      textResponse('after the tool'),
    ])
    const { ctx, provider, agent } = loop
    let release: () => void = () => {}
    const releaseTool = (): void => { release() }
    let started = false
    let completed = false
    let abortedWhenDone = true
    ctx.tools.register(defineContentToolFixture({
      name: 'gated',
      description: 'blocks until the spec releases it',
      parameters: { id: { type: 'string', required: true } },
      async execute(_args, exec) {
        started = true
        await new Promise<void>((resolve) => { release = resolve })
        abortedWhenDone = exec.signal.aborted
        completed = true
        return [{ type: 'text', text: 'tool done' }]
      },
    }))
    try {
      agent.followup(ask('run the tool'))
      await until(() => started)
      // Paused mid-tool: the pause lands at the NEXT model boundary only.
      await control(ctx, agent, 'pause')
      releaseTool()
      await until(() => completed)
      expect(abortedWhenDone).toBe(false)
      const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      expect(results).toHaveLength(1)
      expect(JSON.stringify(results[0]?.data)).toContain('tool done')

      // The follow-up request of that same turn is now held.
      await loop.requestSeen(2)
      expect(provider.requests).toHaveLength(1)

      await control(ctx, agent, 'pause-resume')
      await agent.whenIdle()
      expect(provider.requests).toHaveLength(2)
      expect(provider.requests[1]).toBe(loop.seen[1])
      expect(turnEnd(agent)).toMatchObject({ turn: 1, reason: { kind: 'completed' } })
    } finally {
      releaseTool()
      await ctx.fiber.dispose()
    }
  })

  it("never holds the same session's compaction or session-title request", async () => {
    const loop = await mountGatedLoop('gate-purpose', [
      textResponse('summary'),
      textResponse('title'),
      textResponse('loop answer'),
    ])
    const { ctx, provider, agent } = loop
    try {
      await control(ctx, agent, 'pause')
      agent.followup(ask('hold the loop request only'))
      await loop.requestSeen(1)
      expect(provider.requests).toHaveLength(0)

      const compaction = await drain(ctx.llm.stream(backgroundCall(agent.id, 'compaction')))
      const title = await drain(ctx.llm.stream(backgroundCall(agent.id, 'session-title')))
      expect(compaction.some(chunk => chunk.type === 'finish')).toBe(true)
      expect(title.some(chunk => chunk.type === 'finish')).toBe(true)
      expect(provider.requests.map(request => request.purpose)).toEqual(['compaction', 'session-title'])

      await control(ctx, agent, 'pause-resume')
      await agent.whenIdle()
      expect(provider.requests).toHaveLength(3)
      // The loop's request — held, and recorded first — is the last to arrive.
      expect(provider.requests[2]).toBe(loop.seen[0])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('releases a held request on abort and never delegates it afterwards', async () => {
    const loop = await mountGatedLoop('gate-abort', [textResponse('never sent')])
    const { ctx, provider, agent } = loop
    try {
      await control(ctx, agent, 'pause')
      agent.followup(ask('hold me'))
      await loop.requestSeen(1)
      expect(provider.requests).toHaveLength(0)

      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      expect(provider.requests).toHaveLength(0)
      expect(turnEnd(agent)).toEqual({ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
      expect(agent.status).toBe('idle')

      // The stranded pause now opens: the request is long gone.
      await control(ctx, agent, 'pause-resume')
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(provider.requests).toHaveLength(0)
      expect(loop.seen).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('releases a held request when the plugin unloads', async () => {
    const loop = await mountGatedLoop('gate-unload', [textResponse('never sent')])
    const { ctx, provider, agent, plugin } = loop
    try {
      await control(ctx, agent, 'pause')
      agent.followup(ask('hold me'))
      await loop.requestSeen(1)

      await plugin.dispose()
      await agent.whenIdle()
      expect(provider.requests).toHaveLength(0)
      expect(turnEnd(agent)).toMatchObject({
        turn: 1,
        reason: {
          kind: 'error',
          error: { message: expect.stringContaining('plugin lifetime ended') },
        },
      })
      expect(agent.status).toBe('idle')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
