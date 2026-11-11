/**
 * The order a batch release walks: parent before child, shallowest first.
 *
 * A single tree release already has the pre-order from its own walk, so this
 * module serves the batch path, where the recorded sessions may span several
 * trees. `listDescendants` stamps each row with its distance from the listing
 * root, so one catalog read per recorded root places every member. A session
 * the walk never reached is its own root and releases with the first level.
 * @module dsh-pause-session/release-order
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
/** How a batch release is sequenced. */
export interface ReleaseOrder {
    /** One list per depth, shallowest first. */
    readonly levels: readonly (readonly SessionId[])[];
}
/**
 * Sequence a batch release parent before child.
 * @param ctx - host context carrying the optional subagent catalog.
 * @param sessionIds - every recorded session, in registry order.
 * @param signal - cancellation for each catalog read.
 * @returns one list per depth level, shallowest first.
 */
export declare function releaseOrder(ctx: Context, sessionIds: readonly SessionId[], signal?: AbortSignal): Promise<ReleaseOrder>;
