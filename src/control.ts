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
import type { GlobalPause, LivePark, PressResult } from './global.js'
import type { ParkWatch } from './park.js'
import type { ParkRegistry } from './registry.js'
import { installResumePath, NOT_PARKED_TEXT } from './resume.js'
import type { ReleaseTreeOutcome, ResumeAttempt, ResumeOptions, ResumePath } from './resume.js'
import { mountTriageList } from './triage.js'
import type { TriageListService } from './triage.js'
import type { TriageAction } from './shared.js'
import { describeError, foldTreePhases, UNRECORDED_TEXT } from './shared.js'
import type { ParkPhase, ParkStatus, PauseSnapshot, TriageList } from './shared.js'
import { walkDescendants } from './tree.js'
import type { TreeWalk } from './tree.js'
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

/** One session's park in progress. */
interface ParkMark {
  /**
   * The phase the durable registry confirms for this session — the only phase
   * ever published. `draining` is the state a press creates; the first moment
   * nothing is left to drain moves it to `parking`, and the session-level flush
   * resolves it to `safe` — or to `flush-failed`, which must never be reported
   * as clean. It is written by `commit` and by nothing else, so the answer the
   * snapshot serves can never run ahead of what is on disk.
   */
  phase: ParkPhase
  /**
   * Whether this attempt still owns its mark. Cancelling during the drain bumps
   * the generation, so the flush that lands afterwards cannot publish a state
   * for a session the user has already returned to normal.
   */
  generation: number
  /**
   * Where this mark came from. A `press` mark walks the park machine forward in
   * this process. A `registry` mark is the durable outcome of an earlier park
   * episode, adopted at mount so the session is held again: it never advances,
   * because a flush this process runs cannot testify about how the session
   * stopped before it started, and re-deriving one would turn last night's
   * unclean entry into a false "clean".
   */
  origin: 'press' | 'registry'
  /**
   * Whether a move out of `draining` is already in flight. The mark keeps
   * answering with its last durable phase until that write lands, and the flag
   * keeps a second look from starting a second flush for the same park.
   */
  advancing: boolean
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
  /** Marks per paused session; presence here mirrors the gate's own membership. */
  const marks = new Map<SessionId, ParkMark>()
  /** Host listeners the native Remote stream wakes after a visible change. */
  const listeners = new Set<() => void>()
  let notification: ReturnType<typeof setTimeout> | undefined
  // One snapshot per burst of host changes, not one per phase write. A pause-all
  // can touch many sessions in one pass; the stream only needs the last state.
  const notify = (): void => {
    if (notification !== undefined) return
    notification = setTimeout(() => {
      notification = undefined
      for (const listener of [...listeners]) listener()
    }, 20)
  }
  /**
   * Records this process did not hold again because the session behind them
   * cannot be read here. Nothing can be parked, released, or decided for them
   * from this process, so they are not marks — and the aggregate names them
   * instead of counting them among the sessions this park owns.
   */
  const unheld = new Set<SessionId>()
  /**
   * Sessions a press of this process tried to register and the registry
   * refused. They are running, unmarked, and invisible to the live accessor,
   * so this is the only thing that keeps the aggregate from quietly omitting
   * them; see {@link GlobalPause.markUnrecorded}.
   */
  const unrecorded = new Set<SessionId>()
  /** Bumped by every mark and every cancel; a stale generation publishes nothing. */
  let generation = 0

  const drop = (sessionId: SessionId): void => {
    marks.delete(sessionId)
    notify()
  }

  /**
   * Write one phase to the durable registry, then publish it on the mark and
   * wake the native stream.
   *
   * The order is the whole point: a phase is published only once a later
   * process would read it back. A failed write leaves the mark on its previous
   * phase, which is never cleaner than what the registry holds — the direction
   * that matters, because "safe to close" is a promise about surviving the
   * process, not about this process's memory.
   *
   * A phase that actually changed is also the moment every client is owed a
   * fresh read: the announcement is what carries `parking` → `safe` out of this
   * process, since the flush that resolves it changes no registration by
   * itself. Announcing only on a change is also what keeps the channel quiet —
   * a write that repeats the phase a mark already holds tells a reader nothing,
   * so it must not cost one.
   * @param sessionId - the paused session.
   * @param mark - its live mark, updated in place on success.
   * @param phase - the phase to record and publish.
   * @returns whether the phase became durable.
   */
  const commit = async (sessionId: SessionId, mark: ParkMark, phase: ParkPhase): Promise<boolean> => {
    try {
      await registry.record(sessionId, phase)
    } catch (error: unknown) {
      ctx.logger.warn(`pause: could not record the park state of "${sessionId}" as ${phase}: ${describeError(error)}`)
      return false
    }
    const changed = mark.phase !== phase
    mark.phase = phase
    if (changed) notify()
    return true
  }

