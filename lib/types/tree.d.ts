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
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
/** One session a walk found under another, with the catalog's own mode for it. */
export interface TreeMember {
    readonly id: SessionId;
    /**
     * The catalog's durable mode for this child. `external` is a child with no
     * local session to park, and `unsupported` is a mode this build cannot read;
     * the other two are the harness's own split between a route a restart can
     * resume (`continuable`) and one it cannot.
     */
    readonly mode: 'one-shot' | 'external' | 'continuable' | 'unsupported';
}
/** One branch a walk reached and could not read. */
export interface UnreadBranch {
    readonly id: SessionId;
    /**
     * `corrupt` and `unavailable` mean the branch's own catalog was not read, so
     * the members under it are unknown. `unsupported` means the parent's catalog
     * records a mode this build cannot read; that branch was still traversed, and
     * what it holds is known — but no restart can resume through it.
     */
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable';
}
/** What one session's tree walk found. */
export interface TreeWalk {
    /**
     * Catalog descendants in pre-order, direct children first and each child's
     * own children after it. A missing subagent service leaves this empty.
     */
    readonly members: readonly TreeMember[];
    /**
     * Branches the walk reached and could not fully read. A branch named here may
     * hold members nobody can see, so it is never read as "no members".
     */
    readonly unread: readonly UnreadBranch[];
    /**
     * Whether the walk itself failed, so even the branches are unknown. Named
     * separately from {@link unread}, which lists the branches of a walk that ran.
     */
    readonly unreadWhole: boolean;
}
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
export declare function walkDescendants(ctx: Context, rootSessionId: SessionId, signal?: AbortSignal): Promise<TreeWalk>;
