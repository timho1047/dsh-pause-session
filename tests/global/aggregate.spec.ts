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
 * @module dsh-safe-stop/test/global/aggregate
 */

import { afterAll, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SafeStopControl } from '../../src/client/control.ts'
import { SafeStopGlobalControl } from '../../src/client/global.ts'
import { STATE_ALL_COMMAND, STATUS_COMMAND } from '../../src/shared.ts'
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

/** What the browser paid the host: one count per read a control can make. */
interface EyeReads {
  /** `commands.list` calls: one per session header read. */
  readonly lists: number
  /** `safe-state` executions: the per-session status the header control reads. */
  readonly status: number
  /** `safe-state-all` executions: the aggregate the pill reads. */
  readonly aggregate: number
  /**
   * The session each aggregate read was addressed at, in order: a read leaves
   * its two durable rows in the transcript it was taken through, so this is
   * where those rows landed.
   */
  readonly aggregateAt: readonly string[]
}

/**
 * The browser's command Remote over this process's own command registry, so a
 * spec can drive the real client controls against the real host. The only part
 * of the page's wiring that does not travel is the transport: the forwarded
 * `commands/change` is delivered through `ctx.on`, exactly as the harness
 * forwards it.
 * @param home - the mounted process whose registry the controls talk through.
 * @returns the Remote face the controls take, and a running count of the reads it served.
 */
function clientEye(home: GlobalHome): { readonly commands: never; readonly reads: () => EyeReads } {
  const reads = { lists: 0, status: 0, aggregate: 0, aggregateAt: [] as string[] }
  const commands = {
    list: (sessionId: SessionId) => {
      reads.lists += 1
      const agent = home.ctx.agents.get(sessionId)
      if (agent === undefined) return Promise.resolve({ ok: false, error: { code: 'gateway/internal' } })
      return Promise.resolve({ ok: true, value: home.ctx.commands.list(agent) })
    },
    execute: async (sessionId: SessionId, line: string, _attachments: unknown, signal: AbortSignal) => {
      if (line === `/${STATE_ALL_COMMAND}`) {
        reads.aggregate += 1
        reads.aggregateAt.push(String(sessionId))
      } else if (line === `/${STATUS_COMMAND}`) reads.status += 1
      const agent = home.ctx.agents.get(sessionId)
      if (agent === undefined) return { ok: false, error: { code: 'gateway/internal' } }
      const execution = await home.ctx.commands.execute(agent, line, [], signal)
      return execution === undefined
        ? { ok: false, error: { code: 'gateway/internal' } }
        : { ok: true, value: execution }
    },
  }
  return { commands: commands as never, reads: () => ({ ...reads, aggregateAt: [...reads.aggregateAt] }) }
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
  if (persistence === undefined) throw new Error('safe-stop: this home mounts no session persistence')
  const handle = await persistence.open(sessionId, 'read')
  try {
    return (await handle.read(0, undefined)).events.filter(event => event.type === 'command/run').length
  } finally {
    await handle.close()
  }
}

