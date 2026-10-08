/**
 * The storage stack the plugin needs before it can mount at all.
 *
 * The park registry opens through `ctx.storageDomain`, so a suite that mounts
 * the plugin without these rows leaves its fiber pending and nothing is
 * registered. The shipped composition routes the domain form to the JSON
 * backend, and the backend writes to a real directory on purpose: the whole
 * point of the registry is that a later process reads it back, which is only
 * observable against a medium that outlives the writer.
 * @module dsh-safe-stop/test/registry/storage
 */

import type { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'

/**
 * Mount the hub, the JSON backend at `root`, and the domain form over it.
 * @param ctx - context that owns the mounted rows.
 * @param root - directory the backend keeps its units in; it is created on demand.
 */
export async function mountParkStorage(ctx: Context, root: string): Promise<void> {
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
}
