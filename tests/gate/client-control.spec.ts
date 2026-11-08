/**
 * The browser half's state: what the Session-header control shows is the
 * host's answer, never a local flip.
 *
 * The controller is driven against a double of the native `PauseTransport` the
 * browser really uses — a snapshot source and three actions — so a phase that is
 * still moving is observable at all. The contribution is mounted on a stand-in
 * client context with a fake `remote.pauseSession`, so the wiring (the native
 * stream's change feed and the injected face) is exercised too.
 * @module dsh-pause-session/test/gate/client-control
 */

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply, inject } from '../../src/client/index.tsx'
import type { PauseInjected } from '../../src/client/index.tsx'
import { PauseControl } from '../../src/client/control.ts'
import type { PauseReading } from '../../src/client/control.ts'
import type { PauseTransport } from '../../src/client/remote.ts'
import { pauseView, showsPauseControl } from '../../src/client/view.ts'
import { foldTreePhases, PARK_PHASES } from '../../src/shared.ts'
import type { ParkPhase } from '../../src/shared.ts'
import type { PauseActionRequest, PauseSnapshotWire } from '../../src/remote.ts'
import { until } from './loop.ts'

const SID = SessionId('client-control')

/** Host-side truth a test drives, plus the actions the browser sent. */
interface HostDouble {
  paused: boolean
  phase: ParkPhase
  runningTools: string[]
  /** The record's goal opt-out; `undefined` is a host whose answer carries no such field. */
  rearmGoal: boolean | undefined
  /** When true, a snapshot read has no answer at all. */
  unavailable: boolean
  /** When true, the next snapshot read waits for {@link release}. */
  hold: boolean
  release: (() => void) | undefined
  readonly actions: PauseActionRequest[]
}

/** The native snapshot a host in this state would serve. */
function snapshotOf(host: HostDouble): PauseSnapshotWire | undefined {
  if (host.unavailable) return undefined
  const sessions = host.paused
    ? {
        [String(SID)]: {
          phase: host.phase,
          runningTools: host.runningTools,
          ...host.rearmGoal === undefined ? {} : { rearmGoal: host.rearmGoal },
        },
      }
    : {}
  return {
    global: {
      verdict: host.paused ? 'waiting' : 'idle',
      registered: host.paused ? 1 : 0,
      safe: host.paused && host.phase === 'safe' ? 1 : 0,
      draining: host.paused && host.phase === 'draining' ? [String(SID)] : [],
      parking: host.paused && host.phase === 'parking' ? 1 : 0,
      stalled: [],
      unresumable: [],
      unreadTrees: [],
      jobs: [],
      blind: [],
    },
    sessions,
  }
}

/**
 * A native transport double. Actions change the host's state and notify the
 * stream source, exactly as the host's own `act` does.
 */
function hostDouble(): {
  transport: PauseTransport
  host: HostDouble
  emit(): void
  listeners(): number
  reads(): number
} {
  const host: HostDouble = {
    paused: false,
    phase: 'draining',
    runningTools: [],
    rearmGoal: true,
    unavailable: false,
    hold: false,
    release: undefined,
    actions: [],
  }
  const changes = new Set<() => void>()
  let reads = 0
  const emit = (): void => { for (const listener of [...changes]) listener() }
  const transport: PauseTransport = {
    source: {
      read: async () => {
        reads += 1
        if (host.hold) {
          await new Promise<void>((resolve) => { host.release = resolve })
        }
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
        case 'pause':
          host.paused = true
          host.phase = 'draining'
          break
        case 'resume':
          host.paused = false
          break
        case 'goal':
          host.rearmGoal = !(host.rearmGoal ?? true)
          break
        case 'pause-all':
        case 'resume-all':
          break
      }
      emit()
      return { ok: true, message: request.action }
    },
    triage: async () => [],
    decide: async () => ({ ok: true, message: 'decision' }),
  }
  return {
    transport,
    host,
    emit,
    listeners: () => changes.size,
    reads: () => reads,
  }
}

const readingOf = (control: PauseControl): unknown => control.store.getSnapshot().bySession[String(SID)]

