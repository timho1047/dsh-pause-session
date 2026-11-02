/**
 * Premise 1 — a wake with no model-visible content is achievable.
 *
 * Half (a) drives the real agent loop over the scripted fake provider: an
 * empty-content follow-up must open a real turn and issue a real request, and
 * that request must carry nothing the previous request did not already carry.
 * Half (b) locates the invisibility: it is decided below the loop, by the
 * route's conversion — the DeepSeek serializer drops the empty user message,
 * the harness's pi-ai conversion keeps it, and the vendored pi-ai library then
 * decides per provider API. So it is never a loop guarantee.
 * @module dsh-pause/test/assumptions/empty-wake-content
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { serialize } from '@deepseek-ai/dsh-llm-deepseek/src/serialize.ts'
import { toPiContext } from '@deepseek-ai/dsh-llm-pi-ai/src/context.ts'
import { textResponse } from './fake-provider.ts'
import { mountFakeLoop } from './loop-harness.ts'

const connection = resolveAdapterOptions({})
const emptyFollowup = () => createUserMessage({ content: [], source: { kind: 'user' } })

/**
 * Import one module from the vendored pi-ai library the harness's pi-ai route
 * drives. The library is a dependency of `@deepseek-ai/dsh-llm-pi-ai`, not of
 * this repository, so it is reached through that package's own resolution.
 */
async function piAiModule<T>(path: string): Promise<T> {
  const require = createRequire(import.meta.url)
  const packageRoot = dirname(require.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json'))
  return await import(pathToFileURL(join(packageRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist', path)).href) as T
}

/** One pi-ai transcript carrying a text turn, an answer, and an empty wake. */
const piTranscript = {
  messages: [
    { role: 'user', content: 'hello', timestamp: 0 },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      timestamp: 0,
      stopReason: 'stop',
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'model',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    },
    { role: 'user', content: '', timestamp: 0 },
  ],
}

/**
 * Drive two turns: one carrying text, then one carrying an empty-content
 * follow-up. Returns the request the loop built for each turn.
 */
async function twoTurns(id: string): Promise<{ first: GenerateOptions; second: GenerateOptions }> {
  const { ctx, provider, agent } = await mountFakeLoop(id, [textResponse('first answer'), textResponse('second answer')])
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(provider.requests).toHaveLength(1)
    const first = provider.requests[0]!
    agent.followup(emptyFollowup())
    await agent.whenIdle()
    return { first, second: provider.requests[1]! }
  } finally {
    await ctx.fiber.dispose()
  }
}

let first!: GenerateOptions
let second!: GenerateOptions

beforeAll(async () => {
  ({ first, second } = await twoTurns('premise-1-loop'))
})

describe('premise 1a: an empty-content follow-up opens a real turn', () => {
  it('issues a second model request whose only addition is the previous answer', async () => {
    const { ctx, provider, agent } = await mountFakeLoop('premise-1-turn', [
      textResponse('first answer'),
      textResponse('second answer'),
    ])
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      agent.followup(emptyFollowup())
      await agent.whenIdle()

      // The wake really opened a turn: step/start for turn 2 exists and the
      // provider was reached a second time.
      expect(provider.requests).toHaveLength(2)
      const events = agent.session.snapshotEvents()
      expect(events.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
      expect(events.filter(event => event.type === 'step/start').map(event => [event.data.turn, event.data.step]))
        .toEqual([[1, 1], [2, 1]])
      // The empty message reached the loop's request…
      const empties = provider.requests[1]!.messages.filter(message => message.role === 'user' && message.content.length === 0)
      expect(empties).toHaveLength(1)
      // …and became a durable user/message on the session surface, so the
      // session's own pending-input record is intact for the next wake.
      const logged = events.filter(event => event.type === 'user/message')
      expect(logged).toHaveLength(2)
      expect(logged[1]!.data.content).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('control: a follow-up whose claimed batch is emptied no-ops without a model call', async () => {
    // The reason the wake must carry an (empty-content) message at all: step 0
    // with an empty claimed batch owns the turn boundary but spends no request.
    const { ctx, provider, agent } = await mountFakeLoop('premise-1-control', [])
    try {
      let seen = 0
      ctx.on('agent/pre-step', async (_payload, next) => {
        seen += 1
        const decision = await next()
        return decision.kind === 'enter' ? { kind: 'enter' as const, messages: [] } : decision
      })
      agent.followup(emptyFollowup())
      await agent.whenIdle()
      expect(seen).toBe(1)
      expect(provider.requests).toHaveLength(0)
      const events = agent.session.snapshotEvents()
      expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
      expect(events.filter(event => event.type === 'step/start')).toHaveLength(0)
      expect(events.findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'completed' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('premise 1b: the invisibility is the adapter, not the loop', () => {
  it('DeepSeek serialization drops the empty user message', () => {
    const wireFirst = serialize(first, connection, first.messages, new Map(), () => undefined)
    const wireSecond = serialize(second, connection, second.messages, new Map(), () => undefined)
    // Nothing was added for the empty follow-up: the second wire request is the
    // first one plus the answer the model produced in between.
    expect(wireSecond.messages).toEqual([
      ...wireFirst.messages,
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    ])
    // The dropped message is in the loop request, not missing from the session.
    expect(second.messages.some(message => message.role === 'user' && message.content.length === 0)).toBe(true)
  })

  it('pi-ai conversion keeps the same empty user message', () => {
    const pi = toPiContext(second)
    // Two user turns survive: the one carrying text and the empty wake.
    expect(pi.messages.filter(message => message.role === 'user')).toHaveLength(2)
    expect(pi.messages).toContainEqual({ role: 'user', content: '', timestamp: 0 })
  })

  it('pi-ai over openai-completions sends the empty user turn on the wire', async () => {
    const { convertMessages } = await piAiModule<{
      convertMessages: (model: object, context: object, compat: object) => { role: string; content: unknown }[]
    }>('api/openai-completions.js')
    const messages = convertMessages(
      { id: 'model', provider: 'test', api: 'openai-completions', reasoning: false, input: ['text'] },
      piTranscript,
      {},
    )
    expect(messages).toContainEqual({ role: 'user', content: '' })
  })

  it('pi-ai over anthropic-messages drops it before the wire request', async () => {
    // The same library, a different provider API: the empty turn is dropped.
    // Which of the two a pi-ai route reaches is deployment config, so no pi-ai
    // route may be trusted for zero visibility without checking its API.
    const { streamSimple } = await piAiModule<{
      streamSimple: (model: object, context: object, options: object) => AsyncIterable<unknown>
    }>('api/anthropic-messages.js')
    const bodies: { messages: unknown }[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: unknown })
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    try {
      const stream = streamSimple(
        {
          id: 'model',
          provider: 'anthropic',
          api: 'anthropic-messages',
          reasoning: false,
          input: ['text'],
          baseUrl: 'https://provider.invalid',
        },
        piTranscript,
        { apiKey: 'keyless-probe' },
      )
      for await (const _event of stream) { /* drain the canned stream */ }
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ])
  })
})
