/**
 * One session's park episode: the durable phase writes, the activity walk that
 * settles them, and the press/release lifecycle. The control composes this with
 * the aggregate, the resume path, and the decision list.
 * @module dsh-pause-session/park-state
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PauseGate } from './gate.js'
import type { LivePark, PressResult } from './global.js'
import type { ParkWatch } from './park.js'
import type { ParkRegistry } from './registry.js'
import { isResumableSession } from './composition.js'
import { describeError, UNRECORDED_TEXT } from './shared.js'
import type { ParkPhase, PauseAnswer } from './shared.js'

/** One session's park in progress. */
export interface ParkMark {
  /** The phase the durable registry confirms for this session. */
  phase: ParkPhase
  /** Generation of the attempt that owns this mark. */
  generation: number
  /** Whether this mark is a live press or a record adopted at mount. */
  origin: 'press' | 'registry'
  /** Whether a settle attempt is already walking this mark. */
  advancing: boolean
}

/** The park lifecycle the session control composes. */
export interface ParkState {
  readonly marks: Map<SessionId, ParkMark>
  readonly unrecorded: Set<SessionId>
  readonly unheld: Set<SessionId>
  subscribe(listener: () => void): () => void
  notify(): void
  press(sessionId: SessionId, signal?: AbortSignal, knownResumable?: boolean): Promise<PressResult>
  /** Adopt one durable record as a mark that never advances in this process. */
  adopt(sessionId: SessionId, phase: ParkPhase): void
  look(sessionId: SessionId): void
  drop(sessionId: SessionId): void
  sync(sessionId: SessionId): void
  release(sessionId: SessionId, text: string): Promise<PauseAnswer>
  markUnrecorded(sessionId: SessionId, unrecorded: boolean): void
  live(): Map<SessionId, LivePark>
  cleanup(): void
}

/**
 * Mount the park episode state machine over the gate, registry, and activity fold.
 * @param ctx - host context carrying the session store and logger.
 * @param gate - the pause gate this state drives.
 * @param registry - the durable pause list every phase write goes to.
 * @param watch - the activity fold the park predicate reads.
 * @returns the park lifecycle the control composes.
 */
export function installParkState(
  ctx: Context,
  gate: PauseGate,
  registry: ParkRegistry,
  watch: ParkWatch,
): ParkState {
  const marks = new Map<SessionId, ParkMark>()
  const unrecorded = new Set<SessionId>()
  const unheld = new Set<SessionId>()
  const listeners = new Set<() => void>()
  let notification: ReturnType<typeof setTimeout> | undefined
  let generation = 0

  /** One snapshot per burst of host changes, not one per phase write. */
  const notify = (): void => {
    if (notification !== undefined) return
    notification = setTimeout(() => {
      notification = undefined
      for (const listener of [...listeners]) listener()
    }, 20)
  }

  const drop = (sessionId: SessionId): void => {
    marks.delete(sessionId)
    notify()
  }

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

  const parked = (sessionId: SessionId): boolean => {
    const activity = watch.activity(sessionId)
    if (activity.runningTools.length > 0) return false
    return gate.isHeld(sessionId) || !activity.turnOpen
  }

  const advance = (sessionId: SessionId): boolean => {
    const mark = marks.get(sessionId)
    if (mark === undefined || mark.phase !== 'draining' || mark.advancing) return false
    if (mark.origin === 'registry') return false
    if (!parked(sessionId)) return false
    mark.advancing = true
    return true
  }

  const settle = async (sessionId: SessionId, attempt: number): Promise<void> => {
    const mark = marks.get(sessionId)
    if (mark === undefined || mark.generation !== attempt) return
    const owned = (): boolean => marks.get(sessionId) === mark && mark.generation === attempt
    const session = ctx.sessions.get(sessionId)
    try {
      if (session === undefined) {
        await commit(sessionId, mark, 'parking')
        return
      }
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
      if (marks.get(sessionId) === mark && mark.phase === 'draining') mark.advancing = false
    }
  }

  const look = (sessionId: SessionId): void => {
    if (marks.has(sessionId)) notify()
    if (!advance(sessionId)) return
    const attempt = marks.get(sessionId)?.generation
    if (attempt !== undefined) void settle(sessionId, attempt)
  }

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
      unheld.delete(sessionId)
      notify()
      return 'registered'
    }
    drop(sessionId)
    gate.resume(sessionId)
    return 'unrecordable'
  }

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

  const sync = (sessionId: SessionId): void => {
    if (!gate.isPaused(sessionId)) {
      drop(sessionId)
      return
    }
  }

  return {
    marks,
    unrecorded,
    unheld,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notify,
    press,
    adopt: (sessionId, phase) => {
      marks.set(sessionId, { phase, generation: ++generation, origin: 'registry', advancing: false })
    },
    look,
    drop,
    sync,
    release,
    markUnrecorded: (sessionId, blocked) => {
      if (blocked) unrecorded.add(sessionId)
      else unrecorded.delete(sessionId)
    },
    live: () => new Map<SessionId, LivePark>([...marks].map(([sessionId, mark]) => [sessionId, {
      phase: mark.phase,
      moving: mark.origin === 'press' && mark.phase !== 'flush-failed' && ctx.sessions.get(sessionId) !== undefined,
    }])),
    cleanup: () => {
      if (notification !== undefined) clearTimeout(notification)
      marks.clear()
      listeners.clear()
    },
  }
}
