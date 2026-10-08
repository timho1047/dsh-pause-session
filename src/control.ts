/**
 * The session control the browser half drives: the pause verb, the park state
 * machine behind it, and the live state channel that accompanies both.
 *
 * A third-party plugin can add neither a `ctx.remote` namespace nor a forwarded
 * event: the Client's Remote namespaces and the forwarded-event allowlist are
 * compiled into the harness's own API assembly. The documented Client-callable
 * Host entry point is therefore a session command run through
 * `ctx.remote.commands.execute` (plugin-development `references/user-actions.md`),
 * and the one live channel such a plugin can publish through is the command
 * registry itself — `commands/change` is a forwarded event, and
 * `commands.list(sessionId)` is a Client-callable read.
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
 * published, so a restart re-holds exactly the sessions the last process left
 * parked — and a phase that could not be recorded is never shown as cleaner
 * than the record says.
 * @module dsh-safe-stop/control
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PauseGate } from './gate.js'
import type { ParkWatch } from './park.js'
import type { ParkRegistry } from './registry.js'
import { installResumePath } from './resume.js'
import type { ResumeAttempt, ResumeOptions, ResumePath } from './resume.js'
import {
  encodeParkStatus, PAUSE_COMMAND, PAUSE_DEFINITION_ID, RESUME_ALL_COMMAND, RESUME_ALL_DEFINITION_ID,
  RESUME_COMMAND, RESUME_DEFINITION_ID, STATUS_COMMAND, STATUS_DEFINITION_ID,
} from './shared.js'
import type { ParkPhase, ParkStatus } from './shared.js'

/** Result copy for a session that just reached the pause point; the model never sees it. */
const PAUSED_TEXT = 'This session is paused. It stops once the work in flight drains.'
  + ' Press again to cancel the pause.'

/** Result copy for a press or a release the durable registry refused to record. */
const UNRECORDED_TEXT = 'safe-stop could not write the pause registry, so it did not change the pause state.'

/** One session's park in progress. */
interface ParkMark {
  /**
   * The only phase this machine walks forward through. `draining` is the state
   * a press creates; the first moment nothing is left to drain moves it to
   * `parking`, and the session-level flush resolves it to `safe` — or to
   * `flush-failed`, which must never be reported as clean.
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
   * Hold every session the registry remembers, and publish the marker for the
   * ones that already have a live agent. Called once, right after mount.
   */
  adopt(): Promise<void>
  /**
   * Resume every session the registry remembers, clean ones only — the morning
   * path when nothing is live yet. One session's failure never stops the rest.
   * @returns one attempt per recorded session, in registry order.
   */
  resumeParked(): Promise<readonly ResumeAttempt[]>
  /**
   * Record or clear one session's goal opt-out, for the control surface a later
   * task puts in front of it.
   * @param sessionId - the parked session to change.
   * @param rearmGoal - whether the clean resume path may re-arm its goal.
   * @returns the copy for whoever asked.
   */
  setRearmGoal(sessionId: SessionId, rearmGoal: boolean): Promise<CommandResult>
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
  /** Bumped by every mark and every cancel; a stale generation publishes nothing. */
  let generation = 0

