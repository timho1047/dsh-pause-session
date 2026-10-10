/**
 * The price of watching: what a control that re-reads the host costs while
 * nothing moves.
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
import { SafeStopGlobalControl } from '../../src/client/global.ts'
import type { GlobalReading } from '../../src/client/global.ts'
import { globalStopView } from '../../src/client/view.ts'
import { Poller } from '../../src/client/poll.ts'
import type { PollPolicy } from '../../src/client/poll.ts'
import { encodeGlobalStatus, encodeTriageList, STATE_ALL_COMMAND, TRIAGE_COMMAND } from '../../src/shared.ts'
import type { GlobalStatus, TriageRow } from '../../src/shared.ts'

const ADDRESS = SessionId('poll-address')

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

/**
 * A stand-in for `ctx.remote.commands` that answers like the host registry
 * does and counts the reads it was asked for.
 */
function hostDouble(): {
  commands: never
  host: { reads: number; triageReads: number; lines: string[] }
} {
  const host = { reads: 0, triageReads: 0, lines: [] as string[] }
  const commands = {
    list: () => Promise.resolve({ ok: true, value: [] }),
    execute: (_sessionId: SessionId, line: string) => {
      host.lines.push(line)
      if (line === `/${STATE_ALL_COMMAND}`) {
        host.reads += 1
        return Promise.resolve({
          ok: true,
          value: { commandId: 'c', result: { kind: 'success', text: encodeGlobalStatus(status()) } },
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
      return Promise.resolve({ ok: true, value: { commandId: 'c', result: { kind: 'success' } } })
    },
  }
  return { commands: commands as never, host }
}

/** A policy whose budget is small enough to spend inside one test. */
function policy(overrides: Partial<PollPolicy> = {}): PollPolicy {
  return { initialMs: 25, maxMs: 100, maxVisibleMs: 1000, visible: () => true, ...overrides }
}

const readingOf = (control: SafeStopGlobalControl): GlobalReading | undefined =>
  control.store.getSnapshot().global

describe('the re-read budget', () => {
  afterEach(() => { vi.useRealTimers() })

  it('backs off, stops while the verdict never settles, and keeps showing it', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    const control = new SafeStopGlobalControl(commands, new AbortController().signal, 25, policy())
    await control.refresh(ADDRESS)
    const afterFirst = host.reads

    // The host's answer never changes: this park is permanently `waiting`,
    // which is what a stalled or adopted session leaves behind.
    await vi.advanceTimersByTimeAsync(60_000)
    const spent = host.reads - afterFirst
    expect(spent, 'a permanently waiting verdict was polled without a bound').toBeGreaterThan(0)
    expect(spent, `the budget bought ${String(spent)} reads in a minute`).toBeLessThan(20)

    // The budget is spent: nothing re-arms, however long the page is left.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads - afterFirst, 'an hour of waiting still cost reads').toBe(spent)

    // Stopping the asking is not stopping the answer: the verdict and the pill
    // are exactly what the host last reported.
    expect(readingOf(control)).toEqual({ kind: 'reported', status: status() })
    expect(globalStopView(readingOf(control))).toMatchObject({ visible: true, labelKey: 'all.finishing' })
  })

  it('doubles the wait between reads rather than asking on a fixed beat', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    const control = new SafeStopGlobalControl(commands, new AbortController().signal, 25, policy())
    await control.refresh(ADDRESS)
    const base = host.reads

    // The first wait is the initial interval, the next is twice it, then four
    // times: the same three reads a fixed 25ms beat would spend in 75ms.
    await vi.advanceTimersByTimeAsync(25)
    expect(host.reads - base).toBe(1)
    await vi.advanceTimersByTimeAsync(25)
    expect(host.reads - base).toBe(1)
    await vi.advanceTimersByTimeAsync(25)
    expect(host.reads - base).toBe(2)
    await vi.advanceTimersByTimeAsync(50)
    expect(host.reads - base).toBe(2)
    await vi.advanceTimersByTimeAsync(50)
    expect(host.reads - base).toBe(3)
  })

  it('stops while the page is hidden and continues when it comes back', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    let pageVisible = true
    const control = new SafeStopGlobalControl(
      commands,
      new AbortController().signal,
      25,
      policy({ visible: () => pageVisible }),
    )
    await control.refresh(ADDRESS)
    const base = host.reads

    pageVisible = false
    control.watchVisibility()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads - base, 'a hidden page kept reading').toBe(0)

    pageVisible = true
    control.watchVisibility()
    await vi.advanceTimersByTimeAsync(25)
    expect(host.reads - base, 'a visible page did not continue reading').toBeGreaterThan(0)
  })

  it('a user press buys a fresh budget', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    const control = new SafeStopGlobalControl(commands, new AbortController().signal, 25, policy())
    await control.refresh(ADDRESS)
    // Spend the whole budget first, so the press is the only thing left that
    // can make the control look again.
    await vi.advanceTimersByTimeAsync(60_000)
    const settled = host.reads
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.reads).toBe(settled)

    await control.toggle(ADDRESS)
    await vi.advanceTimersByTimeAsync(30)
    expect(host.reads, 'a press did not start the budget over').toBeGreaterThan(settled)
  })

  it('a poll reads the whole screen once, not once per surface', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    const control = new SafeStopGlobalControl(commands, new AbortController().signal, 25, policy())
    await control.refresh(ADDRESS)
    control.setPanel(true)
    await vi.advanceTimersByTimeAsync(0)
    const reads = host.reads
    const triageReads = host.triageReads

    await vi.advanceTimersByTimeAsync(25)
    expect(host.reads - reads, 'one poll read the verdict more than once').toBe(1)
    expect(host.triageReads - triageReads, 'one poll read the list more than once').toBe(1)
  })
})

