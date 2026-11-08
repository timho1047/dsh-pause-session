/**
 * Browser-side reading and driving of the host's park state for one session.
 *
 * The browser reads the native `pauseSession` stream; actions travel through
 * the same Remote namespace. No slash command is involved. The stream is
 * host-authoritative, so this module never derives a state from its own press.
 * The snapshot also carries the record's goal opt-out, so the switch beside the
 * pause button can show it without a second host round-trip.
 *
 * The stream is the change feed: a fresh snapshot wakes the controls' own
 * coalescing burst, which reads the cached snapshot and publishes it. A press or
 * a goal switch reads as it runs, and the snapshot it causes is that action's
 * own echo, absorbed for a short window (`./burst.ts`).
 * @module dsh-pause-session/client/control
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PauseTransport } from './remote.js'
import { burstWaits, DEFAULT_BURST_POLICY, ReadBurst } from './burst.js'
import type { BurstPolicy } from './burst.js'
import type { GlobalReading } from './global.js'

/**
 * The whole-app answer as the session headers read it, or `undefined` before
 * that control has heard from the host. Reading it costs nothing: it is the
 * published snapshot, not a host round-trip.
 */
export type AggregateSource = () => GlobalReading | undefined

/**
 * What the Session-header control knows about one session: what the host
 * reported, or that no answer has arrived (`undefined`) or the last read
 * failed. Neither of the latter claims a state the host never reported.
 *
 * `draining` and `parking` are the host's own two answers on the way to
 * `safe`; the control shows them rather than rounding them up, because only
 * `safe` means the pending input is durably stored.
 */
export type PausePhase = 'active' | 'draining' | 'parking' | 'safe' | 'flush-failed' | 'unavailable'

/** One host answer about one session. */
export interface PauseReading {
  readonly phase: PausePhase
  /** Tools the host reported in flight; empty unless the phase is `draining`. */
  readonly runningTools: readonly string[]
  /**
   * Whether the host's own record lets the next resume re-open this session's
   * goal. Absent — not `true` — when the host did not say: the control shows no
   * switch rather than the product default, because a default here would tell
   * the user their rounds are safe when nobody has answered.
   */
  readonly rearmGoal?: boolean
}

/** Per-session control state, keyed by Session id so a slot selector can watch one session. */
export interface PauseState {
  /** Reading per Session id; absent means no host answer yet. Writable: the store updates through a draft. */
  bySession: Record<string, PauseReading | undefined>
}

const INITIAL: PauseState = { bySession: {} }

/** Phases that name a moment on the way to a park rather than a state it reached. */
const MOVING: ReadonlySet<PausePhase> = new Set<PausePhase>(['draining', 'parking'])

/** Owns the published reading per session; nothing else writes that state. */
export class PauseControl {
  /** State source the Session-header contribution binds its selector hook to. */
  readonly store: SnapshotStore<PauseState> = createSnapshotStore(INITIAL)

  /** Sessions this control has shown; a host registry change re-reads every one of them. */
  private readonly shown = new Set<SessionId>()
  /** Highest read sequence requested per session: an answer older than it is dropped. */
  private readonly latest = new Map<SessionId, number>()
  /**
   * Sessions a change has put back on the list of ones to read once — a
   * transition this browser has been told about and has not answered yet.
   */
  private readonly owed = new Set<SessionId>()
  /**
   * Whether the look owed at the close of an echo window is still to be taken.
   * It reads every shown session, exactly as a change does: the look exists
   * because a change may have been swallowed, and a swallowed change carries no
   * payload either.
   */
  private trailing = false
  /**
   * Sessions whose header was answered from the whole-app "nothing is
   * registered" instead of a read of their own, and which therefore have to be
   * read for real if that answer stops holding.
   */
  private readonly derived = new Set<SessionId>()
  /** The bounded burst of reads one transition buys; see `./burst.ts`. */
  private readonly burst: ReadBurst
  private reads = 0

  /**
   * @param commands - the Client-callable command namespace.
   * @param lifetime - aborts in-flight calls and the burst when the plugin unloads.
   * @param windowMs - how long the burst collects the registrations of one
   * transition before its first read; also the wait after a press.
   * @param policy - the burst waits and visibility source; defaults to the real page.
   * @param aggregate - the whole-app control's published answer; absent means it is never consulted.
   */
  constructor(
    private readonly transport: PauseTransport,
    private readonly lifetime: AbortSignal,
    windowMs = 400,
    policy: Omit<BurstPolicy, 'windowMs' | 'waitsMs'> = DEFAULT_BURST_POLICY,
    private readonly aggregate: AggregateSource = () => undefined,
  ) {
    this.burst = new ReadBurst(
      () => { void this.readAll() },
      { ...policy, windowMs, waitsMs: burstWaits(windowMs) },
    )
  }

