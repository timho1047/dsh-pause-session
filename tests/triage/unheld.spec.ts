/**
 * A record this mount could not hold, and what happens when the session behind
 * it becomes readable after all.
 *
 * A record is held again when this host can read the session it names. One it
 * could not read at mount — the log had not materialized yet, or the session
 * root was not mounted — is named in the aggregate instead, and nothing here
 * can park or release it. If that session turns up later in this same process,
 * the record must not become a permanent row: the paths that can now read it
 * are the ones that clear it, and the clean-only rule still decides which of
 * them may.
 * @module dsh-pause/test/triage/unheld
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { recordParkWithoutLog, recordsUntil, reviveTriageHome } from './home.ts'

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

describe('a record whose session became readable after the mount', () => {
  it('is cleared by the clean path when the session is live and the park finished', async () => {
    const caseRoot = temporaryRoot('dsh-pause-unheld-clean-')
    // The record is real and durable; the session log it names does not exist
    // yet, so the mount cannot hold anything for it.
    await recordParkWithoutLog(caseRoot, 'late-clean', 'safe')

    const home = await reviveTriageHome(caseRoot)
    try {
      expect(await home.status()).toMatchObject({ registered: 1, safe: 0, stalled: ['late-clean'] })
      expect(home.ctx.agents.get(SessionId('late-clean'))).toBeUndefined()

      // The session turns up: readable, live, and held by nothing, because this
      // process had nothing to hold when it mounted.
      await home.harness.create(SessionId('late-clean'), { provider: 'deepseek-official', model: 'model' })
      expect(home.ctx.agents.get(SessionId('late-clean'))).toBeDefined()

      const answered = await home.run('/pause-resume-all')
      expect(answered.kind, answered.text).toBe('success')
      expect(answered.text).toBe('pause resumed 1 session from where it stopped.')
      // The record is gone: the park is over for a session that is already
      // back, and a record left behind would be named for a park that is not
      // holding anything.
      await recordsUntil(caseRoot, [])
      expect(await home.status()).toMatchObject({ registered: 0, verdict: 'idle' })
    } finally {
      await home.ctx.fiber.dispose()
    }
  })

  it('keeps an unclean one, and the list is what clears it', async () => {
    const caseRoot = temporaryRoot('dsh-pause-unheld-unclean-')
    await recordParkWithoutLog(caseRoot, 'late-unclean', 'draining')

    const home = await reviveTriageHome(caseRoot)
    try {
      await home.harness.create(SessionId('late-unclean'), { provider: 'deepseek-official', model: 'model' })

      // Liveness is not a park outcome: the clean path refuses exactly as it
      // would for a session that is not live at all.
      const refused = await home.run('/pause-resume-all')
      expect(refused.kind, refused.text).toBe('success')
      expect(refused.text).toBe('pause resumed no session; 1 did not pause completely and need your decision.')
      await recordsUntil(caseRoot, [['late-unclean', 'draining']])

      // The row is the user's to decide, and deciding it is what clears the
      // record — the same release order as any other listed session.
      expect((await home.triage()).rows.map(row => row.sessionId)).toEqual(['late-unclean'])
      const decided = await home.decide('late-unclean', 'continue')
      expect(decided.kind, decided.text).toBe('success')
      await recordsUntil(caseRoot, [])
      expect(home.provider.requests).toHaveLength(0)
      expect(await home.status()).toMatchObject({ registered: 0, verdict: 'idle' })
    } finally {
      await home.ctx.fiber.dispose()
    }
  })
})
