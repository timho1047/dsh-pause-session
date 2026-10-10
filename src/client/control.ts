/**
 * Browser-side reading and driving of the host's park state for one session.
 *
 * The host publishes no push channel of its own — a third-party plugin cannot
 * add a Client Remote namespace or a forwarded event — so this control reads
 * the host's command registry, which is the only live surface it can publish
 * through: `commands.list(sessionId)` is a Client-callable read, and the
 * forwarded `commands/change` event says when to read it again. The resume
 * definition's presence in that list IS the host's "this session is paused"
 * fact, and the companion status definition answers with the park state as of
 * the read; this module never derives either from its own press. That one
 * answer carries the record's goal opt-out as well, so the switch beside the
 * pause button can show it without a second host round-trip — and without it,
 * the control renders no switch at all.
 *
 * A phase that is still moving (`draining`, `parking`) has no registry change
 * to announce it reaching its end, so a transition buys a short bounded burst of
 * reads over the next few seconds (`./burst.ts`) rather than a heartbeat; a
 * phase that never settles stops being asked about instead of being asked about
 * forever. Registry changes start that burst, and one tick's worth of them —
 * parking a session registers three commands, and the host announces each of
 * them — is one burst.
 * @module dsh-safe-stop/client/control
 */

import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  decodeParkStatus, GOAL_COMMAND, PAUSE_COMMAND, RESUME_COMMAND, RESUME_DEFINITION_ID, STATUS_COMMAND,
  STATUS_DEFINITION_ID,
} from '../shared.js'
import { burstWaits, DEFAULT_BURST_POLICY, ReadBurst } from './burst.js'
import type { BurstPolicy } from './burst.js'

/**
 * What the Session-header control knows about one session: what the host
 * reported, or that no answer has arrived (`undefined`) or the last read
 * failed. Neither of the latter claims a state the host never reported.
 *
 * `draining` and `parking` are the host's own two answers on the way to
 * `safe`; the control shows them rather than rounding them up, because only
 * `safe` means the pending input is durably stored.
 */
export type SafeStopPhase = 'active' | 'draining' | 'parking' | 'safe' | 'flush-failed' | 'unavailable'

/** One host answer about one session. */
export interface SafeStopReading {
  readonly phase: SafeStopPhase
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
export interface SafeStopState {
  /** Reading per Session id; absent means no host answer yet. Writable: the store updates through a draft. */
  bySession: Record<string, SafeStopReading | undefined>
}

const INITIAL: SafeStopState = { bySession: {} }

/** Phases that name a moment on the way to a park, not a settled state. */
const TRANSIENT: ReadonlySet<SafeStopPhase> = new Set<SafeStopPhase>(['draining', 'parking'])

/** Owns the published reading per session; nothing else writes that state. */
export class SafeStopControl {
  /** State source the Session-header contribution binds its selector hook to. */
  readonly store: SnapshotStore<SafeStopState> = createSnapshotStore(INITIAL)

  /** Sessions this control has shown; a host registry change re-reads every one of them. */
  private readonly shown = new Set<SessionId>()
  /** Highest read sequence requested per session: an answer older than it is dropped. */
  private readonly latest = new Map<SessionId, number>()
  /** Sessions whose phase is still moving and therefore need another look. */
  private readonly transient = new Set<SessionId>()
  /** Sessions a registry change has put back on the list of ones to read once. */
  private readonly owed = new Set<SessionId>()
  /** The bounded burst of reads one transition buys; see `./burst.ts`. */
  private readonly burst: ReadBurst
  private reads = 0

