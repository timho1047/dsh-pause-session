/**
 * The order a tree release walks: parent before child, shallowest first.
 * @module dsh-pause-session/release-order
 */
import { describeError } from './shared.js';
/**
 * Sequence a batch release parent before child.
 * @param ctx - host context carrying the optional subagent catalog.
 * @param sessionIds - every recorded session, in registry order.
 * @param signal - cancellation for each catalog read.
 * @returns the parent of each child, and one list per depth level.
 */
export async function releaseOrder(ctx, sessionIds, signal) {
    const owned = new Set(sessionIds);
    const parentOf = new Map();
    const subagents = ctx.get('subagents');
    if (subagents !== undefined) {
        for (const sessionId of sessionIds) {
            signal?.throwIfAborted();
            try {
                for (const child of await subagents.listChildren(sessionId, signal)) {
                    if (owned.has(child.id))
                        parentOf.set(child.id, sessionId);
                }
            }
            catch (error) {
                if (signal?.aborted === true)
                    throw error;
                ctx.logger.warn(`pause: could not read the children of "${sessionId}": ${describeError(error)}`);
            }
        }
    }
    const depthOf = (sessionId) => {
        let steps = 0;
        const seen = new Set([sessionId]);
        for (let at = parentOf.get(sessionId); at !== undefined; at = parentOf.get(at)) {
            if (seen.has(at))
                break;
            seen.add(at);
            steps += 1;
        }
        return steps;
    };
    const levels = new Map();
    for (const sessionId of sessionIds) {
        const level = depthOf(sessionId);
        const bucket = levels.get(level);
        if (bucket === undefined)
            levels.set(level, [sessionId]);
        else
            bucket.push(sessionId);
    }
    return {
        parents: parentOf,
        levels: [...levels.keys()].sort((left, right) => left - right)
            .map(level => levels.get(level) ?? []),
    };
}
//# sourceMappingURL=release-order.js.map