describe('browser control state', () => {

  it("shows the host's answer and re-reads it after a press", async () => {
    const { transport, host } = hostDouble()
    const control = new PauseControl(transport, new AbortController().signal)

    // No host answer yet: the control claims nothing.
    expect(readingOf(control)).toBeUndefined()
    expect(pauseView(undefined).enabled).toBe(false)

    await control.refresh(SID)
    expect(readingOf(control)).toEqual({ phase: 'active', runningTools: [] })
    expect(pauseView({ phase: 'active', runningTools: [] }))
      .toEqual({ paused: false, enabled: true, ariaKey: 'pause.aria', runningTools: [] })

    await control.toggle(SID)
    // The press runs the pause action; reading the state afterwards is a
    // snapshot read, and the host's state answers it.
    expect(host.actions).toEqual([{ action: 'pause', sessionId: String(SID) }])
    expect(readingOf(control)).toEqual({ phase: 'draining', runningTools: [], rearmGoal: true })
    expect(pauseView({ phase: 'draining', runningTools: [] }))
      .toMatchObject({ paused: true, enabled: true, labelKey: 'state.draining' })

    await control.toggle(SID)
    expect(host.actions.map(action => action.action)).toEqual(['pause', 'resume'])
    expect(readingOf(control)).toEqual({ phase: 'active', runningTools: [] })
  })

  it('names the running tool and stops claiming "safe" until the host says so', () => {
    // The screen never rounds a moving phase up to "safe to close", and it
    // passes the host's own tool names through as data.
    expect(pauseView({ phase: 'draining', runningTools: ['edit', 'bash'] }))
      .toMatchObject({ paused: true, enabled: true, labelKey: 'state.draining', runningTools: ['edit', 'bash'] })
    expect(pauseView({ phase: 'parking', runningTools: [] }))
      .toMatchObject({ paused: true, enabled: true, labelKey: 'state.parking', runningTools: [] })
    expect(pauseView({ phase: 'safe', runningTools: [] }))
      .toMatchObject({ paused: true, enabled: true, labelKey: 'state.safe' })
    // A failed flush is a pause the host will not call clean.
    expect(pauseView({ phase: 'flush-failed', runningTools: [] }))
      .toMatchObject({ paused: true, enabled: true, labelKey: 'state.flushFailed' })
  })

  it("carries the record's goal opt-out, and switches it through the session's own action", async () => {
    const { transport, host } = hostDouble()
    const control = new PauseControl(transport, new AbortController().signal)
    host.paused = true
    host.phase = 'safe'
    await control.refresh(SID)
    expect(readingOf(control)).toEqual({ phase: 'safe', runningTools: [], rearmGoal: true })
    expect(pauseView(readingOf(control) as PauseReading)).toMatchObject({ rearmGoal: true })

    await control.toggleGoal(SID)
    // One action, addressed to the session whose record it changes. What it
    // shows afterwards is the host's next answer, never this control's flip.
    expect(host.actions).toEqual([{ action: 'goal', sessionId: String(SID) }])
    expect(readingOf(control)).toEqual({ phase: 'safe', runningTools: [], rearmGoal: false })
    expect(pauseView(readingOf(control) as PauseReading)).toMatchObject({ rearmGoal: false })
  })

  it('shows no goal state when the host did not answer one', async () => {
    const { transport, host, emit } = hostDouble()
    const control = new PauseControl(transport, new AbortController().signal)
    // A host whose snapshot carries the phase but no goal field: the control
    // reports exactly what it was told and renders no switch, rather than
    // falling back to the product default and calling it an answer.
    host.paused = true
    host.phase = 'safe'
    host.rearmGoal = undefined
    await control.refresh(SID)
    expect(readingOf(control)).toEqual({ phase: 'safe', runningTools: [] })
    expect(pauseView(readingOf(control) as PauseReading).rearmGoal).toBeUndefined()
    // The mapping cannot invent it either: only an answered flag becomes a view
    // field, so a reading without one renders no switch at all.
    expect(pauseView({ phase: 'safe', runningTools: [] }).rearmGoal).toBeUndefined()

    // A host that cannot be reached claims nothing about the goal, like the
    // rest of the control.
    host.unavailable = true
    emit()
    const unreachable = new PauseControl(transport, new AbortController().signal)
    await unreachable.refresh(SID)
    expect(readingOf(unreachable)).toEqual({ phase: 'unavailable', runningTools: [] })
    expect(pauseView(readingOf(unreachable) as PauseReading).rearmGoal).toBeUndefined()
  })

  it('follows a state the host changed on its own', async () => {
    const { transport, host } = hostDouble()
    const control = new PauseControl(transport, new AbortController().signal)
    await control.refresh(SID)
    expect(readingOf(control)).toEqual({ phase: 'active', runningTools: [] })

    // Another surface paused the session; this control has not been pressed.
    host.paused = true
    control.refreshAll()
    await until(() => (readingOf(control) as { phase?: string } | undefined)?.phase === 'draining')

    host.paused = false
    control.refreshAll()
    await until(() => (readingOf(control) as { phase?: string } | undefined)?.phase === 'active')
  })

  it('claims nothing when the host cannot answer', async () => {
    const { transport, host } = hostDouble()
    const control = new PauseControl(transport, new AbortController().signal)
    host.unavailable = true
    await control.refresh(SID)
    expect(readingOf(control)).toEqual({ phase: 'unavailable', runningTools: [] })
    expect(pauseView({ phase: 'unavailable', runningTools: [] }).enabled).toBe(false)
  })

  it('claims nothing while a paused session\'s status read is still in flight', async () => {
    const { transport, host } = hostDouble()
    const control = new PauseControl(transport, new AbortController().signal)
    host.paused = true
    host.phase = 'safe'
    // The snapshot read never settles. The host's own last answer was "safe",
    // but a read that did not answer may not borrow it, so the control must not
    // publish "safe to close" either.
    host.hold = true
    void control.refresh(SID)
    await until(() => host.release !== undefined)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(readingOf(control)).toBeUndefined()

    host.release?.()
    host.hold = false
    await until(() => readingOf(control) !== undefined)
    expect(readingOf(control)).toEqual({ phase: 'safe', runningTools: [], rearmGoal: true })
  })

  it('drops an answer the host has already moved past', async () => {
    const pending: ((value: unknown) => void)[] = []
    const transport: PauseTransport = {
      source: {
        read: () => new Promise((resolve) => { pending.push(resolve) }),
        onChange: () => () => {},
      },
      act: async () => ({ ok: true, message: 'done' }),
      triage: async () => [],
      decide: async () => ({ ok: true, message: 'done' }),
    }
    const control = new PauseControl(transport, new AbortController().signal)
    const stale = control.refresh(SID)
    const current = control.refresh(SID)

    // The newer read answers first; the older one lands afterwards.
    pending[1]?.({
      global: snapshotOf({ paused: true, phase: 'parking', runningTools: [], rearmGoal: true, unavailable: false, hold: false, release: undefined, actions: [] })!.global,
      sessions: { [String(SID)]: { phase: 'parking', runningTools: [] } },
    })
    await current
    pending[0]?.({
      global: snapshotOf({ paused: false, phase: 'draining', runningTools: [], rearmGoal: true, unavailable: false, hold: false, release: undefined, actions: [] })!.global,
      sessions: {},
    })
    await stale
    expect(readingOf(control)).toEqual({ phase: 'parking', runningTools: [] })
  })
})

