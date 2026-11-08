/**
 * The durable park registry: which sessions are paused, and how cleanly each
 * one stopped.
 *
 * The registry lives in the profile's storage — `ctx.storageDomain`, the
 * schema-validated domain data form over whichever backend the composition
 * routes it to — and never in the session log: a pause is not part of a
 * session's history, and the list has to be readable by a process that has not
 * opened any session yet. The domain's own backend route is configuration, so
 * this module names no path and performs no IO of its own.
 *
 * The domain keeps the DEFAULT whole-unit layout on purpose. The per-record
 * layout reads a malformed or stale record document as an absent record, which
 * here would silently drop one paused session; a whole-unit file turns any
 * corruption into a failed `open`, and a failed open fails the plugin's mount
 * loudly instead of resuming everything.
 * @module dsh-pause-session/registry
 */
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { ParkPhase } from './shared.js';
/** Domain and backend-unit name; one document per profile under the storage root. */
export declare const PARK_REGISTRY_DOMAIN = "pause_registry";
/** One session's stored park outcome. */
export declare const parkRecord: z.ZodObject<{
    phase: z.ZodEnum<{
        draining: "draining";
        parking: "parking";
        safe: "safe";
        "flush-failed": "flush-failed";
    }>;
    updatedAt: z.ZodNumber;
    rearmGoal: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
/** One session's stored park outcome. */
export type ParkRecord = z.infer<typeof parkRecord>;
/**
 * The registry declaration. `version: 1` and no `compatibleVersions`: the
 * domain layer rejects a stored unit stamped with any other version rather than
 * migrating it, so an unrecognized registry fails loud at open. Validation is
 * the rejecting default for the same reason — a record this build cannot read
 * must stop the mount, not disappear from the list.
 */
export declare const parkRegistryDomain: {
    name: string;
    version: number;
    tables: {
        sessions: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<SessionId, {
            phase: "draining" | "parking" | "safe" | "flush-failed";
            updatedAt: number;
            rearmGoal: boolean;
        }>;
    };
};
/** One session the registry remembers. */
export interface ParkedSession {
    readonly sessionId: SessionId;
    readonly phase: ParkPhase;
    /** When the phase was written. */
    readonly updatedAt: number;
    /** Whether resuming this session may re-arm its goal; see {@link parkRecord}. */
    readonly rearmGoal: boolean;
}
/** The durable pause list, opened over the profile's storage. */
export interface ParkRegistry {
    /**
     * @returns every remembered session, in insertion order.
     */
    list(): readonly ParkedSession[];
    /**
     * The same list as {@link list}, as a lazily kept read-only view.
     *
     * The whole-app aggregate and the decision list read this once per status
     * read, and a status read can happen on every native-stream notification; the
     * view is rebuilt only when the stored entries actually changed, so a read
     * that changes nothing does not build a second copy of the list to look at.
     * A caller must not mutate it.
     */
    readonly parked: ReadonlyMap<SessionId, ParkedSession>;
    /**
     * @param sessionId - session to look up.
     * @returns the remembered session, or `undefined` when nothing is parked under that id.
     */
    get(sessionId: SessionId): ParkedSession | undefined;
    /**
     * Write one session's outcome; resolves once it is durable. The goal opt-out
     * already recorded for that session survives a phase change — the phases of
     * one park episode all describe the same parked session.
     * @param sessionId - the session being parked.
     * @param phase - how far the park has got.
     */
    record(sessionId: SessionId, phase: ParkPhase): Promise<void>;
    /**
     * Set one session's goal opt-out; resolves once it is durable.
     * @param sessionId - the parked session to change.
     * @param rearmGoal - whether the clean resume path may re-arm its goal.
     * @throws when no record exists for that session — the flag describes a
     * parked session, and inventing a record would invent a park.
     */
    setRearmGoal(sessionId: SessionId, rearmGoal: boolean): Promise<void>;
    /**
     * Drop one session from the list, so a later process does not re-hold it.
     * @param sessionId - the session being released.
     */
    forget(sessionId: SessionId): Promise<void>;
}
/**
 * Open the registry over the mounted storage. The caller owns the handle's
 * lifetime; this registers the close as an effect on `ctx`, so the unit is
 * released with the plugin.
 * @param ctx - plugin context carrying `storageDomain`.
 * @returns the open registry.
 * @throws whatever `open` rejects with — a `StorageError` for an unreadable
 * unit, a `DomainError('invalid-record')` for a record this build cannot read.
 */
export declare function openParkRegistry(ctx: Context): Promise<ParkRegistry>;
