/**
 * Task 07's client acceptance: the whole-app control's state is the aggregate
 * the host reports, and nothing else.
 *
 * The controller is driven against a double of the native `PauseTransport`: the
 * snapshot source carries the aggregate, so a park that is still moving is
 * observable at all. The phase → view mapping and the address picker are pure
 * functions and are asserted directly; the contribution is mounted on a stand-in
 * client context with a fake `remote.pauseSession`, so the wiring is exercised
 * too.
 * @module dsh-pause-session/test/global/client-status
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply, inject } from '../../src/client/index.tsx'
import type { PausePillInjected } from '../../src/client/pill.tsx'
import { PauseGlobalControl, addressingSession } from '../../src/client/global.ts'
import type { PauseTransport } from '../../src/client/remote.ts'
import type { GlobalReading } from '../../src/client/global.ts'
import { globalPauseView, showsPauseControl } from '../../src/client/view.ts'
import type { GlobalStatus } from '../../src/shared.ts'
import type { PauseActionRequest, PauseSnapshotWire } from '../../src/remote.ts'
import { until } from './home.ts'

/** The one session every test in this file addresses its presses through. */
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

/** Host-side truth a test drives, plus the actions the browser sent. */
interface HostDouble {
  answered: GlobalStatus | undefined
  unavailable: boolean
  readonly actions: PauseActionRequest[]
}

/** The native snapshot a host in this state would serve. */
function snapshotOf(host: HostDouble): PauseSnapshotWire | undefined {
  if (host.unavailable || host.answered === undefined) return undefined
  return { global: host.answered as never, sessions: {} }
}

/** A native transport double whose answer is the whole-app aggregate. */
function hostDouble(): {
  transport: PauseTransport
  host: HostDouble
  emit(): void
  reads(): number
} {
  const host: HostDouble = { answered: status(), unavailable: false, actions: [] }
  const changes = new Set<() => void>()
  let reads = 0
  const emit = (): void => { for (const listener of [...changes]) listener() }
  const whole = (next: GlobalStatus): void => { host.answered = next; emit() }
  return {
    host,
    emit,
    reads: () => reads,
    transport: {
      source: {
        read: async () => {
          reads += 1
          return snapshotOf(host) as never
        },
        onChange: (listener) => {
          changes.add(listener)
          return () => { changes.delete(listener) }
        },
      },
      act: async (request) => {
        host.actions.push(request)
        switch (request.action) {
          case 'pause-all':
            whole(status({ verdict: 'waiting', safe: 0, draining: ['overnight'], registered: 1 }))
            break
          case 'resume-all':
            whole(status({ verdict: 'idle', registered: 0, safe: 0, draining: [] }))
            break
          default:
            break
        }
        // Let a stream-driven caller see the new answer before this resolves.
        await new Promise(resolve => setTimeout(resolve, 0))
        return { ok: true, message: request.action }
      },
      triage: async () => [],
      decide: async () => ({ ok: true, message: 'done' }),
    },
  }
}

const readingOf = (control: PauseGlobalControl): GlobalReading | undefined =>
  control.store.getSnapshot().global