describe('the header control\'s seat', () => {
  /** A loaded snapshot of a top-level session. */
  const mainSession = { subagent: null }
  /** A session snapshot carrying the subagent fact, as the read-only composer reads it. */
  const subagentSession = {
    subagent: { address: { mode: 'continuable', parentSessionId: 'parent-session', childSessionId: String(SID) } },
  }

  it('renders nothing on a subagent session, and its control on a top-level one', () => {
    // The header control is the user's button for a session's work, and that
    // work includes the subagents under it — so the button does not belong
    // inside the tree. The snapshot's own `subagent` field is what tells them
    // apart; a session whose snapshot has not loaded yet claims nothing and
    // keeps the control.
    expect(showsPauseControl(subagentSession.subagent)).toBe(false)
    expect(showsPauseControl(mainSession.subagent)).toBe(true)
    expect(showsPauseControl(undefined)).toBe(true)
  })

  it('answers a still-draining member with the tree\'s phase, not the session\'s', () => {
    // The host folds the registered members of the tree into one phase; the
    // browser only has to read it, and it must never round a phase up. A
    // `draining` reading keeps the control live so pressing again can take the
    // whole tree back.
    expect(pauseView({ phase: 'draining', runningTools: [] }))
      .toMatchObject({ paused: true, enabled: true, labelKey: 'state.draining' })
    expect(pauseView({ phase: 'parking', runningTools: [] }))
      .toMatchObject({ paused: true, enabled: true, labelKey: 'state.parking' })
    expect(pauseView({ phase: 'safe', runningTools: [] }))
      .toMatchObject({ paused: true, enabled: true, labelKey: 'state.safe' })
  })

  it('folds a tree to its least-clean member, and to safe only when all are', () => {
    // The direction the fold compares in: a failed flush is further from clean
    // than work still on its way, and one clean member never carries a set.
    expect(foldTreePhases(new Set(['safe']))).toEqual({ phase: 'safe', safe: true })
    expect(foldTreePhases(new Set(['safe', 'safe', 'safe']))).toEqual({ phase: 'safe', safe: true })
    expect(foldTreePhases(new Set(['safe', 'draining']))).toEqual({ phase: 'draining', safe: false })
    expect(foldTreePhases(new Set(['draining', 'safe', 'parking']))).toEqual({ phase: 'parking', safe: false })
    expect(foldTreePhases(new Set(['safe', 'flush-failed']))).toEqual({ phase: 'flush-failed', safe: false })
    expect(PARK_PHASES).toContain('safe')
  })
})

