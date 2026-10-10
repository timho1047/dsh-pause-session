/**
 * The clean resume path: bring back a session a previous process parked, and
 * let it answer the input that was already pending when it stopped.
 *
 * A resume invents no turn. At the park point the loop had claimed the
 * session's pending input onto the surface and built the request the gate then
 * held; after a restart that input is still the last thing the session says and
 * the model still owes it an answer. What is missing is only a reason for the
 * loop to build a request again, and the documented way to ask for one is a
 * wake input — a user message the loop claims.
 *
 * The wake is invisible only on the routes the composition declares in
 * `silentWakeRoutes`, whose conversion drops an empty user message. On every
 * other route the loop's request carries one visible marker instead, and the
 * marker reaches the model; that is an accepted cost of resuming at all.
 * Whether an empty user message survives is a property of the route's
 * conversion rather than of the loop, so the route is resolved per session —
 * from the request header the session itself persisted.
 *
 * The wake message is attributed to this plugin, never to the user: it is text
 * this module synthesized on the session's behalf, in the session's own log and
 * in front of the model, and a downstream consumer has to be able to tell it
 * apart from something the human typed.
 *
 * Only a cleanly parked session takes this path. A record that never reached
 * the park point, or whose flush did not finish, describes work whose durable
 * state nobody knows; waking it would spend its owner's money on a guess, and
 * deciding those sessions is the morning list's job, not this path's. That
 * holds whether or not the recorded session happens to be live in this process:
 * liveness is not the park outcome, and a session can be live without ever
 * having stopped.
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
import { owesReply } from './history.js'
import type { ParkRegistry } from './registry.js'
import { describeError } from './shared.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Text dsh-safe-stop synthesized on the session's behalf: the wake this
     * path delivers and the unknown-outcome note a decision adds. Declared so
     * the log, and anything reading it, can tell plugin-authored input from the
     * user's own.
     */
    'safe-stop': { kind: 'safe-stop' }
  }
}

/**
 * The one wake content a route that keeps an empty user message is given. It
 * names its producer, because it lands in the same user turn as the input the
 * model owes an answer to and must not read as part of it.
 */
export const WAKE_MARKER = '[safe-stop: resumed from a pause]'

/**
 * How one resume asks the loop for the request it owes the session:
 *
 * - `silent`: the clean path's wake — an empty input on a route the
 *   composition declared silent, and the visible marker on any other route.
 * - `message`: the decision list's "continue, and say the tool outcome is
 *   unknown" — user-visible text on the wire by construction, and the only
 *   resume that is not invisible.
 * - `none`: no wake at all. This is what "leave it for me to read" costs: the
 *   session is not activated, nothing is asked of the model, and the park is
 *   exactly as it was.
 */
export type WakeRequest =
  | { readonly kind: 'silent' }
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'none' }

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

/**
 * Result copy for the review decision. It is the one answer that promises
 * nothing happened, because opening a session to read it is the user's own
 * action in their session list — and activating its agent here would start a
 * session they asked only to look at.
 */
export const REVIEW_TEXT = 'safe-stop did not activate this session: it is still parked, and nothing was sent to a model.'
  + ' Open it from your session list when you want to read it.'

/** Result copy for a change the durable registry refused to record. */
export const UNRECORDED_TEXT = 'safe-stop could not write the pause registry, so it did not change the pause state.'

/** Copy for one goal opt-out change. */
export const REARM_GOAL_ON_TEXT = 'safe-stop will re-open this session\'s goal when it resumes it.'
export const REARM_GOAL_OFF_TEXT = 'safe-stop will leave this session\'s goal closed when it resumes it.'

/** Why one record did not produce a running session. */
export type ResumeRefusal = 'not-parked' | 'not-clean' | 'activation-failed' | 'unrecorded' | 'not-activated'

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
   * @param request - which wake this resume delivers; see {@link WakeRequest}.
   * @param parentId - the direct parent a batch release already brought back, when there is one.
   * @returns what happened, and the copy for whoever asked.
   */
  resumeSession(sessionId: SessionId, request: WakeRequest, parentId?: SessionId): Promise<ResumeAttempt>
  /**
   * Resume one session the decision list officially owns — a record that is
   * known NOT to be clean, which the clean path above must refuse and this entry
   * exists to carry out. Same release order, same wake vocabulary.
   * @param sessionId - the listed session to bring back.
   * @param request - which wake the decision delivers; see {@link WakeRequest}.
   * @param finalize - whether the decision continues the session (`'release'`)
   * or only answers it (`'review'`). A review activates nothing and writes
   * nothing: opening a session to read it is the user's own action, not this
   * plugin's.
   * @param parentId - the direct parent a batch release already brought back, when there is one.
   * @returns what happened, and the copy for whoever asked.
   */
  decideUnclean(
    sessionId: SessionId,
    request: WakeRequest,
    finalize: 'release' | 'review',
    parentId?: SessionId,
  ): Promise<ResumeAttempt>
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

