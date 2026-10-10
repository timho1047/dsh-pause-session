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
 * inventing an answer. Once the host's own answer names a session the park owns,
 * reads are addressed there instead: a read writes two records into the address
 * session's transcript, and they belong in the session being parked rather than
 * in whatever the user happens to be looking at. Failing that, the session the
 * last answer reported as registered is remembered, then the one a read was last
 * served through — an address change is the user looking somewhere else, not
 * news about the park, and a park that has emptied out is no reason to start
 * writing rows into every session the user opens next. A remembered address that
 * stops answering (its agent is gone) is forgotten and the read falls back to
 * the session the shell asks with, so a stale address costs an honest answer
 * rather than a control that can never speak again.
 *
 * Nothing announces the flush that settles a park — the marker commands are
 * registered when the pause is pressed, not when the flush resolves — so a
 * transition buys a short bounded burst of reads and then stops (`./burst.ts`).
 * The burst is spent only while the park is settling: work still in flight
 * announces its own end through the registry change that starts the next burst,
 * so watching it from here would be reads spent on a transition that is going to
 * speak for itself. A settled answer is left on screen unread: the panel stays
 * readable and the pill keeps saying what it says, but the browser stops
 * spending host round-trips and log records on a state that has stopped moving.
 * What owes a read is the host's forwarded registry change, the user's own press
 * or decision, and the first read at mount; once an answer is on screen, the
 * shell handing this control another session to ask through is none of those.
 * @module dsh-safe-stop/client/global
 */

import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  decodeGlobalStatus, decodeTriageList, RESUME_ALL_COMMAND, STATE_ALL_COMMAND, STOP_ALL_COMMAND,
  TRIAGE_COMMAND, TRIAGE_CONTINUE_COMMAND, TRIAGE_GOAL_COMMAND, TRIAGE_LEAVE_COMMAND, TRIAGE_NOTE_COMMAND,
  TRIAGE_REVIEW_COMMAND,
} from '../shared.js'
import type { GlobalStatus, TriageAction, TriageRow } from '../shared.js'
import { burstWaits, DEFAULT_BURST_POLICY, ReadBurst } from './burst.js'
import type { BurstPolicy } from './burst.js'
import { globalStopView } from './view.js'

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