  /**
   * @param commands - the Client-callable command namespace.
   * @param lifetime - aborts in-flight calls and the burst when the plugin unloads.
   * @param firstWaitMs - how long after a transition the burst's first read runs.
   * @param policy - the burst waits and visibility source; defaults to `firstWaitMs` and the real page.
   */
  constructor(
    private readonly commands: ClientRemote['commands'],
    private readonly lifetime: AbortSignal,
    firstWaitMs = 400,
    policy: Omit<BurstPolicy, 'waitsMs'> = DEFAULT_BURST_POLICY,
  ) {
    this.burst = new ReadBurst(
      () => { void this.readAll() },
      { ...policy, waitsMs: burstWaits(firstWaitMs) },
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
   * — parking a session registers three commands — one burst instead of three.
   */
  refreshAll(): void {
    if (this.shown.size === 0 || this.lifetime.aborted) return
    for (const sessionId of this.shown) this.owed.add(sessionId)
    this.burst.trigger()
  }

  /**
   * One pass of the burst. A pass a trigger still owes reads every session that
   * change may have touched; a later pass watches only the sessions that are
   * still moving, because a settled phase is not what the burst is for.
   */
  private async readAll(): Promise<void> {
    if (this.lifetime.aborted) {
      this.burst.stop()
      return
    }
    const pass = this.owed.size > 0 ? [...this.owed] : [...this.transient]
    this.owed.clear()
    for (const sessionId of pass) await this.readOne(sessionId)
    this.follow()
  }

  /** One session's read, published unless a newer read of that session supersedes it. */
  private async readOne(sessionId: SessionId): Promise<void> {
    this.shown.add(sessionId)
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
    const line = current === undefined || current === 'active'
      ? `/${PAUSE_COMMAND}`
      : `/${RESUME_COMMAND}`
    const executed = await this.commands.execute(sessionId, line, [], this.lifetime)
    if (!executed.ok) {
      this.publish(sessionId, { phase: 'unavailable', runningTools: [] })
      this.follow()
      return
    }
    // `undefined` means the host resolved no such command, i.e. this reading
    // was stale; re-reading is the only honest response.
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
    await this.commands.execute(sessionId, `/${GOAL_COMMAND}`, [], this.lifetime)
    await this.refresh(sessionId)
  }

  /** Ask the host what this session's park state is, in the browser's vocabulary. */
  private async read(sessionId: SessionId): Promise<SafeStopReading> {
    const listed = await this.commands.list(sessionId)
    if (!listed.ok) return { phase: 'unavailable', runningTools: [] }
    const paused = listed.value.some(descriptor => descriptor.definitionId === RESUME_DEFINITION_ID)
    if (!paused) return { phase: 'active', runningTools: [] }
    const status = listed.value.find(descriptor => descriptor.definitionId === STATUS_DEFINITION_ID)
    if (status === undefined) return { phase: 'parking', runningTools: [] }
    // The descriptor is only a marker; the command itself reports the state as
    // of this read, which is what makes a moving phase observable at all.
    const answered = await this.commands.execute(sessionId, `/${STATUS_COMMAND}`, [], this.lifetime)
    if (!answered.ok || answered.value === undefined) return { phase: 'unavailable', runningTools: [] }
    const text = answered.value.result.kind === 'success' ? answered.value.result.text : undefined
    const decoded = text === undefined ? undefined : decodeParkStatus(text)
    if (decoded === undefined) {
      // The marker says paused but the status read did not answer in the shared
      // vocabulary: report the pause without inventing a phase or a goal state.
      return { phase: 'parking', runningTools: [] }
    }
    return {
      phase: decoded.phase,
      runningTools: decoded.runningTools,
      ...decoded.rearmGoal === undefined ? {} : { rearmGoal: decoded.rearmGoal },
    }
  }

  private publish(sessionId: SessionId, reading: SafeStopReading): void {
    if (TRANSIENT.has(reading.phase)) this.transient.add(sessionId)
    else this.transient.delete(sessionId)
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: reading }
    })
  }

  /**
   * Decide what the burst owes after a read: another look while any shown
   * session is still moving, and nothing once none is.
   *
   * The host announces a pause through its command registry, but nothing
   * announces the drain finishing, so `draining` can end only in an answer the
   * browser reads. Once every shown session has settled — `safe`, `active`, or
   * a phase the host will not move again — there is nothing left to ask, and
   * the last reading stays on screen.
   */
  private follow(): void {
    if (this.lifetime.aborted || this.transient.size === 0) {
      this.burst.stop()
      return
    }
    this.burst.next()
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
