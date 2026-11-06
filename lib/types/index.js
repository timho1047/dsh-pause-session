/**
 * Host half of dsh-pause-session.
 *
 * Mounts the pause gate — the per-session hold at the model-request waterfall —
 * the activity fold the park predicate reads, the durable park registry, the
 * session control the browser half drives, and the clean resume path that
 * answers the input a parked session left pending.
 *
 * The registry is read before anything is gated, so a session a previous
 * process left parked is held again by this one without any user action; a
 * registry this build cannot read fails the mount loudly rather than silently
 * resuming every session it named.
 * @module dsh-pause-session
 */
import { z } from 'zod';
import { TRIAGE_LOG_MAX_EVENTS, TRIAGE_WINDOW_EVENTS } from './coldlog.js';
import { installSessionControl } from './control.js';
import { PauseGate } from './gate.js';
import { mountParkWatch } from './park.js';
import { PauseRemote } from './remote.js';
import { remoteApiOf } from './remote-adapter.js';
import { openParkRegistry } from './registry.js';
export { PauseRemote } from './remote.js';
/** Plugin name; the Loader row and the bundle patch both use it. */
export const name = 'dsh-pause-session';
/**
 * Required host services: the model runtime to gate, the stores the control
 * needs, the projection registry the park predicate reads turn state from, and
 * the profile's storage, which holds the pause registry.
 */
export const inject = ['llm', 'agents', 'sessions', 'sessionProjections', 'storageDomain'];
/**
 * Provider routes whose request conversion drops an empty user message, so the
 * clean resume path's wake input never reaches the model on them.
 *
 * The list is deployment knowledge, not a constant this plugin may assume:
 * whether an empty user message survives is decided by the adapter (and, for
 * the pi-ai family, by the provider API that adapter is configured for), and a
 * plugin cannot introspect an adapter. The default names the routes the shipped
 * DeepSeek adapter registers; a profile that routes a session elsewhere gets
 * the visible marker instead of a silent empty turn until it declares that
 * route here.
 */
export const DEFAULT_SILENT_WAKE_ROUTES = ['deepseek-official', 'deepseek-account'];
/** Validated plugin configuration. */
const ConfigShape = z.object({
    /** Provider routes known to drop an empty user message; see {@link DEFAULT_SILENT_WAKE_ROUTES}. */
    silentWakeRoutes: z.array(z.string()).default([...DEFAULT_SILENT_WAKE_ROUTES]),
    /**
     * How many events of a parked session's stored log the morning list folds per
     * row, counted back from the end. The list reads a session's stop position
     * and its unknown tool outcomes, both facts about the log's end, so this
     * bounds what a panel left open costs without changing what a row says about
     * a log that fits inside it. A row whose log needs more than this is reported
     * unreadable rather than guessed at; see `./coldlog.ts`.
     */
    maxListedLogEvents: z.number().int().min(1).max(TRIAGE_LOG_MAX_EVENTS).default(TRIAGE_WINDOW_EVENTS),
});
/**
 * The Loader hands a row's config through this schema, and an empty row config
 * arrives as `undefined`; folding it to `{}` first is what lets the field
 * defaults above apply instead of failing the mount.
 */
export const Config = z.preprocess(value => value ?? {}, ConfigShape);
/**
 * Mount the durable pause registry, the pause gate, the activity fold, their
 * session control, and the clean resume path.
 *
 * The registry opens first on purpose: if it cannot be read, nothing else is
 * registered, so a failed mount leaves no half-installed control behind.
 * @param ctx - the plugin's host context.
 * @param config - validated route knowledge for the resume path's wake content.
 */
export async function apply(ctx, config = Config.parse({})) {
    const registry = await openParkRegistry(ctx);
    const lifetime = new AbortController();
    // The gate races this signal, so unloading releases every held request
    // instead of stranding a generator no one can reach again.
    ctx.effect(() => () => { lifetime.abort(new Error('pause: plugin unloaded')); }, 'pause: lifetime');
    const gate = new PauseGate({ lifetime: lifetime.signal });
    ctx.effect(() => ctx.on('llm/stream', (request, next) => gate.stream(request, next)), 'pause: pause gate');
    const watch = await mountParkWatch(ctx);
    const control = installSessionControl(ctx, gate, watch, registry, {
        silentWakeRoutes: config.silentWakeRoutes,
        maxListedLogEvents: config.maxListedLogEvents,
    });
    new PauseRemote(ctx, remoteApiOf(control));
    await control.adopt();
}
//# sourceMappingURL=index.js.map