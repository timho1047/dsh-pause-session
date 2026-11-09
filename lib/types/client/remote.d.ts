/**
 * Client-side bridge from the generated `pauseSession` Remote namespace to the
 * control state machines.
 *
 * The native namespace is the only transport: the stream supplies snapshots and
 * the action methods drive every button. No slash command is involved.
 * @module dsh-pause-session/client/remote
 */
import type { PauseActionResultWire, PauseDecisionRequest, PauseSnapshotWire, TriageRowWire } from '../remote.js';
import type { GlobalStatus, ParkStatus } from '../shared.js';
/** The generated namespace shape this bridge needs. */
export interface RemotePauseNamespace {
    observe(signal?: AbortSignal): AsyncIterable<PauseSnapshotWire>;
    act(request: {
        readonly action: 'pause' | 'resume' | 'pause-all' | 'resume-all' | 'cancel-all' | 'goal';
        readonly sessionId: string;
    }, signal?: AbortSignal): Promise<{
        readonly ok: boolean;
        readonly value?: PauseActionResultWire;
        readonly error?: {
            readonly code: string;
        };
    }>;
    triage(request: {
        readonly caller: string;
    }, signal?: AbortSignal): Promise<{
        readonly ok: boolean;
        readonly value?: readonly TriageRowWire[];
    }>;
    decide(request: PauseDecisionRequest, signal?: AbortSignal): Promise<{
        readonly ok: boolean;
        readonly value?: PauseActionResultWire;
    }>;
}
/** The status shape shared by the controls, with branded ids erased at this boundary. */
export interface PauseSnapshotLike {
    readonly global: GlobalStatus;
    readonly sessions: Readonly<Record<string, ParkStatus>>;
}
/** A remote-backed status source with a change subscription. */
export interface RemoteStatusSource {
    /** Read the latest host snapshot; undefined before the first answer or after failure. */
    read(signal?: AbortSignal): Promise<PauseSnapshotLike | undefined>;
    onChange(listener: () => void): () => void;
    /** Receive each pushed snapshot directly; `undefined` means the stream failed. */
    onSnapshot(listener: (snapshot: PauseSnapshotLike | undefined) => void): () => void;
}
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
export declare function openRemoteSource(remote: RemotePauseNamespace, lifetime: AbortSignal): RemoteStatusSource;
/** Direct browser transport over the generated namespace. */
export interface PauseTransport {
    readonly source: RemoteStatusSource;
    act(request: {
        readonly action: 'pause' | 'resume' | 'pause-all' | 'resume-all' | 'cancel-all' | 'goal';
        readonly sessionId: string;
    }, signal?: AbortSignal): Promise<PauseActionResultWire>;
    triage(caller: string, signal?: AbortSignal): Promise<readonly TriageRowWire[] | undefined>;
    decide(caller: string, target: string, decision: 'continue' | 'note' | 'review' | 'leave' | 'goal', signal?: AbortSignal): Promise<PauseActionResultWire>;
}
/**
 * Build the direct transport over one mounted Remote namespace.
 * @param remote - the generated `pauseSession` namespace.
 * @param lifetime - client lifetime.
 * @returns the source and action methods the controls use.
 */
export declare function remoteTransport(remote: RemotePauseNamespace, lifetime: AbortSignal): PauseTransport;
