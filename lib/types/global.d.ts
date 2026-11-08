/**
 * The whole-app park: one action that registers every running session tree,
 * and the aggregate answer to "can I close the lid?".
 *
 * The per-session control owns one session's park; this module owns the set.
 * It reads three real sources and never infers what they can say themselves:
 *
 * - `ctx.agents.list()` plus the park activity fold decide which sessions are
 *   running. A session with no live agent is not running, and a session with
 *   nothing unfinished — no tool in flight, no turn open, no delivery the loop
 *   has not claimed — is left alone.
 * - The subagent runtime's descendant rows decide the tree and the one-shot
 *   fact. A row's `mode` is the harness's own durable record of whether that
 *   child can be resumed after a restart; a branch the walk could not read is
 *   reported as unread rather than assumed clean.
 * - The job registry decides which background jobs belong to the registered
 *   trees. Those run outside the agent loop: this plugin cannot stop them, so
 *   it names them.
 *
 * The aggregate is derived in one place so the host's answer and the browser's
 * reading of it cannot disagree, and it is a promise about the durable
 * registry: a session is `safe` only when its recorded phase says so.
 * @module dsh-pause-session/global
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { ParkWatch } from './park.js';
import type { ParkRegistry } from './registry.js';
import type { GlobalStatus, ParkPhase } from './shared.js';
import type { PauseAnswer } from './shared.js';
/** One session's live park state, as the per-session control sees it. */
export interface LivePark {
    readonly phase: ParkPhase;
    /** Whether this process can still walk the session to a flushed park. */
    readonly moving: boolean;
}
/** What one press of the per-session control did. */
export type PressResult = 'registered' | 'unrecordable' | 'not-live' | 'not-resumable' | 'already-paused';
/** What the whole-app control needs from the per-session control. */
export interface GlobalPauseDeps {
    /**
     * @param sessionId - session to inspect.
     * @returns whether a press already owns this session.
     */
    isPaused(sessionId: SessionId): boolean;
    /**
     * Press one session's pause and make it durable.
     * @param sessionId - session to register.
     * @param signal - cancellation for the resumability and registry reads.
     * @returns what the press did; only `registered` created a new park.
     */
    press(sessionId: SessionId, signal?: AbortSignal): Promise<PressResult>;
    /**
     * Look at one session's mark now that it is paused.
     * @param sessionId - the session that was just pressed.
     */
    look(sessionId: SessionId): void;
    /**
     * @returns every session a live mark owns, with the phase it reports now.
     */
    live(): ReadonlyMap<SessionId, LivePark>;
    /**
     * @returns every registered session this process could not hold again — a
     * record whose session cannot be read here, so nothing in this process can
     * park it, release it, or act on it.
     */
    unheld(): ReadonlySet<SessionId>;
}
/** The whole-app park, as the plugin entry drives it. */
export interface GlobalPause {
    /**
     * Register and park every running session tree in one action. Sessions this
     * pause already owns are left where they are; an idle session is not touched.
     * @param signal - cancellation for the tree reads this action performs.
     * @returns the aggregate as of this action's end.
     */
    pressAll(signal?: AbortSignal): Promise<PauseAnswer>;
    /**
     * The aggregate as structured data for the native Remote stream.
     * @param signal - cancellation for the tree reads this read performs.
     * @returns the aggregate as of this read.
     */
    readState(signal?: AbortSignal): Promise<GlobalStatus>;
    /**
     * Report one session a press could not register, so the aggregate names it.
     * The whole-app action records that fact for its own targets; a press of a
     * session's tree reports the members the registry refused through here.
     * @param sessionId - the session a press tried and failed to register.
     * @param unrecorded - whether it is now known to be unparked for that reason.
     */
    markUnrecorded(sessionId: SessionId, unrecorded: boolean): void;
}
/**
 * Mount the whole-app park.
 * @param ctx - host context carrying the agent store and the optional subagent
 * and job services.
 * @param watch - the activity fold that says whether a session has unfinished work.
 * @param registry - the durable list this aggregate is a promise about.
 * @param deps - the per-session press and the live phase of every mark.
 * @returns the one-press action and the aggregate read.
 */
export declare function mountGlobalPause(ctx: Context, watch: ParkWatch, registry: ParkRegistry, deps: GlobalPauseDeps): GlobalPause;
