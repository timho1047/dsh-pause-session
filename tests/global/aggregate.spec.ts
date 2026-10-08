/**
 * Task 07's second acceptance: the aggregate the whole-app control answers with
 * is honest at every moment.
 *
 * It turns `safe` only when the last registered session reaches the park point,
 * never before. And a session that cannot get there is named: one still draining
 * behind a tool that never finishes, one whose session-level flush failed, and
 * one whose subagent tree this process cannot read at all.
 * @module dsh-safe-stop/test/global/aggregate
 */

import { afterAll, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readParkRegistry } from '../registry/read.ts'
import {
  blockingScript, cleanRoots, mountGlobalHome, settles, storageOf, temporaryRoot, untilAsync,
} from './home.ts'

/** Every temporary root this spec creates, removed once the file settles. */
const temporaryRoots: string[] = []
afterAll(() => { cleanRoots(temporaryRoots) })

const ask = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

describe('the aggregate answer', () => {
  it('turns safe only once every registered session has parked', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-agg-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: blockingScript() })
    try {
      const first = await home.create('first-job')
      const second = await home.create('second-job')
      first.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 1, 'the first tool in flight')
      second.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 2, 'the second tool in flight')

      expect((await home.run(first, 'safe-stop-all')).kind).toBe('success')
      const pressed = await home.status(first)
      expect(pressed.verdict).toBe('waiting')
      expect(pressed.registered).toBe(2)
      expect(pressed.safe).toBe(0)
      expect(pressed.draining).toEqual(['first-job', 'second-job'])

      // The first tool lands: that session's next request stops at the gate and
      // its park is written. One of two is not safe.
      home.blocking.release(0)
      await untilAsync(async () => (await home.status(first)).safe === 1, 'the first session to park')
      const half = await home.status(first)
      expect(half.verdict).toBe('waiting')
      expect(half.safe).toBe(1)
      expect(half.draining).toEqual(['second-job'])

      // The last one lands too, and only now does the answer flip.
      home.blocking.release(1)
      await untilAsync(async () => (await home.status(first)).verdict === 'safe', 'the last session to park')
      const safe = await home.status(first)
      expect(safe.registered).toBe(2)
      expect(safe.safe).toBe(2)
      expect(safe.draining).toEqual([])
      expect(safe.stalled).toEqual([])

      // The held requests never reached the route: nothing was sent to release
      // them, and nothing claims the sessions continued.
      expect(home.provider.requests).toHaveLength(2)
    } finally {
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })

  it('names a session that never reaches the park point instead of dropping it', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-agg-stuck-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: blockingScript() })
    try {
      const stuck = await home.create('stuck-in-a-tool')
      stuck.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 1, 'the tool in flight')

      expect((await home.run(stuck, 'safe-stop-all')).kind).toBe('success')
      // Time passing is the point: the aggregate must keep saying "waiting, and
      // here is who" rather than rounding the park up to a number that forgets
      // the session it could not park.
      await settles(120)
      const status = await home.status(stuck)
      expect(status.verdict).toBe('waiting')
      expect(status.registered).toBe(1)
      expect(status.safe).toBe(0)
      expect(status.draining).toEqual(['stuck-in-a-tool'])
      expect(status.stalled).toEqual([])
    } finally {
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })

  it('moves a session whose flush failed out of the count and never calls it clean', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-agg-flush-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: blockingScript(), failingFlush: true })
    try {
      const only = await home.create('flush-fails')
      only.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 1, 'the tool in flight')

      await home.run(only, 'safe-stop-all')
      expect((await home.status(only)).draining).toEqual(['flush-fails'])

      // The tool lands and the session reaches the park point, but the flush
      // that would make the park durable fails. It stops being "on its way" and
      // becomes a session the user has to decide about — named either way.
      home.blocking.release(0)
      await untilAsync(async () => (await home.status(only)).stalled.length === 1, 'the failed flush to land')
      const status = await home.status(only)
      expect(status.verdict).toBe('waiting')
      expect(status.safe).toBe(0)
      expect(status.draining).toEqual([])
      expect(status.stalled).toEqual(['flush-fails'])
      expect((await readParkRegistry(storageOf(caseRoot))).map(entry => entry.phase)).toEqual(['flush-failed'])
    } finally {
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })

  it('refuses to call the park safe when a subagent tree could not be read', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-agg-blind-', temporaryRoots)
    // A composition with no subagent service at all: the session itself parks
    // cleanly, but nothing here can vouch for the tree it might have.
    const home = await mountGlobalHome(caseRoot, { subagents: false, script: blockingScript() })
    try {
      const only = await home.create('no-subagent-service')
      only.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 1, 'the tool in flight')

      await home.run(only, 'safe-stop-all')
      home.blocking.release(0)
      await untilAsync(async () => (await home.status(only)).safe === 1, 'the session to park')

      const status = await home.status(only)
      // The park itself is real and counted; what is missing is any evidence
      // about the tree, and the verdict refuses to round that up.
      expect(status.safe).toBe(1)
      expect(status.blind).toEqual(['trees'])
      expect(status.unreadTrees).toEqual(['no-subagent-service'])
      expect(status.verdict).toBe('waiting')
    } finally {
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })
})