/**
 * How a batch release is sequenced: the tree edge each child was found under,
 * and the depth levels a release walks, shallowest first.
 */
interface ReleaseOrder {
  /** Direct parent inside the recorded set, for the sessions that have one. */
  readonly parents: ReadonlyMap<SessionId, SessionId>
  readonly levels: readonly (readonly SessionId[])[]
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
   * continuation is in flight, and a second wake would duplicate it. The content
   * is the route's business only for the silent wake; a note is the user's
   * decision and goes on the wire as written, on every route. Either way the
   * message is attributed to this plugin: the wake is this path speaking on the
   * session's behalf, not the user's own input.
   * @param agent - the live agent to wake.
   * @param request - which wake this resume delivers.
   */
  const wake = (agent: Agent, request: WakeRequest): void => {
    if (request.kind === 'none') return
    if (gate.isHeld(agent.id) || agent.status !== 'idle') return
    if (!owesReply(agent.session.deriveMessages())) return
    const provider = routeOf(agent.session)?.provider
    if (provider === undefined) return
    const content: ContentBlock[] = request.kind === 'message'
      ? [{ type: 'text', text: request.text }]
      : wakeContent(provider)
    agent.followup(createUserMessage({ content, source: { kind: 'safe-stop' } }))
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
      ctx.logger.warn(`safe-stop: could not re-open the goal of "${agent.id}": ${describeError(error)}`)
    }
  }

  /**
   * Load one parked session back from its stored log and hand it the request it
   * stopped in front of. The pause is not released until the durable record is
   * gone, so a record that cannot be dropped leaves the session parked rather
   * than silently running.
   *
   * Activation is what makes a session run again, so nothing but a resume does
   * it: the review answer never reaches this function.
   * @param sessionId - the parked session to bring back.
   * @param request - which wake the decision delivers; see {@link WakeRequest}.
   * @param rearm - whether the record's goal opt-out allows re-opening its goal.
   * @param parentId - the direct parent a batch release already brought back,
   * when there is one. A subagent child resumed under its live parent is the
   * shape the harness's own cold resume uses; with no live parent the session
   * comes back on its own, which is all that can be done with it.
   */
  const activate = async (
    sessionId: SessionId,
    request: WakeRequest,
    rearm: boolean,
    parentId?: SessionId,
  ): Promise<ResumeAttempt> => {
    const parent = parentId === undefined ? undefined : ctx.agents.get(parentId)
    let agent: Agent
    try {
      // Owned by the root, not by this plugin's fiber: the session is the
      // user's, and it must outlive a plugin reload.
      agent = (await ctx.root.agents.resume({
        resumeSessionId: sessionId,
        ...parent === undefined ? {} : { parentAgent: parent },
      })).agent
    } catch (error: unknown) {
      ctx.logger.warn(`safe-stop: could not open "${sessionId}" from its stored log: ${describeError(error)}`)
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
    // Whether that produced a wake says nothing about the release. A wake can
    // be refused because the log owes no answer at all (a session parked while
    // idle) or because the loop was already running; the user's decision to
    // continue is what releases the session in every one of those cases.
    wake(agent, request)
    try {
      await registry.forget(sessionId)
    } catch (error: unknown) {
      ctx.logger.warn(`safe-stop: could not drop "${sessionId}" from the pause registry: ${describeError(error)}`)
      return { sessionId, resumed: false, refusal: 'unrecorded', answer: { kind: 'error', text: UNRECORDED_TEXT } }
    }
    gate.resume(sessionId)
    if (rearm) rearmGoal(agent)
    return { sessionId, resumed: true, answer: { kind: 'success', text: RESUMED_TEXT } }
  }

  /**
   * Load one unclean session back from its stored log.
   *
   * This is the morning list's own entry point, and it exists precisely because
   * the clean path must keep refusing these records: the refusal is the clean
   * path's guarantee, not a guard this entry can borrow. A user who has read the
   * row and chosen one of the decisions that resume it has made the decision the
   * clean path is not allowed to make for them. The release order is the same
   * one: the durable record goes first, then the gate — so a record that cannot
   * be dropped leaves the session parked.
   *
   * A record this process holds no gate for is still this list's to clear: the
   * session is live, so the decision's own wake is what asks for its request,
   * and dropping the record is what stops a later process from re-holding a
   * session the user has already decided.
   * @param sessionId - the listed session to bring back.
   * @param request - which wake the decision delivers; see {@link WakeRequest}.
   * @param finalize - whether the decision continues the session (`'release'`)
   * or only answers it (`'review'`); a review activates nothing and writes
   * nothing.
   * @param parentId - the direct parent a batch release already brought back, when there is one.
   * @returns what happened, and the copy for whoever asked.
   */
  const decideUnclean = async (
    sessionId: SessionId,
    request: WakeRequest,
    finalize: 'release' | 'review',
    parentId?: SessionId,
  ): Promise<ResumeAttempt> => {
    const record = registry.get(sessionId)
    if (record === undefined) {
      return { sessionId, resumed: false, refusal: 'not-parked', answer: { kind: 'success', text: NOT_PARKED_TEXT } }
    }
    // Opening a session to read it is the user's own action in their session
    // list; this decision only answers, so it never activates an agent and
    // never writes. That is what makes it the safe choice on a session whose
    // side effects may already have happened.
    if (finalize === 'review') {
      return { sessionId, resumed: false, refusal: 'not-activated', answer: { kind: 'success', text: REVIEW_TEXT } }
    }
    const live = ctx.agents.get(sessionId)
    if (live === undefined) return await activate(sessionId, request, record.rearmGoal, parentId)
    if (!gate.isPaused(sessionId)) {
      // This process holds nothing for the session — its record was found
      // unreadable at mount, or something else already released it. The session
      // is live, so the decision's own wake is what asks for the request it is
      // owed, and the record goes on the release path's own order.
      ensureRoute(live)
      wake(live, request)
      try {
        await registry.forget(sessionId)
      } catch (error: unknown) {
        ctx.logger.warn(`safe-stop: could not drop "${sessionId}" from the pause registry: ${describeError(error)}`)
        return { sessionId, resumed: false, refusal: 'unrecorded', answer: { kind: 'error', text: UNRECORDED_TEXT } }
      }
      if (record.rearmGoal) rearmGoal(live)
      return { sessionId, resumed: true, answer: { kind: 'success', text: RESUMED_TEXT } }
    }
    const adopted = deps.adopted(sessionId)
    // An adopted pause with nothing standing at the gate has no continuation to
    // release: the process that built that request is gone, so the decision's
    // own wake is what asks for one.
    if (adopted) {
      ensureRoute(live)
      wake(live, request)
    }
    const released = await deps.release(sessionId, RESUMED_TEXT)
    if (released.kind === 'error') {
      return { sessionId, resumed: false, refusal: 'unrecorded', answer: released }
    }
    if (adopted && record.rearmGoal) rearmGoal(live)
    return { sessionId, resumed: true, answer: released }
  }

  /**
   * Resume one recorded session: the clean path's only entry point.
   *
   * The clean-only rule holds on every branch, live or not: a record that is
   * not `safe` is not a park that finished, so this path neither wakes it nor
   * drops it — whoever holds it stays held, and the row reaches the morning
   * list. A pause this process pressed itself is not a record at all: taking it
   * back is the press's own undo, and it delivers no wake.
   * @param sessionId - the recorded session to resume.
   * @param request - which wake this resume delivers; see {@link WakeRequest}.
   * @param parentId - the direct parent a batch release already brought back, when there is one.
   * @returns what happened, and the copy for whoever asked.
   */
  const resumeSession = async (sessionId: SessionId, request: WakeRequest, parentId?: SessionId): Promise<ResumeAttempt> => {
    const record = registry.get(sessionId)
    const live = ctx.agents.get(sessionId)

    if (live !== undefined) {
      if (!gate.isPaused(sessionId)) {
        // This process holds nothing here. An unclean record belongs to the
        // morning list, and refusing it here is what keeps it there.
        if (record !== undefined && record.phase !== 'safe') {
          return { sessionId, resumed: false, refusal: 'not-clean', answer: { kind: 'error', text: UNCLEAN_TEXT } }
        }
        if (record === undefined) {
          return { sessionId, resumed: false, refusal: 'not-parked', answer: { kind: 'success', text: NOT_PARKED_TEXT } }
        }
        // A clean record nothing is holding any more: the session is already
        // back (it became readable after this mount could not hold it), so the
        // park is over. The record goes first — a park this process cannot drop
        // is not one it may continue — and then the session is handed the
        // request it stopped in front of, which is this path's own job.
        try {
          await registry.forget(sessionId)
        } catch (error: unknown) {
          ctx.logger.warn(`safe-stop: could not drop "${sessionId}" from the pause registry: ${describeError(error)}`)
          return { sessionId, resumed: false, refusal: 'unrecorded', answer: { kind: 'error', text: UNRECORDED_TEXT } }
        }
        ensureRoute(live)
        wake(live, request)
        if (record.rearmGoal) rearmGoal(live)
        return { sessionId, resumed: true, answer: { kind: 'success', text: RESUMED_TEXT } }
      }
      // A pause this process did NOT press is another process's verdict: only a
      // finished park may be woken from it. A press of this process's own is
      // the pause the user is taking back, and it delivers no wake either way.
      const adopted = deps.adopted(sessionId)
      if (adopted && record !== undefined && record.phase !== 'safe') {
        return { sessionId, resumed: false, refusal: 'not-clean', answer: { kind: 'error', text: UNCLEAN_TEXT } }
      }
      // An adopted pause with nothing standing at the gate has no continuation
      // to release: the process that built that request is gone.
      if (adopted) {
        ensureRoute(live)
        wake(live, request)
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
    return await activate(sessionId, request, record.rearmGoal, parentId)
  }

  /**
   * Order the recorded sessions so a session is released after the parent it
   * hangs from: waking a child needs its direct parent to be live first. The
   * relation is read from the parent catalogs themselves (which children this
   * session actually has), never guessed from ids; a branch whose catalog
   * cannot be read simply has no known parent and is released with the roots.
   * @param sessionIds - every recorded session, in registry order.
   * @returns the parent of each child, and one list per depth level, shallowest first.
   */
  const releaseOrder = async (sessionIds: readonly SessionId[]): Promise<ReleaseOrder> => {
    const owned = new Set(sessionIds)
    const parentOf = new Map<SessionId, SessionId>()
    const subagents = ctx.get('subagents')
    if (subagents !== undefined) {
      for (const sessionId of sessionIds) {
        try {
          for (const child of await subagents.listChildren(sessionId)) {
            if (owned.has(child.id)) parentOf.set(child.id, sessionId)
          }
        } catch (error: unknown) {
          ctx.logger.warn(`safe-stop: could not read the children of "${sessionId}": ${describeError(error)}`)
        }
      }
    }
    const depthOf = (sessionId: SessionId): number => {
      let steps = 0
      const seen = new Set<SessionId>([sessionId])
      for (let at = parentOf.get(sessionId); at !== undefined; at = parentOf.get(at)) {
        // A damaged catalog could describe a cycle; a session in one is a root.
        if (seen.has(at)) break
        seen.add(at)
        steps += 1
      }
      return steps
    }
    const levels = new Map<number, SessionId[]>()
    for (const sessionId of sessionIds) {
      const level = depthOf(sessionId)
      const bucket = levels.get(level)
      if (bucket === undefined) levels.set(level, [sessionId])
      else bucket.push(sessionId)
    }
    return {
      parents: parentOf,
      levels: [...levels.keys()].sort((left, right) => left - right)
        .map(level => levels.get(level) ?? []),
    }
  }

  return {
    resumeSession,
    decideUnclean,
    resumeParked: async () => {
      const release = await releaseOrder(registry.list().map(entry => entry.sessionId))
      const attempts: ResumeAttempt[] = []
      for (const level of release.levels) {
        // One release per level and no concurrency cap inside it: the levels
        // are the milliseconds a child's wake needs, not a queue.
        attempts.push(...await Promise.all(level.map(sessionId =>
          resumeSession(sessionId, { kind: 'silent' }, release.parents.get(sessionId)))))
      }
      return attempts
    },
    setRearmGoal: async (sessionId, rearmGoal) => {
      try {
        await registry.setRearmGoal(sessionId, rearmGoal)
      } catch (error: unknown) {
        ctx.logger.warn(`safe-stop: could not record the goal opt-out of "${sessionId}": ${describeError(error)}`)
        return { kind: 'error', text: UNRECORDED_TEXT }
      }
      return { kind: 'success', text: rearmGoal ? REARM_GOAL_ON_TEXT : REARM_GOAL_OFF_TEXT }
    },
  }
}
