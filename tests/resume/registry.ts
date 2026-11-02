/**
 * The registry as the morning path writes it: open the same storage root a
 * parked process left behind, change one record's goal opt-out, and release the
 * medium again. Kept apart from the read helper because the JSON backend
 * refuses a second open of one root inside one process, so a case that edits a
 * record must do it before it mounts the plugin.
 * @module dsh-pause-session/test/resume/registry
 */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { openParkRegistry } from '../../src/registry.ts'
import { mountParkStorage } from '../registry/storage.ts'

/**
 * Set one parked session's goal opt-out through the plugin's own registry API.
 * @param root - storage root the parked session's record lives in.
 * @param sessionId - the parked session to change.
 * @param rearmGoal - whether the clean resume path may re-arm its goal.
 */
export async function setGoalRearm(root: string, sessionId: string, rearmGoal: boolean): Promise<void> {
  const ctx = new Context()
  try {
    await mountParkStorage(ctx, root)
    const registry = await openParkRegistry(ctx)
    await registry.setRearmGoal(SessionId(sessionId), rearmGoal)
  } finally {
    await ctx.fiber.dispose()
  }
}
