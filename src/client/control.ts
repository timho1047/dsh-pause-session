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
 * to announce it, so this control re-reads on its own while one is on screen —
 * under `./poll.ts`'s budget, so a phase that never settles stops being asked
 * about instead of being asked about forever. Registry changes are coalesced
 * into one read per browser tick: parking a session registers two commands,
 * and the host announces each of them.
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
import { DEFAULT_POLL_POLICY, Poller } from './poll.js'
import type { PollPolicy } from './poll.js'

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

  /** Sessions this control has shown; every host registry change re-reads them. */
  private readonly shown = new Set<SessionId>()
  /** Highest read sequence requested per session: an answer older than it is dropped. */
  private readonly latest = new Map<SessionId, number>()
  /** Sessions whose phase is still moving and therefore need another look. */
  private readonly transient = new Set<SessionId>()
  /** Sessions a re-read asked for while one was already running. */
  private readonly dirty = new Set<SessionId>()
  /** Whether a re-read pass is in flight; changes landing in one are read by the next. */
  private reading = false
  /** The budgeted re-read timer; see `./poll.ts`. */
  private readonly poller: Poller
  private reads = 0

  /**
   * @param commands - the Client-callable command namespace.
   * @param lifetime - aborts in-flight calls and the re-read loop when the plugin unloads.
   * @param pollMs - how long to wait before the first re-read of a transient phase.
   * @param policy - the polling budget and visibility source; defaults to `pollMs` and the real page.
   */
  constructor(
    private readonly commands: ClientRemote['commands'],
    private readonly lifetime: AbortSignal,
    private readonly pollMs = 400,
    policy: Omit<PollPolicy, 'initialMs'> = DEFAULT_POLL_POLICY,
  ) {
    this.poller = new Poller(
      () => { this.refreshAll() },
      { ...policy, initialMs: pollMs },
    )
  }

  /**
   * Read the host's state for one session.
   * @param sessionId - session whose control was rendered.
   * @returns after this read's answer is published or superseded by a newer one.
   */
  async refresh(sessionId: SessionId): Promise<void> {
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
   * Re-read every session this control has shown, after the host's registry
   * changed. Reads are coalesced: a burst of registry changes asks for one
   * pass, and a change that lands while a pass is running is read by the one
   * that follows rather than starting another read of every session.
   */
  refreshAll(): void {
    for (const sessionId of this.shown) this.dirty.add(sessionId)
    if (this.reading) return
    this.reading = true
    void this.drain()
  }

  /** Read every session one pending pass asked for, until none is left. */
  private async drain(): Promise<void> {
    try {
      do {
        const batch = [...this.dirty]
        this.dirty.clear()
        for (const sessionId of batch) await this.refresh(sessionId)
      } while (this.dirty.size > 0)
    } catch {
      // A registry read that rejected is not a reason to stop following the
      // host: the next change — or the next poll — reads again.
    } finally {
      this.reading = false
    }
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
    this.schedulePoll()
  }

  /**
   * Keep looking while any shown session is still moving. The host announces a
   * settled phase through no registry change of its own, so waiting for one
   * would leave "draining" on screen forever — but a phase that never settles
   * must not be asked about forever either, which is the budget `./poll.ts`
   * enforces.
   */
  private schedulePoll(): void {
    if (this.transient.size === 0 || this.lifetime.aborted) {
      this.poller.stop()
      return
    }
    this.poller.start()
  }

  /**
   * Follow the page in and out of view. Hidden time is not polling time, and
   * a page that comes back continues the episode rather than buying a new
   * budget: showing the page again is not a user action on the park.
   */
  watchVisibility(): void {
    this.poller.checkVisibility()
  }
}