  /**
   * Read the host's state for one session.
   * @param sessionId - session whose control was rendered.
   * @returns after this read's answer is published or superseded by a newer one.
   */
  async refresh(sessionId: SessionId): Promise<void> {
    await this.readOne(sessionId)
    this.follow()
  }

  /**
   * The host's command registry changed, so every session this control has
   * shown may have moved — the forwarded event carries no payload, so the only
   * honest answer is to look at all of them once. The reads run on the burst's
   * own schedule rather than here, which is what makes a tick's worth of changes
   * — parking a session registers three commands, and a phase change re-registers
   * one more — one burst instead of one each. A change that is this browser's own
   * action's echo owes nothing: the action read the host as it ran.
   */
  refreshAll(): void {
    if (this.shown.size === 0 || this.lifetime.aborted) return
    if (!this.burst.trigger()) return
    for (const sessionId of this.shown) this.owed.add(sessionId)
  }

  /**
   * One pass of the burst: every shown session a change still owes a read. The
   * forwarded event carries no payload, so a change may have touched any of
   * them and each is read once. A session the whole-app answer has already
   * spoken for is answered from it instead of being asked about; see
   * {@link answerIsKnown}.
   */
  private async readAll(): Promise<void> {
    if (this.lifetime.aborted) {
      this.burst.stop()
      return
    }
    const pass = this.owed.size > 0 ? [...this.owed] : this.trailing ? [...this.shown] : []
    // Cleared before the reads, not after: a change that lands while this pass
    // is in flight is one this pass cannot have answered, so it survives into
    // the next read rather than being absorbed into this one.
    this.owed.clear()
    this.trailing = false
    for (const sessionId of pass) {
      if (this.answerIsKnown(sessionId)) {
        this.deriveActive(sessionId)
        continue
      }
      await this.readOne(sessionId)
    }
    this.follow()
  }

  /** One session's read, published unless a newer read of that session supersedes it. */
  private async readOne(sessionId: SessionId): Promise<void> {
    this.shown.add(sessionId)
    // A host answer replaces whatever the aggregate said about this header.
    this.derived.delete(sessionId)
    const sequence = ++this.reads
    this.latest.set(sessionId, sequence)
    const reading = await this.read(sessionId)
    // A newer read was requested while this one was in flight; its answer is
    // the current one, so publishing this stale one would show the browser a
    // state the host has already moved past.
    if (this.latest.get(sessionId) !== sequence) return
    this.publish(sessionId, reading)
  }

  /**
   * Press the control: pause an active session, or take back a pause that is
   * still on its way in (or already settled). The phase shown afterwards is the
   * host's answer, never an assumed flip.
   * @param sessionId - session whose control was pressed.
   * @returns after the control re-reads the host.
   */
  async toggle(sessionId: SessionId): Promise<void> {
    const current = this.store.getSnapshot().bySession[String(sessionId)]?.phase
    const action = current === undefined || current === 'active' ? 'pause' : 'resume'
    this.burst.absorb()
    const answer = await this.transport.act({ action, sessionId: String(sessionId) }, this.lifetime)
    if (!answer.ok) {
      this.publish(sessionId, { phase: 'unavailable', runningTools: [] })
      this.follow()
      return
    }
    await this.refresh(sessionId)
  }

  /**
   * Flip this session's goal opt-out. The verb belongs to the session it
   * changes — the host registers it there, and it takes no other target — so
   * this press needs no listed row. What the switch shows afterwards is the
   * host's next answer, never a local flip: a refused switch leaves the record
   * exactly as it was, and the re-read is what says so.
   * @param sessionId - session whose switch was pressed.
   * @returns after the control re-reads the host.
   */
  async toggleGoal(sessionId: SessionId): Promise<void> {
    // The switch is a client action too: the record change it causes announces
    // itself through the registry, and the re-read below is the answer.
    this.burst.absorb()
    await this.transport.act({ action: 'goal', sessionId: String(sessionId) }, this.lifetime)
    await this.refresh(sessionId)
  }

