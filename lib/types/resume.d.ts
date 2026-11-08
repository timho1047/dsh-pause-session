/**
 * The clean resume path: bring back a session a previous process parked, and
 * let it answer the input that was already pending when it stopped.
 *
 * A resume invents no turn. At the park point the loop had claimed the
 * session's pending input onto the surface and built the request the gate then
 * held; after a restart that input is still the last thing the session says and
 * the model still owes it an answer. What is missing is only a reason for the
 * loop to build a request again, and the documented way to ask for one is a
 * wake input — a user message the loop claims.
 *
 * The wake is invisible only on the routes the composition declares in
 * `silentWakeRoutes`, whose conversion drops an empty user message. On every
 * other route the loop's request carries one visible marker instead, and the
 * marker reaches the model; that is an accepted cost of resuming at all.
 * Whether an empty user message survives is a property of the route's
 * conversion rather than of the loop, so the route is resolved per session —
 * from the request header the session itself persisted.
 *
 * The wake message is attributed to this plugin, never to the user: it is text
 * this module synthesized on the session's behalf, in the session's own log and
 * in front of the model, and a downstream consumer has to be able to tell it
 * apart from something the human typed.
 *
 * Only a cleanly parked session takes this path. A record that never reached
 * the park point, or whose flush did not finish, describes work whose durable
 * state nobody knows; waking it would spend its owner's money on a guess, and
 * deciding those sessions is the morning list's job, not this path's. That
 * holds whether or not the recorded session happens to be live in this process:
 * liveness is not the park outcome, and a session can be live without ever
 * having stopped.
 * @module dsh-pause-session/resume
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { PauseGate } from './gate.js';
import type { ParkRegistry } from './registry.js';
import type { PauseAnswer } from './shared.js';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /**
         * Text dsh-pause-session synthesized on the session's behalf: the wake this
         * path delivers and the unknown-outcome note a decision adds. Declared so
         * the log, and anything reading it, can tell plugin-authored input from the
         * user's own.
         */
        'pause': {
            kind: 'pause';
        };
    }
}
/**
 * The one wake content a route that keeps an empty user message is given. It
 * names its producer, because it lands in the same user turn as the input the
 * model owes an answer to and must not read as part of it.
 */
export declare const WAKE_MARKER = "[pause: resumed from a pause]";
/**
 * How one resume asks the loop for the request it owes the session:
 *
 * - `silent`: the clean path's wake — an empty input on a route the
 *   composition declared silent, and the visible marker on any other route.
 * - `message`: the decision list's "continue, and say the tool outcome is
 *   unknown" — user-visible text on the wire by construction, and the only
 *   resume that is not invisible.
 * - `none`: no wake at all. This is what "leave it for me to read" costs: the
 *   session is not activated, nothing is asked of the model, and the park is
 *   exactly as it was.
 */
export type WakeRequest = {
    readonly kind: 'silent';
} | {
    readonly kind: 'message';
    readonly text: string;
} | {
    readonly kind: 'none';
};
/** Result copy for a resumed session; the model never sees it. */
export declare const RESUMED_TEXT = "This session resumed from where it paused.";
/**
 * Result copy for a registered session this path refuses: its durable state is
 * not the outcome of a completed park, so waking it would be a guess.
 */
export declare const UNCLEAN_TEXT: string;
/** Result copy when nothing is parked under that session. */
export declare const NOT_PARKED_TEXT = "pause has no pause recorded for this session.";
/** Result copy for a session that is parked but could not be loaded back. */
export declare const ACTIVATION_FAILED_TEXT = "pause could not reopen this session, so it stayed paused.";
/** Result copy for a one-shot subagent route: its Session exists, but no resume may reactivate it. */
export declare const UNRESUMABLE_TEXT = "pause did not resume this session: it is a one-shot subagent route and cannot be resumed.";
/**
 * Result copy for the review decision. It is the one answer that promises
 * nothing happened, because opening a session to read it is the user's own
 * action in their session list — and activating its agent here would start a
 * session they asked only to look at.
 */
