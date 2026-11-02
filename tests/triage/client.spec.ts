/**
 * The decision list in the browser: the panel rides the same command channel
 * the rest of the control does, and shows nothing it was not told. The
 * whole-app control lives in the conversation header's utilities row, and the
 * panel is opened and read from that seat like any other.
 *
 * The controller is driven against a double of the real Client-callable command
 * namespace that answers the way the host does — the list verb's RESULT carries
 * the rows as of the read, and each decision is its own session-addressed
 * command. The panel's own entry point is a pure function of the whole-app view,
 * so "is there anything to decide" is asserted without a browser renderer.
 * @module dsh-pause/test/triage/client
 */

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply } from '../../src/client/index.tsx'
import type { PausePillInjected } from '../../src/client/pill.tsx'
import { PauseGlobalControl, TRIAGE_DECISION_COMMAND } from '../../src/client/global.ts'
import type { GlobalPauseState, TriageReading } from '../../src/client/global.ts'
import { globalPauseView, triageView, TRIAGE_GOAL_VIEW } from '../../src/client/view.ts'
import {
  decodeTriageList, encodeGlobalStatus, encodeTriageList, STATE_ALL_COMMAND, TRIAGE_COMMAND, TRIAGE_GOAL_COMMAND,
} from '../../src/shared.ts'
import type { GlobalStatus, TriageList, TriageRow } from '../../src/shared.ts'
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

/** Host-side truth a test drives, plus the lines the browser executed. */
interface HostDouble {
  rows: TriageRow[]
  status: GlobalStatus
  readonly lines: string[]
}

/** A stand-in for `ctx.remote.commands` that answers like the host registry does. */
function hostDouble(): { commands: never; host: HostDouble } {
  const host: HostDouble = { rows: [row()], status: status(), lines: [] }
  const commands = {
    list: () => Promise.resolve({ ok: true, value: [] }),
    execute: (_sessionId: SessionId, line: string) => {
      host.lines.push(line)
      if (line === `/${TRIAGE_COMMAND}`) {
        const list: TriageList = { rows: host.rows }
        return Promise.resolve({ ok: true, value: { commandId: 'c', result: { kind: 'success', text: encodeTriageList(list) } } })
      }
      if (line.startsWith('/pause-triage-')) {
        // A decision releases the session it continued, exactly as the host does.
        const target = line.slice(line.indexOf(' ') + 1)
        host.rows = host.rows.filter(entry => line.includes('-leave') || entry.sessionId !== target)
        return Promise.resolve({ ok: true, value: { commandId: 'c', result: { kind: 'success', text: 'ok' } } })
      }
      return Promise.resolve({
        ok: true,
        value: { commandId: 'c', result: { kind: 'success', text: encodeGlobalStatus(host.status) } },
      })
    },
  }
  return { commands: commands as never, host }
}

const triageOf = (control: PauseGlobalControl): TriageReading | undefined =>
  control.store.getSnapshot().triage

