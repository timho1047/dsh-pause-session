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
    stalled: [],
    unresumable: [],
    unreadTrees: [],
    jobs: [],
    blind: [],
    ...overrides,
  }
}

/** One listed row that is still draining, which is a state the panel keeps asking about. */
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
  fail: boolean
  readonly calls: Call[]
  reads: number
  triageReads: number
}

/**
 * A stand-in for `ctx.remote.commands` that answers like the host registry does
 * and records every execution it was asked for. The two whole-app verbs flip
 * the host's state the way the real commands do.
 */
function hostDouble(): { commands: never; host: Host } {
  const host: Host = { answered: undefined, fail: false, calls: [], reads: 0, triageReads: 0 }
  const commands = {
    list: () => Promise.resolve({ ok: true, value: [] }),
    execute: (sessionId: SessionId, line: string) => {
      host.calls.push({ session: String(sessionId), line })
      if (host.fail) return Promise.resolve({ ok: false, error: { code: 'gateway/internal' } })
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

/** The burst waits a test uses: a first wait short enough to spend inside one case. */
function policy(overrides: Partial<Omit<BurstPolicy, 'waitsMs'>> = {}): Omit<BurstPolicy, 'waitsMs'> {
  return { visible: () => true, ...overrides }
}

const readingOf = (control: SafeStopGlobalControl): GlobalReading | undefined =>
  control.store.getSnapshot().global

describe('the park read budget', () => {
  afterEach(() => { vi.useRealTimers() })

  it('costs one short burst for a whole park cycle, then nothing however long the page stays open', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    host.answered = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    const control = new SafeStopGlobalControl(commands, new AbortController().signal, 25, policy())

    // Mounting the control reads once. An idle park can change no further, so
    // that read buys nothing.
    await control.refresh(ADDRESS)
    expect(host.reads).toBe(1)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads, 'an idle park was read again').toBe(1)

    // The press parks one session. The host reports it draining and never
    // settles: the burst is what covers the flush, and it is the whole price.
    await control.toggle(ADDRESS)
    expect(host.reads).toBe(2)
    await vi.advanceTimersByTimeAsync(60_000)
    // 1 mount + 1 press + the burst's 4 reads (waits 25, 62.5, 150, 300ms).
    expect(host.reads, 'one park cycle cost more than its burst').toBe(6)

    // A verdict that never settles is left alone: the bound is a bound, not a
    // slower heartbeat.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads, 'a permanently waiting verdict was read again').toBe(6)

    // Stopping the asking is not stopping the answer: what is on screen is
    // exactly what the host last reported.
    expect(readingOf(control)).toEqual({ kind: 'reported', status: status() })
    expect(globalStopView(readingOf(control))).toMatchObject({ visible: true, labelKey: 'all.finishing' })
  })

  it('reads nothing more once the verdict is safe and nothing is draining', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    host.answered = status({ verdict: 'safe', registered: 2, safe: 2, draining: [] })
    const control = new SafeStopGlobalControl(commands, new AbortController().signal, 25, policy())

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
    const control = new SafeStopGlobalControl(commands, new AbortController().signal, 25, policy())
    await control.refresh(ADDRESS)
    const before = host.reads

    // The host announces a registration or an unregistration — a transition
    // worth looking at, even from a settled state.
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(25)
    expect(host.reads - before).toBe(1)
    expect(host.triageReads, 'a closed panel spent a command call').toBe(0)

    // Coalescing is not dropping: the next change is read as well.
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(25)
    expect(host.reads - before).toBe(2)
  })

  it('addresses its reads at the session the park owns once it knows one', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    host.answered = status()
    const control = new SafeStopGlobalControl(commands, new AbortController().signal, 25, policy())

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

  it('keeps the decision list on the session the user is on, whatever the aggregate is addressed to', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    host.answered = status()
    const control = new SafeStopGlobalControl(commands, new AbortController().signal, 25, policy())
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
    const control = new SafeStopGlobalControl(commands, new AbortController().signal, 25, policy())
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
    host.answered = status()
    let pageVisible = true
    const control = new SafeStopGlobalControl(
      commands,
      new AbortController().signal,
      25,
      policy({ visible: () => pageVisible }),
    )
    await control.refresh(ADDRESS)
    const base = host.reads

    // The burst is waiting out its first 25ms when the page goes away.
    pageVisible = false
    control.watchVisibility()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads - base, 'a hidden page kept reading').toBe(0)

    // Coming back takes the read the burst owed; the hidden hour is not charged
    // to it and does not lose it.
    pageVisible = true
    control.watchVisibility()
    await vi.advanceTimersByTimeAsync(25)
    expect(host.reads - base, 'the read the burst owed was lost').toBe(1)
  })

  it('claims nothing when the host cannot be reached, and asks nothing more', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    host.fail = true
    const control = new SafeStopGlobalControl(commands, new AbortController().signal, 25, policy())
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
    const control = new SafeStopControl(commands, new AbortController().signal, 25, policy())
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
    const entry = registrations.find(registration => registration.options['name'] === 'shell.overlay')
    if (entry === undefined) throw new Error('safe-stop: the whole-app pill registered no slot entry')
    const face = (entry.options as { inject?: () => { refresh: (id: SessionId) => void } }).inject
    if (face === undefined) throw new Error('safe-stop: the pill registered no inject face')
    return { host, listeners, injected: face() }
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
    // The trigger is coalesced, and the read it buys waits for the burst's own
    // first wait rather than landing on top of the press that caused it.
    await vi.advanceTimersByTimeAsync(0)
    expect(benchRun.host.reads - before, 'the trigger read before its burst was due').toBe(0)
    await vi.advanceTimersByTimeAsync(400)
    expect(benchRun.host.reads - before, `${String(events)} registry changes became this many reads`).toBe(1)
    expect(benchRun.host.triageReads, 'a closed panel spent a command call').toBe(0)

    // A later change is read too: coalescing is not dropping.
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(400)
    expect(benchRun.host.reads - before).toBe(2)

    // And a trigger that lands while a burst is still running costs nothing:
    // the reads that burst still owes happen after it.
    benchRun.host.answered = status()
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(400)
    const afterFirst = benchRun.host.reads
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(benchRun.host.reads).toBe(afterFirst)
  })
})
