/**
 * Task 08's browser half: the decision list rides the same command channel the
 * rest of the control does, and shows nothing it was not told.
 *
 * The controller is driven against a double of the real Client-callable command
 * namespace that answers the way the host does — the list verb's RESULT carries
 * the rows as of the read, and each decision is its own session-addressed
 * command. The panel's own entry point is a pure function of the whole-app view,
 * so "is there anything to decide" is asserted without a browser renderer.
 * @module dsh-safe-stop/test/triage/client
 */

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SafeStopGlobalControl, TRIAGE_DECISION_COMMAND } from '../../src/client/global.ts'
import type { TriageReading } from '../../src/client/global.ts'
import { globalStopView, triageView } from '../../src/client/view.ts'
import {
  decodeTriageList, encodeGlobalStatus, encodeTriageList, TRIAGE_COMMAND,
} from '../../src/shared.ts'
import type { GlobalStatus, TriageList, TriageRow } from '../../src/shared.ts'

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
      if (line.startsWith('/safe-triage-')) {
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

const triageOf = (control: SafeStopGlobalControl): TriageReading | undefined =>
  control.store.getSnapshot().triage

describe('the decision list in the browser', () => {
  it('asks the host for the rows when the panel opens, and not before', async () => {
    const { commands, host } = hostDouble()
    const control = new SafeStopGlobalControl(commands, new AbortController().signal)

    // Closed: the panel has no rows and has spent no call on them.
    expect(triageOf(control)).toBeUndefined()
    expect(triageView(undefined).visible).toBe(false)
    expect(host.lines).toEqual([])

    await control.refresh(ADDRESS)
    expect(host.lines).toEqual(['/safe-state-all'])

    // Opening it is what asks; the explicit read after that is the second call.
    control.setPanel(true)
    await control.refreshTriage()
    expect(host.lines).toEqual(['/safe-state-all', `/${TRIAGE_COMMAND}`, `/${TRIAGE_COMMAND}`])
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

  it('runs one decision per action, addressed through the session the user is on', async () => {
    const { commands, host } = hostDouble()
    const control = new SafeStopGlobalControl(commands, new AbortController().signal)
    await control.refresh(ADDRESS)
    control.setPanel(true)
    await control.refreshTriage()
    host.lines.length = 0

    for (const action of ['continue', 'note', 'review', 'leave'] as const) {
      host.rows = [row({ sessionId: `session-${action}` })]
      await control.decide(`session-${action}`, action)
      expect(host.lines[0]).toBe(`/${TRIAGE_DECISION_COMMAND[action]} session-${action}`)
      host.lines.length = 0
    }
    // Every decision re-reads the list and the verdict: the host's answer is
    // what the next render shows, never this control's assumption.
    expect(host.lines.length).toBe(0)
  })

  it('shows the panel entry point only when the host says something did not stop cleanly', () => {
    // `stalled` is the host's own name for "will not finish in this process",
    // which is exactly the set the list exists for.
    expect(globalStopView({ kind: 'reported', status: status({ stalled: ['a'] }) }).unclean).toBe(1)
    expect(globalStopView({ kind: 'reported', status: status({ stalled: [] }) }).unclean).toBe(0)
    // A host that cannot answer gets no entry point, like the rest of the pill.
    expect(globalStopView({ kind: 'unavailable' }).unclean).toBe(0)
  })

  it('refuses to read a list out of the other vocabularies', () => {
    const list = encodeTriageList({ rows: [row()] })
    expect(decodeTriageList(list)?.rows[0]).toMatchObject({ sessionId: 'overnight-tools', phase: 'draining' })
    expect(decodeTriageList(encodeGlobalStatus(status()))).toBeUndefined()
    expect(decodeTriageList('safe-stop: draining')).toBeUndefined()
  })
})