  const drop = (sessionId: SessionId): void => {
    marks.delete(sessionId)
    const fiber = markers.get(sessionId)
    if (fiber === undefined) return
    markers.delete(sessionId)
    void Promise.resolve(fiber.dispose()).catch((error: unknown) => {
      ctx.logger.warn(`safe-stop: session control cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
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
      ctx.logger.warn(`safe-stop: could not record the park state of "${sessionId}" as ${phase}: ${error instanceof Error ? error.message : String(error)}`)
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
        handler: async (invocation) => (await resumePath.resumeSession(invocation.agent.id)).answer,
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
   * @param sessionId - the marked session to re-derive.
   * @returns whether this call moved the mark into `parking` (and so owes a flush).
   */
  const advance = (sessionId: SessionId): boolean => {
    const mark = marks.get(sessionId)
    if (mark === undefined || mark.phase !== 'draining') return false
    // An adopted mark reports the outcome of the episode that ended with the
    // previous process; this process may hold the session, but it does not get
    // to rewrite that outcome.
    if (mark.origin === 'registry') return false
    if (!parked(sessionId)) return false
    // Published now, recorded by `settle`: a mark that claims less than the
    // truth is the safe direction while the write is in flight.
    mark.phase = 'parking'
    return true
  }

  /**
   * Flush a parked session at the session level and publish what actually
   * happened. The flush is the promise that survives a crash: a handle's own
   * flush would leave the routed live buffer — the pending input — in memory.
   */
  const settle = async (sessionId: SessionId, attempt: number): Promise<void> => {
    const mark = marks.get(sessionId)
    if (mark === undefined || mark.generation !== attempt) return
    const session = ctx.sessions.get(sessionId)
    // Nothing live to flush: the session left the store, so there is no durable
    // promise left to keep either.
    if (session === undefined) {
      await commit(sessionId, mark, 'safe')
      return
    }
    // "Stopped, flush pending" is the state a crash during this flush leaves
    // behind, and it must be on disk before the flush starts.
    await commit(sessionId, mark, 'parking')
    if (mark.generation !== attempt) return
    try {
      await ctx.sessions.flush(session)
    } catch (error: unknown) {
      if (mark.generation !== attempt) return
      ctx.logger.warn(`safe-stop: flush failed for "${sessionId}": ${error instanceof Error ? error.message : String(error)}`)
      await commit(sessionId, mark, 'flush-failed')
      return
    }
    if (mark.generation !== attempt) return
    await commit(sessionId, mark, 'safe')
  }

  /** Look at one marked session and act on what it is doing. */
  const look = (sessionId: SessionId): void => {
    publish(sessionId)
    if (!advance(sessionId)) return
    const attempt = marks.get(sessionId)?.generation
    if (attempt !== undefined) void settle(sessionId, attempt)
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
      ctx.logger.warn(`safe-stop: could not drop "${sessionId}" from the pause registry: ${error instanceof Error ? error.message : String(error)}`)
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

  // One effect owns the whole surface: unloading removes the pause verb, the
  // resume verbs, the subscriptions, and every marker this plugin registered.
  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: CommandDefinitionId(PAUSE_DEFINITION_ID),
      name: PAUSE_COMMAND,
      description: 'Pause this Session before its next model request',
      handler: async (invocation) => {
        const sessionId = invocation.agent.id
        if (gate.pause(sessionId)) {
          const mark: ParkMark = { phase: 'draining', generation: ++generation, origin: 'press' }
          marks.set(sessionId, mark)
          // The press IS a durable promise: a pause that cannot be recorded is
          // taken back here rather than left as one a restart silently forgets.
          if (!await commit(sessionId, mark, 'draining')) {
            drop(sessionId)
            gate.resume(sessionId)
            return { kind: 'error', text: UNRECORDED_TEXT }
          }
        }
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
      handler: async () => ({ kind: 'success', text: summarizeResume(await resumePath.resumeParked()) }),
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
        // Every registered session is held again, whether or not anything is
        // live: the request that wakes it is the one this gate must catch, and
        // the wake-up may come from a scheduled task or a webhook long after
        // this mount.
        if (gate.pause(entry.sessionId)) {
          marks.set(entry.sessionId, { phase: entry.phase, generation: ++generation, origin: 'registry' })
        }
        publish(entry.sessionId)
      }
      // A session that was already live when this instance mounted still owes
      // the browser the marker: the registry holds the list, and nothing else
      // re-publishes it for agents that predate this mount.
      for (const agent of ctx.agents.list()) sync(agent.id)
    },
    resumeParked: () => resumePath.resumeParked(),
    setRearmGoal: (sessionId, rearmGoal) => resumePath.setRearmGoal(sessionId, rearmGoal),
  }
}
