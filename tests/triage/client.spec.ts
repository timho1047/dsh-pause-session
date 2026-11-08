/**
 * The decision list in the browser: the panel rides the same native transport
 * the rest of the control does, and shows nothing it was not told. The whole-app
 * control lives in the conversation header's utilities row, and the panel is
 * opened and read from that seat like any other.
 *
 * The controller is driven against a double of the native `PauseTransport`: the
 * whole-app snapshot is the source, and `triage`/`decide` are direct methods.
 * The panel's own entry point is a pure function of the whole-app view, so "is
 * there anything to decide" is asserted without a browser renderer.
 * @module dsh-pause-session/test/triage/client
 */

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply } from '../../src/client/index.tsx'
import type { PausePillInjected } from '../../src/client/pill.tsx'
import { PauseGlobalControl } from '../../src/client/global.ts'
import type { GlobalPauseState, TriageReading } from '../../src/client/global.ts'
import type { PauseTransport } from '../../src/client/remote.ts'
import { globalPauseView, triageView, TRIAGE_GOAL_VIEW } from '../../src/client/view.ts'
import type { GlobalStatus, TriageRow } from '../../src/shared.ts'
import type { PauseActionResultWire, PauseDecisionRequest, TriageRowWire } from '../../src/remote.ts'
import { until } from '../gate/loop.ts'

const ADDRESS = SessionId('client-address')

/** One listed row, spelled the way the host spells it. */
function row(overrides: Partial<TriageRow> = {}): TriageRow {
  return {
    sessionId: 'overnight-tools',
    phase: 'draining',
    updatedAt: 1,
    reading: 'read',
    lastEvent: 'tool/call',
    turn: 1,
    step: 1,
    traces: [{ tool: 'gated', callId: 'call-slow' }],
    owed: true,
    wakeable: true,
    rearmGoal: true,
    ...overrides,
  }
}

/** One whole-app status, spelled the way the host spells it. */
function status(overrides: Partial<GlobalStatus> = {}): GlobalStatus {
  return {
    verdict: 'waiting',
    registered: 2,
    safe: 1,
    draining: [],
    parking: 0,
    stalled: ['overnight-tools'],
    unresumable: [],
    unreadTrees: [],
    jobs: [],
    blind: [],
    ...overrides,
  }
}

/** Host-side truth a test drives, plus the native calls the browser made. */
interface HostDouble {
  rows: TriageRow[]
  status: GlobalStatus
  readonly actions: unknown[]
  readonly triages: string[]
  readonly decisions: PauseDecisionRequest[]
}

/** A native transport double whose pictures and rows come from the host state. */
function hostDouble(): { transport: PauseTransport; host: HostDouble; emit(): void } {
  const host: HostDouble = { rows: [row()], status: status(), actions: [], triages: [], decisions: [] }
  const changes = new Set<() => void>()
  const emit = (): void => { for (const listener of [...changes]) listener() }
  const transport: PauseTransport = {
    source: {
      read: async () => ({ global: host.status, sessions: {} } as never),
      onChange: (listener) => {
        changes.add(listener)
        return () => { changes.delete(listener) }
      },
    },
    act: async (request): Promise<PauseActionResultWire> => {
      host.actions.push(request)
      return { ok: true, message: request.action }
    },
    triage: async (caller) => {
      host.triages.push(caller)
      return host.rows as readonly TriageRowWire[]
    },
    decide: async (caller, target, decision): Promise<PauseActionResultWire> => {
      host.decisions.push({ caller, target, decision })
      // A decision releases the session it continued, exactly as the host does.
      if (decision !== 'leave' && decision !== 'goal') {
        host.rows = host.rows.filter(entry => entry.sessionId !== target)
      }
      emit()
      return { ok: true, message: 'ok' }
    },
  }
  return { transport, host, emit }
}

const triageOf = (control: PauseGlobalControl): TriageReading | undefined =>
  control.store.getSnapshot().triage

