/**
 * Task 07's first acceptance: one action registers every running session tree,
 * and a session the user never asked about is not touched.
 *
 * The running fact is a real one — a tool call in flight — and the tree is a
 * real one: a child session the parent's own subagent catalog records. What is
 * asserted is the durable registry on disk plus what the browser can read back,
 * not any internal set.
 * @module dsh-safe-stop/test/global/stop-all
 */

import { afterAll, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { textResponse } from '../assumptions/fake-provider.ts'
import { RESUME_DEFINITION_ID } from '../../src/shared.ts'
import { readParkRegistry } from '../registry/read.ts'
import {
  blockingScript, cleanRoots, mountGlobalHome, storageOf, temporaryRoot, toolCallResponse, until, untilAsync,
} from './home.ts'

/** The route's script for a case whose session blocks in a tool. */
const BLOCKING_SCRIPT = [toolCallResponse('call-1', 'gated', { id: '1' }), textResponse('after the tool')]

/** Every temporary root this spec creates, removed once the file settles. */
const temporaryRoots: string[] = []
afterAll(() => { cleanRoots(temporaryRoots) })

const ask = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

describe('one press over every running session tree', () => {
  it('registers the running tree and its subagent descendant, and nothing else', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-global-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: BLOCKING_SCRIPT })
    try {
      const busy = await home.create('busy-root')
      const idle = await home.create('idle-bystander')
      const child = await home.create('busy-child')
      // The parent's own catalog records the child; this is the harness's real
      // discovery fact, not a test-side guess about the tree.
      busy.session.append('subagent/catalog', {
        version: 0,
        childId: child.session.id,
        childCreatedAt: child.session.header.createdAt,
        mode: 'continuable',
        label: 'continuable child',
      })
      // Work in flight is what makes the root "running": the loop is inside a
      // turn with a tool call that has not returned.
      busy.followup(ask('run the tool'))
      await until(() => home.blocking.started() === 1, 'the tool in flight')

      const answer = await home.run(idle, 'safe-stop-all')
      expect(answer.kind, JSON.stringify(answer)).toBe('success')

      // Both members of the tree are registered the moment the press answers:
      // the record is written before the press reports success.
      const ids = (await readParkRegistry(storageOf(caseRoot))).map(entry => String(entry.sessionId)).sort()
      expect(ids).toEqual(['busy-child', 'busy-root'])

      // The descendant has nothing to drain and parks; the root keeps its tool
      // and cannot reach the park point while it runs.
      await untilAsync(async () => (await home.status(idle)).safe === 1, 'the descendant to park')
      const phases = (await readParkRegistry(storageOf(caseRoot)))
        .map(entry => [String(entry.sessionId), entry.phase] as const).sort()
      expect(phases).toEqual([['busy-child', 'safe'], ['busy-root', 'draining']])

      // The idle session is untouched in every way the browser can observe:
      // no record, no marker of its own, and no request it never asked for.
      expect(ids).not.toContain('idle-bystander')
      expect(home.ctx.commands.list(idle).map(descriptor => descriptor.definitionId))
        .not.toContain(RESUME_DEFINITION_ID)
      expect(home.provider.requests).toHaveLength(1)

      const status = await home.status(idle)
      expect(status.verdict).toBe('waiting')
      expect(status.registered).toBe(2)
      expect(status.draining).toEqual(['busy-root'])
    } finally {
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })

  it('leaves a tree member that is not live alone, and still reaches safe', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-global-inactive-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: blockingScript() })
    try {
      const parent = await home.create('busy-parent')
      // A child that already finished its run: its log is durable and its agent
      // is gone, which is what most catalog rows look like by the evening.
      const child = await home.ctx.agents.create({
        sessionId: SessionId('finished-child'),
        agentOptions: { provider: 'fake', model: 'fake' },
      })
      const childCreatedAt = child.agent.session.header.createdAt
      child.agent.followup(ask('child work'))
      await untilAsync(async () => home.blocking.started() === 1, 'the child tool in flight')
      home.blocking.release(0)
      await child.agent.whenIdle()
      await home.ctx.sessions.flush(child.agent.session)
      await child.dispose()
      parent.session.append('subagent/catalog', {
        version: 0,
        childId: SessionId('finished-child'),
        childCreatedAt,
        mode: 'continuable',
        label: 'finished child',
      })

      parent.followup(ask('parent work'))
      await untilAsync(async () => home.blocking.started() === 2, 'the parent tool in flight')
      expect((await home.run(parent, 'safe-stop-all')).kind).toBe('success')

      // The tree walk names the finished child, and the press leaves it alone:
      // it has nothing to hold and no session-level flush to run, so a record
      // for it could only be a `safe` no flush backs — the clean path would
      // silently resume it in the morning — or a phase that never settles,
      // which would keep "safe to close" from ever appearing.
      expect((await readParkRegistry(storageOf(caseRoot))).map(entry => String(entry.sessionId)))
        .toEqual(['busy-parent'])

      home.blocking.release(1)
      await untilAsync(async () => (await home.status(parent)).verdict === 'safe', 'the park the tree can reach')
      expect(await readParkRegistry(storageOf(caseRoot))).toEqual([
        { sessionId: SessionId('busy-parent'), phase: 'safe', rearmGoal: true, updatedAt: expect.any(Number) },
      ])
    } finally {
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })

  it('leaves a session that was paused first exactly where it was', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-global-idempotent-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot)
    try {
      const idle = await home.create('idle-pressed')
      // Pressed while idle: it parks immediately, and a later whole-app press
      // must not restart its park (a new episode would re-derive an outcome the
      // first press already reached).
      expect((await home.run(idle, 'safe-stop')).kind).toBe('success')
      await untilAsync(async () => (await home.status(idle)).safe === 1, 'the first press to park')
      const parked = await readParkRegistry(storageOf(caseRoot))

      expect((await home.run(idle, 'safe-stop-all')).kind).toBe('success')

      expect(await readParkRegistry(storageOf(caseRoot))).toEqual(parked)
      expect((await home.status(idle)).safe).toBe(1)
    } finally {
      await home.ctx.fiber.dispose()
    }
  })

  it('registers a session that is owed an unclaimed reply, and not the one at rest', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-global-inbox-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot)
    try {
      const resting = await home.create('at-rest')
      const delivered = await home.create('delivered-unclaimed')
      // Delivered through the inbox, which does not wake the driver: the
      // session is not running yet, but it owes a turn the moment it is.
      delivered.inbox.append('next-turn', ask('do this tomorrow'))

      expect((await home.run(resting, 'safe-stop-all')).kind).toBe('success')

      const ids = (await readParkRegistry(storageOf(caseRoot))).map(entry => String(entry.sessionId)).sort()
      expect(ids).toEqual(['delivered-unclaimed'])
    } finally {
      await home.ctx.fiber.dispose()
    }
  })
})
