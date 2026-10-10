/**
 * The park registry's storage with its writes held open on demand.
 *
 * The plugin's durability rule is an ordering rule — a phase is published only
 * after the write that records it resolved — and the only place that ordering
 * is observable is between the two: while a write is in flight, the answer the
 * browser reads must still be the phase the medium already holds. Production's
 * writes resolve too fast to stand inside that window, so this module routes
 * the domain through a backend that queues each record write until the spec
 * lets it through, and hands the spec the queue.
 *
 * The wrapper delegates every other operation to the real JSON backend, so what
 * is under test is the plugin's ordering, not a fake medium.
 * @module dsh-safe-stop/test/registry/held
 */

import type { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvUnit, StorageBackend } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'

/** One record write the plugin has asked for and the spec has not let through yet. */
export interface HeldWrite {
  /** The table the record belongs to. */
  readonly table: string
  /** The record's key: here, the session id. */
  readonly key: string
  /** The record as the plugin wrote it. */
  readonly value: unknown
}

/** The write queue one mounted storage hands the spec. */
export interface HeldWrites {
  /** Every write requested so far, in request order. */
  readonly requested: readonly HeldWrite[]
  /**
   * Wait until `count` writes have been requested.
   * @param count - how many writes must have been requested.
   */
  untilRequested(count: number): Promise<void>
  /**
   * Let the write at `index` (0-based, in request order) reach the medium.
   * @param index - the write to release.
   */
  release(index: number): void
}

/**
 * Mount the storage stack with the registry's writes under the spec's control.
 * @param ctx - context that owns the mounted rows.
 * @param root - directory the underlying JSON backend keeps its units in.
 * @returns the queue of writes the spec can hold and release.
 */
export async function mountHeldParkStorage(ctx: Context, root: string): Promise<HeldWrites> {
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  const json = ctx.storage.backend.get('json')
  if (json.kv === undefined) throw new Error('spec: the JSON backend offers no kv facet')
  const writes: { write: HeldWrite; go: () => void }[] = []
  const waiters: { count: number; resolve: () => void }[] = []
  const held: StorageBackend = {
    kv: {
      open: async (descriptor): Promise<KvUnit> => {
        const unit = await json.kv!.open(descriptor)
        return {
          loadAll: () => unit.loadAll(),
          // The one operation the spec interposes on: the record is not written
          // until `release`, so "in flight" is a fact the spec owns.
          putRecord: (table, key, value) => new Promise<void>((resolve, reject) => {
            writes.push({
              write: { table, key, value },
              go: () => { void unit.putRecord(table, key, value).then(resolve, reject) },
            })
            for (const waiter of [...waiters]) {
              if (writes.length >= waiter.count) {
                waiters.splice(waiters.indexOf(waiter), 1)
                waiter.resolve()
              }
            }
          }),
          deleteRecord: (table, key) => unit.deleteRecord(table, key),
          setGlobal: value => unit.setGlobal(value),
          close: () => unit.close(),
        }
      },
    },
    close: async () => {},
  }
  ctx.effect(() => ctx.storage.backend.register('held', held), 'spec: held registry writes')
  // The domain form injects the lifecycle service of every backend it routes
  // to, so a wrapper has to provide one exactly as a backend plugin does; the
  // hub registration alone leaves the form's fiber pending.
  ctx.provide(storageBackendServiceKey('held'), held)
  await ctx.plugin(StorageDomain, { backend: 'held' })
  return {
    get requested() { return writes.map(entry => entry.write) },
    untilRequested: async (count) => {
      if (writes.length >= count) return
      await new Promise<void>((resolve) => { waiters.push({ count, resolve }) })
    },
    release: (index) => { writes[index]?.go() },
  }
}
