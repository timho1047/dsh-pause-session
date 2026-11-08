/**
 * Wire adapter between the pause engine and the generated Remote namespace.
 *
 * The engine speaks in branded Session ids and CommandResult copy; the Remote
 * contract is plain JSON. Mapping lives here so neither side depends on the
 * other's types.
 * @module dsh-pause-session/remote-adapter
 */
import type { SessionControl } from './control.js';
import type { PauseRemoteApi, PauseSnapshotWire } from './remote.js';
import type { GlobalStatus, ParkStatus } from './shared.js';
/** Map the engine's snapshot to the wire shape. */
export declare function snapshotOf(snapshot: {
    global: GlobalStatus;
    sessions: Readonly<Record<string, ParkStatus>>;
}): PauseSnapshotWire;
/**
 * Build the Remote callbacks over the mounted pause control.
 * @param control - the engine's host control surface.
 * @returns the wire API.
 */
export declare function remoteApiOf(control: SessionControl): PauseRemoteApi;
