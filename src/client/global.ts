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
import { decodeGlobalStatus, RESUME_ALL_COMMAND, STATE_ALL_COMMAND, STOP_ALL_COMMAND } from '../shared.js'
import type { GlobalStatus } from '../shared.js'

/** What the whole-app control knows: the host's answer, or that it could not ask. */
export type GlobalReading =
  | { readonly kind: 'reported'; readonly status: GlobalStatus }
  | { readonly kind: 'unavailable' }

/** Whole-app control state. */
export interface GlobalStopState {
  /** The host's answer; absent until one arrives. Writable: the store updates through a draft. */
  global: GlobalReading | undefined
}

const INITIAL: GlobalStopState = { global: undefined }

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
   * Keep looking while the park is still moving. Nothing announces the last
   * session reaching the park point, so waiting for a notification would leave
   * "finishing" on screen forever.
   */
  private schedulePoll(): void {
    const current = this.store.getSnapshot().global
    const moving = current?.kind === 'reported' && current.status.verdict === 'waiting'
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
