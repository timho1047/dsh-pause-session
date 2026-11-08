/**
 * The session control the browser half drives: the pause verb, the park state
 * machine behind it, and the live state channel that accompanies both.
 *
 * The host exposes this control through the native Typert Remote namespace:
 * `observe` streams snapshots and `act` / `triage` / `decide` drive the UI. No
 * slash command is registered. Phase changes wake the Remote stream through a
 * local listener set; the durable registry remains the source of truth for what
 * the snapshot reports.
 * @module dsh-pause-session/control
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: the optional `ctx.sessionPersistence` observation seam.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { PauseGate } from './gate.js'
import { isResumableSession } from './composition.js'
import { mountGlobalPause } from './global.js'
import type { GlobalPause } from './global.js'
import type { ParkWatch } from './park.js'
import type { ParkRegistry } from './registry.js'
import { installResumePath, NOT_PARKED_TEXT } from './resume.js'
import type { ReleaseTreeOutcome, ResumeAttempt, ResumeOptions, ResumePath } from './resume.js'
import { mountTriageList } from './triage.js'
import type { TriageListService } from './triage.js'
import type { TriageAction } from './shared.js'
import { describeError, UNRECORDED_TEXT } from './shared.js'
import type { ParkPhase, PauseSnapshot, TriageList } from './shared.js'
import { readSnapshot as readSnapshotOf } from './snapshot.js'
import { installParkState } from './park-state.js'
import { walkDescendants } from './tree.js'
import type { PauseAnswer } from './shared.js'

/**
 * Whether this host can read one recorded session at all — a live session, or a
 * stored log the persistence backend can observe.
 * @param ctx - host context carrying the session store and the optional persistence service.
 * @param sessionId - the recorded session to look for.
 * @returns whether the session can be acted on here.
 */
async function sessionReadable(ctx: Context, sessionId: SessionId): Promise<boolean> {
  if (ctx.sessions.get(sessionId) !== undefined) return true
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return false
  try {
    return await persistence.stat(sessionId) !== undefined
  } catch (error: unknown) {
    ctx.logger.warn(`pause: could not look for the stored log of "${sessionId}": ${describeError(error)}`)
    return false
  }
}

/** What one tree-wide press registered, and what it could not. */
export interface PressTreeOutcome {
  /** How many sessions this press covered: the session plus its descendants. */
  readonly members: number
  /** How many of them now have a durable park record behind them. */
  readonly registered: number
  /** Whether the pressed session itself is one of them. */
  readonly rootRegistered: boolean
  /** The members whose record could not be written; they are not paused. */
  readonly unrecorded: readonly SessionId[]
  /** Whether any branch was unread, so the subagent tree was not fully covered. */
  readonly unread: boolean
  /** Tree members on a one-shot or unreadable route; they were not registered. */
  readonly unresumable: readonly SessionId[]
  /** Branch ids the tree walk could not read. */
  readonly unreadBranches: readonly SessionId[]
}

/** What mounting the session control hands back to the plugin entry. */
export interface SessionControl {
  /**
   * Hold every session the registry remembers and can read, and publish the
   * marker for the ones that already have a live agent. Called once, right
   * after mount.
   */
  adopt(): Promise<void>
  /**
   * Read the whole app and every live paused session as one JSON-safe snapshot.
   * The native snapshot serves this; it never enters a Session log.
   * @param signal - cancellation for the tree reads this snapshot performs.
   * @returns the whole-app verdict and the paused sessions this process holds.
   */
  readSnapshot(signal?: AbortSignal): Promise<PauseSnapshot>
  /** Wake a listener after any visible status change. */
  subscribe(listener: () => void): () => void
  /** Press one Session tree. */
  pressTree(sessionId: SessionId, signal?: AbortSignal): Promise<PressTreeOutcome>
  /** Release one Session's registered tree. */
  releaseTree(sessionId: SessionId, signal?: AbortSignal): Promise<ReleaseTreeOutcome>
  /** Press every running Session tree. */
  pauseAll(signal?: AbortSignal): Promise<PauseAnswer>
  /** Resume every cleanly paused Session. */
  resumeAll(signal?: AbortSignal): Promise<PauseAnswer>
  /** Release every registered tree, cancelling a press that is still draining. */
  cancelAll(signal?: AbortSignal): Promise<PauseAnswer>
  /** Flip one Session's goal re-arm opt-out. */
  toggleGoal(sessionId: SessionId, signal?: AbortSignal): Promise<PauseAnswer>
  /** Read the morning list for one calling Session. */
  readTriage(caller: SessionId, signal?: AbortSignal): Promise<TriageList>
  /** Take one listed decision for one calling Session. */
  decideTriage(
    caller: SessionId,
    target: SessionId,
    action: TriageAction,
    signal?: AbortSignal,
  ): Promise<PauseAnswer>
}