describe('the decision list in the browser', () => {
  it('asks the host for the rows when the panel opens, and not before', async () => {
    const { commands, host } = hostDouble()
    const control = new PauseGlobalControl(commands, new AbortController().signal)

    // Closed: the panel has no rows and has spent no call on them.
    expect(triageOf(control)).toBeUndefined()
    expect(triageView(undefined).visible).toBe(false)
    expect(host.lines).toEqual([])

    await control.refresh(ADDRESS)
    expect(host.lines).toEqual(['/pause-state-all'])

    // Opening it is what asks; the explicit read after that is the second call.
    control.setPanel(true)
    await control.refreshTriage()
    expect(host.lines).toEqual(['/pause-state-all', `/${TRIAGE_COMMAND}`, `/${TRIAGE_COMMAND}`])
    // `updatedAt` is the host's own park timestamp and does not ride the
    // published list; every fact the row shows does.
    expect(triageOf(control)).toMatchObject({ kind: 'reported', rows: [{ ...row(), updatedAt: 0 }] })
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

  it('runs one listed verb per action, addressed through the session the user is on', async () => {
    const { commands, host } = hostDouble()
    const control = new PauseGlobalControl(commands, new AbortController().signal)
    await control.refresh(ADDRESS)
    control.setPanel(true)
    await control.refreshTriage()
    host.lines.length = 0

    for (const action of ['continue', 'note', 'review', 'leave', 'goal'] as const) {
      host.rows = [row({ sessionId: `session-${action}` })]
      await control.decide(`session-${action}`, action)
      // The read comes first: the host acts only on a row it has shown the
      // session the decision is addressed to, and that read is what shows it.
      // It comes again afterwards because the host's answer is what the panel
      // shows next — a verb can take a row off the list, or flip what it says.
      expect(host.lines).toEqual([
        `/${TRIAGE_COMMAND}`,
        `/${TRIAGE_DECISION_COMMAND[action]} session-${action}`,
        `/${TRIAGE_COMMAND}`,
        `/${STATE_ALL_COMMAND}`,
      ])
      host.lines.length = 0
    }
  })

  it('carries the goal re-arm state the host reported, and its switch verb', () => {
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
    expect(TRIAGE_DECISION_COMMAND.goal).toBe(TRIAGE_GOAL_COMMAND)
  })

  it('shows the panel entry point only when the host says something did not stop cleanly', () => {
    // `stalled` is the host's own name for "will not finish in this process",
    // which is exactly the set the list exists for.
    expect(globalPauseView({ kind: 'reported', status: status({ stalled: ['a'] }) }).unclean).toBe(1)
    expect(globalPauseView({ kind: 'reported', status: status({ stalled: [] }) }).unclean).toBe(0)
    // A host that cannot answer gets no entry point, like the rest of the pill.
    expect(globalPauseView({ kind: 'unavailable' }).unclean).toBe(0)
  })

  it('refuses to read a list out of the other vocabularies', () => {
    const list = encodeTriageList({ rows: [row()] })
    expect(decodeTriageList(list)?.rows[0]).toMatchObject({ sessionId: 'overnight-tools', phase: 'draining' })
    expect(decodeTriageList(encodeGlobalStatus(status()))).toBeUndefined()
    expect(decodeTriageList('pause: draining')).toBeUndefined()
  })

  it('round-trips a row whole, separators and all', () => {
    // Every field the host's own data can put a separator in: the session id in
    // the row field, the tool and call id in a trace, and the event name in the
    // stop position. A folded spelling would name a different session, which is
    // a row looked up again under the wrong name.
    const spelled = row({
      sessionId: 'overnight;tools,one',
      lastEvent: 'turn/end',
      traces: [{ tool: 'a/b;c,d', callId: 'call-1/x' }],
    })
    const text = encodeTriageList({ rows: [spelled] })
    const decoded = decodeTriageList(text)
    expect(decoded?.rows).toHaveLength(1)
    expect(decoded?.rows[0]).toMatchObject({
      sessionId: 'overnight;tools,one',
      phase: 'draining',
      reading: 'read',
      lastEvent: 'turn/end',
      turn: 1,
      step: 1,
      traces: [{ tool: 'a/b;c,d', callId: 'call-1/x' }],
      owed: true,
      wakeable: true,
    })
    // A row that names no stop position says so, rather than decoding the
    // empty marker as an event.
    const bare = decodeTriageList(encodeTriageList({ rows: [row({ lastEvent: undefined, turn: undefined, step: undefined })] }))
    expect(bare?.rows[0]?.lastEvent).toBeUndefined()
    expect(bare?.rows[0]?.turn).toBeUndefined()
    // A session id that is exactly the empty marker is still that session.
    const marker = decodeTriageList(encodeTriageList({ rows: [row({ sessionId: '-' })] }))
    expect(marker?.rows[0]?.sessionId).toBe('-')
  })
})

describe('the decision list from its header seat', () => {
  /**
   * Mount the client half on a stand-in Context, and reach the whole-app
   * control through the face the framework hands its header entry. The real
   * SlotRegistry is not mounted here (see `tests/client-slot.spec.ts`); what is
   * exercised is the seat the panel is opened and read from.
   */
  function bench() {
    const { commands, host } = hostDouble()
    const registrations: { options: Record<string, unknown> }[] = []
    const ctx = {
      effect(callback: () => unknown) {
        callback()
        return () => {}
      },
      locale: { register: () => () => {} },
      remote: { commands, $on: () => () => {} },
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
    return { host, injected: face() }
  }

  it('opens and reads the panel from the header, spending nothing on rows while it is closed', async () => {
    const benchRun = bench()
    const state = (): GlobalPauseState => benchRun.injected.hooks.pauseGlobal.getSnapshot()

    benchRun.injected.refresh(ADDRESS)
    await until(() => state().global !== undefined)
    // Something did not stop cleanly, which is what makes the panel reachable:
    // its entry point counts the same set the whole-app verdict calls unclean.
    expect(globalPauseView(state().global)).toMatchObject({ visible: true, unclean: 1 })
    expect(state().triage).toBeUndefined()
    expect(benchRun.host.lines).toEqual([`/${STATE_ALL_COMMAND}`])

    benchRun.injected.setPanel(true)
    await until(() => state().triage !== undefined)
    expect(state().panelOpen).toBe(true)
    expect(benchRun.host.lines).toContain(`/${TRIAGE_COMMAND}`)
    expect(triageView(state().triage).rows).toMatchObject([
      { sessionId: 'overnight-tools', phaseKey: 'triage.phase.draining', unknownTools: ['gated'] },
    ])

    // A decision taken from the header still runs the session-addressed verb;
    // the press is fire-and-forget, so the command is what is waited on.
    benchRun.injected.decide('overnight-tools', 'continue')
    const decision = `/${TRIAGE_DECISION_COMMAND.continue} overnight-tools`
    await until(() => benchRun.host.lines.includes(decision))
    expect(benchRun.host.lines.slice(0, 2)).toEqual([`/${STATE_ALL_COMMAND}`, `/${TRIAGE_COMMAND}`])
  })
})
