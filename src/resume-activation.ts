/**
 * Reactivate one parked session: restore its composition, give it the route its
 * log recorded, deliver the wake it owes, and only then drop the gate and record.
 * @module dsh-pause-session/resume-activation
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-goal'
import type { PauseGate } from './gate.js'
import { UnresumableSessionError, restoreComposition } from './composition.js'
import { owesReply } from './history.js'
import type { ParkRegistry } from './registry.js'
import { describeError, UNRECORDED_TEXT } from './shared.js'
import {
  ACTIVATION_FAILED_TEXT, RESUMED_TEXT, UNRESUMABLE_TEXT, WAKE_MARKER,
} from './resume-text.js'
import type { ResumeAttempt, ResumeOptions, WakeRequest } from './resume-text.js'

/** The activation entry points the resume path composes. */
export interface Activator {
  activate(sessionId: SessionId, request: WakeRequest, rearm: boolean, parentId?: SessionId, signal?: AbortSignal): Promise<ResumeAttempt>
  ensureRoute(agent: Agent): void
  wake(agent: Agent, request: WakeRequest): void
  rearmGoal(agent: Agent): void
}

/**
 * Build the activation closure.
 * @param ctx - host context carrying the agent store and goal service.
 * @param gate - the pause gate released after activation.
 * @param registry - the durable list the release forgets from.
 * @param options - the route knowledge the wake content depends on.
 * @returns the activation methods the resume path uses.
 */
export function createActivator(
  ctx: Context,
  gate: PauseGate,
  registry: ParkRegistry,
  options: ResumeOptions,
): Activator {
  const routeOf = (session: Session): LlmCallConfig | undefined => session.requestHeader()?.config

  const ensureRoute = (agent: Agent): void => {
    if (agent.model.current() !== undefined) return
    const config = routeOf(agent.session)
    if (config === undefined) return
    agent.model.select({
      provider: config.provider,
      model: config.model,
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    })
  }

  const wakeContent = (provider: string): ContentBlock[] =>
    options.silentWakeRoutes.includes(provider) ? [] : [{ type: 'text', text: WAKE_MARKER }]

  const wake = (agent: Agent, request: WakeRequest): void => {
    if (request.kind === 'none') return
    if (gate.isHeld(agent.id) || agent.status !== 'idle') return
    if (!owesReply(agent.session.deriveMessages())) return
    const provider = routeOf(agent.session)?.provider
    if (provider === undefined) return
    const content: ContentBlock[] = request.kind === 'message'
      ? [{ type: 'text', text: request.text }]
      : wakeContent(provider)
    agent.followup(createUserMessage({ content, source: { kind: 'pause' } }))
  }

  const rearmGoal = (agent: Agent): void => {
    const goals = ctx.get('goals')
    if (goals === undefined) return
    try {
      const goal = goals.get(agent)
      if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'disarmed') return
      if (goal.roundsStarted >= goal.maxGoalRounds) return
      goals.resume(agent, { id: goal.id, revision: goal.revision })
    } catch (error: unknown) {
      ctx.logger.warn(`pause: could not re-open the goal of "${agent.id}": ${describeError(error)}`)
    }
  }

  const activate = async (
    sessionId: SessionId,
    request: WakeRequest,
    rearm: boolean,
    parentId?: SessionId,
    signal?: AbortSignal,
  ): Promise<ResumeAttempt> => {
    const parent = parentId === undefined ? undefined : ctx.agents.get(parentId)
    let agent: Agent
    try {
      const composition = await restoreComposition(ctx, sessionId, parent, signal)
      agent = (await ctx.root.agents.resume({
        resumeSessionId: sessionId,
        ...parent === undefined ? {} : { parentAgent: parent },
        ...composition,
        ...signal === undefined ? {} : { signal },
      })).agent
    } catch (error: unknown) {
      if (error instanceof UnresumableSessionError) {
        return {
          sessionId,
          resumed: false,
          refusal: 'unresumable',
          answer: { kind: 'error', text: UNRESUMABLE_TEXT },
        }
      }
      ctx.logger.warn(`pause: could not open "${sessionId}" from its stored log: ${describeError(error)}`)
      return {
        sessionId,
        resumed: false,
        refusal: 'activation-failed',
        answer: { kind: 'error', text: ACTIVATION_FAILED_TEXT },
      }
    }
    ensureRoute(agent)
    wake(agent, request)
    try {
      await registry.forget(sessionId)
    } catch (error: unknown) {
      ctx.logger.warn(`pause: could not drop "${sessionId}" from the pause registry: ${describeError(error)}`)
      return { sessionId, resumed: false, refusal: 'unrecorded', answer: { kind: 'error', text: UNRECORDED_TEXT } }
    }
    gate.resume(sessionId)
    if (rearm) rearmGoal(agent)
    return { sessionId, resumed: true, answer: { kind: 'success', text: RESUMED_TEXT } }
  }

  return { activate, ensureRoute, wake, rearmGoal }
}
