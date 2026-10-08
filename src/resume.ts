/**
 * The clean resume path: bring back a session a previous process parked, and
 * let it answer the input that was already pending when it stopped.
 *
 * A resume invents no turn. At the park point the loop had claimed the
 * session's pending input onto the surface and built the request the gate then
 * held; after a restart that input is still the last thing the session says and
 * the model still owes it an answer. What is missing is only a reason for the
 * loop to build a request again, and the documented way to ask for one is a
 * wake input — a user message the loop claims. Its content must leave the wire
 * request unchanged, and whether an empty message does that is a property of
 * the route's conversion rather than of the loop: the loop always builds the
 * empty message in, and the adapter below it either drops it or sends it.
 * The route is therefore resolved per session — from the request header the
 * session itself persisted — and the composition declares which routes drop an
 * empty user message. Every other route gets one fixed minimal marker instead:
 * visible on the wire, never an instruction, because a route that keeps an
 * empty message would otherwise put an empty user turn in front of the model.
 *
 * Only a cleanly parked session takes this path. A record that never reached
 * the park point, or whose flush did not finish, describes work whose durable
 * state nobody knows; waking it would spend its owner's money on a guess, and
 * deciding those sessions is the morning list's job, not this path's.
 * @module dsh-safe-stop/resume
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: brings `ctx.get('goals')` and the goal view this path reads.
import type {} from '@deepseek-ai/dsh-goal'
import type { PauseGate } from './gate.js'
import type { ParkRegistry } from './registry.js'

/** The one wake content a route that keeps an empty user message is given. */
export const WAKE_MARKER = '.'

/** Result copy for a resumed session; the model never sees it. */
export const RESUMED_TEXT = 'This session resumed from where it paused.'

/**
 * Result copy for a registered session this path refuses: its durable state is
 * not the outcome of a completed park, so waking it would be a guess.
 */
export const UNCLEAN_TEXT = 'safe-stop did not resume this session: it did not stop cleanly,'
  + ' so its pending work needs your decision rather than a silent wake.'

/** Result copy when nothing is parked under that session. */
export const NOT_PARKED_TEXT = 'safe-stop has no pause recorded for this session.'

/** Result copy for a session that is parked but could not be loaded back. */
export const ACTIVATION_FAILED_TEXT = 'safe-stop could not open this session from its stored log, so it stayed paused.'

/** Result copy for a change the durable registry refused to record. */
export const UNRECORDED_TEXT = 'safe-stop could not write the pause registry, so it did not change the pause state.'

/** Copy for one goal opt-out change. */
export const REARM_GOAL_ON_TEXT = 'safe-stop will re-open this session\'s goal when it resumes it.'
export const REARM_GOAL_OFF_TEXT = 'safe-stop will leave this session\'s goal closed when it resumes it.'

/** Why one record did not produce a running session. */
export type ResumeRefusal = 'not-parked' | 'not-clean' | 'activation-failed' | 'unrecorded'

/** What one resume attempt did. */
export interface ResumeOutcome {
  readonly sessionId: SessionId
  /** Whether the session is now running from the point it stopped. */
  readonly resumed: boolean
  /** Present exactly when `resumed` is false. */
  readonly refusal?: ResumeRefusal
}

/** One resume attempt plus the answer the command that asked for it receives. */
export interface ResumeAttempt extends ResumeOutcome {
  readonly answer: CommandResult
}

/** How this path is wired into the session control that owns the pause state. */
export interface ResumeDeps {
  /**
   * Take a live session's pause back: the durable record goes first, then the
   * gate. Owned by the session control so there is one release order.
   */
  release(sessionId: SessionId, text: string): Promise<CommandResult>
  /**
   * Whether the pause this process holds was adopted from the registry rather
   * than pressed here. Only an adopted pause is a restart: a press this process
   * made and took back must never wake a model.
   */
  adopted(sessionId: SessionId): boolean
}

/** Route knowledge this path needs from the composition. */
export interface ResumeOptions {
  /**
   * Provider routes whose request conversion drops an empty user message, so an
   * empty wake never reaches the model. Deployment-owned because it is a
   * property of the adapter behind each route, and a third-party plugin cannot
   * introspect an adapter.
   */
  readonly silentWakeRoutes: readonly string[]
}

