/**
 * Task 06's clean-only rule: the resume path activates a session from its
 * stored log, so it may only do that for a record whose park finished.
 *
 * All three unfinished outcomes are refused here — a session paused while a
 * tool was still in flight never reached the park point, one standing still
 * with its flush still open has no durable promise behind its input, and one
 * whose flush failed has lost it — with no agent activated, no request sent and
 * no record dropped, which is what routes them to the morning decision list
 * instead of waking them silently.
 * @module dsh-safe-stop/test/resume/unclean-refusal
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { readParkRegistry } from '../registry/read.ts'
import { ensureHostEntry } from './build.ts'
import { parkAndLeave, resumeAll, reviveHome, settles, storageOf } from './home.ts'

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

describe('the clean resume path refuses a session that did not finish parking', () => {
  it('wakes none of the three unfinished parks', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-resume-unclean-')
    await parkAndLeave(caseRoot, 'overnight-draining', 'draining')
    await parkAndLeave(caseRoot, 'overnight-parking', 'parking')
    await parkAndLeave(caseRoot, 'overnight-flush-failed', 'flush-failed')
    expect(await records(storageOf(caseRoot))).toEqual([
      ['overnight-draining', 'draining'],
      ['overnight-parking', 'parking'],
      ['overnight-flush-failed', 'flush-failed'],
    ])

    const home = await reviveHome(caseRoot)
    try {
      expect(await resumeAll(home)).toBe('safe-stop resumed no session; 3 did not stop cleanly and need your decision.')
      await settles()

      // Neither session was activated, so nothing was woken and no request was
      // built — the pause still holds, exactly as the registry describes it.
      expect(home.ctx.agents.get(SessionId('overnight-draining'))).toBeUndefined()
      expect(home.ctx.agents.get(SessionId('overnight-parking'))).toBeUndefined()
      expect(home.ctx.agents.get(SessionId('overnight-flush-failed'))).toBeUndefined()
      expect(home.provider.requests).toHaveLength(0)
      expect(home.seen).toHaveLength(0)
    } finally {
      await home.ctx.fiber.dispose()
    }
    // Refusing is not forgetting: both records are still there for the list.
    expect(await records(storageOf(caseRoot))).toEqual([
      ['overnight-draining', 'draining'],
      ['overnight-parking', 'parking'],
      ['overnight-flush-failed', 'flush-failed'],
    ])
  })
})
