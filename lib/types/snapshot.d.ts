/**
 * Pure projection of the durable park and each live tree into the native
 * snapshot. This module owns the phase fold and the goal opt-out; it does not
 * press, release, or decide anything.
 * @module dsh-pause-session/snapshot
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { ParkWatch } from './park.js';
import type { ParkRegistry } from './registry.js';
import type { TreeWalk } from './tree.js';
import type { ParkMark } from './park-state.js';
import type { GlobalStatus, PauseSnapshot } from './shared.js';
/** What the snapshot projection needs from the control. */
export interface SnapshotDeps {
    readonly ctx: Context;
    readonly marks: ReadonlyMap<SessionId, ParkMark>;
    readonly watch: ParkWatch;
    readonly registry: ParkRegistry;
    /** Read the whole-app aggregate, reusing the walks this projection already paid for. */
    readGlobal(signal?: AbortSignal, walks?: ReadonlyMap<SessionId, TreeWalk>): Promise<GlobalStatus>;
}
/**
 * Read every live mark and the whole-app aggregate in one pass.
 * @param deps - the control-owned marks, watch, registry, and aggregate reader.
 * @param signal - cancellation for the tree walks and aggregate.
 * @returns the native snapshot.
 */
export declare function readSnapshot(deps: SnapshotDeps, signal?: AbortSignal): Promise<PauseSnapshot>;
