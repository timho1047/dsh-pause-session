/**
 * Pure projection of the durable park and each live tree into the native
 * snapshot. This module owns the phase fold and the goal opt-out; it does not
 * press, release, or decide anything.
 * @module dsh-pause-session/snapshot
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ParkWatch } from './park.js'
import type { ParkRegistry } from './registry.js'
import { walkDescendants } from './tree.js'
import type { TreeWalk } from './tree.js'
import { foldTreePhases } from './shared.js'
import type { ParkMark } from './park-state.js'
import type { GlobalStatus, ParkPhase, ParkStatus, PauseSnapshot } from './shared.js'

/** What the snapshot projection needs from the control. */
export interface SnapshotDeps {
  readonly ctx: Context
  readonly marks: ReadonlyMap<SessionId, ParkMark>
  readonly watch: ParkWatch
  readonly registry: ParkRegistry
  /** Read the whole-app aggregate, reusing the walks this projection already paid for. */
  readGlobal(signal?: AbortSignal, walks?: ReadonlyMap<SessionId, TreeWalk>): Promise<GlobalStatus>
}

/** The phase a durable record holds for one session, live or adopted. */
function recordedPhase(deps: SnapshotDeps, sessionId: SessionId): ParkPhase | undefined {
  return deps.marks.get(sessionId)?.phase ?? deps.registry.get(sessionId)?.phase
}

/** Fold one session's mark and its registered descendants into the header reading. */
async function treeStatus(
  deps: SnapshotDeps,
  sessionId: SessionId,
  mark: ParkMark,
  signal?: AbortSignal,
  knownWalk?: TreeWalk,
): Promise<ParkStatus> {
  const walk = knownWalk ?? await walkDescendants(deps.ctx, sessionId, signal)
  const phases: ParkPhase[] = [mark.phase]
  const extraRunning: string[] = []
  for (const member of walk.members) {
    const phase = recordedPhase(deps, member.id)
    if (phase !== undefined) {
      phases.push(phase)
      continue
    }
    // A member this press could not register (one-shot/external route) is
    // still part of the tree. If it is doing work, the tree is not safe.
    if (member.mode !== 'continuable') {
      const activity = deps.watch.activity(member.id)
      if (activity.turnOpen || activity.runningTools.length > 0) {
        phases.push('draining')
        extraRunning.push(...activity.runningTools)
      }
    }
  }
  // An unread branch is unknown: it is neither clean nor a settled phase.
  for (let at = 0; at < walk.unread.length + (walk.unreadWhole ? 1 : 0); at += 1) phases.push('parking')

  const folded = foldTreePhases(phases)
  const runningTools = [
    ...(mark.phase === 'draining' ? deps.watch.activity(sessionId).runningTools : []),
    ...walk.members.flatMap(member => recordedPhase(deps, member.id) === 'draining'
      ? deps.watch.activity(member.id).runningTools
      : []),
    ...extraRunning,
  ]
  const record = deps.registry.get(sessionId)
  return {
    phase: folded.phase,
    safe: folded.safe,
    runningTools,
    ...record === undefined ? {} : { rearmGoal: record.rearmGoal },
  }
}

/**
 * Read every live mark and the whole-app aggregate in one pass.
 * @param deps - the control-owned marks, watch, registry, and aggregate reader.
 * @param signal - cancellation for the tree walks and aggregate.
 * @returns the native snapshot.
 */
export async function readSnapshot(
  deps: SnapshotDeps,
  signal?: AbortSignal,
): Promise<PauseSnapshot> {
  const sessions: Record<string, ParkStatus> = {}
  const walks = new Map<SessionId, TreeWalk>()
  await Promise.all([...deps.marks].map(async ([sessionId, mark]) => {
    const walk = await walkDescendants(deps.ctx, sessionId, signal)
    // The aggregate has its own blind-spot reading for a host with no subagent
    // service; sharing an empty walk would erase that fact.
    if (deps.ctx.get('subagents') !== undefined) walks.set(sessionId, walk)
    sessions[String(sessionId)] = await treeStatus(deps, sessionId, mark, signal, walk)
  }))
  return { global: await deps.readGlobal(signal, walks), sessions }
}