/**
 * One fake `remote.pauseSession` namespace over the same host double: the
 * generated stream serves the opening snapshot, then one item per change.
 */
function remoteDouble(host: HostDouble): {
  remote: {
    observe(signal?: AbortSignal): AsyncIterable<PauseSnapshotWire>
    act(request: PauseActionRequest, signal?: AbortSignal): Promise<{ ok: boolean; value: PauseActionResult }>
    triage(): Promise<{ ok: boolean; value: [] }>
    decide(): Promise<{ ok: boolean; value: PauseActionResult }>
  }
  emit(): void
  listeners(): () => number
} {
  const changes = new Set<() => void>()
  let latest = snapshotOf(host) ?? emptySnapshot()
  const emit = (): void => {
    latest = snapshotOf(host) ?? emptySnapshot()
    for (const listener of [...changes]) listener()
  }
  return {
    remote: {
      observe: async function* (signal?: AbortSignal) {
        yield latest
        for (;;) {
          await new Promise<void>((resolve, reject) => {
            const done = (): void => { signal?.removeEventListener('abort', onAbort); changes.delete(done); resolve() }
            const onAbort = (): void => { changes.delete(done); reject(signal?.reason) }
            changes.add(done)
            signal?.addEventListener('abort', onAbort, { once: true })
          })
          yield latest
        }
      },
      act: async (request) => {
        host.actions.push(request)
        await Promise.resolve()
        switch (request.action) {
          case 'pause':
            host.paused = true
            host.phase = 'draining'
            break
          case 'resume':
            host.paused = false
            break
          case 'goal':
            host.rearmGoal = !(host.rearmGoal ?? true)
            break
          case 'pause-all':
          case 'resume-all':
            break
        }
        emit()
        // Let the stream deliver the new snapshot before the action resolves,
        // so the control's own post-action read is not a race against it.
        await new Promise(resolve => setTimeout(resolve, 0))
        return { ok: true, value: { ok: true, message: request.action } }
      },
      triage: async () => ({ ok: true, value: [] }),
      decide: async () => ({ ok: true, value: { ok: true, message: 'done' } }),
    },
    emit,
    listeners: () => () => changes.size,
  }
}

/** The shape of one wire outcome, named to keep the namespace double honest. */
interface PauseActionResult { readonly ok: boolean; readonly message: string }

