/**
 * The browser status route: one authenticated JSON read of the host's pause
 * state, outside the Session log.
 *
 * A background status read has no business writing `command/run` and
 * `command/done` records into a Session's transcript. The route is available
 * only where the Web carrier mounts it; without `webServer` or `connection`
 * the browser falls back to the command channel, which keeps Desktop and
 * headless compositions working.
 *
 * Security follows the composition's browser fence: every request asks
 * `connection.requestRejection` before the state is computed. The route is
 * read-only and returns only the same status the command surface already
 * publishes; it has no path input and no state-changing verb.
 *
 * @module dsh-pause-session/status-route
 */
import type { Context } from '@deepseek-ai/cordis';
import type { PauseSnapshot } from './shared.js';
/**
 * Register the read-only status route when the composition is a browser host.
 * @param ctx - plugin context; the route is owned by its child fiber.
 * @param read - compute the current snapshot.
 */
export declare function mountStatusRoute(ctx: Context, read: (signal?: AbortSignal) => Promise<PauseSnapshot>): void;
