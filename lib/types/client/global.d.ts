/**
 * Browser-side reading and driving of the host's whole-app park state.
 *
 * The aggregate arrives from the native `pauseSession` stream. The stream is
 * process-wide and writes nothing into any Session; actions travel through the
 * same Remote namespace. A pushed snapshot is applied directly; a settled park
 * costs nothing while its last answer stays on screen.
 * @module dsh-pause-session/client/global
 */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { GlobalStatus, TriageAction, TriageRow } from '../shared.js';
import type { PauseTransport } from './remote.js';
/** What the whole-app control knows: the host's answer, or that it could not ask. */
export type GlobalReading = {
    readonly kind: 'reported';
    readonly status: GlobalStatus;
} | {
    readonly kind: 'unavailable';
};
/** What the decision-list panel knows: the host's rows, or that it could not ask. */
export type TriageReading = {
    readonly kind: 'reported';
    readonly rows: readonly TriageRow[];
} | {
    readonly kind: 'unavailable';
};
/** Whole-app control state. */
export interface GlobalPauseState {
    /** The host's answer; absent until one arrives. Writable: the store updates through a draft. */
    global: GlobalReading | undefined;
    /** Whether the user asked for the decision list; the panel reads only when it is open. */
    panelOpen: boolean;
    /** The host's decision list; absent until the panel asks for it. */
    triage: TriageReading | undefined;
    /** The last action or read refusal, shown verbatim in the panel. */
    error?: string;
    /** The last snapshot's per-session details, for the draining progress copy. */
    sessions?: Readonly<Record<string, {
        readonly runningTools: readonly string[];
    }>>;
}
/**
 * The session a whole-app action is addressed to.
 *
 * A subagent's own session is never addressed: its agent belongs to a parent
 * and is not the host's business to drive from the shell. Among the rest, the
 * one on screen is the best address (its agent is live by construction), then
 * any session the host reports as running, then any at all.
 * @param state - the session list snapshot the shell provides.
 * @returns the address, or `undefined` when the app has no session to ask through.
 */
export declare function addressingSession(state: {
    readonly ids: readonly SessionId[];
    readonly byId: Readonly<Record<string, {
        readonly running?: boolean;
        readonly origin?: string;
        readonly parentId?: unknown;
        readonly retainedBy?: {
            readonly mainView?: number;
        };
    } | undefined>>;
}): SessionId | undefined;
/** Owns the published whole-app reading; nothing else writes that state. */
export declare class PauseGlobalControl {
    private readonly transport;
    private readonly lifetime;
    /** State source the whole-app contribution binds its selector hook to. */
    readonly store: SnapshotStore<GlobalPauseState>;
    /** The session the shell asked this control through; list reads use it. */
    private address;
    /** Highest decision-list read requested: an answer older than it is dropped. */
    private latestTriage;
    /**
     * @param transport - the native namespace source and actions.
     * @param lifetime - aborts in-flight reads when the plugin unloads.
     */
    constructor(transport: PauseTransport, lifetime: AbortSignal);
    /**
     * The shell handed this control a session. The first call reads the aggregate;
     * later calls only move where list reads and actions are addressed.
     * @param sessionId - the session the shell asks through.
     */
    refresh(sessionId: SessionId): Promise<void>;
    /** Apply one pushed snapshot directly. */
    apply(snapshot: {
        readonly global: GlobalStatus;
        readonly sessions: Readonly<Record<string, {
            readonly runningTools: readonly string[];
        }>>;
    } | undefined): void;
    /** A pushed snapshot may have moved the aggregate and the open list. */
    refreshAll(): void;
    /**
     * Open or close the decision list. Opening asks for the rows; there is no
     * state to show without that answer.
     * @param open - whether the panel should be showing.
     */
    setPanel(open: boolean): void;
    /** Ask the host for the decision list for the session the user is on. */
    refreshTriage(): Promise<void>;
    /**
     * Take one listed verb on one listed session, addressed through the session
     * the user is on. A refusal is published verbatim rather than silently
     * leaving the previous rows in place.
     * @param sessionId - the listed session to act on.
     * @param action - which listed verb was taken.
     */
    decide(sessionId: string, action: TriageAction): Promise<void>;
    /**
     * Press the pill: park everything, or release everything the park owns.
     * Which one it is comes from the host's own last answer, never from a local
     * flip; the state shown afterwards is the host's answer again.
     * @param sessionId - the session to address the verb to.
     */
    toggle(sessionId: SessionId): Promise<void>;
    /** Read the aggregate once and publish it. */
    private readAggregate;
    private reread;
    /** One decision-list read, addressed at the session the user is on. */
    private readTriage;
    /** Ask the native namespace for the decision list. */
    private readTriageRows;
    private publish;
}
