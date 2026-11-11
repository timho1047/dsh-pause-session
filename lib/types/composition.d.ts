/**
 * What a parked Session needs to come back as itself.
 *
 * A root Session is loaded directly: the Agent preset it ran supplies the
 * scoped tools, prompt sections, and skills, so the resume mounts that preset
 * before the Agent is published. A subagent child is not loaded here at all —
 * the subagent runtime owns its activation, composition, and tree membership,
 * and cold-resumes it when this plugin delivers the wake through
 * `ctx.subagents.prompt`.
 *
 * The two cases are told apart by one read of the Session's own log, which is
 * the same read the press-time resumability check already pays for.
 * @module dsh-pause-session/composition
 */
import type { Context } from '@deepseek-ai/cordis';
import type { AgentSetup } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
/** How one parked Session comes back. */
export type ParkedComposition = {
    /** An ordinary Session the plugin loads itself. */
    readonly kind: 'root';
    /** The scoped Agent world to mount before the Agent is published. */
    readonly setup?: AgentSetup;
} | {
    /**
     * A subagent child. The subagent runtime restores its composition from the
     * persisted descriptor and preset projection, so the plugin only delivers
     * the wake.
     */
    readonly kind: 'child';
};
/**
 * Whether a local Session may be parked under a promise of a later resume.
 *
 * A normal root Session has no child descriptor and is resumable. A local
 * subagent child is resumable only when its own durable descriptor is
 * `continuable`; a historical `one-shot` child is terminal and must never be
 * registered as a park the morning path would later have to refuse. External
 * executions have no local Session, so callers never reach this check.
 *
 * A profile without the optional Session-query service cannot prove the
 * descriptor's mode; it keeps the previous permissive behavior rather than
 * dropping every subagent. The web profile mounts the query service.
 * @param ctx - host context carrying the optional Session-query service.
 * @param sessionId - the local Session to inspect.
 * @param signal - cancellation for the observation read.
 * @returns whether a park of this Session may be resumed.
 * @throws the cancellation reason when `signal` aborts the read.
 */
export declare function isResumableSession(ctx: Context, sessionId: SessionId, signal?: AbortSignal): Promise<boolean>;
/**
 * Read one parked Session's own log and decide how it comes back.
 *
 * A child returns as `child` with no setup: the subagent runtime restores the
 * composition from the descriptor and the preset projection, and mounting a
 * second one here would start a different Agent on the same history.
 *
 * A root resolves the preset it ran — the projection, never the creation-time
 * header alone, because a blank Session may select another preset before its
 * first turn — and hands back the setup that mounts it. A profile with no
 * preset roster has no scoped composition to restore and resumes unchanged.
 * @param ctx - host context carrying the optional preset and Session-query services.
 * @param sessionId - the parked Session being resumed.
 * @param signal - cancellation for the observation read.
 * @returns how this Session comes back.
 * @throws when a mounted preset roster cannot read the Session projection.
 */
export declare function readParkedComposition(ctx: Context, sessionId: SessionId, signal?: AbortSignal): Promise<ParkedComposition>;
