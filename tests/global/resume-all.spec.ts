/**
 * Task 07's fourth acceptance: resume-all is one release, and a child is
 * released after the parent it hangs from.
 *
 * Two processes take part. The first parks a real tree — a parent with a
 * subagent child, both in flight — through the whole-app press; the second
 * mounts the same stack over the same logs and registry with no agent alive at
 * all, so every session is activated from its own stored log by the one press.
 * That is the case the ordering exists for: waking a child needs its direct
 * parent to be live first.
 * @module dsh-pause-session/test/global/resume-all
 */

import { afterAll, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { readParkRegistry } from '../registry/read.ts'
import {
  blockingScript, cleanRoots, mountGlobalHome, storageOf, temporaryRoot, until, untilAsync,
} from './home.ts'

/** Every temporary root this spec creates, removed once the file settles. */
const temporaryRoots: string[] = []
afterAll(() => { cleanRoots(temporaryRoots) })

const ask = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

const PARENT = SessionId('resume-parent')
const CHILD = SessionId('resume-child')
const SOLO = SessionId('resume-solo')

describe('resume all after a park', () => {
  it('releases every registered session at once, parents before children', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-resume-all-', temporaryRoots)

    // One process: park a real tree plus a session that hangs from nothing.
    const before = await mountGlobalHome(caseRoot, { script: blockingScript() })
    try {
      const parent = await before.create(String(PARENT))
      const child = await before.create(String(CHILD))
      const solo = await before.create(String(SOLO))
      parent.session.append('subagent/catalog', {
        version: 0,
        childId: child.session.id,
        childCreatedAt: child.session.header.createdAt,
        mode: 'continuable',
        label: 'continuable child',
      })
      parent.followup(ask('parent work'))
      child.followup(ask('child work'))
      solo.followup(ask('solo work'))
      await untilAsync(async () => before.blocking.started() === 3, 'three tools in flight')

      expect((await before.run(solo, 'pause-all')).ok).toBe(true)
      before.blocking.releaseAll()
      await untilAsync(async () => (await before.status(solo)).verdict === 'safe', 'the whole park to settle')
      expect((await readParkRegistry(storageOf(caseRoot))).map(entry => [String(entry.sessionId), entry.phase]).sort())
        .toEqual([['resume-child', 'safe'], ['resume-parent', 'safe'], ['resume-solo', 'safe']])
      // Everything the next process will read has to be on disk first.
      await before.flush()
    } finally {
      before.blocking.releaseAll()
      await before.ctx.fiber.dispose()
    }

    // The next morning: nothing is live, and one press brings it all back.
    const home = await mountGlobalHome(caseRoot, { script: blockingScript() })
    try {
      expect(home.ctx.agents.get(PARENT)).toBeUndefined()
      expect(home.ctx.agents.get(CHILD)).toBeUndefined()
      expect(home.ctx.agents.get(SOLO)).toBeUndefined()
      const desk = await home.create('morning-desk')
      // Recorded after the desk exists, so the log holds exactly what the one
      // press created.
      const created: { id: string; parentLive: boolean }[] = []
      home.ctx.on('agent/created', ({ agent }) => {
        const parentId = agent.id === CHILD ? PARENT : undefined
        created.push({
          id: String(agent.id),
          parentLive: parentId === undefined ? true : home.ctx.agents.get(parentId) !== undefined,
        })
        return undefined
      })

      const answer = await home.run(desk, 'pause-resume-all')
      expect(answer.ok, JSON.stringify(answer)).toBe(true)
      expect(answer.message).toBe('pause resumed 3 sessions from where they stopped.')

      // One press released all three: every session is live afterwards.
      await until(() => home.ctx.agents.get(PARENT) !== undefined, 'the parent to come back')
      expect(home.ctx.agents.get(CHILD), 'the child did not come back with the same press').toBeDefined()
      expect(home.ctx.agents.get(SOLO), 'the solo session did not come back with the same press').toBeDefined()

      // The tree edge is a real one from the catalog, and it held: the child's
      // agent did not exist before its direct parent was live. That is also why
      // it came back *under* its parent rather than as a second root — the
      // check a release that fired the whole batch at once could not pass.
      expect(created.map(entry => entry.id).sort()).toEqual(['resume-child', 'resume-parent', 'resume-solo'])
      expect(created.find(entry => entry.id === 'resume-child')?.parentLive).toBe(true)
      expect(created.findIndex(entry => entry.id === 'resume-parent'))
        .toBeLessThan(created.findIndex(entry => entry.id === 'resume-child'))
      const parentAgent = home.ctx.agents.get(PARENT)
      const childAgent = home.ctx.agents.get(CHILD)
      expect(parentAgent).toBeDefined()
      expect(childAgent).toBeDefined()
      expect(home.ctx.agents.isOwnedBy(CHILD, parentAgent!)).toBe(true)

      // Each returned session answers the input it stopped in front of, so the
      // release really released them rather than just opening their logs.
      await until(() => home.provider.requests.length >= 3, 'the woken sessions to reach the route')

      // The release is durable: the next process does not re-hold a session the
      // user has already resumed.
      expect(await readParkRegistry(storageOf(caseRoot))).toEqual([])
    } finally {
      await home.ctx.fiber.dispose()
    }
  })
})
