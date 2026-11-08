/**
 * Browser-side reading and driving of the host's park state for one session.
 *
 * The browser reads the native `pauseSession` stream; actions travel through
 * the same Remote namespace. No slash command is involved. The stream is
 * host-authoritative, so this module never derives a state from its own press.
 * The snapshot also carries the record's goal opt-out, so the switch beside the
 * pause button can show it without a second host round-trip.
 *
 * The stream is the change feed. A pushed snapshot triggers one cached read per
 * shown header; a press or goal switch reads the host's answer once after the
 * action.
 * @module dsh-pause-session/client/control
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PauseTransport } from './remote.js'

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

/** Owns the published reading per session; nothing else writes that state. */
export class PauseControl {
  /** State source the Session-header contribution binds its selector hook to. */
  readonly store: SnapshotStore<PauseState> = createSnapshotStore(INITIAL)

  /** Sessions this control has shown; a pushed snapshot applies to every one. */
  private readonly shown = new Set<SessionId>()
  /** Highest read sequence requested per session: an answer older than it is dropped. */
  private readonly latest = new Map<SessionId, number>()
  private reads = 0

  /**
   * @param transport - the native namespace source and actions.
   * @param lifetime - aborts in-flight reads when the plugin unloads.
   */
  constructor(
    private readonly transport: PauseTransport,
    private readonly lifetime: AbortSignal,
  ) {}

  /**
   * Read the host's state for one session.
   * @param sessionId - session whose control was rendered.
   * @returns after this read's answer is published or superseded by a newer one.
   */
  async refresh(sessionId: SessionId): Promise<void> {
    await this.readOne(sessionId)
  }

  /** Apply one pushed snapshot without spending a read per shown header. */
  apply(snapshot: { readonly sessions: Readonly<Record<string, { readonly phase: PausePhase; readonly runningTools: readonly string[]; readonly rearmGoal?: boolean }>> } | undefined): void {
    for (const sessionId of this.shown) {
      if (snapshot === undefined) {
        this.publish(sessionId, { phase: 'unavailable', runningTools: [] })
        continue
      }
      const status = snapshot.sessions[String(sessionId)]
      this.publish(sessionId, status === undefined
        ? { phase: 'active', runningTools: [] }
        : {
            phase: status.phase,
            runningTools: status.runningTools,
            ...status.rearmGoal === undefined ? {} : { rearmGoal: status.rearmGoal },
          })
    }
  }

  /** A new pushed snapshot may have moved every header; read them once. */
  refreshAll(): void {
    if (this.shown.size === 0 || this.lifetime.aborted) return
    void this.readAll()
  }

  private async readAll(): Promise<void> {
    if (this.lifetime.aborted) return
    for (const sessionId of [...this.shown]) await this.readOne(sessionId)
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
    const action = current === undefined || current === 'active' ? 'pause' : 'resume'
    const answer = await this.transport.act({ action, sessionId: String(sessionId) }, this.lifetime)
    if (!answer.ok) {
      this.publish(sessionId, { phase: 'unavailable', runningTools: [] })
      return
    }
    await this.refresh(sessionId)
  }

  /**
   * Flip this session's goal opt-out. The verb belongs to the session it
   * changes; the switch shows the host's next answer, never a local flip.
   * @param sessionId - session whose switch was pressed.
   * @returns after the control re-reads the host.
   */
  async toggleGoal(sessionId: SessionId): Promise<void> {
    const answer = await this.transport.act({ action: 'goal', sessionId: String(sessionId) }, this.lifetime)
    if (!answer.ok) {
      this.publish(sessionId, { phase: 'unavailable', runningTools: [] })
      return
    }
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
      const previous = state.bySession[String(sessionId)]
      if (previous !== undefined
        && previous.phase === reading.phase
        && previous.rearmGoal === reading.rearmGoal
        && previous.runningTools.length === reading.runningTools.length
        && previous.runningTools.every((tool, index) => tool === reading.runningTools[index])) return
      state.bySession = { ...state.bySession, [String(sessionId)]: reading }
    })
  }
}
