/**
 * The session control the browser half drives: the pause verb, the park state
 * machine behind it, and the live state channel that accompanies both.
 *
 * A third-party plugin can add neither a `ctx.remote` namespace nor a forwarded
 * event: the Client's Remote namespaces and the forwarded-event allowlist are
 * compiled into the harness's own API assembly. The documented Client-callable
 * Host entry point is therefore a session command run through
 * `ctx.remote.commands.execute`, and the one live channel such a plugin can
 * publish through is the command registry itself — `commands/change` is a
 * forwarded event, and `commands.list(sessionId)` is a Client-callable read.
 *
 * So the resume definition IS the paused marker: it is registered on a paused
 * session's own agent context and removed on resume, and the browser half reads
 * "paused" from that registration rather than inventing it. A descriptor cannot
 * change after registration, so the park state rides a companion status
 * definition (registered beside the marker, answered by calling it) whose
 * description is re-derived on every read — see `./shared.ts`.
 *
 * A mark is not a park. A session is parked only once nothing is left to drain:
 * no call in flight AND either its next model request is held at the gate or no
 * turn is open at all (there will be no next request to hold). Only then is the
 * session flushed, at the session level — `SessionHandle.flush()` does not
 * drain the routed live buffer, so it would record a park that a crash erases.
 * The "safe to close" phase appears only after that flush resolves.
 *
 * Every phase a pause reaches is written to the durable registry before it is
 * published — including the move into `parking`, which the status command may
 * therefore never serve ahead of the record. A restart re-holds exactly the
 * sessions the last process left parked, and a phase that could not be recorded
 * is never shown as cleaner than the record says.
 *
 * A park verb changes state, so it acts only on a person's command: a command
 * dispatched from inside a model turn is refused. The listed verbs add the
 * one binding their target needs — the row must be one the calling session was
 * shown — and that rule lives with the list (`./triage.ts`).
 * @module dsh-safe-stop/control
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: the optional `ctx.sessionPersistence` observation seam.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { PauseGate } from './gate.js'
import { mountGlobalStop } from './global.js'
import type { GlobalStop, LivePark } from './global.js'
import type { ParkWatch } from './park.js'
import type { ParkRegistry } from './registry.js'
import { installResumePath } from './resume.js'
import type { ResumeAttempt, ResumeOptions, ResumePath } from './resume.js'
import { mountTriageList } from './triage.js'
import type { TriageListService } from './triage.js'
import { TRIAGE_NOT_LISTED_TEXT } from './triage.js'
import type { TriageAction } from './shared.js'
import {
  describeError, encodeParkStatus, encodeTriageList, PAUSE_COMMAND, PAUSE_DEFINITION_ID, RESUME_ALL_COMMAND,
  RESUME_ALL_DEFINITION_ID, RESUME_COMMAND, RESUME_DEFINITION_ID, STATE_ALL_COMMAND, STATE_ALL_DEFINITION_ID,
  STATUS_COMMAND, STATUS_DEFINITION_ID, STOP_ALL_COMMAND, STOP_ALL_DEFINITION_ID, TRIAGE_COMMAND,
  TRIAGE_CONTINUE_COMMAND, TRIAGE_CONTINUE_DEFINITION_ID, TRIAGE_DEFINITION_ID, TRIAGE_GOAL_COMMAND,
  TRIAGE_GOAL_DEFINITION_ID, TRIAGE_LEAVE_COMMAND, TRIAGE_LEAVE_DEFINITION_ID, TRIAGE_NOTE_COMMAND,
  TRIAGE_NOTE_DEFINITION_ID, TRIAGE_REVIEW_COMMAND, TRIAGE_REVIEW_DEFINITION_ID,
} from './shared.js'
import type { ParkPhase, ParkStatus } from './shared.js'

/** Result copy for a session that just reached the pause point; the model never sees it. */
const PAUSED_TEXT = 'This session is paused. It stops once the work in flight drains.'
  + ' Press again to cancel the pause.'

/** Result copy for a press or a release the durable registry refused to record. */
const UNRECORDED_TEXT = 'safe-stop could not write the pause registry, so it did not change the pause state.'

