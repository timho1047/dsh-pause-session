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

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable, DomainError } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { PARK_PHASES } from './shared.js'
import type { ParkPhase } from './shared.js'

/** Domain and backend-unit name; one document per profile under the storage root. */
export const PARK_REGISTRY_DOMAIN = 'pause_registry'

/** One session's stored park outcome. */
export const parkRecord = z.object({
  /** How far that session got before its process ended; only `safe` is clean. */
  phase: z.enum(PARK_PHASES),
  /** When this record was last written — a phase change, or a goal opt-out flip. */
  updatedAt: z.number().int().nonnegative(),
  /**
   * Whether resuming this session may re-arm its goal. Re-arming is opt-OUT
   * because a re-armed goal continues on its own and spends the owner's money;
   * a record written before this field existed reads as `true`, which is the
   * product default (a goal session comes back running its rounds).
   *
   * Every phase write of one park episode folds through the stored record, so
   * the opt-out a user sets while the session is still draining survives the
   * `parking` and `safe` writes that follow it.
   */
  rearmGoal: z.boolean().default(true),
})

/** One session's stored park outcome. */
export type ParkRecord = z.infer<typeof parkRecord>

/**
 * The registry declaration. `version: 1` and no `compatibleVersions`: the
 * domain layer rejects a stored unit stamped with any other version rather than
 * migrating it, so an unrecognized registry fails loud at open. Validation is
 * the rejecting default for the same reason — a record this build cannot read
 * must stop the mount, not disappear from the list.
 */
export const parkRegistryDomain = defineDomain({
  name: PARK_REGISTRY_DOMAIN,
  version: 1,
  tables: { sessions: domainTable<SessionId, ParkRecord>(parkRecord) },
})

/** One session the registry remembers. */
export interface ParkedSession {
  readonly sessionId: SessionId
  readonly phase: ParkPhase
  /** When the phase was written. */
  readonly updatedAt: number
  /** Whether resuming this session may re-arm its goal; see {@link parkRecord}. */
  readonly rearmGoal: boolean
}

/** The durable pause list, opened over the profile's storage. */
export interface ParkRegistry {
  /**
   * @returns every remembered session, in insertion order.
   */
  list(): readonly ParkedSession[]
  /**
   * The same list as {@link list}, as a lazily kept read-only view.
   *
   * The whole-app aggregate and the decision list read this once per status
   * read, and a status read can happen on every command-registry change; the
   * view is rebuilt only when the stored entries actually changed, so a read
   * that changes nothing does not build a second copy of the list to look at.
   * A caller must not mutate it.
   */
  readonly parked: ReadonlyMap<SessionId, ParkedSession>
  /**
   * @param sessionId - session to look up.
   * @returns the remembered session, or `undefined` when nothing is parked under that id.
   */
  get(sessionId: SessionId): ParkedSession | undefined
  /**
   * Write one session's outcome; resolves once it is durable. The goal opt-out
   * already recorded for that session survives a phase change — the phases of
   * one park episode all describe the same parked session.
   * @param sessionId - the session being parked.
   * @param phase - how far the park has got.
   */
  record(sessionId: SessionId, phase: ParkPhase): Promise<void>
  /**
   * Set one session's goal opt-out; resolves once it is durable.
   * @param sessionId - the parked session to change.
   * @param rearmGoal - whether the clean resume path may re-arm its goal.
   * @throws when no record exists for that session — the flag describes a
   * parked session, and inventing a record would invent a park.
   */
  setRearmGoal(sessionId: SessionId, rearmGoal: boolean): Promise<void>
  /**
   * Drop one session from the list, so a later process does not re-hold it.
   * @param sessionId - the session being released.
   */
  forget(sessionId: SessionId): Promise<void>
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
export async function openParkRegistry(ctx: Context): Promise<ParkRegistry> {
  const domain: Domain<typeof parkRegistryDomain> = await ctx.storageDomain.open(parkRegistryDomain)
  ctx.effect(() => () => domain.close(), 'pause: registry')
  const sessions = domain.table('sessions')
  /** The entries the cached view was built from; replaced whenever they differ. */
  let cachedFrom: readonly ParkedSession[] = []
  let cached: ReadonlyMap<SessionId, ParkedSession> | undefined
  const entryOf = (sessionId: SessionId): ParkedSession | undefined => {
    const record = sessions.get(sessionId)
    return record === undefined
      ? undefined
      : { sessionId, phase: record.phase, updatedAt: record.updatedAt, rearmGoal: record.rearmGoal }
  }
  const entriesNow = (): readonly ParkedSession[] => [...sessions.entries()].map(([sessionId, record]) => ({
    sessionId,
    phase: record.phase,
    updatedAt: record.updatedAt,
    rearmGoal: record.rearmGoal,
  }))
  return {
    list: entriesNow,
    get parked() {
      const entries = entriesNow()
      // Same length and same records: the view the last read built still
      // describes this list, so hand that one back rather than another copy.
      if (cached !== undefined && entries.length === cachedFrom.length
        && entries.every((entry, at) => entry === cachedFrom[at])) return cached
      cachedFrom = entries
      cached = new Map(entries.map(entry => [entry.sessionId, entry]))
      return cached
    },
    get: entryOf,
    record: async (sessionId, phase) => {
      const updatedAt = Date.now()
      // A record already there is folded through `update`, so the phase write
      // and the record's own goal opt-out are decided in the backend's job
      // order rather than from a read taken before this write was queued.
      if (sessions.get(sessionId) !== undefined) {
        try {
          await sessions.update(sessionId, current => ({ ...current, phase, updatedAt }))
          return
        } catch (error: unknown) {
          // Released between that read and this job: fall through and start the
          // record again, which is what the park phase is asking for.
          if (!(error instanceof DomainError) || error.code !== 'missing-key') throw error
        }
      }
      // A fresh object per write: domain records are the stored objects and are
      // never mutated in place.
      await sessions.put(sessionId, { phase, updatedAt, rearmGoal: true })
    },
    setRearmGoal: async (sessionId, rearmGoal) => {
      // `update` decides existence and reads the current record inside the
      // backend's own job order, so a phase write queued beside it cannot be
      // clobbered by a stale read.
      await sessions.update(sessionId, current => ({ ...current, rearmGoal, updatedAt: Date.now() }))
    },
    forget: async (sessionId) => {
      await sessions.delete(sessionId)
    },
  }
}
