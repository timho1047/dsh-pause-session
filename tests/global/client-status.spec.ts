/**
 * Task 07's client acceptance: the whole-app control's state is the aggregate
 * the host reports, and nothing else.
 *
 * The controller is driven against a double of the real Client-callable command
 * namespace that answers the way the host does — the global status command's
 * RESULT carries the aggregate, so a park that is still moving is observable at
 * all. The phase → view mapping and the address picker are pure functions and
 * are asserted directly; the contribution is mounted on a stand-in slot
 * registry so the wiring is exercised too.
 * @module dsh-safe-stop/test/global/client-status
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply, inject } from '../../src/client/index.tsx'
import type { SafeStopPillInjected } from '../../src/client/pill.tsx'
import { SafeStopGlobalControl, addressingSession } from '../../src/client/global.ts'
import type { GlobalReading } from '../../src/client/global.ts'
import { globalStopView } from '../../src/client/view.ts'
import {
  decodeGlobalStatus, encodeGlobalStatus, RESUME_ALL_COMMAND, STATE_ALL_COMMAND, STOP_ALL_COMMAND,
} from '../../src/shared.ts'
import type { GlobalStatus } from '../../src/shared.ts'
import { until } from './home.ts'

/** The whole-app verbs, spelled once so the double answers the real names. */
const STATE_ALL_LINE = STATE_ALL_COMMAND
const STOP_ALL_LINE = STOP_ALL_COMMAND

const ADDRESS = SessionId('client-address')
const OTHER = SessionId('other-session')
const SUBAGENT = SessionId('subagent-session')

