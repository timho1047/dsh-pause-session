/**
 * Reactivate one parked Session and deliver the wake it owes.
 *
 * The two Session kinds come back through different owners. An ordinary
 * Session is loaded by this plugin and given the route its own log recorded.
 * A subagent child belongs to the subagent runtime: delivering the wake through
 * `ctx.subagents.prompt` is what cold-resumes it as a managed activation, under
 * its live tree root, with its persisted composition and tree membership
 * restored by the runtime itself.
 *
 * Both paths keep the same release order: the durable record goes first, then
 * the gate, so a record that cannot be dropped leaves the Session parked.
 * @module dsh-pause-session/resume-activation
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-goal'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { PauseGate } from './gate.js'
import { readParkedComposition } from './composition.js'
import type { ParkedComposition } from './composition.js'
import { owesReply } from './history.js'
import type { ParkRegistry } from './registry.js'
import { describeError, UNRECORDED_TEXT } from './shared.js'
import type { PauseAnswer } from './shared.js'
import {
  ACTIVATION_FAILED_TEXT, RESUMED_TEXT, UNRESUMABLE_TEXT, WAKE_MARKER,
} from './resume-text.js'
import type { ResumeAttempt, ResumeOptions, WakeRequest } from './resume-text.js'

/** The activation entry points the resume path composes. */
export interface Activator {
  activate(sessionId: SessionId, request: WakeRequest, rearm: boolean, signal?: AbortSignal): Promise<ResumeAttempt>
  ensureRoute(agent: Agent): void
  wake(agent: Agent, request: WakeRequest): void
  rearmGoal(agent: Agent): void
}

/**
 * Build the activation closure.
 * @param ctx - host context carrying the agent store, subagent runtime, and goal service.
 * @param gate - the pause gate released after activation.
 * @param registry - the durable list the release forgets from.
 * @param options - the route knowledge the root wake content depends on.
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

  /** Drop the durable record, then the gate: the order every release keeps. */
  const releaseRecord = async (sessionId: SessionId): Promise<PauseAnswer | undefined> => {
    try {
      await registry.forget(sessionId)
    } catch (error: unknown) {
      ctx.logger.warn(`pause: could not drop "${sessionId}" from the pause registry: ${describeError(error)}`)
      return { kind: 'error', text: UNRECORDED_TEXT }
    }
    gate.resume(sessionId)
    return undefined
  }

  /** Load an ordinary Session, give it its recorded route, and deliver the wake. */
  const activateRoot = async (
    sessionId: SessionId,
    request: WakeRequest,
    rearm: boolean,
    composition: Extract<ParkedComposition, { kind: 'root' }>,
    signal?: AbortSignal,
  ): Promise<ResumeAttempt> => {
    let agent: Agent
    try {
      agent = (await ctx.root.agents.resume({
        resumeSessionId: sessionId,
        ...composition.setup === undefined ? {} : { setup: composition.setup },
        ...signal === undefined ? {} : { signal },
      })).agent
    } catch (error: unknown) {
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
    const refused = await releaseRecord(sessionId)
    if (refused !== undefined) return { sessionId, resumed: false, refusal: 'unrecorded', answer: refused }
    if (rearm) rearmGoal(agent)
    return { sessionId, resumed: true, answer: { kind: 'success', text: RESUMED_TEXT } }
  }

  /**
   * Hand a subagent child the wake through the subagent runtime.
   *
   * The runtime owns the activation, so it is also the only thing that can
   * cold-resume the child under its live tree root. An empty message would be
   * dropped by a route whose conversion discards it, and the route is unknown
   * before the child is live, so the marker is the content that always wakes it.
   */
  const activateChild = async (
    sessionId: SessionId,
    request: WakeRequest,
    rearm: boolean,
    signal?: AbortSignal,
  ): Promise<ResumeAttempt> => {
    const subagents = ctx.get('subagents')
    if (subagents === undefined) {
      // A profile without the subagent runtime owns no managed tree to join;
      // the child can only come back as an independent Session.
      ctx.logger.warn(`pause: subagent runtime is not mounted; opening "${sessionId}" as a root Session`)
      return await activateRoot(sessionId, request, rearm, { kind: 'root' }, signal)
    }
    // A wake is the only thing that cold-resumes a child, so `none` — the
    // review answer — never reaches this path: review returns before activating.
    const content = [{ type: 'text' as const, text: request.kind === 'message' ? request.text : WAKE_MARKER }]
    try {
      await subagents.prompt({
        requestId: randomUUID() as SubagentPromptRequestId,
        childSessionId: sessionId,
        delivery: 'queue',
        content,
      }, signal ?? new AbortController().signal)
    } catch (error: unknown) {
      if (remoteErrorOf(error)?.code === 'subagent/not-resumable') {
        return {
          sessionId,
          resumed: false,
          refusal: 'unresumable',
          answer: { kind: 'error', text: UNRESUMABLE_TEXT },
        }
      }
      ctx.logger.warn(`pause: could not continue subagent "${sessionId}": ${describeError(error)}`)
      return {
        sessionId,
        resumed: false,
        refusal: 'activation-failed',
        answer: { kind: 'error', text: ACTIVATION_FAILED_TEXT },
      }
    }
    const refused = await releaseRecord(sessionId)
    if (refused !== undefined) return { sessionId, resumed: false, refusal: 'unrecorded', answer: refused }
    const agent = ctx.agents.get(sessionId)
    if (rearm && agent !== undefined) rearmGoal(agent)
    return { sessionId, resumed: true, answer: { kind: 'success', text: RESUMED_TEXT } }
  }

  const activate = async (
    sessionId: SessionId,
    request: WakeRequest,
    rearm: boolean,
    signal?: AbortSignal,
  ): Promise<ResumeAttempt> => {
    let composition: ParkedComposition
    try {
      composition = await readParkedComposition(ctx, sessionId, signal)
    } catch (error: unknown) {
      ctx.logger.warn(`pause: could not read the composition of "${sessionId}": ${describeError(error)}`)
      return {
        sessionId,
        resumed: false,
        refusal: 'activation-failed',
        answer: { kind: 'error', text: ACTIVATION_FAILED_TEXT },
      }
    }
    return composition.kind === 'child'
      ? await activateChild(sessionId, request, rearm, signal)
      : await activateRoot(sessionId, request, rearm, composition, signal)
  }

  return { activate, ensureRoute, wake, rearmGoal }
}
