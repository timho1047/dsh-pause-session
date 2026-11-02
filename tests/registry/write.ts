/**
 * Write the park registry the way a host that cannot act on a session leaves
 * it: a durable record, opened through the plugin's own registry over the same
 * storage root, with no session behind it.
 *
 * This is how a case meets a record whose session log never materialized — a
 * subagent killed inside a tool, or a record written before the crash the park
 * never recovered from. The record is real and durable; only the session is
 * missing. Kept apart from the read helper because the write opens the root for
 * writing and must therefore happen before the case mounts the plugin over it.
 * @module dsh-pause/test/registry/write
 */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { openParkRegistry } from '../../src/registry.ts'
import type { ParkPhase } from '../../src/shared.ts'
import { mountParkStorage } from './storage.ts'

/**
 * Record one park outcome with no session behind it.
 * @param root - the storage root a process's records live in.
 * @param sessionId - the session id to record.
 * @param phase - the park outcome to record.
 */
export async function writeParkRecord(root: string, sessionId: string, phase: ParkPhase): Promise<void> {
  const ctx = new Context()
  try {
    await mountParkStorage(ctx, root)
    const registry = await openParkRegistry(ctx)
    await registry.record(SessionId(sessionId), phase)
  } finally {
    await ctx.fiber.dispose()
  }
}
