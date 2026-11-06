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
import type { Context } from '@deepseek-ai/cordis';
export { PauseRemote } from './remote.js';
/** Plugin name; the Loader row and the bundle patch both use it. */
export declare const name = "dsh-pause-session";
/**
 * Required host services: the model runtime to gate, the stores the control
 * needs, the projection registry the park predicate reads turn state from, and
 * the profile's storage, which holds the pause registry.
 */
export declare const inject: string[];
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
export declare const DEFAULT_SILENT_WAKE_ROUTES: readonly ["deepseek-official", "deepseek-account"];
/** Validated plugin configuration. */
declare const ConfigShape: z.ZodObject<{
    silentWakeRoutes: z.ZodDefault<z.ZodArray<z.ZodString>>;
    maxListedLogEvents: z.ZodDefault<z.ZodNumber>;
    exposeCommands: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
/** Validated plugin configuration. */
export type Config = z.infer<typeof ConfigShape>;
/**
 * The Loader hands a row's config through this schema, and an empty row config
 * arrives as `undefined`; folding it to `{}` first is what lets the field
 * defaults above apply instead of failing the mount.
 */
export declare const Config: z.ZodPreprocess<z.ZodObject<{
    silentWakeRoutes: z.ZodDefault<z.ZodArray<z.ZodString>>;
    maxListedLogEvents: z.ZodDefault<z.ZodNumber>;
    exposeCommands: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>>;
/**
 * Mount the durable pause registry, the pause gate, the activity fold, their
 * session control, and the clean resume path.
 *
 * The registry opens first on purpose: if it cannot be read, nothing else is
 * registered, so a failed mount leaves no half-installed control behind.
 * @param ctx - the plugin's host context.
 * @param config - validated route knowledge for the resume path's wake content.
 */
export declare function apply(ctx: Context, config?: Config): Promise<void>;
