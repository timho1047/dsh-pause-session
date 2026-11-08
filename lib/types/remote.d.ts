/**
 * Native Remote transport for the pause controls.
 *
 * This module is deliberately self-contained: it imports only Cordis and the
 * Typert decorators. The Typert generator analyzes this file alone so a
 * third-party package can emit its Host reflection and Client contribution
 * without pulling the plugin's DSH-typed modules into the generation face.
 *
 * The UI uses this namespace on Web and Desktop alike. No slash command is
 * registered; the stream is the live status channel and the methods below are
 * the button actions.
 * @module dsh-pause-session/remote
 */
import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface RemoteErrorDetailsMap {
        /** The pause control is personal; only the owner may read or drive it. */
        'pause/owner-only': {};
    }
}
/** The phase a Session reports to the controls. */
export type PausePhaseWire = 'active' | 'draining' | 'parking' | 'safe' | 'flush-failed';
/** One Session's pause state. */
export interface SessionStatusWire {
    readonly phase: PausePhaseWire;
    readonly runningTools: readonly string[];
    readonly rearmGoal?: boolean;
}
/** The whole-app verdict. */
export interface GlobalStatusWire {
    readonly verdict: 'idle' | 'waiting' | 'safe';
    readonly registered: number;
    readonly safe: number;
    readonly parkedAt?: string;
    readonly draining: readonly string[];
    readonly parking: number;
    readonly stalled: readonly string[];
    readonly unresumable: readonly string[];
    readonly unreadTrees: readonly string[];
    readonly jobs: readonly string[];
    readonly blind: readonly string[];
}
/** One live status snapshot: the aggregate plus every held Session. */
export interface PauseSnapshotWire {
    readonly global: GlobalStatusWire;
    readonly sessions: Readonly<Record<string, SessionStatusWire>>;
}
/** One row in the morning decision list. */
export interface TriageRowWire {
    readonly sessionId: string;
    readonly phase: 'draining' | 'parking' | 'flush-failed';
    readonly updatedAt: number;
    readonly reading: 'read' | 'unreadable';
    readonly lastEvent?: string;
    readonly turn?: number;
    readonly step?: number;
    readonly traces: readonly {
        readonly tool: string;
        readonly callId: string;
    }[];
    readonly owed: boolean;
    readonly wakeable: boolean;
    readonly rearmGoal: boolean;
}
/** One button action. */
export interface PauseActionRequest {
    readonly action: 'pause' | 'resume' | 'pause-all' | 'resume-all' | 'cancel-all' | 'goal';
    /** The Session the control is addressed through. */
    readonly sessionId: string;
}
/** One action outcome. */
export interface PauseActionResultWire {
    readonly ok: boolean;
    readonly message: string;
}
/** One decision-list read. */
export interface PauseTriageRequest {
    readonly caller: string;
}
/** One decision on a listed Session. */
export interface PauseDecisionRequest {
    readonly caller: string;
    readonly target: string;
    readonly decision: 'continue' | 'note' | 'review' | 'leave' | 'goal';
}
export interface PauseRemoteApi {
    snapshot(signal?: AbortSignal): Promise<PauseSnapshotWire>;
    subscribe(listener: () => void): () => void;
    act(request: PauseActionRequest, signal?: AbortSignal): Promise<PauseActionResultWire>;
    triage(request: PauseTriageRequest, signal?: AbortSignal): Promise<readonly TriageRowWire[]>;
    decide(request: PauseDecisionRequest, signal?: AbortSignal): Promise<PauseActionResultWire>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        pauseSession: PauseRemote;
    }
}
/** Host service exposed to the browser as the `pauseSession` Remote namespace. */
export declare class PauseRemote extends TypertRemoteService {
    private readonly api;
    /** One snapshot per host version, shared by every connected observer. */
    private snapshotCache;
    /** Bumped by every host notification; each observer compares it to its own cursor. */
    private version;
    /** Observers waiting for the next version. */
    private readonly waiters;
    private readonly unsubscribe;
    /**
     * @param ctx - host context owning the service.
     * @param api - the pause engine behind the wire methods.
     */
    constructor(ctx: Context, api: PauseRemoteApi);
    /**
     * One exact snapshot, used by tests and by a reconnect that cannot wait for
     * the first stream item.
     * @param signal - carrier cancellation.
     * @returns the current aggregate and session states.
     */
    snapshot(signal?: AbortSignal): Promise<PauseSnapshotWire>;
    /**
     * The snapshot for one host version, computed once even when several clients
     * are watching. A new notification discards the cached promise.
     * @param version - the host version this snapshot answers.
     * @param signal - stream cancellation.
     * @returns the shared snapshot promise.
     */
    private snapshotFor;
    /**
     * Live status: the opening snapshot, then one new snapshot whenever the host
     * reports a change.
     * @param signal - stream cancellation.
     * @returns the snapshot stream.
     */
    observe(signal?: AbortSignal): AsyncIterable<PauseSnapshotWire>;
    /**
     * Pause, resume, press every tree, resume every clean park, or flip one
     * Session's goal re-arm.
     * @param request - the button action.
     * @param signal - carrier cancellation.
     * @returns the user-facing outcome.
     */
    act(request: PauseActionRequest, signal?: AbortSignal): Promise<PauseActionResultWire>;
    /**
     * Read the morning decision list.
     * @param request - the calling Session whose list is read.
     * @param signal - read cancellation.
     * @returns the listed rows.
     */
    triage(request: PauseTriageRequest, signal?: AbortSignal): Promise<readonly TriageRowWire[]>;
    /**
     * Take one decision on one listed Session.
     * @param request - the caller, target, and decision.
     * @param signal - load cancellation.
     * @returns the user-facing outcome.
     */
    decide(request: PauseDecisionRequest, signal?: AbortSignal): Promise<PauseActionResultWire>;
}
