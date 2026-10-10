/**
 * Browser-side reading and driving of the host's whole-app park state.
 *
 * The same one live channel the per-session control uses — a session command
 * run through `ctx.remote.commands.execute`, plus the forwarded
 * `commands/change` event as the only notification — carries the aggregate
 * here. There is no push channel a third-party plugin can add, so the browser
 * asks: `safe-state-all` is registered globally and its RESULT carries the
 * whole-app status as of the read.
 *
 * The command channel is session-addressed, so the control needs one session
 * to talk through. It picks a user session the host can serve (never a
 * subagent's own session), preferring the one on screen; with no session at
 * all there is nothing to ask, and the control claims nothing rather than
 * inventing an answer.
 *
 * A park that is still moving has no registry change to announce it, so this
 * control re-reads on its own while the verdict is `waiting` and stops as soon
 * as it settles.
 * @module dsh-safe-stop/client/global
 */

import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  decodeGlobalStatus, decodeTriageList, RESUME_ALL_COMMAND, STATE_ALL_COMMAND, STOP_ALL_COMMAND,
  TRIAGE_COMMAND, TRIAGE_CONTINUE_COMMAND, TRIAGE_LEAVE_COMMAND, TRIAGE_NOTE_COMMAND, TRIAGE_REVIEW_COMMAND,
} from '../shared.js'
import type { GlobalStatus, TriageAction, TriageRow } from '../shared.js'

/** What the whole-app control knows: the host's answer, or that it could not ask. */
export type GlobalReading =
  | { readonly kind: 'reported'; readonly status: GlobalStatus }
  | { readonly kind: 'unavailable' }

/** What the decision-list panel knows: the host's rows, or that it could not ask. */
export type TriageReading =
  | { readonly kind: 'reported'; readonly rows: readonly TriageRow[] }
  | { readonly kind: 'unavailable' }

/** Whole-app control state. */
export interface GlobalStopState {
  /** The host's answer; absent until one arrives. Writable: the store updates through a draft. */
  global: GlobalReading | undefined
  /** Whether the user asked for the decision list; the panel reads only when it is open. */
  panelOpen: boolean
  /** The host's decision list; absent until the panel asks for it. */
  triage: TriageReading | undefined
}

const INITIAL: GlobalStopState = { global: undefined, panelOpen: false, triage: undefined }

/** The command one decision runs, named from the one vocabulary the host registers. */
export const TRIAGE_DECISION_COMMAND: Readonly<Record<TriageAction, string>> = {
  continue: TRIAGE_CONTINUE_COMMAND,
  note: TRIAGE_NOTE_COMMAND,
  review: TRIAGE_REVIEW_COMMAND,
  leave: TRIAGE_LEAVE_COMMAND,
}

