/**
 * Read the durable park registry the way a fresh process does: a new context,
 * the same storage root, the plugin's own `openParkRegistry`.
 *
 * This is the second test seam the spec names (the registry file). It is kept
 * apart from `./storage.ts` because that module is also imported by the child
 * processes, which run the BUILT plugin entry and cannot load `src/*.ts`.
 * @module dsh-pause/test/registry/read
 */

import { Context } from '@deepseek-ai/cordis'
import { openParkRegistry } from '../../src/registry.ts'
import type { ParkedSession } from '../../src/registry.ts'
import { mountParkStorage } from './storage.ts'

/**
 * Open the registry over `root` in a throwaway context and return its records.
 * @param root - storage root a previous process (or plugin instance) wrote to.
 * @returns every registered session, in insertion order.
 */
export async function readParkRegistry(root: string): Promise<readonly ParkedSession[]> {
  const ctx = new Context()
  try {
    await mountParkStorage(ctx, root)
    const registry = await openParkRegistry(ctx)
    return [...registry.list()]
  } finally {
    await ctx.fiber.dispose()
  }
}
