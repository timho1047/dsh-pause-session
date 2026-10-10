/**
 * The goal opt-out, as the user reaches it: a listed session's own row.
 *
 * Re-opening a goal is the one thing a resume spends without the user watching
 * it, so it is opt-OUT per session, and the flag has to have a real user path:
 * the row in the morning list, which is already bound to the session that read
 * it. What is asserted here is the effect the user can see — the goal stays
 * closed and the rounds never start — plus the default it must not change.
 * @module dsh-safe-stop/test/triage/goal
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ensureHostEntry } from '../resume/build.ts'
import { parkAndLeave, recordsUntil, reviveTriageHome, settles, storageOf, until } from './home.ts'
import { readParkRegistry } from '../registry/read.ts'

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

describe('the listed goal opt-out', () => {
  it('closes the goal across the next resume, and the rounds never start', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-triage-goal-off-')
    await parkAndLeave(caseRoot, 'goal-unclean-off', 'goal-draining')

    const home = await reviveTriageHome(caseRoot, { goals: true })
    try {
      // The row says the goal would be re-opened, which is the product default.
      const before = await home.triage()
      expect(before.rows.map(row => [row.sessionId, row.rearmGoal])).toEqual([['goal-unclean-off', true]])

      // The user turns it off on that row. The list is what shows the row, and
      // the caller's own read is what makes it actionable.
      const flipped = await home.decide('goal-unclean-off', 'goal')
      expect(flipped.kind, flipped.text).toBe('success')
      expect(await readParkRegistry(storageOf(caseRoot)))
        .toEqual([expect.objectContaining({ sessionId: SessionId('goal-unclean-off'), rearmGoal: false })])
      // The host answers by reading, not by assuming: the row now says off.
      expect((await home.triage()).rows.map(row => row.rearmGoal)).toEqual([false])

      // The next resume of that session is the decision on its row, and the
      // opt-out is what it obeys.
      const continued = await home.decide('goal-unclean-off', 'continue')
      expect(continued.kind, continued.text).toBe('success')
      const agent = home.ctx.agents.get(SessionId('goal-unclean-off'))
      expect(agent, 'the decision did not resume the session').toBeDefined()
      // The session resumes — only its goal stays closed, and therefore spends
      // nothing beyond the request the interrupted step already owed.
      expect(home.ctx.goals.get(agent!)?.activation).toBe('disarmed')
      await settles(100)
      expect(home.ctx.goals.get(agent!)?.roundsStarted).toBe(0)
      await recordsUntil(caseRoot, [])
    } finally {
      await home.ctx.fiber.dispose()
    }
  })

  it('re-opens the goal when the row was left at the default', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-triage-goal-on-')
    await parkAndLeave(caseRoot, 'goal-unclean-on', 'goal-draining')

    const home = await reviveTriageHome(caseRoot, { goals: true })
    try {
      // The control: the same park, the same decision, no opt-out written. The
      // default is unchanged — a goal session comes back running its rounds.
      expect((await home.triage()).rows.map(row => row.rearmGoal)).toEqual([true])
      const continued = await home.decide('goal-unclean-on', 'continue')
      expect(continued.kind, continued.text).toBe('success')
      const agent = home.ctx.agents.get(SessionId('goal-unclean-on'))
      expect(agent).toBeDefined()
      await until(() => home.ctx.goals.get(agent!)?.activation === 'armed', 'the goal to come back')
      await until(() => (home.ctx.goals.get(agent!)?.roundsStarted ?? 0) >= 1, 'the goal rounds to continue')
    } finally {
      await home.ctx.fiber.dispose()
    }
  })
})
