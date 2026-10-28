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
 * - Which tool is in flight is not projected anywhere, so this module folds the
 *   `tool/call` → `tool/result` pairing itself from the post-commit
 *   `session/event` feed. The fold is incremental and started at plugin mount,
 *   so it sees every call of every session created under the plugin.
 * @module dsh-safe-stop/park
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: pulls the agent registry's Context merge (ctx.agents).
import type {} from '@deepseek-ai/dsh-agent'

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
 * Mount the per-session activity fold.
 * @param ctx - host context carrying the session store and the projection registry.
 * @returns the watch the park state is derived from.
 */
export function mountParkWatch(ctx: Context): ParkWatch {
  /** Open calls per session, in call order: callId → tool name. */
  const openCalls = new Map<string, Map<string, string>>()
  const listeners = new Set<(sessionId: SessionId) => void>()

  const notify = (sessionId: SessionId): void => {
    for (const listener of [...listeners]) listener(sessionId)
  }

  const callsOf = (sessionId: SessionId): Map<string, string> => {
    let calls = openCalls.get(sessionId)
    if (calls === undefined) {
      calls = new Map()
      openCalls.set(sessionId, calls)
    }
    return calls
  }

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'tool/call': {
        callsOf(session.id).set(event.data.callId, event.data.name)
        notify(session.id)
        return
      }
      case 'tool/result': {
        callsOf(session.id).delete(event.data.message.toolCallId)
        notify(session.id)
        return
      }
      case 'turn/start':
      case 'turn/end': {
        // Turn state itself is read from the projection, but a turn boundary is
        // the other half of "is this session standing still": a turn that ends
        // with no further request can never produce the hold a park would wait
        // for, so the park predicate has to look again here.
        notify(session.id)
        return
      }
      default:
        return
    }
  }), 'safe-stop: session activity')

  ctx.effect(() => ctx.on('session/disposed', (session) => {
    openCalls.delete(session.id)
  }), 'safe-stop: session activity cleanup')

  return {
    activity: (sessionId) => {
      const session = ctx.sessions.get(sessionId)
      return {
        // A session with no live log cannot be mid-turn; the park predicate
        // owns what that means.
        turnOpen: session === undefined ? false : turnOpen(ctx, session),
        runningTools: [...callsOf(sessionId).values()],
      }
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