/** The clean resume path, as the session control drives it. */
export interface ResumePath {
  /**
   * Resume one session the registry remembers.
   * @param sessionId - the session to resume.
   * @returns what happened, and the copy for whoever asked.
   */
  resumeSession(sessionId: SessionId): Promise<ResumeAttempt>
  /**
   * Resume every session the registry remembers, clean ones only. One session's
   * failure never stops the others.
   * @returns one attempt per recorded session, in registry order.
   */
  resumeParked(): Promise<readonly ResumeAttempt[]>
  /**
   * Record or clear one session's goal opt-out.
   * @param sessionId - the parked session to change.
   * @param rearmGoal - whether the clean resume path may re-arm its goal.
   * @returns the copy for whoever asked.
   */
  setRearmGoal(sessionId: SessionId, rearmGoal: boolean): Promise<CommandResult>
}

/** Human-readable failure detail for a log line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether the loop owes this session an answer: its model history ends with
 * something a model has not replied to. That is exactly the input the park
 * point left pending — the claimed user message, or the tool results of the
 * step whose next request was held.
 */
function owedReply(session: Session): boolean {
  const messages = session.deriveMessages()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    // System and developer entries are request framing, not conversation.
    if (message === undefined || message.role === 'system' || message.role === 'developer') continue
    return message.role !== 'assistant'
  }
  return false
}

/**
 * Build the clean resume path.
 * @param ctx - host context carrying the agent store, the session store, and the goal service when one is mounted.
 * @param gate - the pause gate the resume releases.
 * @param registry - the durable list this path reads and forgets from.
 * @param options - the route knowledge the wake content depends on.
 * @param deps - the control-owned release order and the adopted-pause fact.
 * @returns the path the session control exposes.
 */
