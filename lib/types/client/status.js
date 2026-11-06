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
import { STATUS_PATH } from '../shared.js';
/** How long two controls' reads share one request. */
const CACHE_MS = 75;
/**
 * Create the browser status source.
 * @param lifetime - aborts an in-flight request when the client unloads.
 * @returns the shared source.
 */
export function createStatusSource(lifetime) {
    let retryAfter = 0;
    let cachedAt = 0;
    let cached;
    const load = async (signal) => {
        if (Date.now() < retryAfter)
            return undefined;
        const requestSignal = signal ?? lifetime;
        try {
            const response = await fetch(STATUS_PATH, {
                method: 'GET',
                headers: { accept: 'application/json' },
                credentials: 'same-origin',
                cache: 'no-store',
                signal: requestSignal,
            });
            if (response.status === 404 || response.status === 405) {
                retryAfter = Date.now() + 5_000;
                return undefined;
            }
            if (!response.ok)
                return undefined;
            return await response.json();
        }
        catch {
            return undefined;
        }
    };
    return {
        read: (signal) => {
            const now = Date.now();
            if (cached !== undefined && now - cachedAt < CACHE_MS)
                return cached;
            cachedAt = now;
            cached = load(signal);
            return cached;
        },
    };
}
//# sourceMappingURL=status.js.map