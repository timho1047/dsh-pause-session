/**
 * The order a tree release walks: parent before child, shallowest first.
 * @module dsh-pause-session/release-order
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
/** How a batch release is sequenced. */
export interface ReleaseOrder {
    /** The tree edge each child was found under. */
    readonly parents: ReadonlyMap<SessionId, SessionId>;
    /** One list per depth, shallowest first. */
    readonly levels: readonly (readonly SessionId[])[];
}
/**
 * Sequence a batch release parent before child.
 * @param ctx - host context carrying the optional subagent catalog.
 * @param sessionIds - every recorded session, in registry order.
 * @param signal - cancellation for each catalog read.
 * @returns the parent of each child, and one list per depth level.
 */
export declare function releaseOrder(ctx: Context, sessionIds: readonly SessionId[], signal?: AbortSignal): Promise<ReleaseOrder>;