describe('the re-read timer', () => {
  afterEach(() => { vi.useRealTimers() })

  it('arms at most once, and stops for good', async () => {
    vi.useFakeTimers()
    // The subject here is the timer itself: a control whose read never resolves
    // must not pile up timers behind it.
    let reads = 0
    let pageVisible = true
    const timer = new Poller(
      () => { reads += 1 },
      { initialMs: 10, maxMs: 40, maxVisibleMs: 100, visible: () => pageVisible },
    )
    timer.start()
    expect(timer.armed).toBe(true)
    timer.start()
    timer.start()
    expect(timer.armed).toBe(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(reads).toBe(1)
    timer.stop()
    expect(timer.armed).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reads).toBe(1)
    pageVisible = false
    timer.start()
    expect(timer.armed).toBe(false)
  })

  it('counts only the time the page was on screen', async () => {
    vi.useFakeTimers()
    let reads = 0
    let pageVisible = true
    const timer = new Poller(
      () => { reads += 1 },
      { initialMs: 10, maxMs: 10, maxVisibleMs: 25, visible: () => pageVisible },
    )
    timer.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(reads).toBe(1)
    // Hidden for an hour: that is not polling time, so the 15ms left of the
    // budget survive it. A budget charged wall-clock time would have none.
    pageVisible = false
    timer.checkVisibility()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(reads).toBe(1)
    pageVisible = true
    timer.checkVisibility()
    await vi.advanceTimersByTimeAsync(10)
    expect(reads, 'the budget was spent by a hidden hour').toBe(2)
    await vi.advanceTimersByTimeAsync(10)
    expect(reads).toBe(3)
    // And the budget does run out: nothing is left to arm.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(reads).toBe(3)
    expect(timer.armed).toBe(false)
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

  it('coalesces a burst of registry changes into one read per tick', async () => {
    vi.useFakeTimers()
    const benchRun = bench()
    expect(benchRun.listeners).toHaveLength(1)
    // A mounted pill has read the host once; that read is what gives a
    // whole-app command a session to travel through.
    benchRun.injected.refresh(ADDRESS)
    await vi.advanceTimersByTimeAsync(0)
    const before = benchRun.host.reads
    // The host announces a registration and an unregistration per command, so
    // parking N sessions arrives as 2N events in one burst.
    const events = 2 * 5
    for (let at = 0; at < events; at += 1) benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(benchRun.host.reads - before, `${String(events)} registry changes became this many reads`).toBe(1)
    expect(benchRun.host.triageReads).toBe(0)
    // A later change is read too: coalescing is not dropping.
    benchRun.listeners[0]?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(benchRun.host.reads - before).toBe(2)
  })
})
