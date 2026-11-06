/**
 * Browser read of the host's JSON pause snapshot.
 *
 * The source is a plain same-origin `fetch`, not a Session command: background
 * polling must not append `command/run` and `command/done` to the transcript.
 * It caches one request for a short window because both header controls read
 * on the same burst, and it backs off for five seconds after a 404 so a
 * Desktop/IPC composition falls back to the command channel instead of
 * repeating a dead request on every transition.
 *
 * @module dsh-pause-session/client/status
 */
import type { PauseSnapshot } from '../shared.js';
/** The one read the two browser controls share. */
export interface PauseStatusSource {
    /**
     * Read the host snapshot.
     * @param signal - lifetime cancellation, supplied by the owning control.
     * @returns the snapshot, or undefined when the route is unavailable.
     */
    read(signal?: AbortSignal): Promise<PauseSnapshot | undefined>;
}
/**
 * Create the browser status source.
 * @param lifetime - aborts an in-flight request when the client unloads.
 * @returns the shared source.
 */
export declare function createStatusSource(lifetime: AbortSignal): PauseStatusSource;