  /** Ask the native stream what this session's park state is. */
  private async read(sessionId: SessionId): Promise<PauseReading> {
    const snapshot = await this.transport.source.read(this.lifetime)
    if (snapshot === undefined) return { phase: 'unavailable', runningTools: [] }
    const status = snapshot.sessions[String(sessionId)]
    if (status === undefined) return { phase: 'active', runningTools: [] }
    return {
      phase: status.phase,
      runningTools: status.runningTools,
      ...status.rearmGoal === undefined ? {} : { rearmGoal: status.rearmGoal },
    }
  }

  private publish(sessionId: SessionId, reading: PauseReading): void {
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: reading }
    })
  }

  /**
   * Whether the park has already answered for this header: with nothing
   * registered, no session can be paused, so a header that says this session is
   * running carries the whole fact; the status request that would confirm it is
   * a round-trip for nothing.
   *
   * A header the host last showed on its way to a park is never answered this
   * way: that reading is newer than the aggregate the derivation rests on, and
   * only a fresh host answer may replace it.
   */
  private answerIsKnown(sessionId: SessionId): boolean {
    const phase = this.store.getSnapshot().bySession[String(sessionId)]?.phase
    if (phase !== undefined && phase !== 'active') return false
    return this.nothingParked()
  }

  /**
   * Whether the whole-app answer says the park holds nothing at all: the one
   * predicate the derivation below and its revocation share.
   */
  private nothingParked(): boolean {
    const aggregate = this.aggregate()
    return aggregate?.kind === 'reported' && aggregate.status.registered === 0
  }

  /**
   * Answer one header from the whole-app verdict, and remember that it was that
   * kind of answer: the sessions to read for real are exactly the ones the
   * aggregate may have been wrong about.
   */
  private deriveActive(sessionId: SessionId): void {
    this.derived.add(sessionId)
    this.publish(sessionId, { phase: 'active', runningTools: [] })
  }

  /**
   * The whole-app answer moved. Whatever was answered from "nothing is
   * registered" is read for real the moment that stops holding — the session a
   * header stood in for may be the one the park just took, possibly parked from
   * another window whose change this browser only sees as the forwarded event.
   * Called on every published aggregate, so it must do nothing while the
   * derivation still holds.
   */
  reconsider(): void {
    if (this.derived.size === 0 || this.lifetime.aborted || this.nothingParked()) return
    for (const sessionId of this.derived) this.owed.add(sessionId)
    this.derived.clear()
    // What these headers say is known to be wrong now, so this does not wait out
    // anything — least of all the absorption window of an action the user took
    // in the same moment. Absorption is for the changes an action caused, never
    // for what a reading just revealed.
    this.burst.next()
  }

  /**
   * Decide what the burst owes after a read: another look while a change this
   * browser has not answered is still outstanding, and nothing once none is.
   *
   * A phase that is still moving is left alone. The host announces every
   * transition on its command channel — the flush that settles a park included,
   * which changes no registration of its own — so a read that finds `draining`
   * or `parking` is the answer to the transition that produced it, and watching
   * that phase from here would spend reads on a move that is going to speak for
   * itself. What the burst still owes is the delivery of an announcement: a read
   * still armed when the change arrived, and a read for a change that landed
   * while the last pass was in flight.
   *
   * The one transition that cannot speak for itself is the one this browser's
   * own echo window swallowed: a press reads the host, the park moves while the
   * window is still open, and the changes that would have announced it look
   * exactly like the press's own registrations. So an action that left a phase
   * still moving asks for one look when that window closes, and only then — the
   * read is owed at a moment, not watched. Once nothing is owed, the last
   * reading stays on screen; the next change, the next user action, or the shell
   * handing this control a session again is what asks next.
   */
  private follow(): void {
    if (this.lifetime.aborted) {
      this.burst.stop()
      return
    }
    if (this.owed.size === 0) {
      // The look is owed only while both hold: the window is still swallowing
      // changes, and the reading the action left is one of the phases whose next
      // step a change would have announced.
      const hidden = this.burst.absorbing && this.moving()
      if (hidden) this.burst.recheckAfterEcho()
      this.trailing = hidden
      this.burst.stop()
      return
    }
    this.burst.next()
  }

  /**
   * Whether any shown session's last reading is a phase the host has not
   * finished walking — the only states an action's own echo could be hiding a
   * transition behind.
   */
  private moving(): boolean {
    const shown = this.store.getSnapshot().bySession
    for (const sessionId of this.shown) {
      const phase = shown[String(sessionId)]?.phase
      if (phase !== undefined && MOVING.has(phase)) return true
    }
    return false
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
