/**
 * Task 06's goal acceptance: a session parked with a live goal comes back
 * running its rounds, and a record that opted out comes back without spending
 * anything.
 *
 * A goal's activation is process-local — it is not part of the durable goal —
 * so a restart leaves a healthy active goal disarmed. Resuming a cleanly parked
 * session re-arms exactly that case, and only when the session's own registry
 * record still allows it. The round driver is mounted here, as it is in the
 * shipped composition, so "the rounds continue" is observed as real model
 * requests rather than as an activation flag.
 * @module dsh-pause/test/resume/goal-resume
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { readParkRegistry } from '../registry/read.ts'
import { GOAL_OBJECTIVE } from './case.ts'
import { ensureHostEntry } from './build.ts'
import { parkAndLeave, resumeAll, reviveHome, settles, storageOf, until } from './home.ts'
import { setGoalRearm } from './registry.ts'

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

describe('a parked session with a goal', () => {
  it('re-arms the goal and keeps its rounds going', async () => {
    const caseRoot = temporaryRoot('dsh-pause-resume-goal-')
    const parked = await parkAndLeave(caseRoot, 'overnight-goal', 'goal')
    expect(parked.request, 'the child finished its ordinary turn before parking').toBeDefined()

    const home = await reviveHome(caseRoot, { goals: true })
    try {
      expect(await resumeAll(home)).toBe('pause resumed 1 session from where it stopped.')
      const agent = home.ctx.agents.get(SessionId('overnight-goal'))
      expect(agent, 'the parked session was not activated').toBeDefined()

      // The restart dropped the process-local activation; the resume put it back
      // without touching the durable phase.
      const goal = home.ctx.goals.get(agent!)
      expect(goal?.phase).toBe('active')
      expect(goal?.activation).toBe('armed')

      // And the rounds really continue: the driver queues round 1 for the
      // re-armed goal, the model answers, the next round follows.
      await until(() => home.provider.requests.length >= 2, 'the goal rounds reaching the model')
      expect(JSON.stringify(home.provider.requests[0]?.messages)).toContain(GOAL_OBJECTIVE)
      expect(home.ctx.goals.get(agent!)?.roundsStarted).toBeGreaterThanOrEqual(2)
    } finally {
      await home.ctx.fiber.dispose()
    }
  })

  it('leaves the goal closed when the record opted out, and spends nothing', async () => {
    const caseRoot = temporaryRoot('dsh-pause-resume-goal-optout-')
    await parkAndLeave(caseRoot, 'overnight-goal-off', 'goal')
    // The opt-out is durable state of the parked session, written the way the
    // host control writes it — before the morning process mounts.
    await setGoalRearm(storageOf(caseRoot), 'overnight-goal-off', false)
    expect((await readParkRegistry(storageOf(caseRoot))).map(entry => [String(entry.sessionId), entry.rearmGoal]))
      .toEqual([['overnight-goal-off', false]])

    const home = await reviveHome(caseRoot, { goals: true })
    try {
      expect(await resumeAll(home)).toBe('pause resumed 1 session from where it stopped.')
      const agent = home.ctx.agents.get(SessionId('overnight-goal-off'))
      // The session is resumed — only its goal stays closed.
      expect(agent).toBeDefined()
      expect(home.ctx.goals.get(agent!)?.activation).toBe('disarmed')
      await settles()
      expect(home.provider.requests).toHaveLength(0)
      expect(home.ctx.goals.get(agent!)?.roundsStarted).toBe(0)
    } finally {
      await home.ctx.fiber.dispose()
    }
  })
})
