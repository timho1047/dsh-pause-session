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
 * @module dsh-safe-stop/control
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type {} from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PauseGate } from './gate.js'
import type { ParkWatch } from './park.js'
import {
  encodeParkStatus, PAUSE_COMMAND, PAUSE_DEFINITION_ID, RESUME_COMMAND, RESUME_DEFINITION_ID,
  STATUS_COMMAND, STATUS_DEFINITION_ID,
} from './shared.js'
import type { ParkStatus } from './shared.js'

/** Result copy for a session that just reached the pause point; the model never sees it. */
const PAUSED_TEXT = 'This session is paused. It stops once the work in flight drains.'
  + ' Press again to cancel the pause.'

/** Result copy for a released session. */
const RESUMED_TEXT = 'This session resumed from where it paused.'

/** One session's park in progress. */
interface ParkMark {
  /**
   * The only phase this machine walks forward through. `draining` is the state
   * a press creates; the first moment nothing is left to drain moves it to
   * `parking`, and the session-level flush resolves it to `safe` — or to
   * `flush-failed`, which must never be reported as clean.
   */
  phase: 'draining' | 'parking' | 'safe' | 'flush-failed'
  /**
   * Whether this attempt still owns its mark. Cancelling during the drain bumps
   * the generation, so the flush that lands afterwards cannot publish a state
   * for a session the user has already returned to normal.
   */
  generation: number
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

/**
 * Contribute the session control: the pause verb, the per-session status read,
 * and — for every paused session that has a live agent — the resume marker.
 * @param ctx - host context carrying the command registry, the agent store, the
 * session store, and the projection registry.
 * @param gate - the pause gate this control drives and reflects.
 * @param watch - the per-session activity fold the park predicate reads.
 */
export function installSessionControl(ctx: Context, gate: PauseGate, watch: ParkWatch): void {
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
   * once per park: the status is answered by the command, not frozen into it,
   * so a phase change needs no registry write.
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
        handler: (invocation) => {
          gate.resume(invocation.agent.id)
          return { kind: 'success', text: RESUMED_TEXT }
        },
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
    if (!parked(sessionId)) return false
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
      mark.phase = 'safe'
      return
    }
    try {
      await ctx.sessions.flush(session)
    } catch (error: unknown) {
      if (mark.generation !== attempt) return
      mark.phase = 'flush-failed'
      ctx.logger.warn(`safe-stop: flush failed for "${sessionId}": ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (mark.generation !== attempt || mark.phase !== 'parking') return
    mark.phase = 'safe'
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

  // One effect owns the whole surface: unloading removes the pause verb, the
  // subscriptions, and every marker this plugin registered.
  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: CommandDefinitionId(PAUSE_DEFINITION_ID),
      name: PAUSE_COMMAND,
      description: 'Pause this Session before its next model request',
      handler: (invocation) => {
        const sessionId = invocation.agent.id
        if (gate.pause(sessionId)) {
          marks.set(sessionId, { phase: 'draining', generation: ++generation })
        }
        // The press returns now: the drain happens while the user stays free to
        // walk away or press again to cancel it.
        look(sessionId)
        return { kind: 'success', text: PAUSED_TEXT }
      },
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
}