/**
 * Result copy for a state-changing park verb issued from inside a model turn.
 * The invocation carries no origin of its own, so this refusal is the plugin's
 * own reading of the one signal that separates a person's command from a
 * model's.
 */
export const UNATTENDED_TEXT = 'safe-stop did not act: this command came from inside a model turn,'
  + ' and the park verbs act only on a person\'s command.'

/**
 * Whether a command is being dispatched from inside a model turn.
 *
 * A person's slash command reaches the registry through the Client's command
 * Remote with no model turn around it; the loop runs every model-driven step —
 * tool calls included — under its own initiator boundary. The invocation itself
 * carries no origin: `command/run` records a constant `{ kind: 'user' }` source
 * for every executor caller. This is therefore the one signal available, and a
 * state-changing verb refuses when it says a model is driving.
 * @param ctx - host context carrying the agent store.
 * @returns whether a model turn is the initiator of this call.
 */
function modelIssued(ctx: Context): boolean {
  try {
    return ctx.agents.currentInitiator() !== undefined
  } catch {
    // The initiator scope is already disposed: this call belongs to teardown,
    // where refusing is the direction that cannot spend anyone's money.
    return true
  }
}

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
  // No persistence service means no stored session is readable here, which is
  // the same answer the decision list's own cold read gives.
  if (persistence === undefined) return false
  try {
    return await persistence.stat(sessionId) !== undefined
  } catch (error: unknown) {
    // A failing observation is not proof of absence, and dropping a park on a
    // guess is the one direction this control must not take.
    ctx.logger.warn(`safe-stop: could not look for the stored log of "${sessionId}": ${describeError(error)}`)
    return true
  }
}

