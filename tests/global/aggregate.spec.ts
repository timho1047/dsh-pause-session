/**
 * Task 07's second acceptance: the aggregate the whole-app control answers with
 * is honest at every moment.
 *
 * It turns `safe` only when the last registered session reaches the park point,
 * never before. And a session that cannot get there is named: one still draining
 * behind a tool that never finishes, one whose session-level flush failed, and
 * one whose subagent tree this process cannot read at all. The park also names
 * the session it belongs to whatever phase it reached — the clean case included
 * — which is the address a window showing something else reads it through.
 * @module dsh-pause-session/test/global/aggregate
 */

import { afterAll, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PauseTransport } from '../../src/client/remote.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PauseControl } from '../../src/client/control.ts'
import { PauseGlobalControl } from '../../src/client/global.ts'
import { pause, pauseRemote } from '../native-driver.ts'
import { readParkRegistry } from '../registry/read.ts'
import { writeParkRecord } from '../registry/write.ts'
import {
  blockingScript, cleanRoots, mountGlobalHome, settles, storageOf, temporaryRoot, untilAsync,
} from './home.ts'
import type { GlobalHome } from './home.ts'

/** Every temporary root this spec creates, removed once the file settles. */
const temporaryRoots: string[] = []
afterAll(() => { cleanRoots(temporaryRoots) })

const ask = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

/** One client transport over the real native service, with a count of its reads. */
function nativeEye(home: GlobalHome): { transport: PauseTransport; reads: () => number; stop(): void } {
  const listeners = new Set<() => void>()
  const snapshotListeners = new Set<(snapshot: Awaited<ReturnType<PauseTransport['source']['read']>>) => void>()
  const abort = new AbortController()
  let latest: Awaited<ReturnType<PauseTransport['source']['read']>>
  let reads = 0
  const pump = (async () => {
    try {
      for await (const snapshot of pauseRemote(home.ctx).observe(abort.signal)) {
        latest = snapshot as never
        for (const listener of [...listeners]) listener()
        for (const listener of [...snapshotListeners]) listener(latest)
      }
    } catch {
      // The stream was aborted when the spec settled.
    }
  })()
  const remote = pauseRemote(home.ctx)
  return {
    transport: {
      source: {
        read: async (signal) => {
          signal?.throwIfAborted()
          reads += 1
          return latest ?? await remote.snapshot(signal) as never
        },
        onChange: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        onSnapshot: (listener) => {
          snapshotListeners.add(listener)
          return () => { snapshotListeners.delete(listener) }
        },
      },
      act: async (request, signal) => await remote.act(request, signal),
      triage: async (caller, signal) => await remote.triage({ caller }, signal),
      decide: async (caller, target, decision, signal) => await remote.decide({ caller, target, decision }, signal),
    },
    reads: () => reads,
    stop: () => { abort.abort(); void pump },
  }
}

/**
 * How many command executions one session's own durable log holds — the rows a
 * browser read leaves in the transcript it was addressed at.
 * @param home - the mounted process whose session persistence is read.
 * @param sessionId - the session whose log is counted.
 * @returns the number of `command/run` events in that log.
 */
async function commandRuns(home: GlobalHome, sessionId: SessionId): Promise<number> {
  const live = home.ctx.sessions.get(sessionId)
  if (live !== undefined) await home.ctx.sessions.flush(live)
  const persistence = home.ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('pause: this home mounts no session persistence')
  const handle = await persistence.open(sessionId, 'read')
  try {
    return (await handle.read(0, undefined)).events.filter(event => event.type === 'command/run').length
  } finally {
    await handle.close()
  }
}