  /** Whether this session is standing still at the park point. */
  const parked = (sessionId: SessionId): boolean => {
    const activity = watch.activity(sessionId)
    if (activity.runningTools.length > 0) return false
    // A held request IS the safe point: the previous step drained and the loop
    // is waiting on this very gate. With no turn open there is no next request
    // to hold, so the session is standing still there too.
    return gate.isHeld(sessionId) || !activity.turnOpen
  }

  /**
   * The phase a durable record holds for one session right now, whether or not
   * this process holds it. A member whose session this host cannot read still
   * has a record, and that record is the only thing anyone knows about it.
   */
  const recordedPhase = (sessionId: SessionId): ParkPhase | undefined =>
    marks.get(sessionId)?.phase ?? registry.get(sessionId)?.phase

  /**
   * The state this session's header reports: the worst phase among the members
   * the session's own press registered, folded with the session's own.
   *
   * The control speaks for a tree, so it may not say "safe to close" while a
   * member of that tree is still draining, stalled, or not readable — the user
   * would close the lid on work this press started. A branch the walk could not
   * read may hold a member nobody can see, so an unread branch counts as
   * unfinished rather than as empty.
   * @param mark - the session's own mark, whose phase the fold starts from.
   * @returns the phase to publish and the goal opt-out that rides beside it.
   */
  const treeStatus = async (
    sessionId: SessionId,
    mark: ParkMark,
    signal?: AbortSignal,
    knownWalk?: TreeWalk,
  ): Promise<ParkStatus> => {
    const walk = knownWalk ?? await walkDescendants(ctx, sessionId, signal)
    const phases: ParkPhase[] = [mark.phase]
    const extraRunning: string[] = []
    for (const member of walk.members) {
      const phase = recordedPhase(member.id)
      if (phase !== undefined) {
        phases.push(phase)
        continue
      }
      // A member this press could not register (one-shot/external route) is
      // still part of the tree. If it is doing work, the tree is not safe.
      if (member.mode !== 'continuable') {
        const activity = watch.activity(member.id)
        if (activity.turnOpen || activity.runningTools.length > 0) {
          phases.push('draining')
          extraRunning.push(...activity.runningTools)
        }
      }
    }
    // An unread branch: unknown is not clean, and it is not a settled state
    // either, so it folds in as the phase a member would report between the
    // park point and the flush.
    for (let at = 0; at < walk.unread.length + (walk.unreadWhole ? 1 : 0); at += 1) phases.push('parking')

    const folded = foldTreePhases(phases)
    const runningTools = [
      ...(mark.phase === 'draining' ? watch.activity(sessionId).runningTools : []),
      ...walk.members.flatMap(member => recordedPhase(member.id) === 'draining' ? watch.activity(member.id).runningTools : []),
      ...extraRunning,
    ]
    // The goal opt-out is the session's own record's, never a member's: the
    // switch beside this marker names the session it changes.
    const record = registry.get(sessionId)
    return {
      phase: folded.phase,
      safe: folded.safe,
      runningTools,
      ...record === undefined ? {} : { rearmGoal: record.rearmGoal },
    }
  }

    /**
   * Walk one session's mark as far forward as its current activity allows.
   *
   * The move is published by `settle`, once the write that makes `parking`
   * durable has resolved; until then the mark keeps answering with `draining`,
   * which is less than the truth rather than more than the record can back.
   * @param sessionId - the marked session to re-derive.
   * @returns whether this call moved the mark out of `draining` (and so owes a flush).
   */
  const advance = (sessionId: SessionId): boolean => {
    const mark = marks.get(sessionId)
    if (mark === undefined || mark.phase !== 'draining' || mark.advancing) return false
    // An adopted mark reports the outcome of the episode that ended with the
    // previous process; this process may hold the session, but it does not get
    // to rewrite that outcome.
    if (mark.origin === 'registry') return false
    if (!parked(sessionId)) return false
    mark.advancing = true
    return true
  }

