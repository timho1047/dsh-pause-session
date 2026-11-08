/**
 * Task 05's registry acceptance at the seams the plugin itself has: the
 * durable record a fresh instance reads back, the phases it distinguishes, the
 * marker it re-publishes, and the loud failure when the record cannot be read.
 *
 * Nothing here asserts plugin internals: the durable side is read by opening
 * the registry in a second context over the same storage root (what a new
 * process does), and the live side through the same native snapshot the
 * browser half reads.
 * @module dsh-pause-session/test/registry/registry
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply, inject, name } from '../../src/index.ts'
import { PARK_REGISTRY_DOMAIN } from '../../src/registry.ts'
import type { ParkStatus } from '../../src/shared.ts'
import { textResponse } from '../assumptions/fake-provider.ts'
import { mountFakeLoop } from '../assumptions/loop-harness.ts'
import { pause, resume, statusOf } from '../native-driver.ts'
import { mountGatedLoop, until } from '../gate/loop.ts'
import type { GatedLoop } from '../gate/loop.ts'
import { readParkRegistry } from './read.ts'
import { mountParkStorage } from './storage.ts'

const ask = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

/** Every temporary root this spec creates, removed once the file settles. */
const temporaryRoots: string[] = []
afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

/** The park status the host publishes for one agent right now, if it is paused. */
async function published(ctx: Context, agent: Agent): Promise<ParkStatus | undefined> {
  return await statusOf(ctx, agent)
}

/** Wait until the host reports one exact phase for that session. */
async function phaseBecomes(loop: GatedLoop, agent: Agent, wanted: ParkStatus['phase']): Promise<void> {
  let seen: string | undefined
  await until(() => {
    void published(loop.ctx, agent).then(status => { seen = status?.phase })
    return seen === wanted
  })
  expect(seen, `last phase read was ${String(seen)}`).toBe(wanted)
}

/** The stored document of one registry unit, as the JSON backend writes it. */
function storedUnit(phase: unknown): string {
  return `${JSON.stringify({
    unit: { name: PARK_REGISTRY_DOMAIN, version: 1 },
    global: null,
    tables: { sessions: { 'some-session': { phase, updatedAt: 1 } } },
  }, null, 2)}\n`
}