export declare const REVIEW_TEXT: string;
/** Copy for one goal opt-out change. */
export declare const REARM_GOAL_ON_TEXT = "pause will re-open this session's goal when it resumes it.";
export declare const REARM_GOAL_OFF_TEXT = "pause will leave this session's goal closed when it resumes it.";
/** Why one record did not produce a running session. */
export type ResumeRefusal = 'not-parked' | 'not-clean' | 'activation-failed' | 'unrecorded' | 'not-activated' | 'unresumable';
/** What one resume attempt did. */
export interface ResumeOutcome {
    readonly sessionId: SessionId;
    /** Whether the session is now running from the point it stopped. */
    readonly resumed: boolean;
    /** Present exactly when `resumed` is false. */
    readonly refusal?: ResumeRefusal;
}
/** One resume attempt plus the answer the caller receives. */
export interface ResumeAttempt extends ResumeOutcome {
    readonly answer: PauseAnswer;
}
/** How this path is wired into the session control that owns the pause state. */
export interface ResumeDeps {
    /**
     * Take a live session's pause back: the durable record goes first, then the
     * gate. Owned by the session control so there is one release order.
     */
    release(sessionId: SessionId, text: string): Promise<PauseAnswer>;
    /**
     * Whether the pause this process holds was adopted from the registry rather
     * than pressed here. Only an adopted pause is a restart: a press this process
     * made and took back must never wake a model.
     */
    adopted(sessionId: SessionId): boolean;
}
/** Route knowledge this path needs from the composition. */
export interface ResumeOptions {
    /**
     * Provider routes whose request conversion drops an empty user message, so an
     * empty wake never reaches the model. Deployment-owned because it is a
     * property of the adapter behind each route, and a third-party plugin cannot
     * introspect an adapter.
     */
    readonly silentWakeRoutes: readonly string[];
}
/** The clean resume path, as the session control drives it. */
export interface ResumePath {
    /**
     * Resume one session the registry remembers.
     * @param sessionId - the session to resume.
     * @param request - which wake this resume delivers; see {@link WakeRequest}.
     * @param parentId - the direct parent a batch release already brought back, when there is one.
     * @param signal - cancellation for the cold load and setup.
     * @returns what happened, and the copy for whoever asked.
     */
    resumeSession(sessionId: SessionId, request: WakeRequest, parentId?: SessionId, signal?: AbortSignal): Promise<ResumeAttempt>;
    /**
     * Resume one session the decision list officially owns — a record that is
     * known NOT to be clean, which the clean path above must refuse and this entry
     * exists to carry out. Same release order, same wake vocabulary.
     * @param sessionId - the listed session to bring back.
     * @param request - which wake the decision delivers; see {@link WakeRequest}.
     * @param finalize - whether the decision continues the session (`'release'`)
     * or only answers it (`'review'`). A review activates nothing and writes
     * nothing: opening a session to read it is the user's own action, not this
     * plugin's.
     * @param parentId - the direct parent a batch release already brought back, when there is one.
     * @param signal - cancellation for the cold load and setup.
     * @returns what happened, and the copy for whoever asked.
     */
    decideUnclean(sessionId: SessionId, request: WakeRequest, finalize: 'release' | 'review', parentId?: SessionId, signal?: AbortSignal): Promise<ResumeAttempt>;
    /**
     * Resume every session the registry remembers, clean ones only. One session's
     * failure never stops the others.
     * @param signal - cancellation checked between release levels and forwarded to each load.
     * @returns one attempt per recorded session, in registry order.
     */
    resumeParked(signal?: AbortSignal): Promise<readonly ResumeAttempt[]>;
    /**
     * Record or clear one session's goal opt-out.
     * @param sessionId - the parked session to change.
     * @param rearmGoal - whether the clean resume path may re-arm its goal.
     * @returns the copy for whoever asked.
     */
    setRearmGoal(sessionId: SessionId, rearmGoal: boolean): Promise<PauseAnswer>;
    /**
     * Release one parked session and the registered members of its tree: the
     * counterpart of a press that registered a whole tree.
     * @param sessionId - the session whose tree the user released.
     * @param signal - cancellation for the tree read and each member's load.
     * @returns what happened to the tree, and the copy for whoever asked.
     */
    releaseTree(sessionId: SessionId, signal?: AbortSignal): Promise<ReleaseTreeOutcome>;
}
/** What releasing one session's registered tree did. */
export interface ReleaseTreeOutcome {
    /** How many sessions this release covered: the session plus its registered descendants. */
    readonly members: number;
    /** How many of them are running again. */
    readonly resumed: number;
    /** How many could not be resumed, and why the release did not take them back. */
    readonly refusals: readonly {
        readonly sessionId: SessionId;
        readonly refusal: ResumeRefusal;
    }[];
    /** The copy for whoever pressed the release. */
    readonly answer: PauseAnswer;
}
/**
 * How one tree-wide release answers the person who pressed it. One release, one
 * sentence about all of it: what came back, and — by name, because those rows
 * are what the morning list is for — what did not.
 * @param released - the sessions this release covered, in release order.
 * @returns the result text, e.g. `pause resumed 2 sessions from where they stopped; "child" did not pause completely`.
 */
export declare function summarizeTreeRelease(released: readonly ResumeAttempt[]): string;
/**
 * Build the clean resume path.
 * @param ctx - host context carrying the agent store, the session store, and the goal service when one is mounted.
 * @param gate - the pause gate the resume releases.
 * @param registry - the durable list this path reads and forgets from.
 * @param options - the route knowledge the wake content depends on.
 * @param deps - the control-owned release order and the adopted-pause fact.
 * @returns the path the session control exposes.
 */
export declare function installResumePath(ctx: Context, gate: PauseGate, registry: ParkRegistry, options: ResumeOptions, deps: ResumeDeps): ResumePath;
