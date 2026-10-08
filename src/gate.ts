/**
 * The pause gate: one session's hold at the model-request waterfall.
 *
 * The hold sits on the `llm/stream` waterfall, which is the only point that
 * satisfies all four conditions at once: the previous step's tool calls have
 * drained, the request is already built, the session's pending input is
 * committed, and — because nothing pulls the adapter — no timer is armed
 * anywhere. Machine sleep, network loss, and the adapter's stream-idle
 * watchdog therefore cannot touch a parked request.
 * @module dsh-safe-stop/gate
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Message of the failure a held request ends with when its plugin unloads first. */
export const PLUGIN_UNLOADED = 'safe-stop: plugin lifetime ended while a request was held'

/** One latch a paused request waits on. */
interface Latch {
  readonly promise: Promise<void>
  readonly open: () => void
}

/** One paused session and the latch every request of that session waits on. */
interface Pause {
  readonly released: Promise<void>
  release(): void
}

/** The abort signal's own error, or a stable one when the abort carried no reason. */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('safe-stop: request aborted while held')
}

/** A latch without `Promise.withResolvers`, which this project's ES2022 lib predates. */
function latch(): Latch {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

/**
 * Resolve once the session is released or any of `signals` aborts. No timer is
 * armed: the wait ends only by release or by an abort, so a parked request
 * cannot be woken by the clock. Listeners are removed once the wait settles.
 */
function raceRelease(released: Promise<void>, signals: readonly AbortSignal[]): Promise<void> {
  const wake = latch()
  const onAbort = (): void => { wake.open() }
  const watching = signals.filter(signal => !signal.aborted)
  if (watching.length !== signals.length) wake.open()
  for (const signal of watching) signal.addEventListener('abort', onAbort, { once: true })
  return Promise.race([released, wake.promise]).finally(() => {
    for (const signal of watching) signal.removeEventListener('abort', onAbort)
  })
}

/** Options of {@link PauseGate}. */
export interface PauseGateOptions {
  /** Aborted when the owning plugin unloads; a held request must never delegate after that. */
  readonly lifetime: AbortSignal
}

/** Per-session pause state and the waterfall listener that enforces it. */
export class PauseGate {
  /** Paused sessions; membership IS the pause state. */
  private readonly paused = new Map<SessionId, Pause>()
  private readonly listeners = new Set<(sessionId: SessionId, paused: boolean) => void>()

  /**
   * @param options - the plugin-lifetime signal every held request races.
   */
  constructor(private readonly options: PauseGateOptions) {}

  /**
   * Subscribe to pause-state changes.
   * @param listener - called with the session whose state changed and its new state.
   * @returns the unsubscribe function.
   */
  onChange(listener: (sessionId: SessionId, paused: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * @param sessionId - session to inspect.
   * @returns whether the session is currently paused.
   */
  isPaused(sessionId: SessionId): boolean {
    return this.paused.has(sessionId)
  }

  /**
   * Pause one session: its next model request is held until {@link resume}. A
   * request already past the waterfall keeps running — pausing never
   * interrupts a model call or a tool call that has started.
   * @param sessionId - session to pause.
   * @returns whether this call changed the state.
   */
  pause(sessionId: SessionId): boolean {
    if (this.paused.has(sessionId)) return false
    const release = latch()
    this.paused.set(sessionId, { released: release.promise, release: release.open })
    this.notify(sessionId, true)
    return true
  }

  /**
   * Resume one session: release everything it holds and stop holding what
   * follows. The requests sent from then on are the ones built before the
   * hold, so a resumed session continues from the point it stopped.
   * @param sessionId - session to resume.
   * @returns whether this call changed the state.
   */
  resume(sessionId: SessionId): boolean {
    const pause = this.paused.get(sessionId)
    if (pause === undefined) return false
    this.paused.delete(sessionId)
    pause.release()
    this.notify(sessionId, false)
    return true
  }

  /**
   * The wait one model request must finish before it may delegate.
   * @param request - the request reaching the waterfall.
   * @returns the wait, or `undefined` when this gate does not hold that request.
   */
  hold(request: GenerateOptions): Promise<void> | undefined {
    // Context compaction and session titling are background model work inside
    // the same session and carry a purpose; a session pause must never freeze
    // them. Only a request the loop built for its own turn is gateable.
    if (request.purpose !== undefined) return undefined
    const sessionId = request.sessionId
    if (sessionId === undefined) return undefined
    const pause = this.paused.get(sessionId)
    if (pause === undefined) return undefined
    return raceRelease(
      pause.released,
      request.signal === undefined ? [this.options.lifetime] : [request.signal, this.options.lifetime],
    )
  }

  /**
   * The `llm/stream` listener.
   *
   * `ctx.waterfall` composes listeners synchronously, so this returns an async
   * iterator synchronously — an `async` listener would hand the loop a promise
   * where it iterates a stream. One generator body reaches `next()` at most
   * once, which is what makes delegation single-shot per HELD request; a flag
   * shared across requests would also short-circuit everything issued after
   * the release.
   * @param request - the full request, already built and frozen by the loop.
   * @param next - the downstream waterfall chain.
   * @returns the stream, delayed until this request may delegate.
   */
  readonly stream = (request: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> => {
    const gate = this
    return (async function* gated(): AsyncIterable<StreamChunk> {
      const held = gate.hold(request)
      if (held !== undefined) await held
      // The race decides when to stop waiting; the signals decide whether
      // delegating is allowed at this exact moment. A request whose phase
      // aborted, or whose plugin unloaded, must never reach the adapter.
      if (request.signal?.aborted === true) throw abortError(request.signal)
      if (gate.options.lifetime.aborted) throw new Error(PLUGIN_UNLOADED)
      yield* next()
    })()
  }

  private notify(sessionId: SessionId, paused: boolean): void {
    for (const listener of [...this.listeners]) listener(sessionId, paused)
  }
}
