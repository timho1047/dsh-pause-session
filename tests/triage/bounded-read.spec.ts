/**
 * What one bounded read of a parked session's log may claim.
 *
 * The decision list reads the end of a session's log on every command-registry
 * change while the panel is open, so a read that grows with the log would make
 * the panel cost more the longer the session ran. These cases pin both halves of
 * that bound against a log a killed process really left behind: a window that
 * holds the facts reports exactly what a full read reports, and a window that
 * does not is reported unreadable rather than filled with a guess.
 *
 * The subject is the row a user reads, driven through the same verb the browser
 * half executes for the end-to-end case, and the same derivation the row is
 * built from for the window-by-window cases.
 * @module dsh-pause-session/test/triage/bounded-read
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logFacts } from '../../src/coldlog.ts'
import type { ColdFacts } from '../../src/coldlog.ts'
import { parkAndLeave, recordsUntil, reviveTriageHome, sessionRootOf } from './home.ts'
import { ensureHostEntry } from '../resume/build.ts'

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

/**
 * The session the cases below read: one step whose first tool call was answered
 * and whose second was still in flight when the process died, parked through
 * the real child process.
 *
 * Its shape is what makes a bounded read testable at all. The stored log ends
 * with the pause's own bookkeeping and then the unanswered call, so a window of
 * a few events still holds every fact the row publishes, and a window that
 * reaches only the bookkeeping holds none of them.
 */
async function parkPairSession(caseRoot: string): Promise<void> {
  await parkAndLeave(caseRoot, 'bounded-session', 'pair')
  await recordsUntil(caseRoot, [['bounded-session', 'draining']])
}

/** The stored events of that session, exactly as stored. */
async function storedEvents(caseRoot: string): Promise<readonly SessionEvent[]> {
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root: sessionRootOf(caseRoot), compression: 'none' })
  try {
    const handle = await ctx.sessionPersistence.open(SessionId('bounded-session'), 'read')
    try {
      return (await handle.read(0, undefined)).events
    } finally {
      await handle.close()
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

/**
 * The facts the row would publish for a window of the last `window` events.
 * @returns the facts, or `undefined` when the window cannot support them.
 */
function factsOfWindow(events: readonly SessionEvent[], window: number): ColdFacts | undefined {
  const start = Math.max(0, events.length - window)
  return logFacts(events.slice(start), start === 0, [])
}

/**
 * The facts a window establishes, minus the wake promise.
 *
 * `wakeable` also needs the request header the log recorded, which a window that
 * reaches only the last step does not hold; that promise is asserted on the
 * whole log and through the browser's own verb instead.
 * @param facts - the facts under comparison, or `undefined` when there are none.
 * @returns the comparable facts.
 */
function withoutWake(facts: ColdFacts | undefined): unknown {
  const compared = comparable(facts)
  return compared === undefined ? undefined : { ...compared as object, wakeable: undefined }
}

/** The facts one row publishes, stripped to what these cases compare. */
function comparable(facts: ColdFacts | undefined): unknown {
  return facts === undefined ? undefined : {
    last: facts.last?.type,
    traces: facts.traces.map(trace => trace.tool),
    owed: facts.owed,
    wakeable: facts.wakeable,
  }
}

describe('the bounded read of one parked log', () => {
  it('answers a window that holds the facts exactly as the whole log does', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-triage-window-')
    await parkPairSession(caseRoot)
    const events = await storedEvents(caseRoot)
    const whole = factsOfWindow(events, events.length)
    expect(whole, 'the fixture log cannot be folded at all').toBeDefined()
    expect(comparable(whole)).toEqual({
      last: 'tool/call',
      traces: ['gated'],
      owed: true,
      wakeable: true,
    })

    // The narrowest window that answers at all. Every window below it says it
    // cannot read the log, and every window that answers agrees with the whole
    // on what it publishes.
    //
    // `wakeable` has a bound of its own — it also needs the request header the
    // log recorded — so it is compared on the windows that reach that far and
    // checked through the browser's own verb in the case below.
    let narrowest = events.length
    for (let window = 1; window < events.length; window += 1) {
      const facts = factsOfWindow(events, window)
      if (facts === undefined) continue
      expect(withoutWake(facts), `a window of ${String(window)} events answered differently`)
        .toEqual(withoutWake(whole))
      narrowest = window
      break
    }
    expect(narrowest, 'only the whole log answered; the fixture proves nothing about a window').toBeLessThan(events.length)
    // And it is a real window: the log is longer than the facts need.
    expect(events.length).toBeGreaterThan(narrowest)

    // A window that cannot answer says so, and says nothing else.
    expect(factsOfWindow(events, 1), 'a one-event window invented facts').toBeUndefined()
  })
})

describe('the decision list under a bounded read', () => {
  it('lists the row as unreadable when the bound cannot hold its facts', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-triage-bound-small-')
    await parkPairSession(caseRoot)
    const events = await storedEvents(caseRoot)
    // The bound is chosen to sit inside the log's bookkeeping tail, where the
    // facts the row publishes cannot be read.
    expect(factsOfWindow(events, 1), 'this fixture can be read from one event').toBeUndefined()

    const home = await reviveTriageHome(caseRoot, { maxListedLogEvents: 1 })
    try {
      const row = (await home.triage()).rows[0]
      expect(row?.sessionId).toBe('bounded-session')
      expect(row?.phase).toBe('draining')
      expect(row?.reading).toBe('unreadable')
      // Nothing about the log is claimed: no stop position, no traces, no wake.
      expect(row?.lastEvent).toBeUndefined()
      expect(row?.turn).toBeUndefined()
      expect(row?.traces).toEqual([])
      expect(row?.owed).toBe(false)
      expect(row?.wakeable).toBe(false)
      // The park outcome still comes from the durable record, so the row is
      // listed even where its log could not be read; `updatedAt` is durable
      // host state and never travels to the panel.
      expect(row?.rearmGoal).toBe(true)
    } finally {
      await home.ctx.fiber.dispose()
    }
  })

  it('keeps the full read exact when the whole log fits inside the bound', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-triage-bound-fit-')
    await parkPairSession(caseRoot)

    // A bound larger than any real log: every event is read, so the row is
    // derived by the harness's own fold over exactly the stored log.
    const home = await reviveTriageHome(caseRoot, { maxListedLogEvents: 100_000 })
    try {
      const row = (await home.triage()).rows[0]
      expect(row?.reading).toBe('read')
      expect(row?.lastEvent).toBe('tool/call')
      expect(row?.traces.map(trace => trace.tool)).toEqual(['gated'])
      expect(row?.wakeable).toBe(true)
    } finally {
      await home.ctx.fiber.dispose()
    }
  })

  it('clamps a bound that reaches the end of the log to the whole log', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-triage-bound-clamp-')
    await parkPairSession(caseRoot)
    const events = await storedEvents(caseRoot)
    const whole = comparable(factsOfWindow(events, events.length))

    // A bound exactly as long as the log is not "the log is too long": the
    // length probe finds the end, so the row is the full reading.
    const home = await reviveTriageHome(caseRoot, { maxListedLogEvents: events.length })
    try {
      const row = (await home.triage()).rows[0]
      expect(row?.reading).toBe('read')
      expect(comparable(factsOfWindow(events, events.length))).toEqual(whole)
      expect(row?.lastEvent).toBe('tool/call')
      expect(row?.traces.map(trace => trace.tool)).toEqual(['gated'])
    } finally {
      await home.ctx.fiber.dispose()
    }
  })
})
