/**
 * The price of watching: what a control that re-reads the host costs while
 * nothing moves, and what it costs when something does.
 *
 * Every re-read is a host round-trip and two durable `command/run|done` records
 * in the address session's log, so "how often does the browser ask again" is a
 * product decision, not an implementation detail. These cases drive the real
 * controls against a command double and count the reads, with the clock faked
 * so a night of waiting costs no real time.
 *
 * What is asserted is what the user can see: the pill and the panel keep
 * showing the host's last answer at every point, and the asking stops.
 *
 * The numbers here are the product decision, so the cases state them: one park
 * transition costs one burst however many `commands/change` events announce it
 * (the registry emits up to three marker registrations per parked session, and
 * one measured park cycle produced 21 reads in ~2 minutes, in ~5 burst
 * sequences); a press followed by a long drain costs the press read and the
 * burst read that finds the work in flight, and nothing more until the park
 * announces its next transition; and a session the user merely views pays
 * nothing once the park's own address is known.
 * @module dsh-safe-stop/test/global/poll-budget
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply, inject } from '../../src/client/index.tsx'
import { ReadBurst, burstWaits } from '../../src/client/burst.ts'
import type { BurstPolicy } from '../../src/client/burst.ts'
import { SafeStopControl } from '../../src/client/control.ts'
import { SafeStopGlobalControl, registeredAddress } from '../../src/client/global.ts'
import type { GlobalReading } from '../../src/client/global.ts'
import { globalStopView } from '../../src/client/view.ts'
import {
  encodeGlobalStatus, encodeParkStatus, encodeTriageList, RESUME_COMMAND, RESUME_DEFINITION_ID,
  STATE_ALL_COMMAND, STATUS_COMMAND, STATUS_DEFINITION_ID, STOP_ALL_COMMAND, TRIAGE_COMMAND,
} from '../../src/shared.ts'
import type { GlobalStatus, ParkPhase, TriageRow } from '../../src/shared.ts'

const ADDRESS = SessionId('poll-address')
const OTHER = SessionId('unrelated-session')

/** One whole-app status, spelled the way the host spells it. */
function status(overrides: Partial<GlobalStatus> = {}): GlobalStatus {
  return {
    verdict: 'waiting',
    registered: 1,
    safe: 0,
    draining: ['overnight'],
    parking: 0,
    stalled: [],
    unresumable: [],
    unreadTrees: [],
    jobs: [],
    blind: [],
    ...overrides,
  }
}

/** One listed row, as the host would publish it, for the panel's own reads. */
function drainingRow(): TriageRow {
  return {
    sessionId: 'overnight',
    phase: 'draining',
    updatedAt: 0,
    reading: 'read',
    traces: [],
    owed: false,
    wakeable: false,
    rearmGoal: true,
  }
}

/** One execute call the browser made: which session it went through, and what it ran. */
interface Call {
  readonly session: string
  readonly line: string
}

/** Host-side truth a test drives, plus the calls the browser made. */
interface Host {
  answered: GlobalStatus | undefined
  /** Every execution fails, as a host that cannot be reached at all. */
  fail: boolean
  /** Sessions whose executions fail, as one whose agent is gone does. */
  readonly unreachable: Set<string>
  readonly calls: Call[]
  reads: number
  triageReads: number
  /** Sessions the per-session control asked for its command registry through. */
  readonly listed: string[]
}

/**
 * A stand-in for `ctx.remote.commands` that answers like the host registry does
 * and records every execution it was asked for. The two whole-app verbs flip
 * the host's state the way the real commands do.
 */
