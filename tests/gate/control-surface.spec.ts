/**
 * The host surface the browser half reads and calls: a global pause verb plus,
 * for exactly the paused sessions, a resume definition registered on that
 * session's own agent scope. Both are asserted through the real command
 * registry — the same `list`/`execute` calls `ctx.remote.commands` exposes to
 * the Client.
 * @module dsh-pause-session/test/gate/control-surface
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PAUSE_COMMAND, PAUSE_DEFINITION_ID, RESUME_COMMAND, RESUME_DEFINITION_ID } from '../../src/shared.ts'
import { textResponse } from '../assumptions/fake-provider.ts'
import { control, mountGatedLoop, turnEnd } from './loop.ts'

/** The definition ids one agent's effective command view carries. */
function definitionIds(views: readonly { definitionId?: string }[]): (string | undefined)[] {
  return views.map(descriptor => descriptor.definitionId)
}

describe('session control surface', () => {
  it('exposes the pause verb globally and the resume marker only while paused', async () => {
    const loop = await mountGatedLoop('control-marker', [])
    const { ctx, agent } = loop
    try {
      expect(definitionIds(ctx.commands.list(agent))).toContain(PAUSE_DEFINITION_ID)
      expect(definitionIds(ctx.commands.list(agent))).not.toContain(RESUME_DEFINITION_ID)

      await control(ctx, agent, PAUSE_COMMAND)
      const paused = ctx.commands.list(agent)
      expect(definitionIds(paused)).toEqual(expect.arrayContaining([PAUSE_DEFINITION_ID, RESUME_DEFINITION_ID]))
      const marker = paused.find(descriptor => descriptor.definitionId === RESUME_DEFINITION_ID)
      expect(marker?.name).toBe(RESUME_COMMAND)

      await control(ctx, agent, RESUME_COMMAND)
      expect(definitionIds(ctx.commands.list(agent))).not.toContain(RESUME_DEFINITION_ID)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('scopes the marker to its own session, so two paused sessions coexist', async () => {
    const loop = await mountGatedLoop('control-first', [])
    const { ctx, agent } = loop
    const second = await ctx.agentLoop.create(SessionId('control-second'), { provider: 'fake', model: 'fake' })
    try {
      await control(ctx, agent, PAUSE_COMMAND)
      await control(ctx, second, PAUSE_COMMAND)
      expect(definitionIds(ctx.commands.list(agent))).toContain(RESUME_DEFINITION_ID)
      expect(definitionIds(ctx.commands.list(second))).toContain(RESUME_DEFINITION_ID)

      // Resuming one session leaves the other's marker alone.
      await control(ctx, agent, RESUME_COMMAND)
      expect(definitionIds(ctx.commands.list(agent))).not.toContain(RESUME_DEFINITION_ID)
      expect(definitionIds(ctx.commands.list(second))).toContain(RESUME_DEFINITION_ID)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restores the marker when a paused session gets a new agent', async () => {
    const loop = await mountGatedLoop('control-revive', [])
    const { ctx } = loop
    const sessionId = SessionId('control-revive-target')
    try {
      const first = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fake', model: 'fake' } })
      await control(ctx, first.agent, PAUSE_COMMAND)
      expect(definitionIds(ctx.commands.list(first.agent))).toContain(RESUME_DEFINITION_ID)

      // Agent disposal takes its scoped marker with it; the session stays paused.
      await first.dispose()

      const revived = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fake', model: 'fake' } })
      expect(definitionIds(ctx.commands.list(revived.agent))).toContain(RESUME_DEFINITION_ID)
      await control(ctx, revived.agent, RESUME_COMMAND)
      expect(definitionIds(ctx.commands.list(revived.agent))).not.toContain(RESUME_DEFINITION_ID)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('removes the whole surface when the plugin unloads', async () => {
    const loop = await mountGatedLoop('control-unload', [])
    const { ctx, agent, plugin } = loop
    try {
      await control(ctx, agent, PAUSE_COMMAND)
      expect(definitionIds(ctx.commands.list(agent))).toContain(RESUME_DEFINITION_ID)

      await plugin.dispose()
      expect(definitionIds(ctx.commands.list(agent))).toEqual([])
      await expect(ctx.commands.execute(agent, `/${PAUSE_COMMAND}`, [], new AbortController().signal))
        .resolves.toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resumes a parked session through the marker command alone', async () => {
    const loop = await mountGatedLoop('control-resume', [textResponse('resumed answer')])
    const { ctx, provider, agent } = loop
    try {
      await control(ctx, agent, PAUSE_COMMAND)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'through the marker' }], source: { kind: 'user' } }))
      await loop.requestSeen(1)
      expect(provider.requests).toHaveLength(0)

      await control(ctx, agent, RESUME_COMMAND)
      await agent.whenIdle()
      expect(provider.requests).toHaveLength(1)
      expect(turnEnd(agent)).toEqual({ turn: 1, reason: { kind: 'completed' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

