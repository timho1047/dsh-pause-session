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
 * The numbers here are the product decision, so the cases state them: a park
 * transition costs one read however many `commands/change` events announce it
 * (a phase change is one unregistration and one registration of the status
 * verb, and the client's window merges them); a press followed by a long drain
 * costs the press read, the one look that closes the press's own echo window,
 * and one read per announced transition after that — nothing watches the drain
 * itself; and a session the user merely views pays nothing once the park's own
 * address is known.
 *
 * A change that follows the user's own action is that action's own echo, and
 * the action already read the host: those changes are absorbed for
 * `ACTION_ABSORB_MS`, so the measured resume — one action read, plus the
 * unregistration reads its own three markers caused, none of which the 400 ms
 * trailing window can merge — costs the single read the action made. The same
 * three markers with no action before them still buy the burst they always did,
 * and the first change after the window goes quiet is what discovers a park
 * made elsewhere while the window was open. An action that leaves a phase still
 * moving owes one look when its window closes, because a park can reach its final
 * phase inside that window and then never announce anything again.
 * @module dsh-safe-stop/test/global/poll-budget
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply, inject } from '../../src/client/index.tsx'
import { ACTION_ABSORB_MS, ReadBurst, burstWaits } from '../../src/client/burst.ts'
import type { BurstPolicy } from '../../src/client/burst.ts'
import { SafeStopControl } from '../../src/client/control.ts'
import type { SafeStopState } from '../../src/client/control.ts'
import { SafeStopGlobalControl, registeredAddress } from '../../src/client/global.ts'
import type { GlobalReading, GlobalStopState } from '../../src/client/global.ts'
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

  it('press + long drain + park: the drain is not watched, and each announced transition buys one read', async () => {
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
    // the answer to the press itself.
    await control.toggle(ADDRESS)
    expect(host.reads).toBe(2)
    expect(globalStopView(readingOf(control))).toMatchObject({ visible: true, labelKey: 'all.finishing' })

    // The drain is long and nothing announces its end, so nothing watches it:
    // the one read the press still owes is the look that closes its own echo
    // window, where a transition announced inside it would have been absorbed.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.reads, 'a drain in flight was watched instead of announced').toBe(3)
    expect(readingOf(control)).toEqual({ kind: 'reported', status: status() })

    // The tool lands and the session reaches the park point: its phase changed,
    // so the host announces it and the browser reads once.
    const holding = status({ verdict: 'waiting', registered: 1, safe: 0, draining: ['overnight'], parking: 1 })
    host.answered = holding
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.reads, 'the announced park point was not read').toBe(4)

    // The flush resolves: another announced transition, another single read.
    const parked = status({ verdict: 'safe', registered: 1, safe: 1, draining: [], parking: 0 })
    host.answered = parked
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.reads, 'the announced flush was not read').toBe(5)
    expect(readingOf(control)).toEqual({ kind: 'reported', status: parked })
    expect(globalStopView(readingOf(control))).toMatchObject({ labelKey: 'all.safe' })

    // And silence: a settled park is not read again, however long the page stays
    // open and however many more changes the host announces.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads, 'a settled park was read again').toBe(5)
  })

  it('reads the park point and the flush as one when they land inside one window', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    // A park made elsewhere, so this browser has no echo window of its own to
    // close and both transitions are news.
    host.answered = status({ verdict: 'waiting', registered: 1, safe: 0, draining: ['overnight'], parking: 1 })
    const control = controls(commands)
    await control.refresh(ADDRESS)
    expect(host.reads).toBe(1)

    // The flush resolves milliseconds after the park point, as it does against a
    // real disk: two transitions, both inside one collection window, one read —
    // and that read carries the later truth.
    const parked = status({ verdict: 'safe', registered: 1, safe: 1, draining: [], parking: 0 })
    host.answered = parked
    control.refreshAll()
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.reads, 'two transitions inside one window became this many reads').toBe(2)
    expect(readingOf(control)).toEqual({ kind: 'reported', status: parked })
  })

  it('reads a park that reached its last phase inside the press\'s own echo window', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    host.answered = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    const control = controls(commands)
    await control.refresh(ADDRESS)
    const parked = status({ verdict: 'safe', registered: 1, safe: 1, draining: [], parking: 0 })

    // The press parks a session, and the flush resolves while the press's own
    // registration echo is still being absorbed. Both transitions arrive as
    // changes that look exactly like the echo, so reading them back is what the
    // absorption is for.
    await control.toggle(ADDRESS)
    expect(host.reads).toBe(2)
    host.answered = parked
    control.refreshAll()
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(ACTION_ABSORB_MS)
    expect(host.reads, 'the echo was read back').toBe(2)

    // The window closes, and with it the only chance anything had to say the
    // park moved: the one look the press owes is taken, so the pill reports the
    // host's answer instead of a park nobody holds any more.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.reads, 'the hidden transition was never read').toBe(3)
    expect(readingOf(control)).toEqual({ kind: 'reported', status: parked })
    expect(globalStopView(readingOf(control))).toMatchObject({ labelKey: 'all.safe' })

    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads, 'the trailing look was a watch after all').toBe(3)
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

  it('reads once per announced transition while a park is settling', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    // Standing at the park point with the flush pending: a park made elsewhere,
    // so this browser has no echo window of its own to close.
    const holding = status({ verdict: 'waiting', registered: 1, safe: 0, draining: ['overnight'], parking: 1 })
    const parked = status({ verdict: 'safe', registered: 1, safe: 1, draining: [], parking: 0 })
    host.answered = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    const control = controls(commands)
    await control.refresh(ADDRESS)
    expect(host.reads).toBe(1)

    // The session reaches the park point: one announced transition, one read.
    host.answered = holding
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.reads, 'the announced park point was not read').toBe(2)
    expect(globalStopView(readingOf(control))).toMatchObject({ labelKey: 'all.finishing', action: 'resume-all' })

    // The flush is still pending and nothing announces anything: the read the
    // transition bought is the last one, not the start of a watch.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.reads, 'a settling park was watched instead of announced').toBe(2)

    // The flush lands: the next transition announces itself, and the read it
    // buys is the last one there is.
    host.answered = parked
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.reads, 'the announced flush was not read').toBe(3)
    expect(readingOf(control)).toEqual({ kind: 'reported', status: parked })
    expect(globalStopView(readingOf(control))).toMatchObject({ labelKey: 'all.safe' })

    // And silence: a settled park is not read again, however long the page stays
    // open and however many more changes the host announces.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads, 'a settled park was read again').toBe(3)
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
    // A park with one session draining: the aggregate has a parked session to
    // address its reads at, and the panel has rows of its own to read.
    host.answered = status()
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
    // A park that has moved, which is what owes the read: the change is what the
    // burst is collecting when the page goes away.
    host.answered = status({ parking: 1 })
    let pageVisible = true
    const control = controls(commands, { visible: () => pageVisible })
    await control.refresh(ADDRESS)
    const base = host.reads
    expect(base).toBe(1)

    // The transition is announced and the burst is still waiting out its
    // collection window when the page goes away.
    control.refreshAll()
    pageVisible = false
    control.watchVisibility()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads - base, 'a hidden page kept reading').toBe(0)

    // Coming back takes the read the burst owed; the hidden hour is not charged
    // to it and does not lose it. The collection window is taken again from the
    // moment the page came back, so the read follows both waits.
    pageVisible = true
    control.watchVisibility()
    await vi.advanceTimersByTimeAsync(WINDOW_MS + FIRST_WAIT_MS)
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

  it('reads a registry change for every shown session once, and nothing while a phase moves', async () => {
    vi.useFakeTimers()
    const { commands, calls } = sessionDouble({ a: 'draining', b: 'safe' })
    const control = new SafeStopControl(commands, new AbortController().signal, WINDOW_MS, policy())
    await control.refresh(SessionId('a'))
    await control.refresh(SessionId('b'))

    control.refreshAll()
    await vi.advanceTimersByTimeAsync(3_600_000)
    const status = calls.filter(call => call.line === `/${STATUS_COMMAND}`)
    // Both mounted sessions were read once for the change — the forwarded event
    // carries no payload, so either could have moved. Nothing is watched after
    // that: the session still draining ends its drain with a transition the host
    // announces, and the settled one is left alone.
    expect(status.filter(call => call.session === 'a'), 'a draining session was watched').toHaveLength(2)
    expect(status.filter(call => call.session === 'b'), 'a settled session was read again').toHaveLength(2)
  })

  it('presses while a tool runs: the drain is not watched, and the header reaches safe on the announcements alone', async () => {
    vi.useFakeTimers()
    const phases: Record<string, ParkPhase> = { a: 'active' }
    const { commands, calls } = sessionDouble(phases)
    const control = new SafeStopControl(commands, new AbortController().signal, WINDOW_MS, policy())
    const statuses = (): number => calls.filter(call => call.line === `/${STATUS_COMMAND}`).length

    // The header mounts on a running session: one read, no claim.
    await control.refresh(SessionId('a'))
    expect(statuses()).toBe(0)
    expect(control.store.getSnapshot().bySession['a']).toEqual({ phase: 'active', runningTools: [] })

    // The press runs the pause verb and reads the host: the tool is in flight,
    // so the header says so.
    phases['a'] = 'draining'
    await control.toggle(SessionId('a'))
    expect(statuses()).toBe(1)
    expect(control.store.getSnapshot().bySession['a']).toMatchObject({ phase: 'draining', runningTools: [] })

    // The drain is long. The one read the press owes is the look that closes its
    // own echo window; nothing else asks, because the end of the drain announces
    // itself rather than being watched for.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(statuses(), 'the drain was watched instead of announced').toBe(2)
    expect(control.store.getSnapshot().bySession['a']).toMatchObject({ phase: 'draining' })

    // The tool lands and the session reaches the park point: one announced
    // transition, one read.
    phases['a'] = 'parking'
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(statuses(), 'the announced park point was not read').toBe(3)

    // The flush resolves: the transition no registration of its own would show is
    // announced like the one before it, and read like it too.
    phases['a'] = 'safe'
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(statuses(), 'the announced flush was not read').toBe(4)
    expect(control.store.getSnapshot().bySession['a']).toEqual({ phase: 'safe', runningTools: [] })

    // And silence, with no further user action anywhere in the cycle.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(statuses(), 'a settled header was read again').toBe(4)
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

  it('absorbs the marker changes a header press causes, and reads a change after the window', async () => {
    vi.useFakeTimers()
    const { commands, calls } = sessionDouble({ a: 'safe' })
    const control = new SafeStopControl(commands, new AbortController().signal, WINDOW_MS, policy())
    const lists = (): number => calls.filter(call => call.line === 'list').length

    await control.refresh(SessionId('a'))
    expect(lists()).toBe(1)
    // The header's press reads the host too: one list and one status.
    await control.toggle(SessionId('a'))
    expect(lists()).toBe(2)

    // The host unregisters the three marker commands, one change each. They are
    // the press's own echo, so the header pays nothing for them.
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(600)
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(600)
    expect(lists(), 'a marker change the press caused was read back').toBe(2)

    // The last change moved the window 2 s out; once it is over, a change reads.
    await vi.advanceTimersByTimeAsync(ACTION_ABSORB_MS + 1)
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(lists(), 'a change after the absorption window was dropped').toBe(3)

    // The goal switch reads as it runs too, so what it causes is absorbed.
    await control.toggleGoal(SessionId('a'))
    expect(lists()).toBe(4)
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(600)
    expect(lists(), 'a change the goal switch caused was read back').toBe(4)
  })

  it('reads a header the park has moved past even while an action absorbs its own echo', async () => {
    vi.useFakeTimers()
    const { commands, calls } = sessionDouble({ a: 'active', b: 'active' })
    const idle = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    let aggregate: GlobalReading = { kind: 'reported', status: idle }
    const control = new SafeStopControl(commands, new AbortController().signal, WINDOW_MS, policy(), () => aggregate)
    const listed = (id: string): number => calls.filter(call => call.line === 'list' && call.session === id).length

    // Two headers mount while the park holds nothing: after the mount reads, a
    // change is answered from the whole-app verdict rather than read.
    await control.refresh(SessionId('a'))
    await control.refresh(SessionId('b'))
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(listed('a')).toBe(1)
    expect(listed('b')).toBe(1)

    // The user presses header 'a'. Its own read answers it, and in the same
    // moment another window's park makes the aggregate that stood in for 'b'
    // wrong. The press's absorption is for the changes it caused, not for what
    // that reading revealed: 'b' is read rather than left claiming to run.
    await control.toggle(SessionId('a'))
    aggregate = { kind: 'reported', status: status() }
    control.reconsider()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(listed('b'), 'the header was left on an answer the park had moved past').toBe(2)
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

  it('absorbs every change a client action causes, and reads one after the window closes', async () => {
    vi.useFakeTimers()
    const { burst, reads } = movingBurst()
    // The user acted and the action read the host: what arrives for the next
    // `ACTION_ABSORB_MS` is that action's own echo, not news.
    burst.absorb()
    expect(burst.absorbing).toBe(true)
    burst.trigger()
    await vi.advanceTimersByTimeAsync(ACTION_ABSORB_MS + 1)
    expect(reads(), 'a change the action caused was read back').toBe(0)
    expect(burst.absorbing).toBe(false)

    // The window has closed, so the next change is news and buys its burst.
    burst.trigger()
    await vi.advanceTimersByTimeAsync(10)
    expect(reads(), 'a change after the absorption window was dropped').toBe(1)
  })

  it('keeps the window open while the echo keeps arriving', async () => {
    vi.useFakeTimers()
    const { burst, reads } = movingBurst()
    burst.absorb()
    // The measured resume's unregistration storm, at the gaps it actually had:
    // three changes the 400 ms trailing window cannot merge, the last of them
    // 2.04 s after the one before — the case that leaked a read when the window
    // was 2 s. Each one absorbed is another window, so the storm costs nothing
    // rather than one read per change.
    burst.trigger()
    await vi.advanceTimersByTimeAsync(640)
    burst.trigger()
    await vi.advanceTimersByTimeAsync(440)
    burst.trigger()
    await vi.advanceTimersByTimeAsync(2_040)
    expect(reads(), 'the storm the action caused was read back').toBe(0)
    expect(burst.absorbing).toBe(true)

    // The window after the storm's last change is the storm's end.
    await vi.advanceTimersByTimeAsync(ACTION_ABSORB_MS + 1)
    expect(burst.absorbing).toBe(false)
    burst.trigger()
    await vi.advanceTimersByTimeAsync(10)
    expect(reads(), 'the change after the storm was dropped').toBe(1)
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
      wholeApp: faceOf(registrations, 'conversation.session.header.utilities'),
      header: faceOf(registrations, 'conversation.session.header.actions'),
    }
  }

  /** One registered slot's inject face: the operations a control calls, and the state it shows. */
  function faceOf(
    registrations: { options: Record<string, unknown> }[],
    name: string,
  ): {
    refresh: (id: SessionId) => void
    toggle: (id: SessionId) => void
    setPanel: (open: boolean) => void
    hooks: {
      readonly safeStopGlobal?: { getSnapshot: () => GlobalStopState }
      readonly safeStop?: { getSnapshot: () => SafeStopState }
    }
  } {
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
    benchRun.wholeApp.refresh(ADDRESS)
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
    benchRun.wholeApp.refresh(ADDRESS)
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

  it('turns the pair of changes one phase transition emits into one read', async () => {
    vi.useFakeTimers()
    const benchRun = bench()
    benchRun.host.answered = status({ verdict: 'safe', registered: 1, safe: 1, draining: [] })
    benchRun.wholeApp.refresh(ADDRESS)
    await vi.advanceTimersByTimeAsync(0)
    const before = benchRun.host.reads
    expect(before).toBe(1)

    // A phase change re-registers the session's status verb, and the registry
    // announces the removal and the insertion separately. One transition, two
    // changes, one read: the coalescing window is what makes an announcement
    // cost what it is worth rather than what it is spelled as.
    benchRun.listeners[0]?.()
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(800)
    expect(benchRun.host.reads - before, 'one transition became this many reads').toBe(1)

    // The next transition is still read: coalescing is not dropping.
    benchRun.listeners[0]?.()
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(800)
    expect(benchRun.host.reads - before, 'the next transition was dropped').toBe(2)
  })

  it('answers a mounted header from the whole-app verdict while nothing is registered', async () => {
    vi.useFakeTimers()
    const benchRun = bench()
    const header = SessionId('header-session')
    benchRun.host.answered = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    // The pill's own mount read is what gives the header control an aggregate
    // to answer from.
    benchRun.wholeApp.refresh(ADDRESS)
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

  /** The host's answer a whole-app press leaves behind: nothing registered. */
  const idleStatus = (): GlobalStatus => status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })

  /** What the pill currently shows: the last answer the control published. */
  const shownBy = (face: {
    hooks: { safeStopGlobal?: { getSnapshot: () => GlobalStopState } }
  }): GlobalReading | undefined => face.hooks.safeStopGlobal?.getSnapshot().global

  it('absorbs the unregistration storm a resume causes: one read, not four', async () => {
    vi.useFakeTimers()
    const benchRun = bench()
    // The park is settled, so releasing it is the one press left.
    benchRun.host.answered = status({ verdict: 'safe', registered: 1, safe: 1, draining: [] })
    // The pill mounts and reads the host once.
    benchRun.wholeApp.refresh(ADDRESS)
    await vi.advanceTimersByTimeAsync(0)
    expect(benchRun.host.reads).toBe(1)

    // The user resumes. The action reads the host itself: that is read two, and
    // the answer on screen.
    benchRun.wholeApp.toggle(ADDRESS)
    await vi.advanceTimersByTimeAsync(0)
    expect(benchRun.host.reads).toBe(2)
    expect(shownBy(benchRun.wholeApp)).toEqual({ kind: 'reported', status: idleStatus() })

    // The host unregisters the parked session's three marker commands and
    // announces each one on its own — the measured resume put the first two
    // 0.64 s and 1.08 s after the action's own read, and that storm is what the
    // 400 ms trailing window cannot merge. All three are that action's echo, so
    // the whole storm costs nothing at all.
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(640)
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(440)
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(960)
    expect(benchRun.host.reads, 'the unregistration storm was read back').toBe(2)

    // And nothing follows: an idle park is not watched.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(benchRun.host.reads).toBe(2)
    expect(benchRun.host.triageReads, 'a closed panel spent a command call').toBe(0)
  })

  it('reads a change that arrives after the absorption window: the storm plus one late marker costs two reads', async () => {
    vi.useFakeTimers()
    const benchRun = bench()
    benchRun.host.answered = status({ verdict: 'safe', registered: 1, safe: 1, draining: [] })
    benchRun.wholeApp.refresh(ADDRESS)
    await vi.advanceTimersByTimeAsync(0)

    benchRun.wholeApp.toggle(ADDRESS)
    await vi.advanceTimersByTimeAsync(0)
    expect(benchRun.host.reads).toBe(2)

    // One unregistration, absorbed: it moves the window 2 s out from itself.
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(640)
    expect(benchRun.host.reads).toBe(2)

    // A change 2.6 s after that one is past the window: the trailing coalescing
    // is all there is again, so it reads after its own window and first wait.
    await vi.advanceTimersByTimeAsync(2_600)
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(benchRun.host.reads, 'the change read before its burst was due').toBe(2)
    await vi.advanceTimersByTimeAsync(800)
    expect(benchRun.host.reads, 'a change after the absorption window was dropped').toBe(3)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(benchRun.host.reads).toBe(3)
  })

  it('turns three marker changes with no action before them into one burst, not three', async () => {
    vi.useFakeTimers()
    const benchRun = bench()
    benchRun.host.answered = status({ verdict: 'safe', registered: 1, safe: 1, draining: [] })
    benchRun.wholeApp.refresh(ADDRESS)
    await vi.advanceTimersByTimeAsync(0)
    const before = benchRun.host.reads
    expect(before).toBe(1)

    // Nothing was pressed, so these three markers are news rather than an echo
    // and the trailing window is what merges them — the behaviour absorption
    // must not take away. (Markers spread the way the measured storm is — 0.44 s
    // to 2.04 s apart — outrun that window, and every one the running burst
    // misses is read on its own: exactly the cost an action's echo no longer
    // pays.)
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(200)
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(200)
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(800)
    expect(benchRun.host.reads - before, 'three marker changes became this many reads').toBe(1)
  })

  it('discovers a park made in another window on the first change after the absorption window', async () => {
    vi.useFakeTimers()
    const benchRun = bench()
    benchRun.host.answered = status({ verdict: 'safe', registered: 1, safe: 1, draining: [] })
    benchRun.wholeApp.refresh(ADDRESS)
    await vi.advanceTimersByTimeAsync(0)

    // The user releases the park; the action reads, and its echo is absorbed.
    benchRun.wholeApp.toggle(ADDRESS)
    await vi.advanceTimersByTimeAsync(0)
    expect(benchRun.host.reads).toBe(2)

    // Another window parks a session while the window is open. Its marker
    // registrations look exactly like the echo — the forwarded event carries no
    // payload — so they are absorbed, and the pill still shows the release.
    benchRun.host.answered = status()
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(500)
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(500)
    expect(benchRun.host.reads, 'a change inside the absorption window was read').toBe(2)
    expect(shownBy(benchRun.wholeApp)).toEqual({ kind: 'reported', status: idleStatus() })

    // The next change after the window goes quiet — the park's own
    // unregistration, or any other — is what discovers it: the window is not a
    // promise that nothing moved, only that this browser did not have to ask.
    await vi.advanceTimersByTimeAsync(2_100)
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(800)
    expect(benchRun.host.reads, 'the park made elsewhere was never discovered').toBe(3)
    expect(shownBy(benchRun.wholeApp)).toEqual({ kind: 'reported', status: status() })
  })

  it('reads on the next press while the absorption window is still open', async () => {
    vi.useFakeTimers()
    const benchRun = bench()
    benchRun.host.answered = status({ verdict: 'safe', registered: 1, safe: 1, draining: [] })
    benchRun.wholeApp.refresh(ADDRESS)
    await vi.advanceTimersByTimeAsync(0)

    // Resume, then park everything again half a second later: a user action
    // reads whatever the absorption window says.
    benchRun.wholeApp.toggle(ADDRESS)
    await vi.advanceTimersByTimeAsync(500)
    expect(benchRun.host.reads).toBe(2)
    benchRun.wholeApp.toggle(ADDRESS)
    await vi.advanceTimersByTimeAsync(0)
    expect(benchRun.host.reads, 'a press inside the absorption window did not read').toBe(3)
    expect(shownBy(benchRun.wholeApp)).toEqual({ kind: 'reported', status: status() })
  })

  it('reads the rows an opened panel shows, and absorbs the changes it causes', async () => {
    vi.useFakeTimers()
    const benchRun = bench()
    benchRun.host.answered = status({ verdict: 'safe', registered: 1, safe: 1, draining: [] })
    benchRun.wholeApp.refresh(ADDRESS)
    await vi.advanceTimersByTimeAsync(0)
    const reads = benchRun.host.reads
    expect(reads).toBe(1)

    // Opening the panel is a client action: its rows are its own read, and with
    // a park that has stopped moving there is nothing on screen to watch.
    benchRun.wholeApp.setPanel(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(benchRun.host.triageReads, 'the panel did not read its own rows').toBe(1)
    benchRun.listeners[0]?.()
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(benchRun.host.reads - reads, 'an opened panel bought a read for nothing').toBe(0)
    expect(benchRun.host.triageReads, 'a change the open caused was read back').toBe(1)

    // A decision reads as it runs, so the one read it takes is the answer to its
    // own consequences.
    const decided = benchRun.host.reads
    benchRun.wholeApp.decide('overnight', 'leave')
    await vi.advanceTimersByTimeAsync(0)
    expect(benchRun.host.reads - decided, "a decision's own read").toBe(1)
    benchRun.listeners[0]?.()
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(benchRun.host.reads - decided, 'the changes a decision caused were read back').toBe(1)
  })
})