describe('the whole-app control state', () => {
  afterEach(() => { vi.useRealTimers() })

  it("publishes the host's aggregate and nothing before it", async () => {
    const { transport, host, reads } = hostDouble()
    const control = new PauseGlobalControl(transport, new AbortController().signal)

    // No host answer yet: the control claims nothing and renders nothing.
    expect(readingOf(control)).toBeUndefined()
    expect(globalPauseView(undefined).visible).toBe(false)

    await control.refresh(ADDRESS)
    expect(readingOf(control)).toEqual({ kind: 'reported', status: status() })
    expect(reads()).toBe(1)
    expect(host.actions).toEqual([])
    expect(globalPauseView(readingOf(control))).toMatchObject({
      visible: true,
      enabled: true,
      action: 'cancel-all',
      labelKey: 'all.finishing',
      detail: '1/2',
    })
  })

  it('presses the park while nothing is parked, and the release once something is', async () => {
    const { transport, host } = hostDouble()
    const control = new PauseGlobalControl(transport, new AbortController().signal)
    host.answered = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
    await control.refresh(ADDRESS)
    // Nothing is parked: the pill is the bare affordance, with no sentence
    // about a park that does not exist.
    expect(globalPauseView(readingOf(control)).labelKey).toBeUndefined()
    expect(globalPauseView(readingOf(control)).action).toBe('pause-all')

    await control.toggle(ADDRESS)
    // The press runs the whole-app native action; the snapshot it leaves is the
    // host's own new answer.
    expect(host.actions.map(action => action.action)).toEqual(['pause-all'])
    expect(readingOf(control)).toEqual({
      kind: 'reported',
      status: status({ verdict: 'waiting', registered: 1, safe: 0, draining: ['overnight'] }),
    })

    await control.toggle(ADDRESS)
    expect(host.actions.map(action => action.action)).toEqual(['pause-all', 'cancel-all'])
    expect(globalPauseView(readingOf(control))).toMatchObject({ action: 'cancel-all' })
  })

  it('reads once per announced transition, and stops once it settles', async () => {
    vi.useFakeTimers()
    const { transport, host, reads } = hostDouble()
    // Standing at the park point with the flush pending. Nothing about this
    // phase announces itself by itself, so nothing here watches it either: the
    // flush that settles it is a phase change, and that is what the host
    // announces.
    host.answered = status({ safe: 1, draining: [], parking: 1 })
    const control = new PauseGlobalControl(transport, new AbortController().signal)
    await control.refresh(ADDRESS)
    expect(readingOf(control)).toMatchObject({ kind: 'reported' })
    const readsAtMount = reads()

    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(reads(), 'a settling park was watched instead of announced').toBe(readsAtMount)

    // The transition arrives on the command channel: one read, and the pill
    // shows the host's own new answer.
    const parked = status({ verdict: 'safe', registered: 2, safe: 2, draining: [] })
    host.answered = parked
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(100)
    expect(readingOf(control)).toEqual({ kind: 'reported', status: parked })
    expect(globalPauseView(readingOf(control))).toMatchObject({ labelKey: 'all.safe', action: 'resume-all' })

    // A settled park is not polled: no further host round-trip is issued.
    const settledReads = reads()
    await vi.advanceTimersByTimeAsync(500)
    expect(reads()).toBe(settledReads)
  })

  it('claims nothing when the host cannot answer, and acts on nothing either', async () => {
    const { transport, host } = hostDouble()
    const control = new PauseGlobalControl(transport, new AbortController().signal)
    host.unavailable = true
    await control.refresh(ADDRESS)
    // The native source has no snapshot to serve: the control reports
    // unavailable rather than keeping the previous reading alive.
    expect(readingOf(control)).toEqual({ kind: 'unavailable' })
    expect(globalPauseView(readingOf(control))).toEqual({
      visible: true,
      enabled: false,
      ariaKey: 'all.unavailable.aria',
      action: 'none',
      detail: '',
      caveats: [],
      unclean: 0,
    })

    // A press against a state that could not be read must not pick a verb.
    await control.toggle(ADDRESS)
    expect(host.actions).toEqual([])
  })

})