/** How resuming all parked sessions answers the caller. */
export function summarizeResume(attempts: readonly ResumeAttempt[]): string {
  const resumed = attempts.filter(attempt => attempt.resumed).length
  const refused = attempts.length - resumed
  const head = resumed === 0
    ? 'pause resumed no session'
    : resumed === 1
      ? 'pause resumed 1 session from where it stopped'
      : `pause resumed ${resumed} sessions from where they stopped`
  if (refused === 0) return `${head}.`
  const unclean = attempts.filter(attempt => attempt.refusal === 'not-clean').length
  const rest = unclean === refused
    ? `${refused} did not pause completely and need your decision`
    : `${refused} could not be resumed`
  return `${head}; ${rest}.`
}

/**
 * Everything the session control needs from the composition: the clean resume
 * path's route knowledge, plus the bound the decision list reads each parked
 * log under.
 */
export interface SessionControlOptions extends ResumeOptions {
  /** Events of each stored log the decision list may fold per row; see `./coldlog.ts`. */
  readonly maxListedLogEvents?: number
}

/**
 * Contribute the session control: the pause verb, the per-session status read,
 * the global resume verb, and — for every paused session that has a live agent
 * — the resume marker.
 * @param ctx - host context carrying the agent store, the
 * session store, and the projection registry.
 * @param gate - the pause gate this control drives and reflects.
 * @param watch - the per-session activity fold the park predicate reads.
 * @param registry - the durable pause list every phase change is written to.
 * @param options - route knowledge the clean resume path needs, and the decision list's read bound.
 * @returns the mount-time adoption step and the morning resume path.
 */