function hostDouble(): { commands: never; host: Host } {
  const host: Host = {
    answered: undefined, fail: false, unreachable: new Set(), calls: [], reads: 0, triageReads: 0, listed: [],
  }
  const commands = {
    list: (sessionId: SessionId) => {
      host.listed.push(String(sessionId))
      return Promise.resolve({ ok: true, value: [] })
    },
    execute: (sessionId: SessionId, line: string) => {
      host.calls.push({ session: String(sessionId), line })
      if (host.fail || host.unreachable.has(String(sessionId))) {
        return Promise.resolve({ ok: false, error: { code: 'gateway/internal' } })
      }
      if (line === `/${STATE_ALL_COMMAND}`) {
        host.reads += 1
        const answered = host.answered
        if (answered === undefined) {
          return Promise.resolve({ ok: true, value: { commandId: 'c', result: { kind: 'error', text: 'no answer' } } })
        }
        return Promise.resolve({
          ok: true,
          value: { commandId: 'c', result: { kind: 'success', text: encodeGlobalStatus(answered) } },
        })
      }
      if (line === `/${TRIAGE_COMMAND}`) {
        host.triageReads += 1
        return Promise.resolve({
          ok: true,
          value: {
            commandId: 'c',
            result: { kind: 'success', text: encodeTriageList({ rows: [drainingRow()] }) },
          },
        })
      }
      host.answered = line === `/${STOP_ALL_COMMAND}`
        ? status()
        : status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
      return Promise.resolve({ ok: true, value: { commandId: 'c', result: { kind: 'success' } } })
    },
  }
  return { commands: commands as never, host }
}

/** The sessions one verb's executions went through, in order. */
const sessionsOf = (host: Host, line: string): string[] =>
  host.calls.filter(call => call.line === `/${line}`).map(call => call.session)

/** The burst a test drives: a coalescing window and a first wait short enough to spend inside one case. */
const WINDOW_MS = 25
const FIRST_WAIT_MS = 25

/**
 * The burst policy knobs a test overrides. The window and the waits are the
 * controls' own named arguments, because they are the numbers this file is
 * about; what is left here is the page.
 */
function policy(
  overrides: Partial<Omit<BurstPolicy, 'windowMs' | 'waitsMs'>> = {},
): Omit<BurstPolicy, 'windowMs' | 'waitsMs'> {
  return { visible: () => true, ...overrides }
}

/** A whole-app control on the test's burst timing. */
const controls = (
  commands: never,
  overrides: Partial<Omit<BurstPolicy, 'windowMs' | 'waitsMs'>> = {},
): SafeStopGlobalControl =>
  new SafeStopGlobalControl(commands, new AbortController().signal, WINDOW_MS, policy(overrides))

const readingOf = (control: SafeStopGlobalControl): GlobalReading | undefined =>
  control.store.getSnapshot().global

