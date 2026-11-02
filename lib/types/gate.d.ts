/**
 * The pause gate: one session's hold at the model-request waterfall.
 *
 * The hold sits on the `llm/stream` waterfall, which is the only point that
 * satisfies all four conditions at once: the previous step's tool calls have
 * drained, the request is already built, the session's pending input is
 * committed, and — because nothing pulls the adapter — no timer is armed
 * anywhere. Machine sleep, network loss, and the adapter's stream-idle
 * watchdog therefore cannot touch a parked request.
 * @module dsh-pause-session/gate
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
/** Message of the failure a held request ends with when its plugin unloads first. */
export declare const PLUGIN_UNLOADED = "pause: plugin lifetime ended while a request was held";
/** Options of {@link PauseGate}. */
export interface PauseGateOptions {
    /** Aborted when the owning plugin unloads; a held request must never delegate after that. */
    readonly lifetime: AbortSignal;
}
/** Per-session pause state and the waterfall listener that enforces it. */
export declare class PauseGate {
    private readonly options;
    /** Paused sessions; membership IS the pause state. */
    private readonly paused;
    private readonly listeners;
    private readonly heldListeners;
    /**
     * @param options - the plugin-lifetime signal every held request races.
     */
    constructor(options: PauseGateOptions);
    /**
     * Subscribe to pause-state changes.
     * @param listener - called with the session whose state changed and its new state.
     * @returns the unsubscribe function.
     */
    onChange(listener: (sessionId: SessionId, paused: boolean) => void): () => void;
    /**
     * Subscribe to "a request arrived at / left the gate" for a paused session.
     *
     * This is the moment a session can become parked, so it is also the moment a
     * park observer has to look. Listeners run synchronously inside the request
     * path: they must only record that a look is owed.
     * @param listener - called with the session and whether it now holds a request.
     * @returns the unsubscribe function.
     */
    onHeld(listener: (sessionId: SessionId, held: boolean) => void): () => void;
    /**
     * @param sessionId - session to inspect.
     * @returns whether the session is currently paused.
     */
    isPaused(sessionId: SessionId): boolean;
    /**
     * @param sessionId - session to inspect.
     * @returns whether a model request of that session is waiting at the gate
     * right now. False for a session that is paused but whose loop has not built
     * its next request yet — a running tool, for instance, is still draining.
     */
    isHeld(sessionId: SessionId): boolean;
    /**
     * Enter one request that is about to wait. The count rises synchronously with
     * {@link hold}, so an observer notified at that moment reads `isHeld` as true.
     * @param pause - the session's pause record.
     * @returns the exit that lowers the count again.
     */
    private enter;
    /**
     * Pause one session: its next model request is held until {@link resume}. A
     * request already past the waterfall keeps running — pausing never
     * interrupts a model call or a tool call that has started.
     * @param sessionId - session to pause.
     * @returns whether this call changed the state.
     */
    pause(sessionId: SessionId): boolean;
    /**
     * Resume one session: release everything it holds and stop holding what
     * follows. The requests sent from then on are the ones built before the
     * hold, so a resumed session continues from the point it stopped.
     * @param sessionId - session to resume.
     * @returns whether this call changed the state.
     */
    resume(sessionId: SessionId): boolean;
    /**
     * The wait one model request must finish before it may delegate, and the exit
     * that reports the request as no longer waiting.
     * @param request - the request reaching the waterfall.
     * @returns the wait plus its release, or `undefined` when this gate does not
     * hold that request.
     */
    hold(request: GenerateOptions): {
        readonly wait: Promise<void>;
        readonly left: () => void;
    } | undefined;
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
    readonly stream: (request: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>;
    private notify;
    private notifyHeld;
}