describe('the aggregate answer', () => {
  it('reaches safe on both readings after a press made while a tool is still running, with no further action', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-agg-cycle-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: blockingScript() })
    const lifetime = new AbortController()
    const eye = clientEye(home)
    // The page's two controls, on burst timings a spec can wait out.
    const pill = new SafeStopGlobalControl(eye.commands, lifetime.signal, 25, { visible: () => true })
    const header = new SafeStopControl(
      eye.commands, lifetime.signal, 25, { visible: () => true },
      () => pill.store.getSnapshot().global,
    )
    home.ctx.on('commands/change', () => { header.refreshAll(); pill.refreshAll() })
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
      const atMount = eye.reads()

      // The user presses the session control while the tool is still running. The
      // pill did not press, so the changes the press causes are news to it and it
      // reads them once; the header's own read answers the header.
      await header.toggle(evening.id)
      expect(headerReading()).toMatchObject({ phase: 'draining', runningTools: ['gated'] })
      await settles(200)
      const afterPress = eye.reads()
      expect(afterPress.aggregate - atMount.aggregate, 'the pill did not read the park the press started').toBe(1)

      // The drain is long — far longer than any burst — and it is not watched.
      // The header owes one look at the close of its own echo window, because a
      // park can finish inside that window and never announce anything again;
      // the pill owes nothing at all, because the end of a drain announces
      // itself.
      await settles(3_000)
      expect(eye.reads().status - afterPress.status, 'the header watched the drain instead of reading its transitions').toBe(1)
      expect(eye.reads().aggregate - afterPress.aggregate, 'the pill watched a drain it should have been told about').toBe(0)
      expect(headerReading()).toMatchObject({ phase: 'draining' })

      // The tool lands and the park walks itself to the end. Both transitions
      // announce themselves, so both readings reach the truth without a press, a
      // decision, or any other user action — this is the read the pill used to be
      // missing while it still said "finishing up".
      home.blocking.release(0)
      await untilAsync(async () => headerReading()?.phase === 'safe', 'the session reading to reach safe')
      await untilAsync(async () => {
        const reading = pill.store.getSnapshot().global
        return reading?.kind === 'reported' && reading.status.verdict === 'safe'
      }, 'the aggregate reading to reach safe')

      // One read per announced transition, never a watch: the park point and the
      // flush are two transitions, so at most two reads each — and the pill, which
      // followed the drain by being told, spends fewer than the header that had to
      // close its own echo window.
      const followed = eye.reads()
      expect(followed.status - afterPress.status, 'the header read more than its look and one read per transition')
        .toBeLessThanOrEqual(3)
      expect(followed.aggregate - afterPress.aggregate, 'the pill read more than one read per transition')
        .toBeLessThanOrEqual(2)
      expect(followed.aggregate - afterPress.aggregate, 'the pill never read the park it was told about')
        .toBeGreaterThanOrEqual(1)
      expect(await home.status(evening)).toMatchObject({ verdict: 'safe', registered: 1, safe: 1, parkedAt: 'evening-job', draining: [], parking: 0 })

      // And silence: nothing about a settled park is asked again.
      const settled = eye.reads()
      await settles(500)
      expect(eye.reads(), 'a settled park was read again').toEqual(settled)
    } finally {
      lifetime.abort(new Error('spec over'))
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })

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

  it('names a record it could not hold instead of counting it as parked', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-agg-unheld-', temporaryRoots)
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
    const caseRoot = temporaryRoot('dsh-safe-stop-agg-name-', temporaryRoots)
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

      await home.run(parked, 'safe-stop-all')
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

  it('keeps a clean park\'s rows in the parked session, not in the window that reads them', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-agg-window-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: blockingScript() })
    const lifetime = new AbortController()
    const eye = clientEye(home)
    const pill = new SafeStopGlobalControl(eye.commands, lifetime.signal, 25, { visible: () => true })
    home.ctx.on('commands/change', () => { pill.refreshAll() })
    try {
      const parked = await home.create('parked-job')
      const bystander = await home.create('bystander-job')
      parked.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 1, 'the tool in flight')

      // The other window parks everything, and the park reaches `safe`: nothing
      // is draining, stalled, unresumable or unread, so the park's own name is
      // the only thing in the answer that says which session it belongs to.
      await home.run(bystander, 'safe-stop-all')
      home.blocking.release(0)
      await untilAsync(async () => (await home.status(bystander)).verdict === 'safe', 'the park to finish cleanly')

      // This window opens on a session of its own, with the park already clean,
      // and reads once. That first read cannot know where the park is — the
      // answer it gets is what tells it — and it is the only aggregate read the
      // uninvolved session pays for.
      await pill.refresh(bystander.id)
      expect(eye.reads().aggregateAt).toEqual([String(bystander.id)])
      const paidByBystander = await commandRuns(home, bystander.id)
      expect(paidByBystander, 'the uninvolved session paid for nothing at all').toBeGreaterThan(0)

      // The other window resumes the park. The forwarded change reaches this
      // window, and the read it buys goes through the session the park belonged
      // to — the transcript the rows are about — while the session this window
      // is showing gains nothing.
      await home.run(parked, 'safe-resume-all')
      await untilAsync(async () => eye.reads().aggregateAt.length > 1, 'the forwarded change to be read')
      const addresses = eye.reads().aggregateAt
      expect(new Set(addresses.slice(1)), 'a row about the park landed in the session on screen')
        .toEqual(new Set([String(parked.id)]))
      expect(await commandRuns(home, bystander.id), 'the uninvolved transcript gained a row')
        .toBe(paidByBystander)
    } finally {
      lifetime.abort(new Error('spec over'))
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })
})