describe('the park read budget', () => {
  afterEach(() => { vi.useRealTimers() })

  it('costs one press read and one burst read for a press + long drain + park, then nothing, on the park transition', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    host.answered = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    const control = controls(commands)

    // Mounting the control reads once. An idle park can change no further, so
    // that read buys nothing.
    await control.refresh(ADDRESS)
    expect(host.reads).toBe(1)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads, 'an idle park was read again').toBe(1)

    // The press parks one session and the host reports it draining. That read is
    // the last one: work in flight ends the burst, because the park announces
    // the end of that work through its own marker registrations.
    await control.toggle(ADDRESS)
    expect(host.reads).toBe(2)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads, 'a drain in flight was watched instead of announced').toBe(2)

    // A verdict that never settles is left alone: the bound is a bound, not a
    // slower heartbeat. This is the 21-reads-in-2-minutes shape, measured.
    expect(readingOf(control)).toEqual({ kind: 'reported', status: status() })
    expect(globalStopView(readingOf(control))).toMatchObject({ visible: true, labelKey: 'all.finishing' })
  })

  it('answers the parked session rather than the session the user moved to', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    host.answered = status()
    const control = controls(commands)

    // The first read has no registered session to go through, so it goes
    // through the session the shell asked with, and the host's answer names the
    // session the park owns.
    await control.refresh(ADDRESS)
    expect(sessionsOf(host, STATE_ALL_COMMAND)).toEqual([String(ADDRESS)])

    // The user moves to another session and the shell hands the pill that one.
    // Nothing else moved: the next burst still addresses the park's own session,
    // so the rows land in the transcript they are about.
    await control.refresh(OTHER)
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sessionsOf(host, STATE_ALL_COMMAND), 'the session the user moved to paid for a park row')
      .toEqual([String(ADDRESS), 'overnight'])
    expect(readingOf(control)).toEqual({ kind: 'reported', status: status() })
    expect(registeredAddress(status())).toBe(SessionId('overnight'))
    expect(registeredAddress(status({ verdict: 'safe', registered: 1, safe: 1, draining: [] }))).toBeUndefined()
  })

  it('reads nothing more until the park transition, then reads until safe and stops', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    // Standing at the park point with the flush pending: the one state nothing
    // announces, so the burst is what covers it.
    const holding = status({ verdict: 'waiting', registered: 1, safe: 0, draining: [], parking: 1 })
    const parked = status({ verdict: 'safe', registered: 1, safe: 1, draining: [], parking: 0 })
    host.answered = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    const control = controls(commands)
    await control.refresh(ADDRESS)
    expect(host.reads).toBe(1)

    // The flush resolves while the verdict is settling — no event of its own.
    // That is the whole job of the burst: 1 mount read, then its four reads at
    // 25ms of window plus 25, 62.5, 150 and 300ms of waits = 5 reads.
    host.answered = holding
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.reads, 'a settling verdict was not watched').toBe(5)
    expect(globalStopView(readingOf(control))).toMatchObject({ labelKey: 'all.finishing', action: 'resume-all' })

    // The flush lands, the burst reads it, and there is nothing left to ask.
    host.answered = parked
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.reads, 'the safe verdict was not read').toBe(6)
    expect(readingOf(control)).toEqual({ kind: 'reported', status: parked })
    expect(globalStopView(readingOf(control))).toMatchObject({ labelKey: 'all.safe' })

    // And silence: a settled park is not read again, however long the page stays
    // open and however many more changes the host announces.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads, 'a settled park was read again').toBe(6)
  })

  it('reads nothing more once the verdict is safe and nothing is draining', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    host.answered = status({ verdict: 'safe', registered: 2, safe: 2, draining: [] })
    const control = controls(commands)

    await control.refresh(ADDRESS)
    expect(readingOf(control)).toEqual({ kind: 'reported', status: status({ verdict: 'safe', registered: 2, safe: 2, draining: [] }) })
    // Every registered session is parked and none is on its way anywhere: the
    // steady state reads nothing at all, not a slow poll.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads, 'a settled park was read again').toBe(1)
  })

  it('reads again on a registry change, and a later one too', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    host.answered = status({ verdict: 'safe', registered: 1, safe: 1, draining: [] })
    const control = controls(commands)
    await control.refresh(ADDRESS)
    const before = host.reads

    // The host announces a registration or an unregistration — a transition
    // worth looking at, even from a settled state. The read waits out the
    // coalescing window first, so that several registrations of one transition
    // are one burst.
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(400)
    expect(host.reads - before).toBe(1)
    expect(host.triageReads, 'a closed panel spent a command call').toBe(0)

    // Coalescing is not dropping: the next change is read as well.
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(400)
    expect(host.reads - before).toBe(2)
  })

  it('addresses its reads at the session the park owns once it knows one', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    host.answered = status()
    const control = controls(commands)

    // The very first read has no registered session to go through yet, so it
    // goes through the session the shell asked with.
    await control.refresh(OTHER)
    expect(sessionsOf(host, STATE_ALL_COMMAND)).toEqual([String(OTHER)])

    // The host's own answer names a draining session, which is a session this
    // park owns and this host can execute against; every read from here on is
    // addressed there, so the rows land in the session being parked rather than
    // in an unrelated transcript.
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(60_000)
    const addresses = sessionsOf(host, STATE_ALL_COMMAND)
    expect(addresses[0]).toBe(String(OTHER))
    expect(addresses.slice(1), 'reads stayed on the unrelated session').toEqual(
      Array.from({ length: addresses.length - 1 }, () => 'overnight'),
    )
    expect(addresses.filter(address => address === String(OTHER)), 'the unrelated session paid for more than one read')
      .toHaveLength(1)

    // A verdict that names no registered session has no better address to offer.
    expect(registeredAddress(status())).toBe(SessionId('overnight'))
    expect(registeredAddress(status({ verdict: 'safe', registered: 1, safe: 1, draining: [] }))).toBeUndefined()
  })

  it('spends nothing when the user opens another session after the park has emptied', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    const idle = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    host.answered = idle
    const control = controls(commands)

    // The pill mounts on the session the user is on and reads the park once.
    await control.refresh(ADDRESS)
    expect(host.reads).toBe(1)

    // They resumed their parked session earlier, so the registry is empty. Now
    // they open another session, and the shell hands the pill that one: the
    // view moved, the park did not.
    await control.refresh(OTHER)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads, 'opening a session cost a read').toBe(1)
    expect(sessionsOf(host, STATE_ALL_COMMAND), 'a row landed in the session that was opened')
      .toEqual([String(ADDRESS)])
    // What stays on screen is still the host's own answer.
    expect(readingOf(control)).toEqual({ kind: 'reported', status: idle })
  })

  it('keeps reading through the address a read was served by, not the session on screen', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    host.answered = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    const control = controls(commands)
    await control.refresh(ADDRESS)
    await control.refresh(OTHER)

    // A park made in another window announces itself through the registry
    // change it causes, and an empty registry is exactly what such a park
    // changes: the change is read, and it is read through the address this
    // control already has rather than through the session now on screen.
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.reads, 'a forwarded change with an empty registry was not read').toBe(2)
    expect(sessionsOf(host, STATE_ALL_COMMAND)).toEqual([String(ADDRESS), String(ADDRESS)])
  })

  it('forgets an address that stopped answering, falls back to the session on screen, and reports honestly', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    const idle = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    host.answered = idle
    const control = controls(commands)
    await control.refresh(ADDRESS)
    await control.refresh(OTHER)

    // The session the first read went through was released with the park it
    // served, so the read through it fails now. The control asks the session
    // the shell is on instead of going mute, and shows that answer.
    host.unreachable.add(String(ADDRESS))
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sessionsOf(host, STATE_ALL_COMMAND)).toEqual([String(ADDRESS), String(ADDRESS), String(OTHER)])
    expect(readingOf(control), 'the fallback answer was not the host\'s own')
      .toEqual({ kind: 'reported', status: idle })

    // The fallback is the address from then on: the dead one is not asked again.
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sessionsOf(host, STATE_ALL_COMMAND), 'the forgotten address was asked again').toEqual(
      [String(ADDRESS), String(ADDRESS), String(OTHER), String(OTHER)],
    )
  })

  it('claims nothing when neither the address it remembers nor the session on screen can answer', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    host.answered = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    const control = controls(commands)
    await control.refresh(ADDRESS)
    await control.refresh(OTHER)

    host.unreachable.add(String(ADDRESS))
    host.unreachable.add(String(OTHER))
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(60_000)
    // One honest attempt per address and no third; the last host answer is not
    // kept on screen in place of an answer nobody gave.
    expect(sessionsOf(host, STATE_ALL_COMMAND)).toEqual([String(ADDRESS), String(ADDRESS), String(OTHER)])
    expect(readingOf(control)).toEqual({ kind: 'unavailable' })
    expect(globalStopView(readingOf(control))).toMatchObject({ visible: false, enabled: false })
  })

  it('takes the session the user moves to as another chance while no answer has arrived', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    host.answered = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    const control = controls(commands)

    // The mount read fails: no answer, so nothing is known and nothing renders.
    host.fail = true
    await control.refresh(ADDRESS)
    expect(readingOf(control)).toEqual({ kind: 'unavailable' })

    // The host was only briefly away. Moving to another session is a chance to
    // reach it; the answer that comes back ends the retrying, so the session
    // after that one costs nothing.
    host.fail = false
    await control.refresh(OTHER)
    expect(readingOf(control)).toEqual({
      kind: 'reported',
      status: status({ verdict: 'idle', registered: 0, safe: 0, draining: [] }),
    })
    expect(sessionsOf(host, STATE_ALL_COMMAND)).toEqual([String(ADDRESS), String(OTHER)])

    await control.refresh(ADDRESS)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(sessionsOf(host, STATE_ALL_COMMAND), 'an answered control read on an address change').toEqual(
      [String(ADDRESS), String(OTHER)],
    )
  })

  it('keeps the decision list on the session the user is on, whatever the aggregate is addressed to', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    // A park whose burst is still live: one session draining, one at the park
    // point with its flush pending. Opening the panel must not cost the
    // aggregate its address.
    host.answered = status({ parking: 1 })
    const control = controls(commands)
    await control.refresh(OTHER)

    control.setPanel(true)
    await vi.advanceTimersByTimeAsync(60_000)
    // The host records the list per calling session and a decision acts only on
    // rows that session was shown, so the list — unlike the aggregate — may not
    // move to the parked session: the user is on the other one.
    const listed = sessionsOf(host, TRIAGE_COMMAND)
    expect(listed, 'the panel was never read').not.toHaveLength(0)
    expect(new Set(listed), 'the list was read from a session the user is not on').toEqual(new Set([String(OTHER)]))
    expect(sessionsOf(host, STATE_ALL_COMMAND).at(-1), 'the aggregate stopped using the parked session').toBe('overnight')

    await control.decide('overnight', 'leave')
    expect(sessionsOf(host, 'safe-triage-leave overnight'), 'the decision came from the wrong session').toEqual([String(OTHER)])
  })

  it('a press after the burst is spent reads again, and a settled answer buys nothing', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    host.answered = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    const control = controls(commands)
    await control.refresh(ADDRESS)
    await control.toggle(ADDRESS)
    await vi.advanceTimersByTimeAsync(60_000)
    const spent = host.reads

    // The verdict is still moving and the user presses again. Releasing the
    // park is a fresh transition, so it is read — and its own burst follows.
    await control.toggle(ADDRESS)
    expect(host.reads).toBe(spent + 1)
    // The release left nothing registered, so this burst ends with its first
    // read rather than spending the rest.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads).toBe(spent + 1)
  })

  it('stops while the page is hidden and takes the read it owed when it comes back', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    // A park still settling, which is the one state the burst watches: its
    // first read is counting down when the page goes away.
    host.answered = status({ parking: 1 })
    let pageVisible = true
    const control = controls(commands, { visible: () => pageVisible })
    await control.refresh(ADDRESS)
    const base = host.reads
    expect(base).toBe(1)

    // The burst is waiting out its first 25ms when the page goes away.
    pageVisible = false
    control.watchVisibility()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads - base, 'a hidden page kept reading').toBe(0)

    // Coming back takes the read the burst owed; the hidden hour is not charged
    // to it and does not lose it.
    pageVisible = true
    control.watchVisibility()
    await vi.advanceTimersByTimeAsync(FIRST_WAIT_MS)
    expect(host.reads - base, 'the read the burst owed was lost').toBe(1)
  })

  it('claims nothing when the host cannot be reached, and asks nothing more', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    host.fail = true
    const control = controls(commands)
    await control.refresh(ADDRESS)
    expect(readingOf(control)).toEqual({ kind: 'unavailable' })
    expect(globalStopView(readingOf(control))).toMatchObject({ visible: false, enabled: false })

    // A host that cannot answer is not a state that is moving: the burst ends.
    const reads = host.reads
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads).toBe(reads)

    // And a press against a state that could not be read picks no verb.
    const calls = host.calls.length
    await control.toggle(ADDRESS)
    expect(host.calls.length).toBe(calls)
  })

  it('drops an answer the host has already moved past', async () => {
    vi.useRealTimers()
    const pending: ((value: unknown) => void)[] = []
    const commands = {
      list: () => Promise.resolve({ ok: true, value: [] }),
      execute: () => new Promise((resolve) => { pending.push(resolve) }),
    }
    const control = new SafeStopGlobalControl(commands as never, new AbortController().signal)
    const stale = control.refresh(ADDRESS)
    const current = control.refresh(ADDRESS)

    const answer = (value: GlobalStatus) => ({
      ok: true,
      value: { commandId: 'c', result: { kind: 'success', text: encodeGlobalStatus(value) } },
    })
    // The newer read answers first; the older one lands afterwards.
    pending[1]?.(answer(status({ verdict: 'safe', registered: 1, safe: 1, draining: [] })))
    await current
    pending[0]?.(answer(status({ verdict: 'waiting', registered: 1, safe: 0, draining: ['late'] })))
    await stale
    expect(readingOf(control)).toEqual({ kind: 'reported', status: status({ verdict: 'safe', registered: 1, safe: 1, draining: [] }) })
  })
})