describe('the decision list in the browser', () => {
  it('asks the host for the rows when the panel opens, and not before', async () => {
    const { transport, host } = hostDouble()
    const control = new PauseGlobalControl(transport, new AbortController().signal)

    // Closed: the panel has no rows and has spent no read on them.
    expect(triageOf(control)).toBeUndefined()
    expect(triageView(undefined).visible).toBe(false)
    expect(host.triages).toEqual([])

    await control.refresh(ADDRESS)

    // Opening it is what asks; the explicit read after that is the second read.
    control.setPanel(true)
    await control.refreshTriage()
    expect(host.triages).toEqual([String(ADDRESS), String(ADDRESS)])
    // The native row carries the host's own park timestamp, so every fact the
    // row shows arrives from the same read.
    expect(triageOf(control)).toMatchObject({ kind: 'reported', rows: [row()] })
  })

  it('turns the host rows into the facts a row shows', () => {
    const view = triageView({
      kind: 'reported',
      rows: [
        row(),
        row({ sessionId: 'vault-session', reading: 'unreadable', lastEvent: undefined, turn: undefined, step: undefined, traces: [], owed: false, wakeable: false }),
        row({ sessionId: 'empty-session', traces: [], wakeable: false }),
      ],
    })
    expect(view.visible).toBe(true)
    expect(view.rows[0]).toMatchObject({
      sessionId: 'overnight-tools',
      phaseKey: 'triage.phase.draining',
      stopped: 'tool/call · turn 1 step 1',
      unknownTools: ['gated'],
      wakeable: true,
      readable: true,
    })
    // A row the host could not read says so: no stop position, no tools, and no
    // promise that continuing would send anything.
    expect(view.rows[1]).toMatchObject({ readable: false, wakeable: false, unknownTools: [] })
    expect(view.rows[1]?.stopped).toBeUndefined()
    expect(view.rows[2]).toMatchObject({ readable: true, wakeable: false, unknownTools: [] })
  })

  it('runs one listed decision per action, addressed through the session the user is on', async () => {
    const { transport, host } = hostDouble()
    const control = new PauseGlobalControl(transport, new AbortController().signal)
    await control.refresh(ADDRESS)
    control.setPanel(true)
    await control.refreshTriage()
    host.triages.length = 0
    host.decisions.length = 0

    for (const action of ['continue', 'note', 'review', 'leave', 'goal'] as const) {
      host.rows = [row({ sessionId: `session-${action}` })]
      await control.decide(`session-${action}`, action)
      // The read comes first: the host acts only on a row it has shown the
      // session the decision is addressed to, and that read is what shows it.
      // It comes again afterwards because the host's answer is what the panel
      // shows next — a decision can take a row off the list, or flip what it says.
      expect(host.triages).toEqual([String(ADDRESS)])
      expect(host.decisions).toEqual([{
        caller: String(ADDRESS),
        target: `session-${action}`,
        decision: action,
      }])
      host.triages.length = 0
      host.decisions.length = 0
    }
  })

  it('carries the goal re-arm state the host reported, and its switch view', () => {
    const view = triageView({
      kind: 'reported',
      rows: [row({ rearmGoal: false }), row({ sessionId: 'armed-session' })],
    })
    expect(view.rows[0]?.rearmGoal).toBe(false)
    expect(view.rows[1]?.rearmGoal).toBe(true)
    expect(TRIAGE_GOAL_VIEW).toEqual({
      action: 'goal',
      labelKey: 'triage.goal',
      ariaKey: 'triage.goal.aria',
    })
  })

  it('shows the panel entry point only when the host says something did not stop cleanly', () => {
    // `stalled` is the host's own name for "will not finish in this process",
    // which is exactly the set the list exists for.
    expect(globalPauseView({ kind: 'reported', status: status({ stalled: ['a'] }) }).unclean).toBe(1)
    expect(globalPauseView({ kind: 'reported', status: status({ stalled: [] }) }).unclean).toBe(0)
    // A host that cannot answer gets no entry point, like the rest of the pill.
    expect(globalPauseView({ kind: 'unavailable' }).unclean).toBe(0)
  })
})

describe('the decision list from its header seat', () => {
  /**
   * Mount the client half on a stand-in Context, and reach the whole-app
   * control through the face the framework hands its header entry. The real
   * SlotRegistry is not mounted here (see `tests/client-slot.spec.ts`); what is
   * exercised is the seat the panel is opened and read from.
   */
  function bench(host: HostDouble) {
    const changes = new Set<() => void>()
    let latest = { global: host.status, sessions: {} }
    const emit = (): void => {
      latest = { global: host.status, sessions: {} }
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
      act: async () => ({ ok: true, value: { ok: true, message: 'done' } }),
      triage: async (request: { caller: string }) => {
        host.triages.push(request.caller)
        return { ok: true, value: host.rows }
      },
      decide: async (request: PauseDecisionRequest) => {
        host.decisions.push(request)
        emit()
        return { ok: true, value: { ok: true, message: 'ok' } }
      },
    }
    const registrations: { options: Record<string, unknown> }[] = []
    const ctx = {
      effect(callback: () => unknown) {
        const cleanup = callback()
        return () => { if (typeof cleanup === 'function') (cleanup as () => void)() }
      },
      locale: { register: () => () => {} },
      remote: { pauseSession: remote },
      inject(_names: readonly string[], callback: (child: typeof ctx) => unknown) {
        callback(ctx)
        return () => {}
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
    const entry = registrations.find(registration =>
      registration.options['name'] === 'conversation.session.header.utilities')
    if (entry === undefined) throw new Error('pause: the whole-app control registered no slot entry')
    const face = (entry.options as { inject?: () => PausePillInjected }).inject
    if (face === undefined) throw new Error('pause: the whole-app control registered no inject face')
    return { host, injected: face(), emit }
  }

  it('opens and reads the panel from the header, spending nothing on rows while it is closed', async () => {
    const host: HostDouble = { rows: [row()], status: status(), actions: [], triages: [], decisions: [] }
    const benchRun = bench(host)
    const state = (): GlobalPauseState => benchRun.injected.hooks.pauseGlobal.getSnapshot()

    benchRun.injected.refresh(ADDRESS)
    await until(() => state().global !== undefined)
    // Something did not stop cleanly, which is what makes the panel reachable:
    // its entry point counts the same set the whole-app verdict calls unclean.
    expect(globalPauseView(state().global)).toMatchObject({ visible: true, unclean: 1 })
    expect(state().triage).toBeUndefined()
    expect(host.triages).toEqual([])

    benchRun.injected.setPanel(true)
    await until(() => state().triage !== undefined)
    expect(state().panelOpen).toBe(true)
    expect(host.triages).toContain(String(ADDRESS))
    expect(triageView(state().triage).rows).toMatchObject([
      { sessionId: 'overnight-tools', phaseKey: 'triage.phase.draining', unknownTools: ['gated'] },
    ])

    // A decision taken from the header still goes through the native action,
    // addressed through the session the user is on.
    benchRun.injected.decide('overnight-tools', 'continue')
    await until(() => host.decisions.some(decision => decision.target === 'overnight-tools'))
    expect(host.decisions.at(-1)).toMatchObject({
      caller: String(ADDRESS),
      target: 'overnight-tools',
      decision: 'continue',
    })
  })
})
