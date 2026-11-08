/**
 * The native surface the browser half reads and calls: one `pauseSession`
 * service whose snapshot names exactly the held sessions, whose `act` toggles
 * them, and whose lifetime is the plugin's own. There is no slash-command
 * registry in this contract.
 * @module dsh-pause-session/test/gate/control-surface
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { act, pause, pauseRemote, resume, snapshot, statusOf } from '../native-driver.ts'
import { textResponse } from '../assumptions/fake-provider.ts'
import { mountGatedLoop, turnEnd } from './loop.ts'

describe('the native session control surface', () => {
  it('names a session in the snapshot only while it is paused', async () => {
    const loop = await mountGatedLoop('control-marker', [])
    const { ctx, agent } = loop
    try {
      expect(Object.keys((await snapshot(ctx)).sessions)).toEqual([])

      await pause(ctx, agent)
      expect(await statusOf(ctx, agent)).toMatchObject({ phase: 'draining' })

      await resume(ctx, agent)
      expect(await statusOf(ctx, agent)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('scopes one session\'s entry to its own session, so two paused sessions coexist', async () => {
    const loop = await mountGatedLoop('control-first', [])
    const { ctx, agent } = loop
    const second = await ctx.agentLoop.create(SessionId('control-second'), { provider: 'fake', model: 'fake' })
    try {
      await pause(ctx, agent)
      await pause(ctx, second)
      expect(await statusOf(ctx, agent)).toBeDefined()
      expect(await statusOf(ctx, second)).toBeDefined()

      // Resuming one session leaves the other's entry alone.
      await resume(ctx, agent)
      expect(await statusOf(ctx, agent)).toBeUndefined()
      expect(await statusOf(ctx, second)).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('shows a paused session again when it gets a new agent', async () => {
    const loop = await mountGatedLoop('control-revive', [])
    const { ctx } = loop
    const sessionId = SessionId('control-revive-target')
    try {
      const first = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fake', model: 'fake' } })
      await pause(ctx, first.agent)
      expect(await statusOf(ctx, first.agent)).toBeDefined()

      // Agent disposal does not take the durable park with it.
      await first.dispose()

      const revived = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fake', model: 'fake' } })
      expect(await statusOf(ctx, revived.agent)).toBeDefined()
      await resume(ctx, revived.agent)
      expect(await statusOf(ctx, revived.agent)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('removes the whole native surface when the plugin unloads', async () => {
    const loop = await mountGatedLoop('control-unload', [])
    const { ctx, agent, plugin } = loop
    try {
      await pause(ctx, agent)
      expect(await statusOf(ctx, agent)).toBeDefined()

      await plugin.dispose()
      expect(ctx.get('pauseSession'), 'the unloaded plugin left its service behind').toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resumes a parked session through the native action alone', async () => {
    const loop = await mountGatedLoop('control-resume', [textResponse('resumed answer')])
    const { ctx, provider, agent } = loop
    try {
      await pause(ctx, agent)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'through the action' }], source: { kind: 'user' } }))
      await loop.requestSeen(1)
      expect(provider.requests).toHaveLength(0)

      await resume(ctx, agent)
      await agent.whenIdle()
      expect(provider.requests).toHaveLength(1)
      expect(turnEnd(agent)).toEqual({ turn: 1, reason: { kind: 'completed' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('cancels a press that is still draining through the global action', async () => {
    const loop = await mountGatedLoop('control-cancel-all', [])
    const { ctx, agent } = loop
    try {
      await pause(ctx, agent)
      expect(await statusOf(ctx, agent)).toBeDefined()
      const answer = await act(ctx, 'cancel-all', agent)
      expect(answer.ok, answer.message).toBe(true)
      expect(await statusOf(ctx, agent)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not expose a command registry as an alternate action channel', async () => {
    const loop = await mountGatedLoop('control-native-only', [])
    const { ctx, agent } = loop
    try {
      expect(pauseRemote(ctx)).toBeDefined()
      // The plugin's inject list no longer declares `commands`; a context that
      // never mounted the command runtime is a valid host.
      expect(ctx.get('commands'), 'the command registry appeared without being mounted').toBeUndefined()
      await pause(ctx, agent)
      expect(await statusOf(ctx, agent)).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