describe('the per-session read budget', () => {
  afterEach(() => { vi.useRealTimers() })

  /**
   * A stand-in for `ctx.remote.commands` holding one phase per session, which
   * is all the session-header control reads: the marker's presence says paused,
   * the companion status command says which phase.
   */
  function sessionDouble(phases: Record<string, ParkPhase>): { commands: never; calls: Call[] } {
    const calls: Call[] = []
    const commands = {
      list: (sessionId: SessionId) => {
        calls.push({ session: String(sessionId), line: 'list' })
        const paused = phases[String(sessionId)] !== 'active'
        return Promise.resolve({
          ok: true,
          value: paused
            ? [
              { name: RESUME_COMMAND, description: 'resume', definitionId: RESUME_DEFINITION_ID },
              { name: STATUS_COMMAND, description: 'status', definitionId: STATUS_DEFINITION_ID },
            ]
            : [],
        })
      },
      execute: (sessionId: SessionId, line: string) => {
        calls.push({ session: String(sessionId), line })
        const phase = phases[String(sessionId)] ?? 'active'
        return Promise.resolve({
          ok: true,
          value: {
            commandId: 'c',
            result: { kind: 'success', text: encodeParkStatus({ phase, safe: phase === 'safe', runningTools: [] }) },
          },
        })
      },
    }
    return { commands: commands as never, calls }
  }

  it('reads a registry change for every shown session once, then watches only what moves', async () => {
    vi.useFakeTimers()
    const { commands, calls } = sessionDouble({ a: 'draining', b: 'safe' })
    const control = new SafeStopControl(commands, new AbortController().signal, WINDOW_MS, policy())
    await control.refresh(SessionId('a'))
    await control.refresh(SessionId('b'))

    control.refreshAll()
    await vi.advanceTimersByTimeAsync(3_600_000)
    const status = calls.filter(call => call.line === `/${STATUS_COMMAND}`)
    // Both mounted sessions were read once for the change — the forwarded event
    // carries no payload, so either could have moved. The rest of the burst
    // watches the one still draining, and the settled session is left alone.
    expect(status.filter(call => call.session === 'a'), 'the draining session was not watched settle').toHaveLength(5)
    expect(status.filter(call => call.session === 'b'), 'a settled session was read again').toHaveLength(2)
  })

  it("answers a header from the park's own verdict while nothing is registered, and reads it for real once something is", async () => {
    vi.useFakeTimers()
    const { commands, calls } = sessionDouble({ a: 'active' })
    const idle = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    let aggregate: GlobalReading = { kind: 'reported', status: idle }
    const control = new SafeStopControl(commands, new AbortController().signal, WINDOW_MS, policy(), () => aggregate)
    const lists = (): number => calls.filter(call => call.line === 'list').length

    // The mount read is kept: it is the first fact the host gives this header.
    await control.refresh(SessionId('a'))
    expect(lists()).toBe(1)

    // A registry change with nothing registered teaches nothing about a header
    // that already says "running": the park holds no session that could be
    // paused, so the header would only pay a round-trip to hear it again.
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(lists(), 'a header was asked about a park that holds nothing').toBe(1)
    expect(control.store.getSnapshot().bySession['a']).toEqual({ phase: 'active', runningTools: [] })

    // The park takes a session in another window — the change this browser saw.
    // The aggregate is what voids the derivation, and the header is read for
    // real rather than left claiming to be running.
    aggregate = { kind: 'reported', status: status() }
    control.reconsider()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(lists(), 'the header was left on an answer the park had moved past').toBe(2)
  })
})

