/**
 * What a session is doing between "pause was asked for" and "its next model
 * request is standing still at the gate".
 *
 * Two facts decide that, and each has its own owner:
 *
 * - Whether a turn is open is derived state the harness already maintains:
 *   the agent registry owns the `turnBoundary` session projection, which folds
 *   `turn/start`, `turn/end`, `step/start`, and `step/end` into
 *   `openTurnStartSeq`. Reading it through `ctx.agents` is a synchronous
 *   projection read, not a scan of the event log (synchronous history reads are
 *   prohibited for new code).
 * - Which tool is in flight is a log-derived per-session fact, so it is a
 *   session projection too. The projection folds each committed
 *   `tool/call` → `tool/result` pairing and keeps the calls in order; the
 *   framework owns replay, caching, and disposal. This module listens only to
 *   committed events so it can wake the control, never to keep a second copy
 *   of the state itself.
 * @module dsh-pause-session/park
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
/** One session's current activity, as the control reports it. */
export interface ParkActivity {
    /** Whether the session is inside a turn — including one waiting for this very park. */
    readonly turnOpen: boolean;
    /** Names of the calls currently in flight, in call order; empty when no tool is running. */
    readonly runningTools: readonly string[];
}
/** Both halves of the activity question for one session. */
export interface ParkWatch {
    /**
     * @param sessionId - session to inspect.
     * @returns the session's current turn and tool activity.
     */
    activity(sessionId: SessionId): ParkActivity;
    /**
     * Subscribe to activity changes.
     * @param listener - called with the session whose activity changed; it must
     * only record that a look is owed, never re-enter the session.
     * @returns the unsubscribe function.
     */
    onChange(listener: (sessionId: SessionId) => void): () => void;
}
/**
 * Mount the per-session activity projection and its notification edge.
 * @param ctx - host context carrying the session store and the projection registry.
 * @returns the watch the park state is derived from.
 */
export declare function mountParkWatch(ctx: Context): Promise<ParkWatch>;