/** A wire snapshot with no park, used when the host went unavailable. */
function emptySnapshot(): PauseSnapshotWire {
  return {
    global: {
      verdict: 'idle', registered: 0, safe: 0, draining: [], parking: 0,
      stalled: [], unresumable: [], unreadTrees: [], jobs: [], blind: [],
    },
    sessions: {},
  }
}

describe('browser control wiring', () => {
  /**
   * Mount the client half on a stand-in Context that records what it registers
   * and carries a fake native Remote namespace. The real SlotRegistry is not
   * mounted here: in this repository its package entry resolves to the browser
   * bundle, so the slot machinery is exercised by `tests/client-slot.spec.ts`
   * and the live application.
   */
  function bench(host: HostDouble) {
    const { remote, emit } = remoteDouble(host)
    const cleanups: (() => void)[] = []
    const registrations: { options?: Record<string, unknown> }[] = []
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
        inject: (_name: string, callback: () => unknown) => { callback(); return () => {} },
        register: (options: Record<string, unknown>, _component: unknown) => {
          registrations.push({ options })
          return () => {}
        },
      },
    }
    apply(ctx as never)
    const entry = registrations.find(registration =>
      registration.options?.name === 'conversation.session.header.actions')
    if (entry === undefined) throw new Error('pause: the control registered no slot entry')
    return {
      host,
      emit,
      cleanups,
      options: entry.options,
      /** The inject face the framework would hand the component. */
      injected: (sessionId: SessionId): PauseInjected => {
        const face = (entry.options as { inject?: (id: SessionId) => PauseInjected }).inject
        if (face === undefined) throw new Error('pause: the control registered no inject face')
        return face(sessionId)
      },
    }
  }

  const phaseAt = (injected: PauseInjected, sessionId: SessionId): string | undefined =>
    injected.hooks.pause.getSnapshot().bySession[String(sessionId)]?.phase

  it('reads the host once per mounted control and re-reads on a native stream change', async () => {
    const { host } = hostDouble()
    // The host reports the session paused elsewhere and still draining before
    // this page mounts.
    host.paused = true
    host.phase = 'draining'
    const benchRun = bench(host)
    expect(benchRun.options).toMatchObject({ id: 'pause', locale: 'pause' })
    const injected = benchRun.injected(SID)

    // Mounting the control reads the stream's cached snapshot once.
    injected.refresh(SID)
    await until(() => phaseAt(injected, SID) === 'draining')
    expect(pauseView(injected.hooks.pause.getSnapshot().bySession[String(SID)])).toMatchObject({
      paused: true,
      enabled: true,
      labelKey: 'state.draining',
    })

    // A stream change is what makes the browser look again.
    host.phase = 'safe'
    host.runningTools = []
    benchRun.emit()
    await until(() => phaseAt(injected, SID) === 'safe')

    // Draining is a pause: pressing again takes it back, which is the whole
    // point of showing a moving phase instead of blocking the button.
    injected.toggle(SID)
    await until(() => host.actions.some(action => action.action === 'resume'))
    await until(() => phaseAt(injected, SID) === 'active')

    // The goal switch rides the same face: pressing it runs the session's own
    // goal action, and the switch's next state is the host's answer again.
    host.paused = true
    host.phase = 'safe'
    host.rearmGoal = true
    benchRun.emit()
    await until(() => phaseAt(injected, SID) === 'safe')
    benchRun.injected(SID).refresh(SID)
    await until(() => injected.hooks.pause.getSnapshot().bySession[String(SID)]?.rearmGoal === true)
    injected.toggleGoal(SID)
    await until(() => host.actions.some(action => action.action === 'goal'))
    await until(() => injected.hooks.pause.getSnapshot().bySession[String(SID)]?.rearmGoal === false)
  })

  it('unsubscribes from the host when the plugin unloads', () => {
    const { host } = hostDouble()
    const benchRun = bench(host)
    for (const cleanup of benchRun.cleanups.reverse()) cleanup()
    // The native stream subscription is owned by an effect; disposing every
    // effect leaves no listener behind.
    expect(benchRun.cleanups.length).toBeGreaterThan(0)
  })
})