describe('the read burst', () => {
  afterEach(() => { vi.useRealTimers() })

  /** One burst whose every read asks for the next one, as a control with a moving state does. */
  function movingBurst(waitsMs: readonly number[] = [10, 20, 40]): { burst: ReadBurst; reads: () => number } {
    let reads = 0
    const burst = new ReadBurst(
      () => { reads += 1; burst.next() },
      { waitsMs, visible: () => true },
    )
    return { burst, reads: () => reads }
  }

  it('spends its waits once and stops for good', async () => {
    vi.useFakeTimers()
    const { burst, reads } = movingBurst()
    burst.trigger()
    expect(burst.live).toBe(true)
    expect(burst.armed).toBe(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(reads()).toBe(1)
    await vi.advanceTimersByTimeAsync(20)
    expect(reads()).toBe(2)
    await vi.advanceTimersByTimeAsync(40)
    expect(reads()).toBe(3)
    // Three waits buy three reads and no more, however long the state moves.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(reads(), 'a burst that spent its waits kept reading').toBe(3)
    expect(burst.live).toBe(false)
    expect(burst.armed).toBe(false)
  })

  it('absorbs every trigger that lands while it is running', async () => {
    vi.useFakeTimers()
    const { burst, reads } = movingBurst()
    // One park announces several registry changes, so the burst sees several
    // triggers in a row.
    for (let at = 0; at < 12; at += 1) burst.trigger()
    await vi.advanceTimersByTimeAsync(10)
    expect(reads(), 'twelve triggers became this many bursts').toBe(1)
    // One burst still owes its later reads: absorbing a trigger is not dropping
    // the state it announced.
    await vi.advanceTimersByTimeAsync(60)
    expect(reads()).toBe(3)
  })

  it('stops on a settled state, and a later trigger starts a fresh burst', async () => {
    vi.useFakeTimers()
    const { burst, reads } = movingBurst()
    burst.trigger()
    await vi.advanceTimersByTimeAsync(10)
    expect(reads()).toBe(1)
    burst.stop()
    expect(burst.armed).toBe(false)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(reads()).toBe(1)

    // The user acts again: that is worth the whole burst once more, not the
    // remainder of the last one.
    burst.trigger()
    await vi.advanceTimersByTimeAsync(10)
    expect(reads()).toBe(2)
    await vi.advanceTimersByTimeAsync(20)
    expect(reads()).toBe(3)
  })

  it('turns itself off entirely when it is given no waits', async () => {
    vi.useFakeTimers()
    const { burst, reads } = movingBurst([])
    expect(burst.enabled).toBe(false)
    burst.trigger()
    burst.next()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(reads()).toBe(0)
    expect(burst.live).toBe(false)
  })

  it('derives the default waits from the first one', () => {
    expect(burstWaits(0)).toEqual([])
    expect(burstWaits(25)).toEqual([25, 62.5, 150, 300])
  })
})

describe('one change, one read', () => {
  afterEach(() => { vi.useRealTimers() })

  /**
   * Mount the client half on a stand-in Context that can deliver the forwarded
   * registry change, and count the reads each control performs.
   */
  function bench() {
    const { commands, host } = hostDouble()
    const listeners: (() => void)[] = []
    const registrations: { options: Record<string, unknown> }[] = []
    const ctx = {
      effect(callback: () => unknown) {
        const cleanup = callback()
        return () => { if (typeof cleanup === 'function') (cleanup as () => void)() }
      },
      locale: { register: () => () => {} },
      remote: {
        commands,
        $on: (_event: string, listener: () => void) => {
          listeners.push(listener)
          return () => { listeners.splice(listeners.indexOf(listener), 1) }
        },
      },
      slots: {
        inject: (_name: string, callback: () => unknown) => { callback(); return () => {} },
        register: (options: Record<string, unknown>) => {
          registrations.push({ options })
          return () => {}
        },
      },
    }
    apply(ctx as never)
    return {
      host,
      listeners,
      injected: faceOf(registrations, 'shell.overlay'),
      header: faceOf(registrations, 'conversation.session.header.actions'),
    }
  }

  /** One registered slot's inject face, with the operations the controls call. */
  function faceOf(
    registrations: { options: Record<string, unknown> }[],
    name: string,
  ): { refresh: (id: SessionId) => void; toggle: (id: SessionId) => void; setPanel: (open: boolean) => void } {
    const entry = registrations.find(registration => registration.options['name'] === name)
    if (entry === undefined) throw new Error(`safe-stop: no slot entry registered for ${name}`)
    const face = (entry.options as { inject?: () => never }).inject
    if (face === undefined) throw new Error(`safe-stop: the ${name} control registered no inject face`)
    return face()
  }

  it('coalesces a tick of registry changes into one read, and reads the next one too', async () => {
    vi.useFakeTimers()
    const benchRun = bench()
    expect(benchRun.listeners).toHaveLength(1)
    // A settled host, so what is counted is the change being read and nothing
    // else the burst might owe.
    benchRun.host.answered = status({ verdict: 'safe', registered: 1, safe: 1, draining: [] })
    // A mounted pill has read the host once; that read is what gives a
    // whole-app command a session to travel through.
    benchRun.injected.refresh(ADDRESS)
    await vi.advanceTimersByTimeAsync(0)
    const before = benchRun.host.reads
    expect(before).toBe(1)

    // The host announces a registration per command — three of them per parked
    // session — so one press arrives as several forwarded events.
    const events = 2 * 5
    for (let at = 0; at < events; at += 1) benchRun.listeners[0]?.()
    // The trigger is coalesced, and the read it buys waits out the burst's own
    // window and first wait rather than landing on top of the press that caused
    // it: 400ms of collection, then 400ms before the read.
    await vi.advanceTimersByTimeAsync(0)
    expect(benchRun.host.reads - before, 'the trigger read before its burst was due').toBe(0)
    await vi.advanceTimersByTimeAsync(799)
    expect(benchRun.host.reads - before, `${String(events)} registry changes read before their burst was due`).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(benchRun.host.reads - before, `${String(events)} registry changes became this many reads`).toBe(1)
    expect(benchRun.host.triageReads, 'a closed panel spent a command call').toBe(0)

    // A later change is read too: coalescing is not dropping.
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(800)
    expect(benchRun.host.reads - before).toBe(2)

    // And a trigger that lands while a burst is still running costs nothing:
    // the reads that burst still owes happen after it.
    benchRun.host.answered = status()
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(800)
    const afterFirst = benchRun.host.reads
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(benchRun.host.reads).toBe(afterFirst)
  })

  it('turns three registry changes spread across the coalescing window into one burst, not three', async () => {
    vi.useFakeTimers()
    const benchRun = bench()
    benchRun.host.answered = status({ verdict: 'safe', registered: 1, safe: 1, draining: [] })
    benchRun.injected.refresh(ADDRESS)
    await vi.advanceTimersByTimeAsync(0)
    const before = benchRun.host.reads
    expect(before).toBe(1)

    // One park transition registers up to three marker commands per session —
    // `/safe-resume`, `/safe-state`, `/safe-goal` — and the host announces each
    // one with its own forwarded event (measured: 21 reads in ~2 minutes across
    // ~5 burst sequences per park cycle). Read at 0, 200 and 400ms of the 400ms
    // window: one burst, not one each.
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(200)
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(200)
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(200)
    expect(benchRun.host.reads - before, 'a change inside the window bought its own burst').toBe(0)
    await vi.advanceTimersByTimeAsync(400)
    expect(benchRun.host.reads - before, 'the burst read before its first wait was due').toBe(0)
    await vi.advanceTimersByTimeAsync(400)
    expect(benchRun.host.reads - before, 'three registrations became this many bursts').toBe(1)

    // The next transition is still read: coalescing is not dropping. The host
    // announces a registration and an unregistration per command, so one press
    // arrives as several events in a row.
    const settled = benchRun.host.reads
    benchRun.listeners[0]?.()
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(benchRun.host.reads - settled, 'the next transition was dropped').toBe(1)

    // A change that lands while a burst is still running costs nothing: the read
    // the burst already owes happens after it.
    const spent = benchRun.host.reads
    benchRun.listeners[0]?.()
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(200)
    expect(benchRun.host.reads - spent, 'a running burst read itself again for a later change').toBe(0)
  })

  it('answers a mounted header from the whole-app verdict while nothing is registered', async () => {
    vi.useFakeTimers()
    const benchRun = bench()
    const header = SessionId('header-session')
    benchRun.host.answered = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    // The pill's own mount read is what gives the header control an aggregate
    // to answer from.
    benchRun.injected.refresh(ADDRESS)
    await vi.advanceTimersByTimeAsync(0)
    benchRun.header.refresh(header)
    await vi.advanceTimersByTimeAsync(0)
    const listed = (): number => benchRun.host.listed.filter(id => id === String(header)).length
    expect(listed(), 'the mount read was dropped').toBe(1)

    // A forwarded change with nothing registered teaches nothing about a header
    // that already says "running".
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(listed(), 'a header was read for a park that holds nothing').toBe(1)

    // The park takes a session in another window: the aggregate voids the
    // derivation, and the header is read for real. The header's own burst pays
    // its window twice — once for the forwarded change, once more when the
    // pill's answer voids the derivation.
    benchRun.host.answered = status()
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(listed(), 'the header was left on an answer the park had moved past').toBe(2)
  })
})