  /**
   * Flush a parked session at the session level and publish what actually
   * happened.
   *
   * The flush is the promise that survives a crash: a handle's own flush would
   * leave the routed live buffer — the pending input — in memory. `safe` is
   * therefore reserved for a flush this process ran and that resolved; a
   * session that is no longer in the store cannot be flushed at all, so its
   * park stops at the phase that says the flush never happened.
   */
  const settle = async (sessionId: SessionId, attempt: number): Promise<void> => {
    const mark = marks.get(sessionId)
    if (mark === undefined || mark.generation !== attempt) return
    /** Whether this attempt still owns the mark: a cancel or a newer press replaces or drops it. */
    const owned = (): boolean => marks.get(sessionId) === mark && mark.generation === attempt
    const session = ctx.sessions.get(sessionId)
    try {
      if (session === undefined) {
        // Nothing live to flush. The park point was reached and nothing about
        // this session is in memory, but no session-level flush can be run for
        // it either — so this process cannot call it clean.
        await commit(sessionId, mark, 'parking')
        return
      }
      // "Stopped, flush pending" is the state a crash during this flush leaves
      // behind, and it must be on disk before the flush starts.
      await commit(sessionId, mark, 'parking')
      if (!owned()) return
      try {
        const flushed = await ctx.sessions.flush(session)
        if (!flushed) {
          await commit(sessionId, mark, 'flush-failed')
          return
        }
      } catch (error: unknown) {
        if (!owned()) return
        ctx.logger.warn(`pause: flush failed for "${sessionId}": ${describeError(error)}`)
        await commit(sessionId, mark, 'flush-failed')
        return
      }
      if (!owned()) return
      await commit(sessionId, mark, 'safe')
    } finally {
      // A later look may retry a park whose phase write failed; a mark that got
      // past `draining` is not advanced again whatever happened here.
      if (marks.get(sessionId) === mark && mark.phase === 'draining') mark.advancing = false
    }
  }

  /** Look at one marked session and act on what it is doing. */
  const look = (sessionId: SessionId): void => {
    if (marks.has(sessionId)) notify()
    if (!advance(sessionId)) return
    const attempt = marks.get(sessionId)?.generation
    if (attempt !== undefined) void settle(sessionId, attempt)
  }