describe('the durable park registry', () => {
  it('records a parked session outside the session log, and a fresh instance reads it back', async () => {
    const loop = await mountGatedLoop('registry-records', [])
    try {
      await pause(loop.ctx, loop.agent)
      await phaseBecomes(loop, loop.agent, 'safe')

      // A new process reads the same root through the same service; only the
      // registry already knows this session is parked.
      expect(await readParkRegistry(loop.storageRoot)).toEqual([
        { sessionId: SessionId('registry-records'), phase: 'safe', rearmGoal: true, updatedAt: expect.any(Number) },
      ])
      // The record is a document in the profile's storage, not an event in the
      // session: the loop harness here has no session storage at all.
      expect(existsSync(join(loop.storageRoot, `${PARK_REGISTRY_DOMAIN}.json`))).toBe(true)
    } finally {
      await loop.ctx.fiber.dispose()
    }
  })

  it('never reports a failed flush as clean, live or after a remount', async () => {
    const loop = await mountGatedLoop('registry-flush-failed', [])
    const { ctx, agent } = loop
    // A durability peer whose checkpoint always fails. A failed flush is the
    // one case where "parked" and "safe to close" must not be the same answer.
    ctx.effect(() => ctx.on('session/flush', () => Promise.reject(new Error('disk full'))), 'spec: failing flush')
    try {
      await pause(ctx, agent)
      await phaseBecomes(loop, agent, 'flush-failed')
      expect(await published(ctx, agent)).toEqual({ phase: 'flush-failed', safe: false, runningTools: [], rearmGoal: true })
      expect(await readParkRegistry(loop.storageRoot)).toEqual([
        { sessionId: SessionId('registry-flush-failed'), phase: 'flush-failed', rearmGoal: true, updatedAt: expect.any(Number) },
      ])

      // A later instance adopts the record as it stands and still does not call
      // it clean: only `safe` is clean, and this is not it.
      await loop.plugin.dispose()
      await ctx.plugin({ name, inject, apply })
      expect(await published(ctx, agent)).toEqual({ phase: 'flush-failed', safe: false, runningTools: [], rearmGoal: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('re-holds a registered session when the plugin mounts again, and holds nothing else', async () => {
    const loop = await mountGatedLoop('registry-adopt', [textResponse('an answer for a free session')])
    const { ctx, agent, provider } = loop
    try {
      await pause(ctx, agent)
      await phaseBecomes(loop, agent, 'safe')

      // The plugin is gone and the registry is all that is left of the pause:
      // no native service answers, so nothing claims the session is held here.
      await loop.plugin.dispose()
      expect(ctx.get('pauseSession'), 'the unloaded plugin left its service behind').toBeUndefined()

      await ctx.plugin({ name, inject, apply })
      // The mount-time scan found the live agent and re-published the marker;
      // a fresh process finds nothing live and publishes it when the session
      // wakes instead (the restart spec covers that).
      expect(await published(ctx, agent), 'the remounted session was not held again').toBeDefined()
      expect(await published(ctx, agent)).toEqual({ phase: 'safe', safe: true, runningTools: [], rearmGoal: true })

      // The request the loop builds for the next message stops at the gate.
      agent.followup(ask('still parked'))
      await loop.requestSeen(1)
      expect(provider.requests).toHaveLength(0)

      // And the release that follows is a real release, not a dropped request.
      await resume(ctx, agent)
      await agent.whenIdle()
      expect(provider.requests).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves a session that was never paused alone while another one is held', async () => {
    const loop = await mountGatedLoop('registry-held', [textResponse('free answer')])
    const { ctx, provider } = loop
    const free = await ctx.agentLoop.create(SessionId('registry-free'), { provider: 'fake', model: 'fake' })
    try {
      await pause(ctx, loop.agent)
      await phaseBecomes(loop, loop.agent, 'safe')

      free.followup(ask('unrelated work'))
      await until(() => provider.requests.length === 1)
      await free.whenIdle()
      expect(await published(ctx, free)).toBeUndefined()
      expect(await published(ctx, free), 'a session the press never named was held').toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('forgets a session the user resumed, so the pause does not come back', async () => {
    const loop = await mountGatedLoop('registry-resumed', [textResponse('after the release')])
    const { ctx, agent, provider } = loop
    try {
      await pause(ctx, agent)
      await phaseBecomes(loop, agent, 'safe')
      expect(await readParkRegistry(loop.storageRoot)).toHaveLength(1)

      await resume(ctx, agent)
      expect(await readParkRegistry(loop.storageRoot)).toEqual([])

      // A later mount has nothing to re-apply: the session is not held again.
      await loop.plugin.dispose()
      await ctx.plugin({ name, inject, apply })
      expect(await published(ctx, agent), 'the released session stayed in the snapshot').toBeUndefined()
      agent.followup(ask('normal work'))
      await loop.requestSeen(1)
      await agent.whenIdle()
      expect(provider.requests).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a session registered when its agent is released', async () => {
    const loop = await mountGatedLoop('registry-owner', [])
    const { ctx } = loop
    const sessionId = SessionId('registry-released')
    try {
      const first = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fake', model: 'fake' } })
      await pause(ctx, first.agent)
      await phaseBecomes(loop, first.agent, 'safe')

      // The agent goes away; the pause does not.
      await first.dispose()
      expect(await readParkRegistry(loop.storageRoot)).toEqual([
        { sessionId, phase: 'safe', rearmGoal: true, updatedAt: expect.any(Number) },
      ])

      // A replacement agent is published as paused again, from the registry.
      const revived = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fake', model: 'fake' } })
      expect(await published(ctx, revived.agent), 'the replacement agent was not published as paused').toBeDefined()
      expect(await published(ctx, revived.agent)).toEqual({ phase: 'safe', safe: true, runningTools: [], rearmGoal: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails the mount loudly when the registry cannot be read', async () => {
    for (const [label, content, code] of [
      ['a truncated document', `${storedUnit('safe').slice(0, 30)}`, 'malformed-medium'],
      ['a record this build cannot read', storedUnit('maybe parked'), 'invalid-record'],
    ] as const) {
      const root = temporaryRoot('dsh-pause-session-corrupt-')
      const loop = await mountFakeLoop('registry-corrupt', [])
      try {
        await mountParkStorage(loop.ctx, root)
        writeFileSync(join(root, `${PARK_REGISTRY_DOMAIN}.json`), content)

        // The failure has to stop the mount, not quietly drop the sessions the
        // registry names — a dropped record is a resumed session.
        await expect(loop.ctx.plugin({ name, inject, apply }), label)
          .rejects.toMatchObject({ code })
        // Nothing was registered either: no half-installed control to press.
        expect(loop.ctx.get('pauseSession'), 'a failed mount left the native service behind').toBeUndefined()
      } finally {
        await loop.ctx.fiber.dispose()
      }
    }
  })
})
