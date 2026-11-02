/**
 * Task 06's clean-resume acceptance, end to end across a real process
 * boundary: a session a killed process left parked at the model-request gate is
 * resumed in a fresh process, the model answers the input that was already
 * pending, and the request that reaches the route is the parked request —
 * nothing added.
 *
 * The child parks and dies; the parent mounts the same stack over the same
 * roots and presses the morning verb on a session it happens to have open. The
 * wire assertion runs the parked child's own request and the resumed request
 * through the route's serializer, so what is compared is the payload, not the
 * plugin's intent.
 * @module dsh-pause-session/test/resume/clean-resume
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RESUME_DEFINITION_ID } from '../../src/shared.ts'
import { turnEnd } from '../gate/loop.ts'
import { readParkRegistry } from '../registry/read.ts'
import { PENDING_INPUT } from './case.ts'
import { ensureHostEntry } from './build.ts'
import { parkAndLeave, resumeAll, reviveHome, storageOf, until } from './home.ts'
import { wireMessages, wireText } from './wire.ts'

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

beforeAll(() => { ensureHostEntry() })

describe('a cleanly parked session resumed in a fresh process', () => {
  it('answers the input that was pending, and puts nothing new on the wire', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-resume-clean-')
    const parked = await parkAndLeave(caseRoot, 'overnight-clean', 'clean')
    expect(parked.request, 'the child parked nothing at the gate').toBeDefined()
    expect((await readParkRegistry(storageOf(caseRoot))).map(entry => [String(entry.sessionId), entry.phase]))
      .toEqual([['overnight-clean', 'safe']])

    const home = await reviveHome(caseRoot)
    try {
      // Nothing is live before the press: the registry is the only thing that
      // remembers this session, which is what makes the activation part real.
      expect(home.ctx.agents.get(SessionId('overnight-clean'))).toBeUndefined()
      expect(await resumeAll(home)).toBe('pause resumed 1 session from where it stopped.')

      const resumed = home.ctx.agents.get(SessionId('overnight-clean'))
      expect(resumed, 'the parked session was not activated').toBeDefined()
      await until(() => home.provider.requests.length === 1, 'the model answering the pending input')
      await resumed!.whenIdle()

      // The request the loop built carries the parked input, so the model
      // answers what the session was already waiting on — nothing retyped.
      const woken = home.seen[0]!
      expect(JSON.stringify(woken.messages)).toContain(PENDING_INPUT)
      // The wake really is in the loop's request…
      expect(woken.messages.filter(message => message.role === 'user' && message.content.length === 0)).toHaveLength(1)
      // …and the route drops it, so the payload IS the parked request.
      expect(wireMessages(woken)).toEqual(wireMessages(parked.request!))
      expect(wireMessages(woken).some(message => wireText(message) === '' )).toBe(false)
      // The session continued rather than restarted: the interrupted turn is
      // closed as such and the answer is the next one.
      expect(turnEnd(resumed!)).toEqual({ turn: 2, reason: { kind: 'completed' } })
    } finally {
      await home.ctx.fiber.dispose()
    }
    // The press is durable: the next process does not re-hold a resumed session.
    expect(await readParkRegistry(storageOf(caseRoot))).toEqual([])
  })

  it('resumes from a step whose tool results were already in hand', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-resume-tool-')
    // The park point the gate exists for: the tool finished, its results are on
    // the surface, and the request that would answer them never left.
    const parked = await parkAndLeave(caseRoot, 'overnight-tool', 'tool-result')
    const home = await reviveHome(caseRoot, { tools: true })
    try {
      expect(await resumeAll(home)).toBe('pause resumed 1 session from where it stopped.')
      const resumed = home.ctx.agents.get(SessionId('overnight-tool'))
      expect(resumed, 'the parked session was not activated').toBeDefined()
      await until(() => home.provider.requests.length === 1, 'the model answering the tool results')
      await resumed!.whenIdle()

      // The resumed request answers the tool results, and the payload is again
      // the parked request: the tool turn plus nothing.
      const woken = home.seen[0]!
      expect(woken.messages.some(message => message.role === 'tool')).toBe(true)
      expect(woken.messages.filter(message => message.role === 'user' && message.content.length === 0)).toHaveLength(1)
      expect(wireMessages(woken)).toEqual(wireMessages(parked.request!))
      expect(turnEnd(resumed!)).toEqual({ turn: 2, reason: { kind: 'completed' } })
      // The answer the model produced after the tool is in the session, so the
      // turn continued instead of restarting the step.
      expect(JSON.stringify(resumed!.session.snapshotEvents())).toContain('answer 1')
    } finally {
      await home.ctx.fiber.dispose()
    }
    expect(await readParkRegistry(storageOf(caseRoot))).toEqual([])
  })

  it('resumes through the session-scoped verb when the session is already open', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-resume-open-')
    const parked = await parkAndLeave(caseRoot, 'overnight-open', 'clean')
    const home = await reviveHome(caseRoot)
    try {
      // Opening a session this morning activates its agent; the pause is what
      // stops it from running, not the absence of an agent.
      const opened = (await home.ctx.agents.resume({ resumeSessionId: SessionId('overnight-open') })).agent
      expect(home.ctx.commands.list(opened).map(descriptor => descriptor.definitionId))
        .toContain(RESUME_DEFINITION_ID)
      expect(home.provider.requests).toHaveLength(0)

      const execution = await home.ctx.commands.execute(opened, '/pause-resume', [], new AbortController().signal)
      expect(execution?.result.kind, JSON.stringify(execution?.result)).toBe('success')

      await until(() => home.provider.requests.length === 1, 'the model answering the pending input')
      await opened.whenIdle()
      expect(JSON.stringify(home.seen[0]?.messages)).toContain(PENDING_INPUT)
      // The same invisibility holds on this entry point: one wake message in
      // the loop's request, none of it on the wire.
      expect(home.seen[0]?.messages.filter(message => message.role === 'user' && message.content.length === 0))
        .toHaveLength(1)
      expect(wireMessages(home.seen[0]!)).toEqual(wireMessages(parked.request!))
    } finally {
      await home.ctx.fiber.dispose()
    }
    expect(await readParkRegistry(storageOf(caseRoot))).toEqual([])
  })
})