export function installSessionControl(
  ctx: Context,
  gate: PauseGate,
  watch: ParkWatch,
  registry: ParkRegistry,
  options: SessionControlOptions,
): SessionControl {
  const park = installParkState(ctx, gate, registry, watch)

  /**
   * Press one session's pause and register its whole tree behind it.
   *
   * "One session's work" includes the subagents it delegated to, nested ones
   * included, and the user does not pause them one by one. So the press walks
   * the session's own catalog tree and gives every member the same durable
   * treatment the session gets: {@link press} registers what it can hold, and a
   * member whose record cannot be written is named here rather than counted as
   * paused.
   *
   * A tree the walk could not read is the one case where the press does less
   * than the tree: the session itself is still registered — the user pressed a
   * session, and its park is real — and the answer says the subagents were not
   * covered rather than counting a tree nobody read.
   * @param sessionId - the session whose tree the user pressed.
   * @returns which members are registered and which could not be.
   */
  const pressTree = async (sessionId: SessionId, signal?: AbortSignal): Promise<PressTreeOutcome> => {
    // Nothing live means nothing this press could hold; the check is also what
    // keeps a session disposed in the middle of a press on the path that
    // records the park point it reached.
    if (ctx.sessions.get(sessionId) === undefined) {
      return { members: 0, registered: 0, rootRegistered: false, unrecorded: [], unread: false, unresumable: [], unreadBranches: [] }
    }
    const walk = await walkDescendants(ctx, sessionId, signal)
    // A tree this press could not read is not a reason to drop the session
    // itself: the user pressed a session, and its own park is still real. What
    // is refused is the claim about the tree, which is why the count stays at
    // the one member this press actually covers.
    if (walk.unreadWhole) {
      const pressed = await park.press(sessionId, signal)
      // The look is unconditional on purpose only after a mark exists: a
      // session that left the store during this press has a mark and cannot be
      // flushed, which is the one way its park still reaches a durable "not
      // clean" instead of a phase that never settles.
      if (pressed === 'registered') park.look(sessionId)
      globalPause.markUnrecorded(sessionId, pressed === 'unrecordable')
      return {
        members: pressed === 'registered' ? 1 : 0,
        registered: pressed === 'registered' ? 1 : 0,
        rootRegistered: pressed === 'registered',
        unrecorded: pressed === 'unrecordable' ? [sessionId] : [],
        unread: true,
        unresumable: [],
        unreadBranches: [],
      }
    }
    const registered: SessionId[] = []
    const unrecorded: SessionId[] = []
    const unresumable = walk.members.filter(member => member.mode !== 'continuable').map(member => member.id)
    const unreadBranches = walk.unread.map(branch => branch.id)
    const members = walk.members.filter(member => member.mode === 'continuable')
    for (const id of [sessionId, ...members.map(member => member.id)]) {
      // The press is per member on purpose: one member that cannot be recorded
      // is named while the rest keep the pause they got. A member on a
      // one-shot or external route is never registered: there is no later
      // resume that could honestly satisfy that promise.
      const pressed = await park.press(id, signal, id !== sessionId)
      if (pressed === 'registered') {
        registered.push(id)
        // A member this host has nothing live for has no mark to walk; one that
        // does is looked at now, exactly as the session's own press looked at
        // itself.
        park.look(id)
      } else if (pressed === 'unrecordable') {
        unrecorded.push(id)
      }
      // The aggregate owns the same fact, so a member the registry refused is
      // named by the whole-app report too. A skipped member is not a failed
      // promise and is not named as one.
      globalPause.markUnrecorded(id, pressed === 'unrecordable')
    }
    return {
      members: registered.length + unrecorded.length,
      registered: registered.length,
      rootRegistered: registered.includes(sessionId),
      unrecorded,
      unread: unreadBranches.length > 0,
      unresumable,
      unreadBranches,
    }
  }

  // The resume verb, the global resume verb, and the goal opt-out ride one
  // path. It is mounted here because the release order and the marked origin
  // are this control's own facts.
  const resumePath: ResumePath = installResumePath(ctx, gate, registry, options, {
    release: park.release,
    adopted: sessionId => park.marks.get(sessionId)?.origin === 'registry',
  })

  // The decision list reads the same durable registry and acts through the same
  // resume path, so a session is on exactly one of the two morning paths: the
  // silent one when its record says `safe`, this one otherwise.
  const triage: TriageListService = mountTriageList(ctx, registry, resumePath, options.maxListedLogEvents)

  // The whole-app park reads the marks through this one accessor, so the
  // aggregate and the per-session control can never describe different states.
  const globalPause: GlobalPause = mountGlobalPause(ctx, watch, registry, {
    isPaused: sessionId => gate.isPaused(sessionId),
    press: park.press,
    look: park.look,
    live: park.live,
    unheld: () => park.unheld,
  })

  const readSnapshot = (signal?: AbortSignal): Promise<PauseSnapshot> =>
    readSnapshotOf({ ctx, marks: park.marks, watch, registry, readGlobal: globalPause.readState }, signal)

  // One effect owns the subscriptions and the mark cleanup. There is no
  // status is the Remote stream and actions are Remote methods.
  ctx.effect(function* () {
    yield gate.onChange(sessionId => { park.sync(sessionId) })
    yield gate.onHeld(sessionId => {
      queueMicrotask(() => { park.look(sessionId) })
    })
    yield watch.onChange(sessionId => { park.look(sessionId) })
    yield ctx.on('agent/created', ({ agent }) => {
      park.sync(agent.id)
      return undefined
    })
    yield async () => {
      park.cleanup()
    }
  }, 'pause: session events')

  return {
    readSnapshot,
    subscribe: park.subscribe,
    pressTree: async (sessionId, signal) => await pressTree(sessionId, signal),
    releaseTree: async (sessionId, signal) => await resumePath.releaseTree(sessionId, signal),
    pauseAll: async (signal) => {
      const answer = await globalPause.pressAll(signal)
      park.notify()
      return answer
    },
    cancelAll: async (signal) => {
      const outcomes = []
      // A tree can mix a clean member with a press that is still draining. The
      // clean release then resumes the clean member and keeps the draining one;
      // repeat so the remaining all-unclean tree can take the cancel path.
      for (let round = 0; round < 3; round += 1) {
        const before = registry.parked.size
        for (const sessionId of [...registry.parked.keys()]) {
          signal?.throwIfAborted()
          outcomes.push((await resumePath.releaseTree(sessionId, signal)).answer)
        }
        if (registry.parked.size === before) break
      }
      park.notify()
      const failed = outcomes.filter(answer => answer.kind === 'error')
      return failed.length === 0
        ? { kind: 'success', text: 'Every pause was released.' }
        : { kind: 'error', text: failed.map(answer => answer.text).join(' ') }
    },
    resumeAll: async (signal) => {
      const answer = { kind: 'success' as const, text: summarizeResume(await resumePath.resumeParked(signal)) }
      park.notify()
      return answer
    },
    toggleGoal: async (sessionId) => {
      const record = registry.get(sessionId)
      if (record === undefined) return { kind: 'error', text: NOT_PARKED_TEXT }
      const answer = await resumePath.setRearmGoal(sessionId, !record.rearmGoal)
      park.notify()
      return answer
    },
    readTriage: async (caller, signal) => await triage.read(caller, signal),
    decideTriage: async (caller, target, action, signal) => {
      const answer = await triage.decide(caller, target, action, signal)
      park.notify()
      return answer
    },
    adopt: async () => {
      for (const entry of registry.list()) {
        // Every registered session this host can read is held again, whether or
        // not anything is live: the request that wakes it is the one this gate
        // must catch, and the wake-up may come from a scheduled task or a
        // webhook long after this mount. A record whose session cannot be read
        // is not held — the id would be pinned with nothing behind it and no
        // verb could ever clear it — and is reported instead.
        if (!await sessionReadable(ctx, entry.sessionId)) {
          park.unheld.add(entry.sessionId)
          ctx.logger.warn(`pause: the pause recorded for "${entry.sessionId}" is not held:`
            + ' this host cannot read that session')
          continue
        }
        if (gate.pause(entry.sessionId)) park.adopt(entry.sessionId, entry.phase)
      }
      // A session that was already live when this instance mounted still owes
      // the browser the marker: the registry holds the list, and nothing else
      // re-publishes it for agents that predate this mount.
      for (const agent of ctx.agents.list()) park.sync(agent.id)
    },
  }
}
