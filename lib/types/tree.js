/**
 * One session's subagent tree, read from the parent catalogs.
 *
 * "This session's work" includes the subagents it delegated to, nested ones
 * included, so the session-header press and the status the header shows both
 * need the same answer to "which sessions hang under this one".
 * `listDescendants` is the harness's own recursive walk of the parent-owned
 * catalogs, and it is the only source: the tree is read from the parents that
 * record it, never guessed from session ids.
 *
 * A walk is read, not remembered. The tree is a fact that grows — a delegation
 * in flight publishes its child after the parent's catalog was read — so a
 * press walks the tree at press time and a status read walks it at read time.
 * `@module dsh-pause-session/tree`
 */
import { describeError } from './shared.js';
/**
 * Read the subagent tree under one session.
 *
 * A failure to read a branch is reported as unread rather than as an empty
 * tree: the difference is what keeps a press from claiming it registered a tree
 * it never saw, and keeps a status answer from calling itself safe behind an
 * unknown branch.
 * @param ctx - host context carrying the optional subagent service.
 * @param rootSessionId - the session whose descendants are requested.
 * @param signal - cancellation for the catalog walk.
 * @returns the descendants found and what of the walk could not be read.
 * @throws the cancellation reason when `signal` aborts the walk.
 */
export async function walkDescendants(ctx, rootSessionId, signal) {
    const subagents = ctx.get('subagents');
    if (subagents === undefined)
        return { members: [], unread: [], unreadWhole: false };
    try {
        const rows = await subagents.listDescendants(rootSessionId, signal);
        const members = [];
        const unread = [];
        for (const row of rows) {
            if (row.kind === 'child') {
                members.push({ id: row.id, mode: row.mode });
                continue;
            }
            unread.push({ id: row.id, reason: row.reason });
        }
        return { members, unread, unreadWhole: false };
    }
    catch (error) {
        if (signal?.aborted === true)
            throw error;
        ctx.logger.warn(`pause: could not read the subagent tree of "${rootSessionId}": ${describeError(error)}`);
        return { members: [], unread: [], unreadWhole: true };
    }
}
//# sourceMappingURL=tree.js.map