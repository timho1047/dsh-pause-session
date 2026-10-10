/**
 * Task 08's four decisions, each one observed doing what it says.
 *
 * The subject is a session a killed process left parked inside a tool — the
 * case the clean path refuses — and every decision is driven through the verb
 * the browser half executes, on a morning with no live agent for that session.
 * The differences that matter are the ones the user can see: what reaches the
 * route, what the session log gains, and what stays exactly where it was. A
 * decision is also a target, so the cases that matter include the ones the host
 * must refuse: a command no row was shown for, and a wake that must not land in
 * the log as the user's own words.
 * @module dsh-safe-stop/test/triage/decisions
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { UNATTENDED_TEXT } from '../../src/control.ts'
import { TRIAGE_UNSHOWN_TEXT, UNKNOWN_OUTCOME_NOTE } from '../../src/triage.ts'
import { ensureHostEntry } from '../resume/build.ts'
import { readParkRegistry } from '../registry/read.ts'
import { turnEnd } from '../gate/loop.ts'
import { parkAndLeave, recordsUntil, reviveTriageHome, settles, storageOf, until } from './home.ts'
import type { TriageHome } from './home.ts'

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

/** The model-visible user text of one built request, joined. */
function userText(request: { messages: readonly { role: string; content: readonly { type: string; text?: string }[] }[] }): string {
  return request.messages
    .filter(message => message.role === 'user')
    .flatMap(message => message.content.map(block => block.text ?? ''))
    .join('\n')
}

/**
 * The source kind of the last message the session's own stored log holds, read
 * back through persistence the way any later consumer reads it. This is how the
 * log answers "who wrote this?": `user` means the human did.
 */
async function lastLoggedSource(home: TriageHome, sessionId: string): Promise<string | undefined> {
  const persistence = home.ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('safe-stop: this home mounts no session persistence')
  // The log is read through its durable form, so the writer's own checkpoint is
  // what puts the wake's message in it.
  const live = home.ctx.sessions.get(SessionId(sessionId))
  if (live !== undefined) await home.ctx.sessions.flush(live)
  const handle = await persistence.open(SessionId(sessionId), 'read')
  try {
    const stored = await handle.read(0, undefined)
    const message = [...stored.events].reverse().find(event => event.type === 'user/message')
    if (message === undefined || message.type !== 'user/message') return undefined
    return message.data.source.kind
  } finally {
    await handle.close()
  }
}

