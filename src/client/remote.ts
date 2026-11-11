/**
 * Client-side bridge from the generated `pauseSession` Remote namespace to the
 * control state machines.
 *
 * The native namespace is the only transport: the stream supplies snapshots and
 * the action methods drive every button. No slash command is involved.
 * @module dsh-pause-session/client/remote
 */

import type {
  PauseActionResultWire, PauseDecisionRequest, PauseSnapshotWire, TriageRowWire,
} from '../remote.js'
import type { GlobalBlindSpot, GlobalStatus, ParkStatus } from '../shared.js'

/** The generated namespace shape this bridge needs. */
export interface RemotePauseNamespace {
  observe(signal?: AbortSignal): AsyncIterable<PauseSnapshotWire>
  act(request: {
    readonly action: 'pause' | 'resume' | 'pause-all' | 'resume-all' | 'cancel-all' | 'goal'
    readonly sessionId: string
  }, signal?: AbortSignal): Promise<{ readonly ok: boolean; readonly value?: PauseActionResultWire; readonly error?: { readonly code: string } }>
  triage(request: { readonly caller: string }, signal?: AbortSignal): Promise<{
    readonly ok: boolean
    readonly value?: readonly TriageRowWire[]
  }>
  decide(request: PauseDecisionRequest, signal?: AbortSignal): Promise<{
    readonly ok: boolean
    readonly value?: PauseActionResultWire
  }>
}

/** Convert one wire snapshot to the host-status vocabulary the controls already use. */
function snapshotOf(wire: PauseSnapshotWire): PauseSnapshotLike {
  return {
    global: {
      ...wire.global,
      parkedAt: wire.global.parkedAt as never,
      draining: wire.global.draining as never,
      stalled: wire.global.stalled as never,
      unresumable: wire.global.unresumable as never,
      unreadTrees: wire.global.unreadTrees as never,
      jobs: wire.global.jobs as never,
      blind: wire.global.blind as GlobalBlindSpot[],
    },
    sessions: Object.fromEntries(Object.entries(wire.sessions).map(([id, status]) => [id, status as ParkStatus])),
  }
}

/** The status shape shared by the controls, with branded ids erased at this boundary. */
export interface PauseSnapshotLike {
  readonly global: GlobalStatus
  readonly sessions: Readonly<Record<string, ParkStatus>>
}

/** A remote-backed status source with a change subscription. */
export interface RemoteStatusSource {
  /** Read the latest host snapshot; undefined before the first answer or after failure. */
  read(signal?: AbortSignal): Promise<PauseSnapshotLike | undefined>
  onChange(listener: () => void): () => void
  /** Receive each pushed snapshot directly; `undefined` means the stream failed. */
  onSnapshot(listener: (snapshot: PauseSnapshotLike | undefined) => void): () => void
}

/** First retry delay after the stream drops, in milliseconds. */
const RECONNECT_BASE_MS = 300
/** Ceiling for the reconnect backoff, in milliseconds. */
const RECONNECT_MAX_MS = 5_000

/**
 * Open the native status stream and expose its latest snapshot to both controls.
 *
 * The stream owns no retry of its own: a carrier can drop it on a mux reconnect,
 * a host reload, or a network blip, and the controls must not stay unavailable
 * until the page is refreshed. This source reconnects with a bounded backoff and
 * republishes the new snapshot; while it is disconnected the last value is
 * discarded, so readers see "unavailable" rather than a stale claim.
 * @param remote - the generated Remote namespace.
 * @param lifetime - client lifetime; aborting it releases the stream.
 * @returns the cached source and its change subscription.
 */
export function openRemoteSource(remote: RemotePauseNamespace, lifetime: AbortSignal): RemoteStatusSource {
  let latest: PauseSnapshotLike | undefined
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Readers waiting for the first snapshot of any attempt. */
  const waiters = new Set<() => void>()
  const listeners = new Set<() => void>()
  const snapshotListeners = new Set<(snapshot: PauseSnapshotLike | undefined) => void>()

  const notify = (): void => {
    for (const wake of [...waiters]) wake()
    waiters.clear()
    for (const listener of [...listeners]) listener()
    for (const listener of [...snapshotListeners]) listener(latest)
  }

  const schedule = (): void => {
    if (lifetime.aborted || timer !== undefined) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS)
    attempt += 1
    timer = setTimeout(() => {
      timer = undefined
      void pump()
    }, delay)
  }

  const pump = async (): Promise<void> => {
    if (lifetime.aborted) return
    try {
      for await (const snapshot of remote.observe(lifetime)) {
        // A delivered snapshot proves this attempt healthy; the next drop starts
        // its backoff from the short delay again.
        attempt = 0
        latest = snapshotOf(snapshot)
        notify()
      }
    } catch {
      // The carrier failed. Everything this attempt could have delivered is
      // already published; the retry below owns the recovery.
    }
    if (lifetime.aborted) return
    latest = undefined
    notify()
    schedule()
  }

  void pump()

  return {
    onChange: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    onSnapshot: (listener) => {
      snapshotListeners.add(listener)
      return () => { snapshotListeners.delete(listener) }
    },
    read: async (signal) => {
      if (latest === undefined && !lifetime.aborted) {
        await new Promise<void>((resolve) => {
          // Every reader gets its own wakeup: the two header controls mount
          // together and both ask before the opening snapshot lands.
          const wake = (): void => {
            waiters.delete(wake)
            signal?.removeEventListener('abort', wake)
            resolve()
          }
          waiters.add(wake)
          signal?.addEventListener('abort', wake, { once: true })
        })
      }
      signal?.throwIfAborted()
      return latest
    },
  }
}

/** Direct browser transport over the generated namespace. */
export interface PauseTransport {
  readonly source: RemoteStatusSource
  act(request: {
    readonly action: 'pause' | 'resume' | 'pause-all' | 'resume-all' | 'cancel-all' | 'goal'
    readonly sessionId: string
  }, signal?: AbortSignal): Promise<PauseActionResultWire>
  triage(caller: string, signal?: AbortSignal): Promise<readonly TriageRowWire[] | undefined>
  decide(
    caller: string,
    target: string,
    decision: 'continue' | 'note' | 'review' | 'leave' | 'goal',
    signal?: AbortSignal,
  ): Promise<PauseActionResultWire>
}

/**
 * Build the direct transport over one mounted Remote namespace.
 * @param remote - the generated `pauseSession` namespace.
 * @param lifetime - client lifetime.
 * @returns the source and action methods the controls use.
 */
export function remoteTransport(remote: RemotePauseNamespace, lifetime: AbortSignal): PauseTransport {
  const source = openRemoteSource(remote, lifetime)
  const failed = (): PauseActionResultWire => ({ ok: false, message: 'pause action failed' })
  return {
    source,
    act: async (request, signal) => {
      const answer = await remote.act(request, signal)
      return answer.ok ? (answer.value ?? failed()) : failed()
    },
    triage: async (caller, signal) => {
      const answer = await remote.triage({ caller }, signal)
      return answer.ok ? answer.value : undefined
    },
    decide: async (caller, target, decision, signal) => {
      const answer = await remote.decide({ caller, target, decision }, signal)
      return answer.ok ? (answer.value ?? failed()) : failed()
    },
  }
}
