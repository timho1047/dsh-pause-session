/**
 * Task 08's acceptance: the morning decision list, read out of real park state.
 *
 * Every case here starts the way the morning really starts — a child process
 * parks a session and is SIGKILLed, and a fresh parent context then decides what
 * to do with what is left. The child's log is the only input: the list's facts
 * are read back through the plugin's own verbs, which is the same channel the
 * browser half uses.
 * @module dsh-safe-stop/test/triage/list
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { decodeTriageList, encodeTriageList, TRIAGE_PREFIX } from '../../src/shared.ts'
import type { TriageList } from '../../src/shared.ts'
import { ensureHostEntry } from '../resume/build.ts'
import { readParkRegistry } from '../registry/read.ts'
import { parkAndLeave, recordParkWithoutLog, recordsUntil, reviveTriageHome, storageOf } from './home.ts'

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

/** Session id and phase, in registry order. */
async function records(root: string): Promise<[string, string][]> {
  return (await readParkRegistry(root)).map(entry => [String(entry.sessionId), entry.phase])
}

describe('the decision list', () => {
  it('names the tool that was in flight when the process died, and the trace it left', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-triage-draining-')
    await parkAndLeave(caseRoot, 'overnight-tools', 'pair')
    // The park never completed, so the durable outcome is the honest one for a
    // session that was still working when the process ended.
    await recordsUntil(caseRoot, [['overnight-tools', 'draining']])

    const home = await reviveTriageHome(caseRoot)
    const list = await home.triage()
    try {
      expect(list.rows).toHaveLength(1)
      const row = list.rows[0]!
      expect(row.sessionId).toBe('overnight-tools')
      expect(row.phase).toBe('draining')
      // The facts come from the log, not from the listing.
      expect(row.reading).toBe('read')
      expect(row.lastEvent).toBe('tool/call')
      expect(row.turn).toBe(1)
      expect(row.step).toBe(1)
      // The call that finished has a durable result and is NOT a trace; the one
      // the process died inside is, and neither has its marker in the log yet.
      expect(row.traces).toEqual([{ tool: 'gated', callId: 'call-slow' }])
      expect(row.owed).toBe(true)
      expect(row.wakeable).toBe(true)
      // Reading the list is not a decision: nothing was activated, nothing was
      // written, and the session's record is exactly where it was.
      expect(home.ctx.agents.get(SessionId('overnight-tools'))).toBeUndefined()
      expect(home.provider.requests).toHaveLength(0)
      await recordsUntil(caseRoot, [['overnight-tools', 'draining']])
    } finally {
      await home.ctx.fiber.dispose()
    }
  })

  it('keeps a cleanly parked session off the list and resumes it silently instead', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-triage-clean-')
    await parkAndLeave(caseRoot, 'overnight-clean', 'clean')
    await recordsUntil(caseRoot, [['overnight-clean', 'safe']])

    const home = await reviveTriageHome(caseRoot)
    const listed = (await home.triage()).rows
    try {
      // The clean record is on the silent path by construction: the list is the
      // registry's own complement, so "safe" cannot appear on it.
      expect(listed).toEqual([])

      // And the morning verb resumes it without the list ever seeing it. The
      // wake is the clean path's: the loop builds one empty message in, and the
      // route drops it, so nothing new reaches the payload.
      const answered = await home.run('/safe-resume-all')
      expect(answered.kind, answered.text).toBe('success')
      const resumed = home.ctx.agents.get(SessionId('overnight-clean'))
      expect(resumed, 'the clean session was not resumed').toBeDefined()
      expect(home.seen[0]?.messages.filter(message => message.role === 'user' && message.content.length === 0))
        .toHaveLength(1)
      await resumed!.whenIdle()
      // The list is empty both before and after: the clean path never goes
      // through it.
      expect((await home.triage()).rows).toEqual([])
      await recordsUntil(caseRoot, [])
    } finally {
      await home.ctx.fiber.dispose()
    }
  })

  it('leaves a record with no readable log unreadable instead of answering for it', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-triage-unreadable-')
    // A durable record with no session log behind it: the outcome is real, the
    // evidence for it is not readable here.
    await recordParkWithoutLog(caseRoot, 'vault-session', 'draining')

    const home = await reviveTriageHome(caseRoot)
    const list = await home.triage()
    try {
      expect(list.rows.map(row => row.sessionId)).toEqual(['vault-session'])
      const row = list.rows[0]!
      expect(row.reading).toBe('unreadable')
      // Unknown is not empty: no traces claimed, no wake promised, and the row
      // still states the outcome the registry durably holds.
      expect(row.traces).toEqual([])
      expect(row.lastEvent).toBeUndefined()
      expect(row.wakeable).toBe(false)
      expect(row.phase).toBe('draining')
      // And the published vocabulary carries the refusal rather than a verdict:
      // a decoded row keeps saying `unreadable` and none of the facts it does
      // not have.
      const round = decodeTriageList(encodeTriageList(list))
      expect(round?.rows[0]).toMatchObject({ sessionId: 'vault-session', reading: 'unreadable', traces: [], wakeable: false })
      expect(round?.rows[0]?.lastEvent).toBeUndefined()
    } finally {
      await home.ctx.fiber.dispose()
    }

    // The same refusal on the wire, spelled out: a row the host could not read
    // never decodes as a read row, and a text this vocabulary does not own never
    // decodes at all.
    const hostile: TriageList = {
      rows: [{
        sessionId: 'vault-session',
        phase: 'draining',
        updatedAt: 1,
        reading: 'unreadable',
        traces: [],
        owed: false,
        wakeable: false,
      }],
    }
    const text = encodeTriageList(hostile)
    expect(text.startsWith(TRIAGE_PREFIX)).toBe(true)
    expect(decodeTriageList(text)?.rows[0]?.reading).toBe('unreadable')
    expect(decodeTriageList('safe-stop: safe to close')).toBeUndefined()
    expect(decodeTriageList('safe-stop all: safe; registered: 1')).toBeUndefined()
  })
})
