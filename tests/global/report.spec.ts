/**
 * Task 07's third acceptance: the report names what it cannot do, from the real
 * sources that know.
 *
 * The one-shot fact comes from the parent catalog's own descendant rows (the
 * harness's durable record of whether a child survives a restart); the job fact
 * comes from the job registry, where background work lives outside the agent
 * loop entirely. What is asserted is the report a user reads, decoded the way
 * the browser control decodes it.
 * @module dsh-pause/test/global/report
 */

import { afterAll, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { decodeGlobalStatus } from '../../src/shared.ts'
import {
  blockingScript, cleanRoots, mountGlobalHome, settles, temporaryRoot, untilAsync,
} from './home.ts'

/** Every temporary root this spec creates, removed once the file settles. */
const temporaryRoots: string[] = []
afterAll(() => { cleanRoots(temporaryRoots) })

const ask = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

describe('the whole-app report', () => {
  it('names a tree on a one-shot route and a background job, and still says it is safe', async () => {
    const caseRoot = temporaryRoot('dsh-pause-report-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: blockingScript() })
    let job: ReturnType<typeof home.job> | undefined
    try {
      const parent = await home.create('bridge-user')
      const child = await home.create('one-shot-child')
      // A job's owner must be a live session: this is the shell a background
      // command started from the parent's own agent, long before the press.
      job = home.job(parent.id, 'npm run build')
      // The parent's catalog records a route that cannot be resumed after a
      // restart: the child is destroyed when its run ends, and cold resume
      // refuses it. The work itself cannot be continued — only reported.
      parent.session.append('subagent/catalog', {
        version: 0,
        childId: child.session.id,
        childCreatedAt: child.session.header.createdAt,
        mode: 'one-shot',
        label: 'bridge',
      })
      // The catalog row is what the tree walk reads; the child's own descriptor
      // is what proves the route cannot be resumed. A real historical one-shot
      // child has both, and the press must leave it out of the registry rather
      // than promise a wake the morning path would refuse.
      child.session.append('subagent/descriptor', snapshotSubagentDescriptor({
        mode: 'one-shot',
        provider: 'spawn',
        label: 'bridge',
      }))
      parent.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 1, 'the tool in flight')

      await home.run(parent, 'pause-all')
      home.blocking.release(0)
      await untilAsync(async () => (await home.status(parent)).verdict === 'safe', 'the whole tree to park')

      const status = await home.status(parent)
      // The one-shot child is named by the tree report but never registered:
      // its route has no resume that could satisfy a park record.
      expect(status.registered).toBe(1)
      expect(status.safe).toBe(1)
      expect(status.blind).toEqual([])
      expect(status.unresumable).toEqual(['bridge-user'])
      expect(status.jobs).toEqual([job.id])

      // The report a user reads says both things, and says them about the very
      // read that also says the lid can be closed.
      const answer = await home.run(parent, 'pause-state-all')
      const decoded = answer.text === undefined ? undefined : decodeGlobalStatus(answer.text)
      expect(decoded?.verdict).toBe('safe')
      expect(answer.text).toContain('unresumable: bridge-user')
      expect(answer.text).toContain(`jobs: ${job!.id}`)

      // The background job is outside the agent loop: nothing this park did
      // stopped it, and it is still running after the park finished.
      expect(home.ctx.jobs.list(parent.id).map(view => [String(view.id), view.status]))
        .toEqual([[job!.id, 'running']])

      // The report is as of the read: a settled job stops being named.
      job!.finish()
      await settles(30)
      expect((await home.status(parent)).jobs).toEqual([])
    } finally {
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })

  it('names no route when every child can be resumed', async () => {
    const caseRoot = temporaryRoot('dsh-pause-report-clean-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: blockingScript() })
    try {
      const parent = await home.create('plain-parent')
      const child = await home.create('continuable-child')
      parent.session.append('subagent/catalog', {
        version: 0,
        childId: child.session.id,
        childCreatedAt: child.session.header.createdAt,
        mode: 'continuable',
        label: 'continuable child',
      })
      parent.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 1, 'the tool in flight')

      await home.run(parent, 'pause-all')
      home.blocking.release(0)
      await untilAsync(async () => (await home.status(parent)).verdict === 'safe', 'the whole tree to park')

      const status = await home.status(parent)
      expect(status.registered).toBe(2)
      expect(status.unresumable).toEqual([])
      expect(status.unreadTrees).toEqual([])
      expect(status.jobs).toEqual([])
    } finally {
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })
})
