/**
 * The session control the browser half drives: the pause verb, the park state
 * machine behind it, and the live state channel that accompanies both.
 *
 * The host exposes this control through the native Typert Remote namespace:
 * `observe` streams snapshots and `act` / `triage` / `decide` drive the UI. No
 * slash command is registered. Phase changes wake the Remote stream through a
 * local listener set; the durable registry remains the source of truth for what
 * the snapshot reports.
 * @module dsh-pause-session/control
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { PauseGate } from './gate.js';
import type { ParkWatch } from './park.js';
import type { ParkRegistry } from './registry.js';
import type { ReleaseTreeOutcome, ResumeAttempt, ResumeOptions } from './resume.js';
import type { TriageAction } from './shared.js';
import type { PauseSnapshot, TriageList } from './shared.js';
/** What one tree-wide press registered, and what it could not. */
export interface PressTreeOutcome {
    /** How many sessions this press covered: the session plus its descendants. */
    readonly members: number;
    /** How many of them now have a durable park record behind them. */
    readonly registered: number;
    /** Whether the pressed session itself is one of them. */
    readonly rootRegistered: boolean;
    /** The members whose record could not be written; they are not paused. */
    readonly unrecorded: readonly SessionId[];
    /** Whether the tree walk itself failed, so the session's subagents were not covered. */
    readonly unread: boolean;
}
/** What mounting the session control hands back to the plugin entry. */
export interface SessionControl {
    /**
     * Hold every session the registry remembers and can read, and publish the
     * marker for the ones that already have a live agent. Called once, right
     * after mount.
     */
    adopt(): Promise<void>;
    /**
     * Read the whole app and every live paused session as one JSON-safe snapshot.
     * The browser status route serves this; it never enters a Session log.
     * @param signal - cancellation for the tree reads this snapshot performs.
     * @returns the whole-app verdict and the paused sessions this process holds.
     */
    readSnapshot(signal?: AbortSignal): Promise<PauseSnapshot>;
    /** Wake a listener after any visible status change. */
    subscribe(listener: () => void): () => void;
    /** Press one Session tree. */
    pressTree(sessionId: SessionId, signal?: AbortSignal): Promise<PressTreeOutcome>;
    /** Release one Session's registered tree. */
    releaseTree(sessionId: SessionId, signal?: AbortSignal): Promise<ReleaseTreeOutcome>;
    /** Press every running Session tree. */
    pauseAll(signal?: AbortSignal): Promise<CommandResult>;
    /** Resume every cleanly paused Session. */
    resumeAll(signal?: AbortSignal): Promise<CommandResult>;
    /** Flip one Session's goal re-arm opt-out. */
    toggleGoal(sessionId: SessionId, signal?: AbortSignal): Promise<CommandResult>;
    /** Read the morning list for one calling Session. */
    readTriage(caller: SessionId, signal?: AbortSignal): Promise<TriageList>;
    /** Take one listed decision for one calling Session. */
    decideTriage(caller: SessionId, target: SessionId, action: TriageAction, signal?: AbortSignal): Promise<CommandResult>;
}
/** How resuming all parked sessions answers the command that asked for it. */
export declare function summarizeResume(attempts: readonly ResumeAttempt[]): string;
/**
 * Everything the session control needs from the composition: the clean resume
 * path's route knowledge, plus the bound the decision list reads each parked
 * log under.
 */
export interface SessionControlOptions extends ResumeOptions {
    /** Events of each stored log the decision list may fold per row; see `./coldlog.ts`. */
    readonly maxListedLogEvents?: number;
}
/**
 * Contribute the session control: the pause verb, the per-session status read,
 * the global resume verb, and — for every paused session that has a live agent
 * — the resume marker.
 * @param ctx - host context carrying the command registry, the agent store, the
 * session store, and the projection registry.
 * @param gate - the pause gate this control drives and reflects.
 * @param watch - the per-session activity fold the park predicate reads.
 * @param registry - the durable pause list every phase change is written to.
 * @param options - route knowledge the clean resume path needs, and the decision list's read bound.
 * @returns the mount-time adoption step and the morning resume path.
 */
export declare function installSessionControl(ctx: Context, gate: PauseGate, watch: ParkWatch, registry: ParkRegistry, options: SessionControlOptions): SessionControl;