/** The command one listed verb runs, named from the one vocabulary the host registers. */
export const TRIAGE_DECISION_COMMAND: Readonly<Record<TriageAction, string>> = {
  continue: TRIAGE_CONTINUE_COMMAND,
  note: TRIAGE_NOTE_COMMAND,
  review: TRIAGE_REVIEW_COMMAND,
  leave: TRIAGE_LEAVE_COMMAND,
  goal: TRIAGE_GOAL_COMMAND,
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

/**
 * The registered sessions one whole-app answer names, best address first: the
 * one still draining is the one this host is executing against right now, the
 * rest is the host's own vocabulary for a registered session it is not going to
 * move any further.
 *
 * A stalled or unreadable record is deliberately not an address for a read —
 * this host may not hold that session at all, and a read that could not be
 * delivered would report "unavailable" for a transport reason rather than a
 * state — but it is still a registered session, which is all the remembered
 * address is for. The host's own answer is JSON: the branded ids arrive as the
 * strings they were encoded as, exactly like the ids the shell hands the pill.
 * @param status - the host's last whole-app answer.
 * @returns the registered sessions the answer names, best first.
 */
function registeredSessions(status: GlobalStatus): string[] {
  return [
    ...status.draining,
    ...status.stalled,
    ...status.unresumable,
    ...status.unreadTrees,
  ]
}

/**
 * The session a registered park owns, when the host's answer names one that is
 * still moving. This is how a read stops landing in whatever session the user
 * happens to be looking at.
 * @param status - the host's last whole-app answer.
 * @returns a draining session, or `undefined` when the answer names none.
 */
export function registeredAddress(status: GlobalStatus): SessionId | undefined {
  const draining = status.draining[0]
  return draining === undefined ? undefined : draining as SessionId
}

/** Owns the published whole-app reading; nothing else writes that state. */
export class SafeStopGlobalControl {
  /** State source the whole-app contribution binds its selector hook to. */
  readonly store: SnapshotStore<GlobalStopState> = createSnapshotStore(INITIAL)

  /** The session the shell asked this control through; reads start here. */
  private address: SessionId | undefined
  /**
   * The last session an answer reported as registered — the park's own address.
   *
   * `draining` names only what is moving right now, so a park that stopped
   * moving would stop naming the session it lives in, and the read would fall
   * back to whatever the user happens to be looking at. Remembering the last
   * registered session keeps the park's rows in the park's transcript for as
   * long as the park exists. An empty registry does not clear it: a park whose
   * sessions stopped moving has not moved out of its sessions.
   */
  private lastRegistered: SessionId | undefined
  /**
   * The session an aggregate read was last served through. Later reads keep
   * going there: every read is two records in the address session's log, and
   * the shell's address follows whatever the user is looking at, which is not
   * where a row about the park belongs.
   */
  private served: SessionId | undefined
  /** Highest decision-list read requested: an answer older than it is dropped. */
  private latestTriage = 0
  /** Highest read sequence requested: an answer older than it is dropped. */
  private latest = 0
  /** The bounded burst of reads one transition buys; see `./burst.ts`. */
  private readonly burst: ReadBurst

  /**
   * @param commands - the Client-callable command namespace.
   * @param lifetime - aborts in-flight calls and the burst when the plugin unloads.
   * @param windowMs - how long the burst collects the registrations of one
   * transition before its first read; also the wait after a press.
   * @param policy - the burst waits and visibility source; defaults to the real page.
   */
  constructor(
    private readonly commands: ClientRemote['commands'],
    private readonly lifetime: AbortSignal,
    windowMs = 400,
    policy: Omit<BurstPolicy, 'windowMs' | 'waitsMs'> = DEFAULT_BURST_POLICY,
  ) {
    this.burst = new ReadBurst(
      () => { void this.readAll() },
      { ...policy, windowMs, waitsMs: burstWaits(windowMs) },
    )
  }

  /**
   * The shell handed this control a session: the one the pill mounted on, or
   * the one the user has just moved to. Only a control with no answer yet reads
   * here — the view moving is not the park moving, and after the first answer
   * the forwarded registry change and the user's own press are what ask again.
   * A read that came back with nothing is not an answer, so moving to another
   * session is one more chance to reach the host rather than a control that
   * stays mute until something else happens to change. The address is kept
   * either way: it is where this control's presses and its decision list go, and
   * the fallback a remembered address falls back to.
   * @param sessionId - the session the shell asks through.
   * @returns after this read's answer is published or superseded by a newer one.
   */
  async refresh(sessionId: SessionId): Promise<void> {
    this.address = sessionId
    if (this.answered()) return
    await this.readAggregate()
    this.follow()
  }

  /** Whether the host has answered: a state, not the absence of one it never sent. */
  private answered(): boolean {
    return this.store.getSnapshot().global?.kind === 'reported'
  }

  /**
   * The host's command registry changed: something may have moved, so a burst
   * is owed. The reads run on the burst's own schedule rather than here, which
   * is what coalesces a tick's worth of changes — parking N sessions announces
   * three registrations each — into one burst.
   */
  refreshAll(): void {
    if (this.address === undefined || this.lifetime.aborted) return
    this.burst.trigger()
  }

  /**
   * One read of the whole screen: the aggregate, plus the decision list while
   * the user has it open. A closed panel spends no command calls on rows nobody
   * is reading.
   */
  private async readAll(): Promise<void> {
    if (this.target() === undefined || this.lifetime.aborted) {
      this.burst.stop()
      return
    }
    await this.readAggregate()
    if (this.store.getSnapshot().panelOpen) await this.readTriage()
    // One burst decision per pass: taken per read, two reads that disagree
    // about what is moving would end the burst and start it again, which is a
    // heartbeat with extra steps.
    this.follow()
  }

  /**
   * The session a read goes through: the one the park lives in, else the one an
   * aggregate read was last served through, else the session the shell is on
   * now. The park's own address comes first because a read's rows land in the
   * transcript it was taken through, and the park — not the reader — is what
   * they are about.
   */
  private target(): SessionId | undefined {
    const current = this.store.getSnapshot().global
    const registered = current?.kind === 'reported' ? registeredAddress(current.status) : undefined
    return registered ?? this.lastRegistered ?? this.served ?? this.address
  }

  /**
   * Ask the host for the aggregate through the session a read goes through,
   * with the one fallback an address that stopped answering is worth: the
   * remembered address is forgotten, and the read is taken again through the
   * session the shell is on. A memory of a session this host no longer holds
   * would otherwise leave the control unable to say anything at all, and a
   * single retry is the whole price of keeping it honest.
   */
  private async readAggregate(): Promise<void> {
    const address = this.target()
    if (address === undefined) return
    if (!await this.readAt(address)) return
    const fallback = this.target()
    if (fallback === undefined || fallback === address) return
    await this.readAt(fallback)
  }

  /**
   * Publish one aggregate answer, unless a newer read was requested while this
   * one was in flight: that answer would show a state the host has moved past.
   * A served address is remembered, and one that did not answer is forgotten —
   * that is what makes the next read fall back rather than ask it again.
   * @param sessionId - the session this read goes through.
   * @returns whether this read came back without an answer; a superseded read is
   * not one, because the newer read already owns the outcome.
   */
  private async readAt(sessionId: SessionId): Promise<boolean> {
    const sequence = ++this.latest
    const reading = await this.read(sessionId)
    if (this.latest !== sequence) return false
    if (reading.kind === 'reported') {
      this.served = sessionId
      const registered = registeredSessions(reading.status)[0]
      if (registered !== undefined) this.lastRegistered = registered as SessionId
    } else if (this.served === sessionId) {
      // The address that just failed is not the one to ask again; the target's
      // next choice is what the retry uses.
      this.served = undefined
    }
    this.publish(reading)
    return reading.kind === 'unavailable'
  }

  /**
   * Open or close the decision list. Opening asks the host for the rows; there
   * is no state to show without that answer. It also buys a burst of its own:
   * whether anything on screen is worth watching was decided on the last
   * aggregate read, and opening the panel changes that question rather than
   * answering it — the rows are what the panel reads.
   * @param open - whether the panel should be showing.
   */
  setPanel(open: boolean): void {
    this.store.update((state) => { state.panelOpen = open })
    if (open) {
      void this.refreshTriage()
      this.burst.trigger()
      return
    }
    this.follow()
  }

  /**
   * Ask the host for the decision list through the session the user is on. The
   * list is recorded per calling session and the decisions act only on rows
   * that session was shown, so this read — unlike the aggregate — stays on the
   * shell's own address.
   */
  async refreshTriage(): Promise<void> {
    await this.readTriage()
    this.follow()
  }

  /**
   * Read the aggregate again because the user asked this control to act: the
   * address is the session the shell is on, since a press is a user action on
   * the session the user is looking at, and the host's answer is what the
   * control shows next.
   * @param sessionId - the session the shell is on.
   */
  private async reread(sessionId: SessionId): Promise<void> {
    this.address = sessionId
    await this.readAggregate()
    this.follow()
  }

  /** One decision-list read, addressed at the session the user is on. */
  private async readTriage(): Promise<void> {
    const address = this.address
    if (address === undefined) return
    const sequence = ++this.latestTriage
    const reading = await this.readTriageRows(address)
    // A newer read was requested while this one was in flight; its answer is
    // the current one.
    if (this.latestTriage !== sequence) return
    this.store.update((state) => { state.triage = reading })
  }

  /**
   * Take one listed verb on one listed session, addressed through the session
   * the user is on. The list is read first, because the host acts only on rows
   * it has shown the calling session, and read again afterwards because the
   * host's answer — not this control's assumption — is what the next render
   * shows: a decision can release a session, and the goal switch changes what
   * the row itself says.
   * @param sessionId - the listed session to act on.
   * @param action - which listed verb was taken.
   */
  async decide(sessionId: string, action: TriageAction): Promise<void> {
    const address = this.address
    if (address === undefined) return
    await this.refreshTriage()
    await this.commands.execute(address, `/${TRIAGE_DECISION_COMMAND[action]} ${sessionId}`, [], this.lifetime)
    await this.refreshTriage()
    // A decision can release a session, which the whole-app verdict reports.
    await this.reread(address)
  }

  /**
   * Press the pill: park everything, or release everything the park owns.
   * Which one it is comes from the host's own last answer, never from a local
   * flip; the state shown afterwards is the host's answer again. A reading the
   * view does not turn into a verb — every registered session is one the host
   * will not wake — is not pressed at all.
   * @param sessionId - the session to address the verb to.
   * @returns after the control re-reads the host.
   */
  async toggle(sessionId: SessionId): Promise<void> {
    const current = this.store.getSnapshot().global
    // Nothing to press against: a state that could not be read is not a state
    // this control may act on.
    if (current === undefined || current.kind !== 'reported') return
    const action = globalStopView(current).action
    if (action === 'none') return
    const line = action === 'stop-all' ? `/${STOP_ALL_COMMAND}` : `/${RESUME_ALL_COMMAND}`
    const executed = await this.commands.execute(sessionId, line, [], this.lifetime)
    if (!executed.ok) {
      this.publish({ kind: 'unavailable' })
      this.follow()
      return
    }
    await this.reread(sessionId)
  }

  /** Ask the host for the decision list, in the browser's vocabulary. */
  private async readTriageRows(sessionId: SessionId): Promise<TriageReading> {
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
  }

  /**
   * Decide what the burst owes after a read: another look while the park is
   * settling, and nothing at all while it is working or once it has settled.
   *
   * A verdict with work in flight is left alone. The park announces the end of
   * that work by registering or unregistering its marker commands, and that is
   * the very event that starts the next burst — so watching it from here would
   * spend a read per wait on a transition that is going to announce itself.
   * What this control does keep watching is the one transition nothing
   * announces: a session that has stopped and whose flush has not resolved yet,
   * where `safe to close` appears only in an answer the browser reads. Once
   * that answer has arrived, the last reading stays published — the verdict, the
   * pill and the rows are exactly what the host last reported.
   */
  private follow(): void {
    if (this.lifetime.aborted || !this.settling()) {
      this.burst.stop()
      return
    }
    this.burst.next()
  }

  /**
   * Whether anything on screen is still settling: a registered session standing
   * at the park point with its flush pending, or a listed row in that same
   * state — or a list still being read — while the panel is open. A verdict that
   * stays `waiting` because a record is stalled, unresumable or unread is not
   * settling: nothing in this process will change it, and the park will announce
   * any session that starts moving again by registering its markers.
   */
  private settling(): boolean {
    const state = this.store.getSnapshot()
    const current = state.global
    const held = current?.kind === 'reported' && current.status.parking > 0
    const listed = state.panelOpen
      && (state.triage === undefined
        || state.triage.kind === 'unavailable'
        || state.triage.rows.some(row => row.phase === 'parking'))
    return held || listed
  }

  /**
   * Follow the page in and out of view. A hidden page is not being read — and
   * the read the burst was about to take is not lost, it waits for the page to
   * come back.
   */
  watchVisibility(): void {
    this.burst.checkVisibility()
  }
}
