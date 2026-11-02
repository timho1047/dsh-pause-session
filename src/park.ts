/**
 * What a session is doing between "pause was asked for" and "its next model
 * request is standing still at the gate".
 *
 * Two facts decide that, and each has its own owner:
 *
 * - Whether a turn is open is derived state the harness already maintains:
 *   the agent registry owns the `turnBoundary` session projection, which folds
 *   `turn/start`, `turn/end`, `step/start`, and `step/end` into
 *   `openTurnStartSeq`. Reading it through `ctx.agents` is a synchronous
 *   projection read, not a scan of the event log (synchronous history reads are
 *   prohibited for new code).
 * - Which tool is in flight is a log-derived per-session fact, so it is a
 *   session projection too. The projection folds each committed
 *   `tool/call` → `tool/result` pairing and keeps the calls in order; the
 *   framework owns replay, caching, and disposal. This module listens only to
 *   committed events so it can wake the control, never to keep a second copy
 *   of the state itself.
 * @module dsh-pause/park
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
// Type-only: pulls the agent registry's Context merge (ctx.agents).
import type {} from '@deepseek-ai/dsh-agent'

/** One tool call the session has committed but not yet answered. */
const openCallSchema = z.object({
  /** The provider-issued id pairing the call with the result that has not arrived. */
  callId: z.string(),
  /** The tool's own name, as the model called it. */
  name: z.string(),
})

/** The host-only projection state: open calls in call order. */
type OpenToolCall = z.infer<typeof openCallSchema>

/**
 * The host-only fold behind {@link ParkWatch}. It is registered on the
 * plugin's fiber; unload removes it with every other registration.
 */
const parkActivityProjection: ProjectionDefinition<'dsh-pause/activity', OpenToolCall[]> = {
  key: 'dsh-pause/activity',
  stateSchema: z.array(openCallSchema),
  init: () => [],
  apply: (state, event) => {
    if (event.type === 'tool/call') {
      return [...state, { callId: String(event.data.callId), name: event.data.name }]
    }
    if (event.type === 'tool/result') {
      const callId = String(event.data.message.toolCallId)
      const at = state.findIndex(call => call.callId === callId)
      if (at < 0) return state
      return [...state.slice(0, at), ...state.slice(at + 1)]
    }
    return state
  },
  stateVersion: 1,
}

/** One session's current activity, as the control reports it. */
export interface ParkActivity {
  /** Whether the session is inside a turn — including one waiting for this very park. */
  readonly turnOpen: boolean
  /** Names of the calls currently in flight, in call order; empty when no tool is running. */
  readonly runningTools: readonly string[]
}

/** Both halves of the activity question for one session. */
export interface ParkWatch {
  /**
   * @param sessionId - session to inspect.
   * @returns the session's current turn and tool activity.
   */
  activity(sessionId: SessionId): ParkActivity
  /**
   * Subscribe to activity changes.
   * @param listener - called with the session whose activity changed; it must
   * only record that a look is owed, never re-enter the session.
   * @returns the unsubscribe function.
   */
  onChange(listener: (sessionId: SessionId) => void): () => void
}

/** Whether the agent registry's `turnBoundary` fold reports an open turn. */
function turnOpen(ctx: Context, session: Session): boolean {
  return ctx.agents.turnBoundaryOf(session).openTurnStartSeq !== null
}

/**
 * Mount the per-session activity projection and its notification edge.
 * @param ctx - host context carrying the session store and the projection registry.
 * @returns the watch the park state is derived from.
 */
export async function mountParkWatch(ctx: Context): Promise<ParkWatch> {
  const activity = await ctx.sessionProjections.register(parkActivityProjection)
  const listeners = new Set<(sessionId: SessionId) => void>()

  const notify = (sessionId: SessionId): void => {
    for (const listener of [...listeners]) listener(sessionId)
  }

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'tool/call':
      case 'tool/result':
        // The projection owns the open-call list; the committed event only
        // says the control owes a look at it.
        notify(session.id)
        return
      case 'turn/start':
      case 'turn/end':
        // Turn state itself is read from the projection, but a turn boundary is
        // the other half of "is this session standing still": a turn that ends
        // with no further request can never produce the hold a park would wait
        // for, so the park predicate has to look again here.
        notify(session.id)
        return
      default:
        return
    }
  }), 'pause: session activity changes')

  return {
    activity: (sessionId) => {
      const session = ctx.sessions.get(sessionId)
      if (session === undefined) {
        // A session with no live log cannot be mid-turn; the park predicate
        // owns what that means.
        return { turnOpen: false, runningTools: [] }
      }
      return {
        turnOpen: turnOpen(ctx, session),
        runningTools: activity.stateOf(session).map(call => call.name),
      }
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
