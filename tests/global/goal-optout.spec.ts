/**
 * The queue's gap, closed end to end: a session that stopped CLEANLY can still
 * have its goal opt-out set before the silent morning resume re-arms it.
 *
 * The decision list shows only the records that did NOT stop cleanly, and those
 * are exactly the ones a resume refuses — so the list was never the surface for
 * the clean case, which is the common one and the one where re-arming spends
 * the owner's money on its own. The session's own switch is that surface: the
 * pause marker registers it on the session it changes, the park status carries
 * the record it flips, and the durable record decides what the next process's
 * silent resume may spend.
 *
 * Two processes take part, the way the morning really happens: an evening one
 * that parks a live goal session cleanly and switches the opt-out through the
 * session's own verb, and a fresh one that mounts the same stack over the same
 * logs and registry and has nothing but the silent path to bring it back.
 * @module dsh-pause-session/test/global/goal-optout
 */

import { afterAll, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { decodeParkStatus, GOAL_COMMAND, STATUS_COMMAND } from '../../src/shared.ts'
import { readParkRegistry } from '../registry/read.ts'
import { GOAL_OBJECTIVE } from '../resume/case.ts'
import {
  cleanRoots, mountGlobalHome, settles, storageOf, temporaryRoot, until, untilAsync,
} from './home.ts'

/** Every temporary root this spec creates, removed once the file settles. */
const temporaryRoots: string[] = []
afterAll(() => { cleanRoots(temporaryRoots) })

const ask = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

/**
 * Wait until a fresh read of the registry shows this record's goal opt-out —
 * the same read the next process performs, and the only thing the morning can
 * act on. The backend republishes the unit asynchronously, so the first read
 * after a write can still open the previous document.
 * @param root - the case's storage root.
 * @param sessionId - the record to look for.
 * @param wanted - the opt-out the stored record must show.
 */
async function rearmUntil(root: string, sessionId: string, wanted: boolean): Promise<void> {
  let seen: boolean | undefined
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      seen = (await readParkRegistry(root)).find(entry => String(entry.sessionId) === sessionId)?.rearmGoal
    } catch {
      // A unit being republished is not a failure of the subject; look again.
    }
    if (seen === wanted) return
    await settles(10)
  }
  throw new Error(`the registry never showed "${sessionId}" with rearmGoal ${String(wanted)}; it shows ${String(seen)}`)
}

/**
 * One evening: give a session a goal, let its one turn finish, park it cleanly,
 * and — when the case asks for it — switch the goal opt-out off through the
 * session's own verb. The round driver is deliberately absent so the goal sits
 * still: the park point is then the idle boundary, which is the clean case.
 * @param caseRoot - the case's roots.
 * @param sessionId - the session to park.
 * @param optOut - whether the user switches the goal opt-out off before leaving.
 */
async function parkCleanGoal(caseRoot: string, sessionId: string, optOut: boolean): Promise<void> {
  const evening = await mountGlobalHome(caseRoot, { goals: true, goalRounds: false })
  try {
    const agent = await evening.create(sessionId)
    // Two rounds is enough to see the control case continue and stop on its
    // own, so a case never depends on how fast the fake route runs out.
    evening.ctx.goals.create(agent, { objective: GOAL_OBJECTIVE, maxGoalRounds: 2 })
    agent.followup(ask('start the work'))
    await agent.whenIdle()

    expect((await evening.run(agent, 'pause')).kind).toBe('success')
    await untilAsync(async () => (await evening.status(agent)).verdict === 'safe', 'the clean park to settle')
    expect((await readParkRegistry(storageOf(caseRoot))).map(entry => [String(entry.sessionId), entry.phase]))
      .toEqual([[sessionId, 'safe']])

    if (optOut) {
      // The switch is this session's own verb, and the pause marker is what
      // registered it: no listed row takes part.
      const switched = await evening.run(agent, GOAL_COMMAND)
      expect(switched.kind, switched.text).toBe('success')
      const read = await evening.run(agent, STATUS_COMMAND)
      const status = read.text === undefined ? undefined : decodeParkStatus(read.text)
      expect(status?.rearmGoal).toBe(false)
      await rearmUntil(storageOf(caseRoot), sessionId, false)
    }
    await evening.flush()
  } finally {
    await evening.ctx.fiber.dispose()
  }
}

describe('the goal opt-out of a cleanly parked session', () => {
  it('leaves the goal disarmed when the clean record opted out through its own switch', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-global-goal-off-', temporaryRoots)
    await parkCleanGoal(caseRoot, 'evening-goal-off', true)

    // The morning: nothing is live, so the silent path is the only thing that
    // can bring the session back — and the record is the only thing it obeys.
    const morning = await mountGlobalHome(caseRoot, { goals: true })
    try {
      const desk = await morning.create('morning-desk')
      const answer = await morning.run(desk, 'pause-resume-all')
      expect(answer.kind, JSON.stringify(answer)).toBe('success')
      const agent = morning.ctx.agents.get(SessionId('evening-goal-off'))
      expect(agent, 'the cleanly parked session was not resumed').toBeDefined()

      // The session comes back — only its goal stays closed, so the resume
      // spends nothing beyond the request the session already owed (none: it
      // stopped at an idle boundary with its last answer written).
      expect(morning.ctx.goals.get(agent!)?.activation).toBe('disarmed')
      await settles(100)
      expect(morning.ctx.goals.get(agent!)?.roundsStarted).toBe(0)
      expect(morning.provider.requests).toHaveLength(0)
    } finally {
      await morning.ctx.fiber.dispose()
    }
  })

  it('re-opens the goal when the clean record was left at the default', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-global-goal-on-', temporaryRoots)
    await parkCleanGoal(caseRoot, 'evening-goal-on', false)

    // The control: the same park, the same silent resume, no opt-out written.
    // The default is unchanged — a goal session comes back running its rounds.
    const morning = await mountGlobalHome(caseRoot, { goals: true })
    try {
      const desk = await morning.create('morning-desk')
      const answer = await morning.run(desk, 'pause-resume-all')
      expect(answer.kind, JSON.stringify(answer)).toBe('success')
      const agent = morning.ctx.agents.get(SessionId('evening-goal-on'))
      expect(agent, 'the cleanly parked session was not resumed').toBeDefined()
      await until(() => morning.ctx.goals.get(agent!)?.activation === 'armed', 'the goal to come back')
      await until(() => (morning.ctx.goals.get(agent!)?.roundsStarted ?? 0) >= 1, 'the goal rounds to continue')
      await until(() => morning.provider.requests.length >= 1, 'the round reaching the model')
    } finally {
      await morning.ctx.fiber.dispose()
    }
  })
})