describe('the whole-app view', () => {
  it('names every fact the report carries, and never rounds a moving park up', () => {
    const view = globalPauseView({
      kind: 'reported',
      status: status({
        jobs: ['bash-3'],
        unresumable: ['bridge-user'],
        unreadTrees: ['hidden-tree'],
        stalled: ['late-session'],
      }),
    })
    expect(view).toMatchObject({ visible: true, enabled: true, labelKey: 'all.finishing', action: 'cancel-all' })
    expect(view.caveats).toEqual([
      { key: 'all.caveat.jobs', names: ['bash-3'] },
      { key: 'all.caveat.unread', names: ['hidden-tree'] },
      { key: 'all.caveat.unresumable', names: ['bridge-user'] },
      { key: 'all.caveat.stalled', names: ['late-session'] },
    ])
  })

  it('gives a park nobody can finish its own headline and no release to press', () => {
    const view = globalPauseView({ kind: 'reported', status: status({ safe: 0, draining: [], stalled: ['late'] }) })
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
    const view = globalPauseView({ kind: 'reported', status: status({ safe: 0, draining: [], parking: 1, registered: 1 }) })
    expect(view).toMatchObject({
      visible: true,
      enabled: true,
      labelKey: 'all.finishing',
      action: 'cancel-all',
      detail: '0/1',
    })
  })

  it('runs no verb for a reading its own view does not turn into one', async () => {
    const { transport, host } = hostDouble()
    const control = new PauseGlobalControl(transport, new AbortController().signal)
    // The whole park is held, and none of it can be woken from here: the same
    // shape the pill refuses to press.
    host.answered = status({ verdict: 'waiting', safe: 0, draining: [], stalled: ['late'] })
    await control.refresh(ADDRESS)
    expect(globalPauseView(readingOf(control)).action).toBe('none')

    await control.toggle(ADDRESS)
    // Not even an action: the control has nothing to press, so it presses nothing.
    expect(host.actions).toEqual([])
    expect(readingOf(control)).toEqual({ kind: 'reported', status: host.answered })
  })

  it('names a missing surface instead of listing everything it blinds', () => {
    const view = globalPauseView({
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
  /** Mount the client half on a stand-in Context carrying a fake native namespace. */
  function bench(host: HostDouble) {
    const changes = new Set<() => void>()
    let latest = snapshotOf(host) ?? { global: status({ verdict: 'idle', registered: 0 }), sessions: {} }
    const emit = (): void => {
      latest = snapshotOf(host) ?? { global: status({ verdict: 'idle', registered: 0 }), sessions: {} }
      for (const listener of [...changes]) listener()
    }
    const remote = {
      observe: async function* (signal?: AbortSignal) {
        yield latest
        for (;;) {
          await new Promise<void>((resolve, reject) => {
            const done = (): void => { changes.delete(done); resolve() }
            const onAbort = (): void => { changes.delete(done); reject(signal?.reason) }
            changes.add(done)
            signal?.addEventListener('abort', onAbort, { once: true })
          })
          yield latest
        }
      },
      act: async (request: PauseActionRequest) => {
        host.actions.push(request)
        if (request.action === 'pause-all') host.answered = status({ verdict: 'waiting', safe: 0, draining: ['overnight'], registered: 1 })
        if (request.action === 'resume-all') host.answered = status({ verdict: 'idle', registered: 0, safe: 0, draining: [] })
        emit()
        await new Promise(resolve => setTimeout(resolve, 0))
        return { ok: true, value: { ok: true, message: request.action } }
      },
      triage: async () => ({ ok: true, value: [] }),
      decide: async () => ({ ok: true, value: { ok: true, message: 'done' } }),
    }
    const cleanups: (() => void)[] = []
    const injectedNames: string[] = []
    const registrations: { options: Record<string, unknown> }[] = []
    const ctx = {
      effect(callback: () => unknown) {
        const cleanup = callback()
        cleanups.push(typeof cleanup === 'function' ? cleanup as () => void : () => {})
        return () => {}
      },
      locale: { register: () => () => {} },
      remote: { pauseSession: remote },
      inject(_names: readonly string[], callback: (child: typeof ctx) => unknown) {
        callback(ctx)
        return () => {}
      },
      slots: {
        inject: (name: string, callback: () => unknown) => { injectedNames.push(name); callback(); return () => {} },
        register: (options: Record<string, unknown>, _component: unknown) => {
          registrations.push({ options })
          return () => {}
        },
      },
    }
    apply(ctx as never)
    const entry = registrations.find(registration => registration.options.name === 'conversation.session.header.utilities')
    if (entry === undefined) throw new Error('pause: the whole-app control registered no slot entry')
    return { host, emit, changes, cleanups, injectedNames, options: entry.options }
  }

  it('contributes the whole-app control into the header utilities slot, under its own id', () => {
    const benchRun = bench({ answered: status(), unavailable: false, actions: [] })
    expect(benchRun.injectedNames).toEqual(['conversation.session.header.actions', 'conversation.session.header.utilities'])
    expect(benchRun.options).toMatchObject({
      name: 'conversation.session.header.utilities',
      id: 'pause-all',
      locale: 'pause',
    })
  })

  it('stays off a subagent session, exactly like the per-session control', () => {
    // Both sides of the header read the same snapshot fact: a subagent's session
    // header is not where its parent's tree is read from, and the parent's
    // control already speaks for it.
    const subagent = { address: { mode: 'continuable', parentSessionId: 'parent', childSessionId: 'child' } }
    expect(showsPauseControl(subagent)).toBe(false)
    expect(showsPauseControl(null)).toBe(true)
  })

  it('reads the host once at mount and re-reads on a native stream change', async () => {
    const benchRun = bench({ answered: status(), unavailable: false, actions: [] })
    const face = (benchRun.options as { inject?: () => PausePillInjected }).inject
    if (face === undefined) throw new Error('pause: the pill registered no inject face')
    const injected = face()

    injected.refresh(ADDRESS)
    await until(() => injected.hooks.pauseGlobal.getSnapshot().global !== undefined, 'the first reading')
    expect(globalPauseView(injected.hooks.pauseGlobal.getSnapshot().global))
      .toMatchObject({ visible: true, labelKey: 'all.finishing' })

    // The native stream is the only notification there is: it is what makes
    // this control look again.
    benchRun.host.answered = status({ verdict: 'safe', registered: 2, safe: 2, draining: [] })
    benchRun.emit()
    await until(() => {
      const reading = injected.hooks.pauseGlobal.getSnapshot().global
      return reading?.kind === 'reported' && reading.status.verdict === 'safe'
    }, 'the pill to read the hosted change')

    injected.toggle(ADDRESS)
    await until(() => benchRun.host.actions.some(action => action.action === 'resume-all'), 'the pill to press the release')
  })

  it('unsubscribes from the host when the plugin unloads', async () => {
    const benchRun = bench({ answered: status(), unavailable: false, actions: [] })
    await until(() => benchRun.changes.size > 0, 'the stream to subscribe')
    for (const cleanup of benchRun.cleanups.reverse()) cleanup()
    expect(benchRun.changes.size).toBe(0)
  })
})
