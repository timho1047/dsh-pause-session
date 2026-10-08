/**
 * Browser-side reading and driving of the host's pause state for one session.
 *
 * The host publishes no push channel of its own — a third-party plugin cannot
 * add a Client Remote namespace or a forwarded event — so this control reads
 * the host's command registry, which is the only live surface it can publish
 * through: `commands.list(sessionId)` is a Client-callable read, and the
 * forwarded `commands/change` event says when to read it again. The resume
 * definition's presence in that list IS the host's "this session is paused"
 * fact; this module never derives the state from its own press.
 * @module dsh-safe-stop/client/control
 */

import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { PAUSE_COMMAND, RESUME_COMMAND, RESUME_DEFINITION_ID } from '../shared.js'

/**
 * What the Session-header control knows about one session: what the host
 * reported, or that no answer has arrived (`undefined`) or the last read
 * failed. Neither of the latter claims a state the host never reported.
 */
export type SafeStopPhase = 'active' | 'paused' | 'unavailable'

/** Per-session control state, keyed by Session id so a slot selector can watch one session. */
export interface SafeStopState {
  /** Phase per Session id; absent means no host answer yet. Writable: the store updates through a draft. */
  bySession: Record<string, SafeStopPhase | undefined>
}

const INITIAL: SafeStopState = { bySession: {} }

/** Owns the published phase per session; nothing else writes that state. */
export class SafeStopControl {
  /** State source the Session-header contribution binds its selector hook to. */
  readonly store: SnapshotStore<SafeStopState> = createSnapshotStore(INITIAL)

  /** Sessions this control has shown; every host registry change re-reads them. */
  private readonly shown = new Set<SessionId>()
  /** Highest read sequence requested per session: an answer older than it is dropped. */
  private readonly latest = new Map<SessionId, number>()
  private reads = 0

  /**
   * @param commands - the Client-callable command namespace.
   * @param lifetime - aborts in-flight calls when the plugin unloads.
   */
  constructor(
    private readonly commands: ClientRemote['commands'],
    private readonly lifetime: AbortSignal,
  ) {}

  /**
   * Read the host's state for one session.
   * @param sessionId - session whose control was rendered.
   * @returns after this read's answer is published or superseded by a newer one.
   */
  async refresh(sessionId: SessionId): Promise<void> {
    this.shown.add(sessionId)
    const sequence = ++this.reads
    this.latest.set(sessionId, sequence)
    const listed = await this.commands.list(sessionId)
    // A newer read was requested while this one was in flight; its answer is
    // the current one, so publishing this stale one would show the browser a
    // state the host has already moved past.
    if (this.latest.get(sessionId) !== sequence) return
    if (!listed.ok) {
      this.publish(sessionId, 'unavailable')
      return
    }
    const paused = listed.value.some(descriptor => descriptor.definitionId === RESUME_DEFINITION_ID)
    this.publish(sessionId, paused ? 'paused' : 'active')
  }

  /** Re-read every session this control has shown, after the host's registry changed. */
  refreshAll(): void {
    for (const sessionId of this.shown) void this.refresh(sessionId)
  }

  /**
   * Press the control: pause an active session, resume a paused one. The phase
   * shown afterwards is the host's answer, never an assumed flip.
   * @param sessionId - session whose control was pressed.
   * @returns after the control re-reads the host.
   */
  async toggle(sessionId: SessionId): Promise<void> {
    const line = this.store.getSnapshot().bySession[String(sessionId)] === 'paused'
      ? `/${RESUME_COMMAND}`
      : `/${PAUSE_COMMAND}`
    const executed = await this.commands.execute(sessionId, line, [], this.lifetime)
    if (!executed.ok) {
      this.publish(sessionId, 'unavailable')
      return
    }
    // `undefined` means the host resolved no such command, i.e. this reading
    // was stale; re-reading is the only honest response.
    await this.refresh(sessionId)
  }

  private publish(sessionId: SessionId, phase: SafeStopPhase): void {
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: phase }
    })
  }
}