/**
 * The session a whole-app command is addressed to.
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
export class SafeStopGlobalControl {
  /** State source the whole-app contribution binds its selector hook to. */
  readonly store: SnapshotStore<GlobalStopState> = createSnapshotStore(INITIAL)

  /** The last session this control asked through; every later re-read uses it. */
  private address: SessionId | undefined
  /** Highest decision-list read requested: an answer older than it is dropped. */
  private latestTriage = 0
  /** Highest read sequence requested: an answer older than it is dropped. */
  private latest = 0
  private pending: ReturnType<typeof setTimeout> | undefined

  /**
   * @param commands - the Client-callable command namespace.
   * @param lifetime - aborts in-flight calls and the re-read loop when the plugin unloads.
   * @param pollMs - how long to wait before re-reading a park that is still moving.
   */
  constructor(
    private readonly commands: ClientRemote['commands'],
    private readonly lifetime: AbortSignal,
    private readonly pollMs = 400,
  ) {}

  /**
   * Ask the host for the aggregate through one session.
   * @param sessionId - the session to address the global command to.
   * @returns after this read's answer is published or superseded by a newer one.
   */
  async refresh(sessionId: SessionId): Promise<void> {
    this.address = sessionId
    const sequence = ++this.latest
    const reading = await this.read(sessionId)
    // A newer read was requested while this one was in flight; publishing this
    // stale one would show a state the host has already moved past.
    if (this.latest !== sequence) return
    this.publish(reading)
  }

  /** Re-read through the session this control last asked through. */
  refreshAll(): void {
    const address = this.address
    if (address === undefined) return
    void this.refresh(address)
    // The list is the same question asked of the same host, so a registry
    // change refreshes it too — but only while the user has it open: a closed
    // panel must not spend command calls on state nobody is reading.
    if (this.store.getSnapshot().panelOpen) void this.refreshTriage()
  }

  /**
   * Open or close the decision list. Opening asks the host for the rows; there
   * is no state to show without that answer.
   * @param open - whether the panel should be showing.
   */
  setPanel(open: boolean): void {
    this.store.update((state) => { state.panelOpen = open })
    if (open) void this.refreshTriage()
    else this.schedulePoll()
  }

  /** Ask the host for the decision list through the session this control talks through. */
  async refreshTriage(): Promise<void> {
    const address = this.address
    if (address === undefined) return
    const sequence = ++this.latestTriage
    const reading = await this.readTriage(address)
    // A newer read was requested while this one was in flight; its answer is
    // the current one.
    if (this.latestTriage !== sequence) return
    this.store.update((state) => { state.triage = reading })
    this.schedulePoll()
  }

  /**
   * Take one decision on one listed session, addressed through the session the
   * user is on. The list is read first, because the host acts only on rows it
   * has shown the calling session, and read again afterwards because the host's
   * answer — not this control's assumption — is what the next render shows.
   * @param sessionId - the listed session to decide on.
   * @param action - which of the four decisions was taken.
   */
  async decide(sessionId: string, action: TriageAction): Promise<void> {
    const address = this.address
    if (address === undefined) return
    await this.refreshTriage()
    await this.commands.execute(address, `/${TRIAGE_DECISION_COMMAND[action]} ${sessionId}`, [], this.lifetime)
    // A decision can release a session, which the whole-app verdict reports.
    await this.refresh(address)
  }

  /**
   * Press the control: park everything, or release everything the park owns.
   * Which one it is comes from the host's own last answer, never from a local
   * flip; the state shown afterwards is the host's answer again.
   * @param sessionId - the session to address the verb to.
   * @returns after the control re-reads the host.
   */
  async toggle(sessionId: SessionId): Promise<void> {
    const current = this.store.getSnapshot().global
    // Nothing to press against: a state that could not be read is not a state
    // this control may act on.
    if (current === undefined || current.kind !== 'reported') return
    const line = current.status.verdict === 'idle' ? `/${STOP_ALL_COMMAND}` : `/${RESUME_ALL_COMMAND}`
    const executed = await this.commands.execute(sessionId, line, [], this.lifetime)
    if (!executed.ok) {
      this.publish({ kind: 'unavailable' })
      return
    }
    await this.refresh(sessionId)
  }

  /** Ask the host for the decision list, in the browser's vocabulary. */
  private async readTriage(sessionId: SessionId): Promise<TriageReading> {
    const answered = await this.commands.execute(sessionId, `/${TRIAGE_COMMAND}`, [], this.lifetime)
    if (!answered.ok || answered.value === undefined) return { kind: 'unavailable' }
    const text = answered.value.result.kind === 'success' ? answered.value.result.text : undefined
    const list = text === undefined ? undefined : decodeTriageList(text)
    // An answer this control cannot read is not a state it may report.
    return list === undefined ? { kind: 'unavailable' } : { kind: 'reported', rows: list.rows }
  }

  /** Ask the host what the whole-app park state is, in the browser's vocabulary. */
  private async read(sessionId: SessionId): Promise<GlobalReading> {
    const answered = await this.commands.execute(sessionId, `/${STATE_ALL_COMMAND}`, [], this.lifetime)
    if (!answered.ok || answered.value === undefined) return { kind: 'unavailable' }
    const text = answered.value.result.kind === 'success' ? answered.value.result.text : undefined
    const status = text === undefined ? undefined : decodeGlobalStatus(text)
    // An answer this control cannot read is not a state it may report.
    if (status === undefined) return { kind: 'unavailable' }
    return { kind: 'reported', status }
  }

  private publish(reading: GlobalReading): void {
    this.store.update((state) => { state.global = reading })
    this.schedulePoll()
  }

  /**
   * Keep looking while there is something on screen that can still move.
   * Nothing announces the last session reaching the park point, so waiting for
   * a notification would leave "finishing" on screen forever; and a row still
   * draining can join or leave the list while the panel is open. A settled
   * screen stops asking — every re-read is two command records in the address
   * session's log, which is worth paying only while the answer can change.
   */
  private schedulePoll(): void {
    const state = this.store.getSnapshot()
    const current = state.global
    const moving =
      (current?.kind === 'reported' && current.status.verdict === 'waiting')
      || (state.panelOpen && (
        state.triage === undefined
        || state.triage.kind === 'unavailable'
        || state.triage.rows.some(row => row.phase === 'draining')
      ))
    if (!moving || this.pollMs <= 0 || this.lifetime.aborted) {
      if (this.pending !== undefined) {
        clearTimeout(this.pending)
        this.pending = undefined
      }
      return
    }
    if (this.pending !== undefined) return
    this.pending = setTimeout(() => {
      this.pending = undefined
      this.refreshAll()
    }, this.pollMs)
  }
}