  /**
   * Press one session's pause and make it durable.
   *
   * The press IS a durable promise: a pause that cannot be recorded is taken
   * back here rather than left as one a restart silently forgets. A session a
   * pause already owns is left exactly where it is — including one adopted
   * from an earlier process, whose outcome is not this process's to re-derive.
   *
   * A session with nothing live is left alone entirely. It has no request to
   * hold and no session-level flush to run, so a record for it could only be
   * one of two lies: `safe`, a park that never happened but that the clean path
   * would silently resume, or a phase that never settles, which would keep
   * "safe to close" from ever appearing. Registering the running tree therefore
   * means registering the members a pause can actually hold and flush.
   * @param sessionId - the session to pause.
   * @param signal - cancellation for the resumability read and registry write.
   * @param knownResumable - whether the caller already proved the local route is
   * `continuable` from the parent catalog, avoiding a second Session read.
   * @returns what the press did; only `registered` created a new park.
   */
  const press = async (
    sessionId: SessionId,
    signal?: AbortSignal,
    knownResumable = false,
  ): Promise<PressResult> => {
    if (ctx.sessions.get(sessionId) === undefined) return 'not-live'
    if (!knownResumable && !await isResumableSession(ctx, sessionId, signal)) return 'not-resumable'
    if (!gate.pause(sessionId)) return 'already-paused'
    const mark: ParkMark = { phase: 'draining', generation: ++generation, origin: 'press', advancing: false }
    marks.set(sessionId, mark)
    if (await commit(sessionId, mark, 'draining')) {
      // Whatever this process could not hold earlier is moot now: the session
      // is live and the press owns it.
      unheld.delete(sessionId)
      notify()
      return 'registered'
    }
    drop(sessionId)
    gate.resume(sessionId)
    return 'unrecordable'
  }

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
      const pressed = await press(sessionId, signal)
      // The look is unconditional on purpose only after a mark exists: a
      // session that left the store during this press has a mark and cannot be
      // flushed, which is the one way its park still reaches a durable "not
      // clean" instead of a phase that never settles.
      if (pressed === 'registered') look(sessionId)
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
      const pressed = await press(id, signal, id !== sessionId)
      if (pressed === 'registered') {
        registered.push(id)
        // A member this host has nothing live for has no mark to walk; one that
        // does is looked at now, exactly as the session's own press looked at
        // itself.
        look(id)
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

  const sync = (sessionId: SessionId): void => {
    if (!gate.isPaused(sessionId)) {
      drop(sessionId)
      return
    }
    // A session paused before its agent existed (or one whose agent was
    // replaced) is still represented by the native snapshot.
  }

  /**
   * Take the pause back: the durable record goes first, so a process that dies
   * in between does not re-hold a session the user has already released. A
   * record that cannot be dropped leaves the session paused, which is the state
   * the registry still describes.
   */
  const release = async (sessionId: SessionId, text: string): Promise<PauseAnswer> => {
    if (!gate.isPaused(sessionId)) return { kind: 'success', text }
    try {
      await registry.forget(sessionId)
    } catch (error: unknown) {
      ctx.logger.warn(`pause: could not drop "${sessionId}" from the pause registry: ${describeError(error)}`)
      return { kind: 'error', text: UNRECORDED_TEXT }
    }
    gate.resume(sessionId)
    notify()
    return { kind: 'success', text }
  }

  // The resume verb, the global resume verb, and the goal opt-out ride one
  // path. It is mounted here because the release order and the marked origin
  // are this control's own facts.
  const resumePath: ResumePath = installResumePath(ctx, gate, registry, options, {
    release,
    adopted: sessionId => marks.get(sessionId)?.origin === 'registry',
  })

  // The decision list reads the same durable registry and acts through the same
  // resume path, so a session is on exactly one of the two morning paths: the
  // silent one when its record says `safe`, this one otherwise.
  const triage: TriageListService = mountTriageList(ctx, registry, resumePath, options.maxListedLogEvents)

  // The whole-app park reads the marks through this one accessor, so the
  // aggregate and the per-session control can never describe different states.
  const globalPause: GlobalPause = mountGlobalPause(ctx, watch, registry, {
    isPaused: sessionId => gate.isPaused(sessionId),
    press,
    look,
    live: () => new Map<SessionId, LivePark>([...marks].map(([sessionId, mark]) => [sessionId, {
      phase: mark.phase,
      // An adopted mark reports the outcome of the episode that ended with the
      // previous process, and a failed flush is already final: neither walks
      // any further here. Neither does a session that left the store — there is
      // no flush left to run for it, so it will not finish in this process.
      moving: mark.origin === 'press' && mark.phase !== 'flush-failed' && ctx.sessions.get(sessionId) !== undefined,
    }])),
    unheld: () => unheld,
  })

  /**
   * Read the whole app and every live paused session in one pass. The browser
   * native snapshot is the only caller; reading it writes nothing into a
   * Session's log.
   * @param signal - cancellation for the tree walks and the whole-app read.
   * @returns the JSON-safe snapshot.
   */
  const readSnapshot = async (signal?: AbortSignal): Promise<PauseSnapshot> => {
    const sessions: Record<string, ParkStatus> = {}
    const walks = new Map<SessionId, TreeWalk>()
    await Promise.all([...marks].map(async ([sessionId, mark]) => {
      const walk = await walkDescendants(ctx, sessionId, signal)
      // The aggregate has its own blind-spot reading for a host with no
      // subagent service; sharing an empty walk would erase that fact.
      if (ctx.get('subagents') !== undefined) walks.set(sessionId, walk)
      sessions[String(sessionId)] = await treeStatus(sessionId, mark, signal, walk)
    }))
    return { global: await globalPause.readState(signal, walks), sessions }
  }

  // One effect owns the subscriptions and the mark cleanup. There is no
  // status is the Remote stream and actions are Remote methods.
  ctx.effect(function* () {
    yield gate.onChange(sessionId => { sync(sessionId) })
    yield gate.onHeld(sessionId => {
      queueMicrotask(() => { look(sessionId) })
    })
    yield watch.onChange(sessionId => { look(sessionId) })
    yield ctx.on('agent/created', ({ agent }) => {
      sync(agent.id)
      return undefined
    })
    yield async () => {
      if (notification !== undefined) clearTimeout(notification)
      marks.clear()
    }
  }, 'pause: session events')

  return {
    readSnapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    pressTree: async (sessionId, signal) => await pressTree(sessionId, signal),
    releaseTree: async (sessionId, signal) => await resumePath.releaseTree(sessionId, signal),
    pauseAll: async (signal) => {
      const answer = await globalPause.pressAll(signal)
      notify()
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
      notify()
      const failed = outcomes.filter(answer => answer.kind === 'error')
      return failed.length === 0
        ? { kind: 'success', text: 'Every pause was released.' }
        : { kind: 'error', text: failed.map(answer => answer.text).join(' ') }
    },
    resumeAll: async (signal) => {
      const answer = { kind: 'success' as const, text: summarizeResume(await resumePath.resumeParked(signal)) }
      notify()
      return answer
    },
    toggleGoal: async (sessionId) => {
      const record = registry.get(sessionId)
      if (record === undefined) return { kind: 'error', text: NOT_PARKED_TEXT }
      const answer = await resumePath.setRearmGoal(sessionId, !record.rearmGoal)
      notify()
      return answer
    },
    readTriage: async (caller, signal) => await triage.read(caller, signal),
    decideTriage: async (caller, target, action, signal) => {
      const answer = await triage.decide(caller, target, action, signal)
      notify()
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
          unheld.add(entry.sessionId)
          ctx.logger.warn(`pause: the pause recorded for "${entry.sessionId}" is not held:`
            + ' this host cannot read that session')
          continue
        }
        if (gate.pause(entry.sessionId)) {
          marks.set(entry.sessionId, {
            phase: entry.phase,
            generation: ++generation,
            origin: 'registry',
            advancing: false,
          })
        }
      }
      // A session that was already live when this instance mounted still owes
      // the browser the marker: the registry holds the list, and nothing else
      // re-publishes it for agents that predate this mount.
      for (const agent of ctx.agents.list()) sync(agent.id)
    },
  }
}
