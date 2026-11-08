/**
 * Browser-side reading and driving of the host's whole-app park state.
 *
 * The aggregate arrives from the native `pauseSession` stream. The stream is
 * process-wide and writes nothing into any Session; actions travel through the
 * same Remote namespace. A pushed snapshot is applied directly; a settled park
 * costs nothing while its last answer stays on screen.
 * @module dsh-pause-session/client/global
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GlobalStatus, TriageAction, TriageRow } from '../shared.js'
import type { TriageRowWire } from '../remote.js'
import { globalPauseView } from './view.js'
import type { PauseTransport } from './remote.js'


/** Map one Remote row to the list's structured row. */
function wireTriageRow(row: TriageRowWire): TriageRow {
  return {
    sessionId: row.sessionId,
    phase: row.phase,
    updatedAt: row.updatedAt,
    reading: row.reading,
    ...row.lastEvent === undefined ? {} : { lastEvent: row.lastEvent },
    ...row.turn === undefined ? {} : { turn: row.turn },
    ...row.step === undefined ? {} : { step: row.step },
    traces: row.traces.map(trace => ({ tool: trace.tool, callId: trace.callId ?? '' })),
    owed: row.owed,
    wakeable: row.wakeable,
    rearmGoal: row.rearmGoal,
  }
}
/** What the whole-app control knows: the host's answer, or that it could not ask. */
export type GlobalReading =
  | { readonly kind: 'reported'; readonly status: GlobalStatus }
  | { readonly kind: 'unavailable' }

/** What the decision-list panel knows: the host's rows, or that it could not ask. */
export type TriageReading =
  | { readonly kind: 'reported'; readonly rows: readonly TriageRow[] }
  | { readonly kind: 'unavailable' }

/** Whole-app control state. */
export interface GlobalPauseState {
  /** The host's answer; absent until one arrives. Writable: the store updates through a draft. */
  global: GlobalReading | undefined
  /** Whether the user asked for the decision list; the panel reads only when it is open. */
  panelOpen: boolean
  /** The host's decision list; absent until the panel asks for it. */
  triage: TriageReading | undefined
  /** The last action or read refusal, shown verbatim in the panel. */
  error?: string
  /** The last snapshot's per-session details, for the draining progress copy. */
  sessions?: Readonly<Record<string, { readonly runningTools: readonly string[] }>>
}

const INITIAL: GlobalPauseState = { global: undefined, panelOpen: false, triage: undefined }


/**
 * The session a whole-app action is addressed to.
 *
 * A subagent's own session is never addressed: its agent belongs to a parent
 * and is not the host's business to drive from the shell. Among the rest, the
 * one on screen is the best address (its agent is live by construction), then
 * any session the host reports as running, then any at all.
 * @param state - the session list snapshot the shell provides.
 * @returns the address, or `undefined` when the app has no session to ask through.
 */
export function addressingSession(state: {
  readonly ids: readonly SessionId[]
  readonly byId: Readonly<Record<string, {
    readonly running?: boolean
    readonly origin?: string
    readonly parentId?: unknown
    readonly retainedBy?: { readonly mainView?: number }
  } | undefined>>
}): SessionId | undefined {
  const usable = state.ids.filter((id) => {
    const row = state.byId[String(id)]
    return row !== undefined && row.origin !== 'subagent' && row.parentId === undefined
  })
  return usable.find(id => (state.byId[String(id)]?.retainedBy?.mainView ?? 0) > 0)
    ?? usable.find(id => state.byId[String(id)]?.running === true)
    ?? usable[0]
}

/** Owns the published whole-app reading; nothing else writes that state. */
export class PauseGlobalControl {
  /** State source the whole-app contribution binds its selector hook to. */
  readonly store: SnapshotStore<GlobalPauseState> = createSnapshotStore(INITIAL)

  /** The session the shell asked this control through; list reads use it. */
  private address: SessionId | undefined
  /** Highest decision-list read requested: an answer older than it is dropped. */
  private latestTriage = 0

  /**
   * @param transport - the native namespace source and actions.
   * @param lifetime - aborts in-flight reads when the plugin unloads.
   */
  constructor(
    private readonly transport: PauseTransport,
    private readonly lifetime: AbortSignal,
  ) {}