/** One session's park in progress. */
interface ParkMark {
  /**
   * The phase the durable registry confirms for this session — the only phase
   * ever published. `draining` is the state a press creates; the first moment
   * nothing is left to drain moves it to `parking`, and the session-level flush
   * resolves it to `safe` — or to `flush-failed`, which must never be reported
   * as clean. It is written by `commit` and by nothing else, so the answer the
   * status command serves can never run ahead of what is on disk.
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

/** The status one mark reports right now. */
function statusOf(mark: ParkMark, runningTools: readonly string[]): ParkStatus {
  switch (mark.phase) {
    case 'draining':
      return { phase: 'draining', safe: false, runningTools }
    case 'parking':
      return { phase: 'parking', safe: false, runningTools: [] }
    case 'safe':
      return { phase: 'safe', safe: true, runningTools: [] }
    case 'flush-failed':
      return { phase: 'flush-failed', safe: false, runningTools: [] }
  }
}

/** What mounting the session control hands back to the plugin entry. */
export interface SessionControl {
  /**
   * Hold every session the registry remembers and can read, and publish the
   * marker for the ones that already have a live agent. Called once, right
   * after mount.
   */
  adopt(): Promise<void>
}

/** How resuming all parked sessions answers the command that asked for it. */
export function summarizeResume(attempts: readonly ResumeAttempt[]): string {
  const resumed = attempts.filter(attempt => attempt.resumed).length
  const refused = attempts.length - resumed
  const head = resumed === 0
    ? 'safe-stop resumed no session'
    : resumed === 1
      ? 'safe-stop resumed 1 session from where it stopped'
      : `safe-stop resumed ${resumed} sessions from where they stopped`
  if (refused === 0) return `${head}.`
  const unclean = attempts.filter(attempt => attempt.refusal === 'not-clean').length
  const rest = unclean === refused
    ? `${refused} did not stop cleanly and need your decision`
    : `${refused} could not be resumed`
  return `${head}; ${rest}.`
}

/**
 * Contribute the session control: the pause verb, the per-session status read,
 * the global resume verb, and — for every paused session that has a live agent
 * — the resume marker.
 * @param ctx - host context carrying the command registry, the agent store, the
 * session store, and the projection registry.
 * @param gate - the pause gate this control drives and reflects.
 * @param watch - the per-session activity fold the park predicate reads.
 * @param registry - the durable pause list every phase change is written to.
 * @param options - route knowledge the clean resume path's wake content needs.
 * @returns the mount-time adoption step and the morning resume path.
 */
export function installSessionControl(
  ctx: Context,
  gate: PauseGate,
  watch: ParkWatch,
  registry: ParkRegistry,
  options: ResumeOptions,
): SessionControl {
  /** Marks per paused session; presence here mirrors the gate's own membership. */
  const marks = new Map<SessionId, ParkMark>()
  /** Publish fibers per paused session; disposing one removes both commands. */
  const markers = new Map<SessionId, Fiber>()
  /**
   * Records this process did not hold again because the session behind them
   * cannot be read here. Nothing can be parked, released, or decided for them
   * from this process, so they are not marks — and the aggregate names them
   * instead of counting them among the sessions this park owns.
   */
  const unheld = new Set<SessionId>()
  /** Bumped by every mark and every cancel; a stale generation publishes nothing. */
  let generation = 0

  const drop = (sessionId: SessionId): void => {
    marks.delete(sessionId)
    const fiber = markers.get(sessionId)
    if (fiber === undefined) return
    markers.delete(sessionId)
    void Promise.resolve(fiber.dispose()).catch((error: unknown) => {
      ctx.logger.warn(`safe-stop: session control cleanup failed: ${describeError(error)}`)
    })
  }

  /**
   * Write one phase to the durable registry, then publish it on the mark.
   *
   * The order is the whole point: a phase is published only once a later
   * process would read it back. A failed write leaves the mark on its previous
   * phase, which is never cleaner than what the registry holds — the direction
   * that matters, because "safe to close" is a promise about surviving the
   * process, not about this process's memory.
   * @param sessionId - the paused session.
   * @param mark - its live mark, updated in place on success.
   * @param phase - the phase to record and publish.
   * @returns whether the phase became durable.
   */
  const commit = async (sessionId: SessionId, mark: ParkMark, phase: ParkPhase): Promise<boolean> => {
    try {
      await registry.record(sessionId, phase)
    } catch (error: unknown) {
      ctx.logger.warn(`safe-stop: could not record the park state of "${sessionId}" as ${phase}: ${describeError(error)}`)
      return false
    }
    mark.phase = phase
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
   * Ensure one paused session has both commands registered. Registration is
   * once per park: the status is answered by the command, not frozen into the
   * descriptor, so a phase change needs no command re-registration.
   */
  const publish = (sessionId: SessionId): void => {
    const mark = marks.get(sessionId)
    if (mark === undefined || markers.has(sessionId)) return
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) return
    const status = (): string => encodeParkStatus(statusOf(mark, watch.activity(sessionId).runningTools))
    // The registry keys scoped definitions off the context a call is made
    // through, and Cordis refuses an undeclared service access, so the marker
    // goes through a `commands`-injected child of THIS agent's context: the
    // scope layer is that agent, two sessions never collide, and agent
    // disposal removes the marker on its own.
    const fiber = agent.ctx.inject(['commands'], (scope) => {
      scope.commands.register({
        definitionId: CommandDefinitionId(RESUME_DEFINITION_ID),
        name: RESUME_COMMAND,
        description: 'Resume this paused Session',
        handler: async (invocation) => (modelIssued(ctx)
          ? { kind: 'error', text: UNATTENDED_TEXT }
          : (await resumePath.resumeSession(invocation.agent.id, { kind: 'silent' })).answer),
      })
      scope.commands.register({
        definitionId: CommandDefinitionId(STATUS_DEFINITION_ID),
        name: STATUS_COMMAND,
        description: status(),
        handler: () => ({ kind: 'success', text: status() }),
      })
    })
    markers.set(sessionId, fiber)
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
        await ctx.sessions.flush(session)
      } catch (error: unknown) {
        if (!owned()) return
        ctx.logger.warn(`safe-stop: flush failed for "${sessionId}": ${describeError(error)}`)
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
    publish(sessionId)
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
   * @returns whether the session is now paused, with a durable record behind it.
   */
  const press = async (sessionId: SessionId): Promise<boolean> => {
    if (ctx.sessions.get(sessionId) === undefined) return true
    if (!gate.pause(sessionId)) return true
    const mark: ParkMark = { phase: 'draining', generation: ++generation, origin: 'press', advancing: false }
    marks.set(sessionId, mark)
    if (await commit(sessionId, mark, 'draining')) {
      // Whatever this process could not hold earlier is moot now: the session
      // is live and the press owns it.
      unheld.delete(sessionId)
      return true
    }
    drop(sessionId)
    gate.resume(sessionId)
    return false
  }

  const sync = (sessionId: SessionId): void => {
    if (!gate.isPaused(sessionId)) {
      drop(sessionId)
      return
    }
    // A session paused before its agent existed (or one whose agent was
    // replaced) still owes the browser both commands.
    publish(sessionId)
  }

  /**
   * Take the pause back: the durable record goes first, so a process that dies
   * in between does not re-hold a session the user has already released. A
   * record that cannot be dropped leaves the session paused, which is the state
   * the registry still describes.
   */
  const release = async (sessionId: SessionId, text: string): Promise<CommandResult> => {
    if (!gate.isPaused(sessionId)) return { kind: 'success', text }
    try {
      await registry.forget(sessionId)
    } catch (error: unknown) {
      ctx.logger.warn(`safe-stop: could not drop "${sessionId}" from the pause registry: ${describeError(error)}`)
      return { kind: 'error', text: UNRECORDED_TEXT }
    }
    gate.resume(sessionId)
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
  const triage: TriageListService = mountTriageList(ctx, registry, resumePath)

  /**
   * The one handler the four decision verbs share. The list is addressed by
   * session like every other command on this channel, so the row the user
   * decided on travels as the command's own input. The calling session is what
   * makes that row a target: the list acts only on rows it published to this
   * caller, and never on a model's command.
   */
  const decide = (action: TriageAction) => async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (modelIssued(ctx)) return { kind: 'error', text: UNATTENDED_TEXT }
    const target = invocation.rawInput.trim()
    if (target.length === 0) return { kind: 'error', text: TRIAGE_NOT_LISTED_TEXT }
    return await triage.decide(invocation.agent.id, SessionId(target), action)
  }

  // The whole-app park reads the marks through this one accessor, so the
  // aggregate and the per-session control can never describe different states.
  const globalStop: GlobalStop = mountGlobalStop(ctx, watch, registry, {
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

  // One effect owns the whole surface: unloading removes the pause verb, the
  // resume verbs, the subscriptions, and every marker this plugin registered.
  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: CommandDefinitionId(PAUSE_DEFINITION_ID),
      name: PAUSE_COMMAND,
      description: 'Pause this Session before its next model request',
      handler: async (invocation) => {
        if (modelIssued(ctx)) return { kind: 'error', text: UNATTENDED_TEXT }
        const sessionId = invocation.agent.id
        if (!await press(sessionId)) return { kind: 'error', text: UNRECORDED_TEXT }
        // The press returns now: the drain happens while the user stays free to
        // walk away or press again to cancel it.
        look(sessionId)
        return { kind: 'success', text: PAUSED_TEXT }
      },
    })
    // Registered globally, so the morning path exists on any session the user
    // has open — the sessions it resumes have no live agent to carry a command
    // of their own yet.
    yield ctx.commands.register({
      definitionId: CommandDefinitionId(RESUME_ALL_DEFINITION_ID),
      name: RESUME_ALL_COMMAND,
      description: 'Resume every Session safe-stop parked',
      handler: async () => (modelIssued(ctx)
        ? { kind: 'error', text: UNATTENDED_TEXT }
        : { kind: 'success', text: summarizeResume(await resumePath.resumeParked()) }),
    })
    // The one-press whole-app park. Registered globally for the same reason:
    // the sessions it registers are the ones the user is not looking at.
    yield ctx.commands.register({
      definitionId: CommandDefinitionId(STOP_ALL_DEFINITION_ID),
      name: STOP_ALL_COMMAND,
      description: 'Pause every running Session and its subagents',
      handler: async () => (modelIssued(ctx) ? { kind: 'error', text: UNATTENDED_TEXT } : globalStop.pressAll()),
    })
    // The aggregate read behind the whole-app control. Its result carries the
    // state as of this read, which is what makes a moving park observable at
    // all — a descriptor cannot change after registration. A read changes no
    // state, so it is open to any caller.
    yield ctx.commands.register({
      definitionId: CommandDefinitionId(STATE_ALL_DEFINITION_ID),
      name: STATE_ALL_COMMAND,
      description: 'Report whether every parked Session is safe to close',
      handler: async () => globalStop.readStatus(),
    })
    // The morning decision list, and the four decisions it offers. All five are
    // registered globally for the same reason the whole-app verbs are: the
    // sessions they act on are the ones with no live agent to carry a command.
    // The decisions take the listed session as their input, because the command
    // channel is addressed by the session the user is typing on; the read
    // records what it showed that session, which is what the decisions act on.
    yield ctx.commands.register({
      definitionId: CommandDefinitionId(TRIAGE_DEFINITION_ID),
      name: TRIAGE_COMMAND,
      description: 'List every Session that did not stop cleanly',
      handler: async (invocation) => ({ kind: 'success', text: encodeTriageList(await triage.read(invocation.agent.id)) }),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId(TRIAGE_CONTINUE_DEFINITION_ID),
      name: TRIAGE_CONTINUE_COMMAND,
      description: 'Resume a listed Session: <session id>',
      handler: decide('continue'),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId(TRIAGE_NOTE_DEFINITION_ID),
      name: TRIAGE_NOTE_COMMAND,
      description: 'Resume a listed Session with a note that its tool outcome is unknown: <session id>',
      handler: decide('note'),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId(TRIAGE_REVIEW_DEFINITION_ID),
      name: TRIAGE_REVIEW_COMMAND,
      description: 'Open a listed Session for review without running it: <session id>',
      handler: decide('review'),
    })
    yield ctx.commands.register({
      definitionId: CommandDefinitionId(TRIAGE_LEAVE_DEFINITION_ID),
      name: TRIAGE_LEAVE_COMMAND,
      description: 'Leave a listed Session paused for today: <session id>',
      handler: decide('leave'),
    })
    // The one listed verb that is not a resume: it flips whether the next
    // resume of that session may re-open its goal, which is the only thing a
    // resume spends without the user watching it.
    yield ctx.commands.register({
      definitionId: CommandDefinitionId(TRIAGE_GOAL_DEFINITION_ID),
      name: TRIAGE_GOAL_COMMAND,
      description: 'Turn a listed Session\'s goal re-arm on or off: <session id>',
      handler: decide('goal'),
    })
    yield gate.onChange(sessionId => { sync(sessionId) })
    // A request arriving at (or leaving) the gate is the moment a session can
    // become parked. The notification lands inside the request path, so the
    // look is deferred to a clean stack.
    yield gate.onHeld(sessionId => {
      queueMicrotask(() => { look(sessionId) })
    })
    yield watch.onChange(sessionId => { look(sessionId) })
    // An agent created after its session was paused still owes the browser the
    // marker: a session keeps its pause across an agent replacement.
    yield ctx.on('agent/created', ({ agent }) => {
      sync(agent.id)
      return undefined
    })
    // The agent's own teardown already removed the marker registration; forget
    // the stale handle so a replacement agent can register its own.
    yield ctx.on('agent/disposed', ({ agent }) => {
      markers.delete(agent.id)
      return undefined
    })
    yield async () => {
      const pending = [...markers.values()].map(fiber => fiber.dispose())
      markers.clear()
      marks.clear()
      await Promise.all(pending)
    }
  }, 'safe-stop: session control')

  return {
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
          ctx.logger.warn(`safe-stop: the pause recorded for "${entry.sessionId}" is not held:`
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
        publish(entry.sessionId)
      }
      // A session that was already live when this instance mounted still owes
      // the browser the marker: the registry holds the list, and nothing else
      // re-publishes it for agents that predate this mount.
      for (const agent of ctx.agents.list()) sync(agent.id)
    },
  }
}