export function installResumePath(
  ctx: Context,
  gate: PauseGate,
  registry: ParkRegistry,
  options: ResumeOptions,
  deps: ResumeDeps,
): ResumePath {
  /** The route the session's next request will use, as its own log recorded it. */
  const routeOf = (session: Session): LlmCallConfig | undefined => session.requestHeader()?.config

  /**
   * Give an agent that was loaded back without one the route its own log
   * recorded. The loop refuses to build a request without a provider and model,
   * and the persisted header is what the app's own activation path uses too, so
   * this resumes onto the route the session stopped on.
   */
  const ensureRoute = (agent: Agent): void => {
    if (agent.options.provider !== undefined && agent.options.model !== undefined) return
    const config = routeOf(agent.session)
    if (config === undefined) return
    const current = {
      provider: config.provider,
      model: config.model,
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    }
    // Scoped to the agent: the selection is the agent's route, not the plugin's.
    agent.ctx.effect(
      () => installModelSelection(agent.ctx, { current, assembled: undefined }),
      'safe-stop: resumed route',
    )
  }

  /** What one wake input carries for the route in use. */
  const wakeContent = (provider: string): ContentBlock[] =>
    options.silentWakeRoutes.includes(provider) ? [] : [{ type: 'text', text: WAKE_MARKER }]

  /**
   * Ask the loop for the request it owes this session. Nothing is woken when a
   * request is already standing at the gate or the loop is already running: the
   * continuation is in flight, and a second wake would duplicate it.
   * @param agent - the live agent to wake.
   * @returns whether a wake input was delivered.
   */
  const wake = (agent: Agent): boolean => {
    if (gate.isHeld(agent.id) || agent.status !== 'idle') return false
    if (!owedReply(agent.session)) return false
    const provider = routeOf(agent.session)?.provider
    if (provider === undefined) return false
    agent.followup(createUserMessage({ content: wakeContent(provider), source: { kind: 'user' } }))
    return true
  }

  /**
   * Re-open one session's goal. Activation is process-local and is not part of
   * the durable goal, so a restart leaves a healthy goal disarmed; only that
   * case is repaired here. A goal the owner paused, blocked, or completed is a
   * decision, and this path does not take decisions back. The wake (when there
   * is one) runs first on purpose: the goal round driver queues the next round
   * as soon as the agent is idle, and that round must not join the request that
   * is answering the input already pending.
   * @param agent - the agent whose goal may be re-armed.
   */
  const rearmGoal = (agent: Agent): void => {
    const goals = ctx.get('goals')
    if (goals === undefined) return
    try {
      const goal = goals.get(agent)
      if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'disarmed') return
      if (goal.roundsStarted >= goal.maxGoalRounds) return
      goals.resume(agent, { id: goal.id, revision: goal.revision })
    } catch (error: unknown) {
      ctx.logger.warn(`safe-stop: could not re-open the goal of "${agent.id}": ${describe(error)}`)
    }
  }

  /**
   * Load one parked session back from its stored log and hand it the request it
   * stopped in front of. The pause is not released until the durable record is
   * gone, so a record that cannot be dropped leaves the session parked rather
   * than silently running.
   */
  const activate = async (sessionId: SessionId, rearm: boolean): Promise<ResumeAttempt> => {
    let agent: Agent
    try {
      // Owned by the root, not by this plugin's fiber: the session is the
      // user's, and it must outlive a plugin reload.
      agent = (await ctx.root.agents.resume({ resumeSessionId: sessionId })).agent
    } catch (error: unknown) {
      ctx.logger.warn(`safe-stop: could not open "${sessionId}" from its stored log: ${describe(error)}`)
      return {
        sessionId,
        resumed: false,
        refusal: 'activation-failed',
        answer: { kind: 'error', text: ACTIVATION_FAILED_TEXT },
      }
    }
    ensureRoute(agent)
    // Delivered while the pause still holds the gate, so the request it builds
    // waits there and leaves only once the durable record does.
    wake(agent)
    try {
      await registry.forget(sessionId)
    } catch (error: unknown) {
      ctx.logger.warn(`safe-stop: could not drop "${sessionId}" from the pause registry: ${describe(error)}`)
      return { sessionId, resumed: false, refusal: 'unrecorded', answer: { kind: 'error', text: UNRECORDED_TEXT } }
    }
    gate.resume(sessionId)
    if (rearm) rearmGoal(agent)
    return { sessionId, resumed: true, answer: { kind: 'success', text: RESUMED_TEXT } }
  }

  const resumeSession = async (sessionId: SessionId): Promise<ResumeAttempt> => {
    const record = registry.get(sessionId)
    const live = ctx.agents.get(sessionId)

    if (live !== undefined) {
      if (!gate.isPaused(sessionId)) {
        // Something else already released this session; there is nothing this
        // path could do that would not be a second resume.
        return { sessionId, resumed: true, answer: { kind: 'success', text: RESUMED_TEXT } }
      }
      const adopted = deps.adopted(sessionId)
      // An adopted pause with nothing standing at the gate has no continuation
      // to release: the process that built that request is gone.
      if (adopted) {
        ensureRoute(live)
        wake(live)
      }
      const released = await deps.release(sessionId, RESUMED_TEXT)
      if (released.kind === 'error') {
        return { sessionId, resumed: false, refusal: 'unrecorded', answer: released }
      }
      // Re-arming spends money on the session's own, so the record's opt-out
      // decides it — and only an adopted pause can have lost the activation.
      if (adopted && (record?.rearmGoal ?? true)) rearmGoal(live)
      return { sessionId, resumed: true, answer: released }
    }

    if (record === undefined) {
      return { sessionId, resumed: false, refusal: 'not-parked', answer: { kind: 'success', text: NOT_PARKED_TEXT } }
    }
    // The one rule of this path: a record that is not `safe` is not a park that
    // finished, and waking it would act on a durable state nobody knows.
    if (record.phase !== 'safe') {
      return { sessionId, resumed: false, refusal: 'not-clean', answer: { kind: 'error', text: UNCLEAN_TEXT } }
    }
    return await activate(sessionId, record.rearmGoal)
  }

  return {
    resumeSession,
    resumeParked: async () => {
      const attempts: ResumeAttempt[] = []
      for (const entry of registry.list()) attempts.push(await resumeSession(entry.sessionId))
      return attempts
    },
    setRearmGoal: async (sessionId, rearmGoal) => {
      try {
        await registry.setRearmGoal(sessionId, rearmGoal)
      } catch (error: unknown) {
        ctx.logger.warn(`safe-stop: could not record the goal opt-out of "${sessionId}": ${describe(error)}`)
        return { kind: 'error', text: UNRECORDED_TEXT }
      }
      return { kind: 'success', text: rearmGoal ? REARM_GOAL_ON_TEXT : REARM_GOAL_OFF_TEXT }
    },
  }
}