describe('the aggregate answer', () => {
  it('reaches safe on both readings after a press made while a tool is still running, with no further action', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-agg-cycle-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: blockingScript() })
    const lifetime = new AbortController()
    const headerEye = nativeEye(home)
    const pillEye = nativeEye(home)
    const pill = new PauseGlobalControl(pillEye.transport, lifetime.signal)
    const header = new PauseControl(headerEye.transport, lifetime.signal)
    // The page's wiring: a pushed snapshot applies to both controls directly.
    const offHeader = headerEye.transport.source.onSnapshot((snapshot) => {
      header.apply(snapshot)
      pill.apply(snapshot)
    })
    const offPill = pillEye.transport.source.onSnapshot((snapshot) => {
      header.apply(snapshot)
      pill.apply(snapshot)
    })
    const headerReading = () => header.store.getSnapshot().bySession[String(eveningId)]
    let eveningId: SessionId
    try {
      const evening = await home.create('evening-job')
      eveningId = evening.id
      evening.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 1, 'the tool in flight')

      // Both controls mount the way the page mounts them over this session.
      await header.refresh(evening.id)
      await pill.refresh(evening.id)
      expect(headerReading()).toEqual({ phase: 'active', runningTools: [] })
      expect(pill.store.getSnapshot().global).toMatchObject({ kind: 'reported', status: { registered: 0 } })

      // Another window presses while the tool is still running. This window
      // performs no user action; the stream is what tells it, and the read it
      // buys is the only one it makes for this transition.
      await pause(home.ctx, evening)
      await untilAsync(async () => headerReading()?.phase === 'draining', 'the header to see the press')
      expect(headerReading()).toMatchObject({ phase: 'draining', runningTools: ['gated'] })
      await untilAsync(async () => {
        const reading = pill.store.getSnapshot().global
        return reading?.kind === 'reported' && reading.status.registered === 1
      }, 'the pill to see the press')
      const afterPress = { header: headerEye.reads(), pill: pillEye.reads() }

      // The drain is long — far longer than any burst — and it is not watched:
      // no further transition is announced until the tool lands.
      await settles(3_000)
      expect(headerEye.reads() - afterPress.header, 'the header watched the drain instead of reading its transitions').toBe(0)
      expect(pillEye.reads() - afterPress.pill, 'the pill watched a drain it should have been told about').toBe(0)
      expect(headerReading()).toMatchObject({ phase: 'draining' })

      // The tool lands and the park walks itself to the end. Both transitions
      // announce themselves, so both readings reach the truth without a press, a
      // decision, or any other user action.
      home.blocking.release(0)
      await untilAsync(async () => headerReading()?.phase === 'safe', 'the session reading to reach safe')
      await untilAsync(async () => {
        const reading = pill.store.getSnapshot().global
        return reading?.kind === 'reported' && reading.status.verdict === 'safe'
      }, 'the aggregate reading to reach safe')
      expect(await home.status(evening)).toMatchObject({ verdict: 'safe', registered: 1, safe: 1, parkedAt: 'evening-job', draining: [], parking: 0 })

      // And silence: nothing about a settled park is asked again.
      const settled = { header: headerEye.reads(), pill: pillEye.reads() }
      await settles(500)
      expect({ header: headerEye.reads(), pill: pillEye.reads() }, 'a settled park was read again').toEqual(settled)
    } finally {
      lifetime.abort(new Error('spec over'))
      offHeader()
      offPill()
      headerEye.stop()
      pillEye.stop()
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })

  it('turns safe only once every registered session has parked', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-agg-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: blockingScript() })
    try {
      const first = await home.create('first-job')
      const second = await home.create('second-job')
      first.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 1, 'the first tool in flight')
      second.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 2, 'the second tool in flight')

      expect((await home.run(first, 'pause-all')).ok).toBe(true)
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
    const caseRoot = temporaryRoot('dsh-pause-session-agg-stuck-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: blockingScript() })
    try {
      const stuck = await home.create('stuck-in-a-tool')
      stuck.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 1, 'the tool in flight')

      expect((await home.run(stuck, 'pause-all')).ok).toBe(true)
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
    const caseRoot = temporaryRoot('dsh-pause-session-agg-flush-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: blockingScript(), failingFlush: true })
    try {
      const only = await home.create('flush-fails')
      only.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 1, 'the tool in flight')

      await home.run(only, 'pause-all')
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
    const caseRoot = temporaryRoot('dsh-pause-session-agg-blind-', temporaryRoots)
    // A composition with no subagent service at all: the session itself parks
    // cleanly, but nothing here can vouch for the tree it might have.
    const home = await mountGlobalHome(caseRoot, { subagents: false, script: blockingScript() })
    try {
      const only = await home.create('no-subagent-service')
      only.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 1, 'the tool in flight')

      await home.run(only, 'pause-all')
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

  it('names a record it could not hold instead of counting it as parked', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-agg-unheld-', temporaryRoots)
    // A durable record with no session log behind it — the child killed inside
    // a tool whose log never materialized. The record is real; the session is
    // not readable, so this process cannot hold it, park it, or clear it.
    await writeParkRecord(storageOf(caseRoot), 'gone-session', 'safe')

    const home = await mountGlobalHome(caseRoot, { script: blockingScript() })
    try {
      const reader = await home.create('reader')
      const status = await home.status(reader)
      // Its durable phase says "safe", and the report still may not: nothing in
      // this process is holding it, so "safe to close" would promise a hold
      // that does not exist.
      expect(status.registered).toBe(1)
      expect(status.safe).toBe(0)
      expect(status.stalled).toEqual(['gone-session'])
      expect(status.verdict).toBe('waiting')
      // The only registered session is the one this host cannot hold, and it is
      // still the park's own name: a fact about the park, not an address that
      // has to work.
      expect(status.parkedAt).toBe('gone-session')
      // Reported, not dropped: the durable record is exactly where it was.
      expect((await readParkRegistry(storageOf(caseRoot))).map(entry => [String(entry.sessionId), entry.phase]))
        .toEqual([['gone-session', 'safe']])
    } finally {
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })

  it('names a parked session a read can reach rather than only a record it cannot hold', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-agg-name-', temporaryRoots)
    // A record this host cannot hold is registered before the live park exists,
    // so it is the first session the aggregate walks. It is named in `stalled`
    // like every other record the process cannot hold, and the parked session a
    // client could actually read through is the better address for the park.
    await writeParkRecord(storageOf(caseRoot), 'gone-session', 'safe')

    const home = await mountGlobalHome(caseRoot, { script: blockingScript() })
    try {
      const parked = await home.create('reader')
      parked.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 1, 'the tool in flight')

      await home.run(parked, 'pause-all')
      home.blocking.release(0)
      await untilAsync(async () => (await home.status(parked)).safe === 1, 'the session to park')

      const status = await home.status(parked)
      expect(status.registered).toBe(2)
      expect(status.safe).toBe(1)
      expect(status.stalled).toEqual(['gone-session'])
      expect(status.parkedAt).toBe('reader')
    } finally {
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })

  it('reads the park through the native stream without writing status rows into any session', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-agg-window-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: blockingScript() })
    const lifetime = new AbortController()
    const eye = nativeEye(home)
    const pill = new PauseGlobalControl(eye.transport, lifetime.signal)
    const off = eye.transport.source.onSnapshot(snapshot => { pill.apply(snapshot) })
    try {
      const parked = await home.create('parked-job')
      const bystander = await home.create('bystander-job')
      parked.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 1, 'the tool in flight')

      // This window opens on a session of its own, with the park already clean,
      // and reads once. The stream carries the whole-app answer, so the read
      // costs the same whatever session is on screen.
      await pill.refresh(bystander.id)
      expect(pill.store.getSnapshot().global).toMatchObject({ kind: 'reported' })

      // The other window parks everything, and the park reaches `safe`.
      await home.run(bystander, 'pause-all')
      home.blocking.release(0)
      await untilAsync(async () => (await home.status(bystander)).verdict === 'safe', 'the park to finish cleanly')
      await untilAsync(async () => {
        const reading = pill.store.getSnapshot().global
        return reading?.kind === 'reported' && reading.status.verdict === 'safe'
      }, 'the pill to read the settled park from the stream')

      // Status reads are snapshots: neither transcript gains a command row for
      // them, whoever's window asked.
      expect(await commandRuns(home, bystander.id), 'the uninvolved transcript gained a status row').toBe(0)
      expect(await commandRuns(home, parked.id), 'the parked transcript gained a status row').toBe(0)
    } finally {
      lifetime.abort(new Error('spec over'))
      off()
      eye.stop()
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })
})