describe('the decisions on one listed session', () => {
  it('continues with no note: the clean path\'s own invisible wake', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-triage-continue-')
    await parkAndLeave(caseRoot, 'overnight-continue', 'draining')

    const home = await reviveTriageHome(caseRoot)
    try {
      // What the row promises is what the decision then does: the list's `wake`
      // and the wake the resume delivers are one rule read by both.
      expect((await home.triage()).rows[0]?.wakeable, 'the row promised no wake').toBe(true)
      const answered = await home.decide('overnight-continue', 'continue')
      expect(answered.kind, answered.text).toBe('success')
      const resumed = home.ctx.agents.get(SessionId('overnight-continue'))
      expect(resumed, 'the decision did not activate the session').toBeDefined()
      await until(() => home.provider.requests.length === 1, 'the model answering the interrupted step')
      await resumed!.whenIdle()

      // The wake is the clean path's: one empty user message in the loop's
      // request, and no note anywhere near the wire.
      const request = home.seen[0]!
      expect(request.messages.filter(message => message.role === 'user' && message.content.length === 0)).toHaveLength(1)
      expect(userText(request)).not.toContain('outcome is unknown')
      // The tool the process died inside is answered by the harness's own
      // synthetic result before the model sees the step.
      expect(request.messages.some(message => message.role === 'tool')).toBe(true)
      // The wake is this plugin's, and the session's own log says so: a later
      // consumer reads the same durable record and cannot mistake it for the
      // user's words.
      expect(await lastLoggedSource(home, 'overnight-continue')).toBe('safe-stop')
      // A decision is a release: the next process does not re-hold it.
      await recordsUntil(caseRoot, [])
    } finally {
      await home.ctx.fiber.dispose()
    }
  })

  it('continues with a note that says the tool outcome is unknown and forbids a blind retry', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-triage-note-')
    await parkAndLeave(caseRoot, 'overnight-note', 'draining')

    const home = await reviveTriageHome(caseRoot)
    try {
      const answered = await home.decide('overnight-note', 'note')
      expect(answered.kind, answered.text).toBe('success')
      const resumed = home.ctx.agents.get(SessionId('overnight-note'))
      expect(resumed, 'the decision did not activate the session').toBeDefined()
      await until(() => home.provider.requests.length === 1, 'the model answering the noted step')
      await resumed!.whenIdle()

      // The note IS the wake, so it rides the request the session was already
      // owed rather than opening a turn of its own.
      const request = home.seen[0]!
      expect(userText(request)).toContain(UNKNOWN_OUTCOME_NOTE)
      expect(request.messages.filter(message => message.role === 'user' && message.content.length === 0)).toHaveLength(0)
      expect(request.messages.some(message => message.role === 'tool')).toBe(true)
      // The two facts the product promises, spelled out in the injected text.
      expect(UNKNOWN_OUTCOME_NOTE).toContain('outcome is unknown')
      expect(UNKNOWN_OUTCOME_NOTE).toContain('do not retry it blindly')
      // The note is synthesized by the plugin on the user's behalf, and the log
      // keeps that attribution: it is not text the human typed.
      expect(await lastLoggedSource(home, 'overnight-note')).toBe('safe-stop')
      // The press is durable: the next process does not re-hold a resumed or
      // refused session, and one that was only opened still holds.
      await recordsUntil(caseRoot, [])
    } finally {
      await home.ctx.fiber.dispose()
    }
  })

  it('opens the session for review without spending a single request', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-triage-review-')
    await parkAndLeave(caseRoot, 'overnight-review', 'draining')

    const home = await reviveTriageHome(caseRoot)
    try {
      const answered = await home.decide('overnight-review', 'review')
      expect(answered.kind, answered.text).toBe('success')
      const opened = home.ctx.agents.get(SessionId('overnight-review'))
      expect(opened, 'the decision did not open the session').toBeDefined()
      // The agent exists so the user can read it; nothing was asked of a model.
      expect(opened!.status).toBe('idle')
      expect(home.provider.requests).toHaveLength(0)
      expect(home.seen).toHaveLength(0)
      await settles()
      expect(home.provider.requests).toHaveLength(0)
      // Opening it still repaired the log the way any cold read does, so what
      // the user sees is the balanced transcript rather than a dangling step.
      expect(turnEnd(opened!)).toEqual({ turn: 1, reason: { kind: 'interrupted' } })
      // Opening it is not releasing it: the record is what keeps the session
      // from running on its own later, so it stays.
      await recordsUntil(caseRoot, [['overnight-review', 'draining']])
    } finally {
      await home.ctx.fiber.dispose()
    }
  })

  it('leaves the session alone: no agent, no request, no write', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-triage-leave-')
    await parkAndLeave(caseRoot, 'overnight-leave', 'draining')
    const before: [string, string][] = [['overnight-leave', 'draining']]

    const home = await reviveTriageHome(caseRoot)
    try {
      const answered = await home.decide('overnight-leave', 'leave')
      expect(answered.kind, answered.text).toBe('success')
      await settles()
      expect(home.ctx.agents.get(SessionId('overnight-leave'))).toBeUndefined()
      expect(home.provider.requests).toHaveLength(0)
      // Still listed, too: leaving it today does not decide it away.
      expect((await home.triage()).rows.map(row => row.sessionId)).toEqual(['overnight-leave'])
      await recordsUntil(caseRoot, before)
    } finally {
      await home.ctx.fiber.dispose()
    }
  })

  it('refuses a decision on a row this calling session was never shown', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-triage-unshown-')
    await parkAndLeave(caseRoot, 'overnight-unshown', 'draining')

    const home = await reviveTriageHome(caseRoot)
    try {
      // The row is real and listed, but this session never read the list: the
      // command channel names its target as input, and a name nobody was shown
      // is not a target. Nothing may be resumed, and nothing may be spent.
      const answered = await home.run('/safe-triage-continue overnight-unshown')
      expect(answered.kind).toBe('error')
      expect(answered.text).toBe(TRIAGE_UNSHOWN_TEXT)
      await settles()
      expect(home.ctx.agents.get(SessionId('overnight-unshown'))).toBeUndefined()
      expect(home.provider.requests).toHaveLength(0)
      // Reading the list is what makes the same row actionable, and the record
      // was untouched by the refusal.
      expect((await home.triage()).rows.map(row => row.sessionId)).toEqual(['overnight-unshown'])
      const allowed = await home.decide('overnight-unshown', 'continue')
      expect(allowed.kind, allowed.text).toBe('success')
      await recordsUntil(caseRoot, [])
    } finally {
      await home.ctx.fiber.dispose()
    }
  })

  it('refuses a park verb issued from inside a model turn', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-triage-unattended-')
    await parkAndLeave(caseRoot, 'overnight-unattended', 'draining')

    const home = await reviveTriageHome(caseRoot)
    try {
      // The loop runs every model-driven step — tool calls included — under its
      // own initiator boundary. A model that could decide a park could spend
      // another session's budget, so these verbs refuse to act inside one.
      const read = await home.ctx.agents.withInitiator(home.desk, () => home.triage())
      expect(read.rows.map(row => row.sessionId)).toEqual(['overnight-unattended'])
      // A read changes nothing, so it stays open to any caller. The decision
      // does not, even with the row just read under that same turn.
      const refused = await home.ctx.agents.withInitiator(home.desk, () => home.decide('overnight-unattended', 'continue'))
      expect(refused.kind).toBe('error')
      expect(refused.text).toBe(UNATTENDED_TEXT)
      await settles()
      expect(home.ctx.agents.get(SessionId('overnight-unattended'))).toBeUndefined()
      expect(home.provider.requests).toHaveLength(0)
      await recordsUntil(caseRoot, [['overnight-unattended', 'draining']])
      // The same decision from a person's channel is what the list is for.
      const allowed = await home.decide('overnight-unattended', 'continue')
      expect(allowed.kind, allowed.text).toBe('success')
      await recordsUntil(caseRoot, [])
    } finally {
      await home.ctx.fiber.dispose()
    }
  })

  it('refuses a decision aimed at a session that is not on the list', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-triage-not-listed-')
    await parkAndLeave(caseRoot, 'overnight-clean', 'clean')

    const home = await reviveTriageHome(caseRoot)
    try {
      // A cleanly parked session belongs to the silent path, so the list never
      // shows it — and a decision can only act on a row the caller was shown.
      // Deciding it here would be a second resume of a session that is not the
      // list's business.
      const answered = await home.decide('overnight-clean', 'continue')
      expect(answered.kind).toBe('error')
      expect(home.ctx.agents.get(SessionId('overnight-clean'))).toBeUndefined()
      await recordsUntil(caseRoot, [['overnight-clean', 'safe']])
    } finally {
      await home.ctx.fiber.dispose()
    }
  })
})