/** One whole-app status, spelled the way the host spells it. */
function status(overrides: Partial<GlobalStatus> = {}): GlobalStatus {
  return {
    verdict: 'waiting',
    registered: 2,
    safe: 1,
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

/** Host-side truth a test drives, plus the calls the browser made. */
interface HostDouble {
  answered: GlobalStatus | undefined
  fail: boolean
  readonly lines: string[]
}

/** A stand-in for `ctx.remote.commands` that answers like the host registry does. */
function hostDouble(): { commands: never; host: HostDouble; readsDone: (count: number) => Promise<void> } {
  const host: HostDouble = { answered: status(), fail: false, lines: [] }
  let reads = 0
  const waiters: { count: number; resolve: () => void }[] = []
  const commands = {
    list: () => Promise.resolve({ ok: true, value: [] }),
    execute: (_sessionId: SessionId, line: string) => {
      host.lines.push(line)
      if (host.fail) return Promise.resolve({ ok: false, error: { code: 'gateway/internal' } })
      if (line === `/${STATE_ALL_LINE}`) {
        reads += 1
        for (const waiter of [...waiters]) {
          if (reads >= waiter.count) {
            waiters.splice(waiters.indexOf(waiter), 1)
            waiter.resolve()
          }
        }
        if (host.answered === undefined) {
          return Promise.resolve({ ok: true, value: { commandId: 'c', result: { kind: 'error', text: 'no answer' } } })
        }
        return Promise.resolve({
          ok: true,
          value: { commandId: 'c', result: { kind: 'success', text: encodeGlobalStatus(host.answered) } },
        })
      }
      // The two verbs flip the host's state the way the real commands do.
      host.answered = line === `/${STOP_ALL_COMMAND}`
        ? status({ verdict: 'waiting', safe: 0, draining: ['overnight'], registered: 1 })
        : status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
      return Promise.resolve({ ok: true, value: { commandId: 'c', result: { kind: 'success' } } })
    },
  }
  return {
    commands: commands as never,
    host,
    readsDone: (count: number) => (reads >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => { waiters.push({ count, resolve }) })),
  }
}

const readingOf = (control: SafeStopGlobalControl): GlobalReading | undefined =>
  control.store.getSnapshot().global

describe('the whole-app control state', () => {
  afterEach(() => { vi.useRealTimers() })

  it("publishes the host's aggregate and nothing before it", async () => {
    const { commands, host } = hostDouble()
    const control = new SafeStopGlobalControl(commands, new AbortController().signal)

    // No host answer yet: the control claims nothing and renders nothing.
    expect(readingOf(control)).toBeUndefined()
    expect(globalStopView(undefined).visible).toBe(false)

    await control.refresh(ADDRESS)
    expect(readingOf(control)).toEqual({ kind: 'reported', status: status() })
    expect(host.lines).toEqual([`/${STATE_ALL_LINE}`])
    expect(globalStopView(readingOf(control))).toMatchObject({
      visible: true,
      enabled: true,
      action: 'resume-all',
      labelKey: 'all.finishing',
      detail: '1/2',
    })
  })

  it('presses the park while nothing is parked, and the release once something is', async () => {
    const { commands, host } = hostDouble()
    const control = new SafeStopGlobalControl(commands, new AbortController().signal)
    host.answered = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    await control.refresh(ADDRESS)
    // Nothing is parked: the pill is the bare affordance, with no sentence
    // about a park that does not exist.
    expect(globalStopView(readingOf(control)).labelKey).toBeUndefined()
    expect(globalStopView(readingOf(control)).action).toBe('stop-all')

    await control.toggle(ADDRESS)
    // The press runs the whole-app verb; reading the state afterwards is the
    // status read, which is a command call like any other.
    expect(host.lines).toEqual([`/${STATE_ALL_LINE}`, `/${STOP_ALL_LINE}`, `/${STATE_ALL_LINE}`])
    expect(readingOf(control)).toEqual({
      kind: 'reported',
      status: status({ verdict: 'waiting', registered: 1, safe: 0, draining: ['overnight'] }),
    })

    await control.toggle(ADDRESS)
    expect(host.lines.at(-2)).toBe(`/${RESUME_ALL_COMMAND}`)
    expect(globalStopView(readingOf(control))).toMatchObject({ action: 'stop-all' })
  })

  it('keeps reading while the park is settling, and stops once it settles', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    // Standing at the park point with the flush pending: the state nothing
    // announces, which is the one the burst watches.
    host.answered = status({ safe: 1, draining: [], parking: 1 })
    const control = new SafeStopGlobalControl(commands, new AbortController().signal, 25)
    await control.refresh(ADDRESS)
    expect(readingOf(control)).toMatchObject({ kind: 'reported' })
    const readsAtPress = host.lines.length

    // The last session parks; only the host's next answer says so.
    host.answered = status({ verdict: 'safe', registered: 2, safe: 2, draining: [] })
    await vi.advanceTimersByTimeAsync(30)
    expect(readingOf(control)).toEqual({ kind: 'reported', status: status({ verdict: 'safe', registered: 2, safe: 2, draining: [] }) })
    expect(globalStopView(readingOf(control))).toMatchObject({ labelKey: 'all.safe', action: 'resume-all' })

    // A settled park is not polled: no further host round-trip is issued.
    expect(host.lines.length).toBeGreaterThan(readsAtPress)
    const settledReads = host.lines.length
    await vi.advanceTimersByTimeAsync(500)
    expect(host.lines.length).toBe(settledReads)
  })

  it('claims nothing when the host cannot answer, and acts on nothing either', async () => {
    const { commands, host } = hostDouble()
    const control = new SafeStopGlobalControl(commands, new AbortController().signal)
    host.fail = true
    await control.refresh(ADDRESS)
    expect(readingOf(control)).toEqual({ kind: 'unavailable' })
    expect(globalStopView(readingOf(control))).toEqual({
      visible: false,
      enabled: false,
      ariaKey: 'unavailable.aria',
      action: 'none',
      detail: '',
      caveats: [],
      // The decision list's entry point is part of the same view, and a host
      // that cannot answer has no list to offer either.
      unclean: 0,
    })

    // A press against a state that could not be read must not pick a verb.
    const before = host.lines.length
    await control.toggle(ADDRESS)
    expect(host.lines.length).toBe(before)
  })

  it('drops an answer the host has already moved past', async () => {
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

describe('the whole-app status encoding', () => {
  it('round-trips every field, separators and all', () => {
    const spelled = status({
      verdict: 'waiting',
      registered: 4,
      safe: 1,
      draining: ['overnight'],
      // A name is the host's own data: whatever it holds comes back exactly, so
      // a row is never looked up under a name that was folded into another.
      stalled: ['late; session', 'tab\tand\nnewline', '-'],
      unresumable: ['a, b'],
      unreadTrees: ['hidden'],
      jobs: ['bash-1', 'subagent-2'],
      blind: ['jobs'],
    })
    const text = encodeGlobalStatus(spelled)
    const decoded = decodeGlobalStatus(text)
    expect(decoded).toBeDefined()
    expect(decoded?.stalled).toEqual(['late; session', 'tab\tand\nnewline', '-'])
    expect(decoded?.unresumable).toEqual(['a, b'])
    expect(decoded?.draining).toEqual(['overnight'])
    expect(decoded?.unreadTrees).toEqual(['hidden'])
    expect(decoded?.jobs).toEqual(['bash-1', 'subagent-2'])
    expect(decoded?.blind).toEqual(['jobs'])
    expect(decoded?.registered).toBe(4)
    expect(decoded?.safe).toBe(1)
  })

  it('does not let a name forge a field', () => {
    // The separators inside a name are escaped, so the only `;` the decoder
    // splits on is the one the encoder wrote.
    const text = encodeGlobalStatus(status({
      verdict: 'waiting',
      registered: 2,
      safe: 0,
      draining: ['forged; stalled: everything; safe: 99'],
      stalled: [],
    }))
    const decoded = decodeGlobalStatus(text)
    expect(decoded?.draining).toEqual(['forged; stalled: everything; safe: 99'])
    expect(decoded?.stalled).toEqual([])
    expect(decoded?.safe).toBe(0)
  })

  it('decodes nothing from text that is not a whole-app status', () => {
    expect(decodeGlobalStatus('safe-stop: draining; tools: edit')).toBeUndefined()
    expect(decodeGlobalStatus('safe-stop all: maybe; registered: 1')).toBeUndefined()
    expect(decodeGlobalStatus('safe-stop all: idle; registered: -4; safe: nope')).toMatchObject({
      verdict: 'idle',
      registered: 0,
      safe: 0,
      blind: [],
    })
  })
})

describe('the whole-app view', () => {
  it('names every fact the report carries, and never rounds a moving park up', () => {
    const view = globalStopView({
      kind: 'reported',
      status: status({
        jobs: ['bash-3'],
        unresumable: ['bridge-user'],
        unreadTrees: ['hidden-tree'],
        stalled: ['late-session'],
      }),
    })
    expect(view).toMatchObject({ visible: true, enabled: true, labelKey: 'all.finishing', action: 'resume-all' })
    expect(view.caveats).toEqual([
      { key: 'all.caveat.jobs', names: ['bash-3'] },
      { key: 'all.caveat.unread', names: ['hidden-tree'] },
      { key: 'all.caveat.unresumable', names: ['bridge-user'] },
      { key: 'all.caveat.stalled', names: ['late-session'] },
    ])
  })

  it('gives a park nobody can finish its own headline and no release to press', () => {
    const view = globalStopView({ kind: 'reported', status: status({ safe: 0, draining: [], stalled: ['late'] }) })
    expect(view).toMatchObject({
      labelKey: 'all.unclean',
      detail: '1',
      // Every registered session is one the host will not wake, so the control
      // offers no action at all rather than one the host would refuse — and the
      // accessible name says which fact stops it.
      action: 'none',
      enabled: false,
      ariaKey: 'all.unclean.aria',
    })
    expect(view.caveats).toEqual([{ key: 'all.caveat.stalled', names: ['late'] }])
  })

  it('keeps the release pressable while a registered session holds the park point', () => {
    // Stopped and standing still, flush pending: nothing is "still working", but
    // this session is one the host can release, so it is not the unclean case
    // either.
    const view = globalStopView({ kind: 'reported', status: status({ safe: 0, draining: [], parking: 1, registered: 1 }) })
    expect(view).toMatchObject({
      visible: true,
      enabled: true,
      labelKey: 'all.finishing',
      action: 'resume-all',
      detail: '0/1',
    })
  })

  it('runs no verb for a reading its own view does not turn into one', async () => {
    const { commands, host } = hostDouble()
    const control = new SafeStopGlobalControl(commands, new AbortController().signal)
    // The whole park is held, and none of it can be woken from here: the same
    // shape the pill refuses to press.
    host.answered = status({ verdict: 'waiting', safe: 0, draining: [], stalled: ['late'] })
    await control.refresh(ADDRESS)
    expect(globalStopView(readingOf(control)).action).toBe('none')

    const before = host.lines.length
    await control.toggle(ADDRESS)
    // Not even a read: the control has nothing to press, so it presses nothing.
    expect(host.lines.slice(before)).toEqual([])
    expect(readingOf(control)).toEqual({ kind: 'reported', status: host.answered })
  })

  it('names a missing surface instead of listing everything it blinds', () => {
    const view = globalStopView({
      kind: 'reported',
      status: status({ blind: ['trees', 'jobs'], unreadTrees: ['a', 'b'], jobs: [] }),
    })
    expect(view.caveats).toEqual([
      { key: 'all.caveat.blindJobs', names: [] },
      { key: 'all.caveat.blindTrees', names: [] },
    ])
  })
})

describe('the whole-app address', () => {
  const row = (extra: Record<string, unknown> = {}) => ({ running: false, retainedBy: {}, ...extra })

  it('prefers the session on screen, skips subagents, and falls back to a running one', () => {
    expect(addressingSession({
      ids: [OTHER, SUBAGENT, ADDRESS],
      byId: {
        [String(OTHER)]: row(),
        [String(SUBAGENT)]: row({ origin: 'subagent', parentId: OTHER }),
        [String(ADDRESS)]: row({ retainedBy: { mainView: 1 } }),
      },
    })).toBe(ADDRESS)

    expect(addressingSession({
      ids: [OTHER, ADDRESS],
      byId: { [String(OTHER)]: row(), [String(ADDRESS)]: row({ running: true }) },
    })).toBe(ADDRESS)

    expect(addressingSession({
      ids: [SUBAGENT, ADDRESS],
      byId: { [String(SUBAGENT)]: row({ origin: 'subagent' }), [String(ADDRESS)]: row() },
    })).toBe(ADDRESS)

    expect(addressingSession({ ids: [SUBAGENT], byId: { [String(SUBAGENT)]: row({ origin: 'subagent' }) } }))
      .toBeUndefined()
  })
})

describe('the whole-app contribution', () => {
  /** Mount the client half on a stand-in Context that records what it registers. */
  function bench() {
    const { commands, host, readsDone } = hostDouble()
    const listeners: (() => void)[] = []
    const cleanups: (() => void)[] = []
    const injected: string[] = []
    const registrations: { options: Record<string, unknown>; inject?: () => SafeStopPillInjected }[] = []
    const ctx = {
      effect(callback: () => unknown) {
        const cleanup = callback()
        cleanups.push(typeof cleanup === 'function' ? cleanup as () => void : () => {})
        return () => {}
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
        inject: (name: string, callback: () => unknown) => { injected.push(name); callback(); return () => {} },
        register: (options: Record<string, unknown>, _component: unknown) => {
          registrations.push({ options })
          return () => {}
        },
      },
    }
    apply(ctx as never)
    const entry = registrations.find(registration => registration.options.name === 'shell.overlay')
    if (entry === undefined) throw new Error('safe-stop: the whole-app pill registered no slot entry')
    return { host, readsDone, listeners, cleanups, injected, options: entry.options, entry }
  }

  it('contributes the pill into the frame-wide overlay layer, under its own id', () => {
    const benchRun = bench()
    expect(benchRun.injected).toEqual(['conversation.session.header.actions', 'shell.overlay'])
    expect(benchRun.options).toMatchObject({ name: 'shell.overlay', id: 'safe-stop-all', locale: 'safe-stop' })
  })

  it('reads the host once at mount and re-reads on a forwarded registry change', async () => {
    const benchRun = bench()
    const face = (benchRun.options as { inject?: () => SafeStopPillInjected }).inject
    if (face === undefined) throw new Error('safe-stop: the pill registered no inject face')
    const injected = face()

    injected.refresh(ADDRESS)
    await benchRun.readsDone(1)
    await until(() => injected.hooks.safeStopGlobal.getSnapshot().global !== undefined, 'the first reading')
    expect(globalStopView(injected.hooks.safeStopGlobal.getSnapshot().global))
      .toMatchObject({ visible: true, labelKey: 'all.finishing' })

    // The forwarded registry change is the only notification there is: it is
    // what makes this control look again.
    const before = benchRun.host.lines.length
    expect(benchRun.listeners).toHaveLength(1)
    benchRun.listeners[0]?.()
    await until(() => benchRun.host.lines.length > before, 'the pill to re-read')

    injected.toggle(ADDRESS)
    await until(() => benchRun.host.lines.includes(`/${RESUME_ALL_COMMAND}`), 'the pill to press the release')
  })

  it('unsubscribes from the host when the plugin unloads', () => {
    const benchRun = bench()
    expect(benchRun.listeners).toHaveLength(1)
    for (const cleanup of benchRun.cleanups.reverse()) cleanup()
    expect(benchRun.listeners).toHaveLength(0)
  })
})
