/**
 * The order a batch release walks: parent before child, shallowest first.
 *
 * A single tree release already has the pre-order from its own walk, so this
 * module serves the batch path, where the recorded sessions may span several
 * trees. `listDescendants` stamps each row with its distance from the listing
 * root, so one catalog read per recorded root places every member. A session
 * the walk never reached is its own root and releases with the first level.
 * @module dsh-pause-session/release-order
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describeError } from './shared.js'

/** How a batch release is sequenced. */
export interface ReleaseOrder {
  /** One list per depth, shallowest first. */
  readonly levels: readonly (readonly SessionId[])[]
}

/**
 * Sequence a batch release parent before child.
 * @param ctx - host context carrying the optional subagent catalog.
 * @param sessionIds - every recorded session, in registry order.
 * @param signal - cancellation for each catalog read.
 * @returns one list per depth level, shallowest first.
 */
export async function releaseOrder(
  ctx: Context,
  sessionIds: readonly SessionId[],
  signal?: AbortSignal,
): Promise<ReleaseOrder> {
  const depth = new Map<SessionId, number>()
  const subagents = ctx.get('subagents')
  if (subagents !== undefined) {
    const owned = new Set(sessionIds)
    for (const sessionId of sessionIds) {
      signal?.throwIfAborted()
      // A member an earlier listing already placed has its depth; walking it
      // again would read the same catalogs for nothing.
      if (depth.has(sessionId)) continue
      depth.set(sessionId, 0)
      try {
        for (const row of await subagents.listDescendants(sessionId, signal)) {
          if (row.kind !== 'child' || !owned.has(row.id)) continue
          depth.set(row.id, row.depth)
        }
      } catch (error: unknown) {
        if (signal?.aborted === true) throw error
        ctx.logger.warn(`pause: could not read the descendants of "${sessionId}": ${describeError(error)}`)
      }
    }
  }
  const levels = new Map<number, SessionId[]>()
  for (const sessionId of sessionIds) {
    const level = depth.get(sessionId) ?? 0
    const bucket = levels.get(level)
    if (bucket === undefined) levels.set(level, [sessionId])
    else bucket.push(sessionId)
  }
  return {
    levels: [...levels.keys()].sort((left, right) => left - right)
      .map(level => levels.get(level) ?? []),
  }
}