  /**
   * The shell handed this control a session. The first call reads the aggregate;
   * later calls only move where list reads and actions are addressed.
   * @param sessionId - the session the shell asks through.
   */
  async refresh(sessionId: SessionId): Promise<void> {
    this.address = sessionId
    await this.readAggregate()
  }

  /** Apply one pushed snapshot directly. */
  apply(snapshot: { readonly global: GlobalStatus; readonly sessions: Readonly<Record<string, { readonly runningTools: readonly string[] }>> } | undefined): void {
    this.store.update((state) => { state.sessions = snapshot?.sessions })
    this.publish(snapshot === undefined ? { kind: 'unavailable' } : { kind: 'reported', status: snapshot.global })
  }

  /** A pushed snapshot may have moved the aggregate and the open list. */
  refreshAll(): void {
    if (this.lifetime.aborted) return
    void this.readAggregate()
    if (this.store.getSnapshot().panelOpen) void this.refreshTriage()
  }

  /**
   * Open or close the decision list. Opening asks for the rows; there is no
   * state to show without that answer.
   * @param open - whether the panel should be showing.
   */
  setPanel(open: boolean): void {
    this.store.update((state) => { state.panelOpen = open })
    if (open) void this.refreshTriage()
  }

  /** Ask the host for the decision list for the session the user is on. */
  async refreshTriage(): Promise<void> {
    await this.readTriage()
  }

  /**
   * Take one listed verb on one listed session, addressed through the session
   * the user is on. A refusal is published verbatim rather than silently
   * leaving the previous rows in place.
   * @param sessionId - the listed session to act on.
   * @param action - which listed verb was taken.
   */
  async decide(sessionId: string, action: TriageAction): Promise<void> {
    const address = this.address
    if (address === undefined) return
    const answer = await this.transport.decide(String(address), sessionId, action, this.lifetime)
    if (!answer.ok) {
      this.store.update((state) => { state.error = answer.message })
      return
    }
    this.store.update((state) => { state.error = undefined })
    await this.refreshTriage()
    await this.reread(address)
  }

  /**
   * Press the pill: park everything, or release everything the park owns.
   * Which one it is comes from the host's own last answer, never from a local
   * flip; the state shown afterwards is the host's answer again.
   * @param sessionId - the session to address the verb to.
   */
  async toggle(sessionId: SessionId): Promise<void> {
    const current = this.store.getSnapshot().global
    if (current === undefined || current.kind !== 'reported') return
    const action = globalPauseView(current).action
    if (action === 'none') return
    const answer = await this.transport.act({ action, sessionId: String(sessionId) }, this.lifetime)
    if (!answer.ok) {
      this.store.update((state) => { state.error = answer.message })
      return
    }
    this.store.update((state) => { state.error = undefined })
    await this.reread(sessionId)
  }

  /** Read the aggregate once and publish it. */
  private async readAggregate(): Promise<void> {
    const snapshot = await this.transport.source.read(this.lifetime)
    if (snapshot === undefined) {
      this.publish({ kind: 'unavailable' })
      return
    }
    this.store.update((state) => { state.sessions = snapshot.sessions })
    this.publish({ kind: 'reported', status: snapshot.global })
  }

  private async reread(sessionId: SessionId): Promise<void> {
    this.address = sessionId
    await this.readAggregate()
  }

  /** One decision-list read, addressed at the session the user is on. */
  private async readTriage(): Promise<void> {
    const address = this.address
    if (address === undefined) return
    const sequence = ++this.latestTriage
    const reading = await this.readTriageRows(address)
    if (this.latestTriage !== sequence) return
    this.store.update((state) => { state.triage = reading })
  }

  /** Ask the native namespace for the decision list. */
  private async readTriageRows(sessionId: SessionId): Promise<TriageReading> {
    const rows = await this.transport.triage(String(sessionId), this.lifetime)
    return rows === undefined ? { kind: 'unavailable' } : { kind: 'reported', rows: rows.map(wireTriageRow) }
  }

  private publish(reading: GlobalReading): void {
    this.store.update((state) => {
      if (state.global?.kind === reading.kind
        && (reading.kind === 'unavailable'
          || (state.global?.kind === 'reported'
            && JSON.stringify(state.global.status) === JSON.stringify(reading.status)))) return
      state.global = reading
    })
  }
}
