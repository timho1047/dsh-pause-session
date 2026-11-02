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
/** Message of the failure a held request ends with when its plugin unloads first. */
export const PLUGIN_UNLOADED = 'pause: plugin lifetime ended while a request was held';
/** The abort signal's own error, or a stable one when the abort carried no reason. */
function abortError(signal) {
    return signal.reason instanceof Error ? signal.reason : new Error('pause: request aborted while held');
}
/** A latch without `Promise.withResolvers`, which this project's ES2022 lib predates. */
function latch() {
    let open = () => { };
    const promise = new Promise((resolve) => { open = resolve; });
    return { promise, open };
}
/**
 * Resolve once the session is released or any of `signals` aborts. No timer is
 * armed: the wait ends only by release or by an abort, so a parked request
 * cannot be woken by the clock. Listeners are removed once the wait settles.
 */
function raceRelease(released, signals) {
    const wake = latch();
    const onAbort = () => { wake.open(); };
    const watching = signals.filter(signal => !signal.aborted);
    if (watching.length !== signals.length)
        wake.open();
    for (const signal of watching)
        signal.addEventListener('abort', onAbort, { once: true });
    return Promise.race([released, wake.promise]).finally(() => {
        for (const signal of watching)
            signal.removeEventListener('abort', onAbort);
    });
}
/** Per-session pause state and the waterfall listener that enforces it. */
export class PauseGate {
    options;
    /** Paused sessions; membership IS the pause state. */
    paused = new Map();
    listeners = new Set();
    heldListeners = new Set();
    /**
     * @param options - the plugin-lifetime signal every held request races.
     */
    constructor(options) {
        this.options = options;
    }
    /**
     * Subscribe to pause-state changes.
     * @param listener - called with the session whose state changed and its new state.
     * @returns the unsubscribe function.
     */
    onChange(listener) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    /**
     * Subscribe to "a request arrived at / left the gate" for a paused session.
     *
     * This is the moment a session can become parked, so it is also the moment a
     * park observer has to look. Listeners run synchronously inside the request
     * path: they must only record that a look is owed.
     * @param listener - called with the session and whether it now holds a request.
     * @returns the unsubscribe function.
     */
    onHeld(listener) {
        this.heldListeners.add(listener);
        return () => { this.heldListeners.delete(listener); };
    }
    /**
     * @param sessionId - session to inspect.
     * @returns whether the session is currently paused.
     */
    isPaused(sessionId) {
        return this.paused.has(sessionId);
    }
    /**
     * @param sessionId - session to inspect.
     * @returns whether a model request of that session is waiting at the gate
     * right now. False for a session that is paused but whose loop has not built
     * its next request yet — a running tool, for instance, is still draining.
     */
    isHeld(sessionId) {
        return (this.paused.get(sessionId)?.holding ?? 0) > 0;
    }
    /**
     * Enter one request that is about to wait. The count rises synchronously with
     * {@link hold}, so an observer notified at that moment reads `isHeld` as true.
     * @param pause - the session's pause record.
     * @returns the exit that lowers the count again.
     */
    enter(pause) {
        pause.holding += 1;
        this.notifyHeld(pause.sessionId, true);
        return () => {
            pause.holding -= 1;
            if (pause.holding === 0)
                this.notifyHeld(pause.sessionId, false);
        };
    }
    /**
     * Pause one session: its next model request is held until {@link resume}. A
     * request already past the waterfall keeps running — pausing never
     * interrupts a model call or a tool call that has started.
     * @param sessionId - session to pause.
     * @returns whether this call changed the state.
     */
    pause(sessionId) {
        if (this.paused.has(sessionId))
            return false;
        const release = latch();
        this.paused.set(sessionId, { sessionId, released: release.promise, release: release.open, holding: 0 });
        this.notify(sessionId, true);
        return true;
    }
    /**
     * Resume one session: release everything it holds and stop holding what
     * follows. The requests sent from then on are the ones built before the
     * hold, so a resumed session continues from the point it stopped.
     * @param sessionId - session to resume.
     * @returns whether this call changed the state.
     */
    resume(sessionId) {
        const pause = this.paused.get(sessionId);
        if (pause === undefined)
            return false;
        this.paused.delete(sessionId);
        pause.release();
        this.notify(sessionId, false);
        return true;
    }
    /**
     * The wait one model request must finish before it may delegate, and the exit
     * that reports the request as no longer waiting.
     * @param request - the request reaching the waterfall.
     * @returns the wait plus its release, or `undefined` when this gate does not
     * hold that request.
     */
    hold(request) {
        // Context compaction and session titling are background model work inside
        // the same session and carry a purpose; a session pause must never freeze
        // them. Only a request the loop built for its own turn is gateable.
        if (request.purpose !== undefined)
            return undefined;
        const sessionId = request.sessionId;
        if (sessionId === undefined)
            return undefined;
        const pause = this.paused.get(sessionId);
        if (pause === undefined)
            return undefined;
        const left = this.enter(pause);
        const wait = raceRelease(pause.released, request.signal === undefined ? [this.options.lifetime] : [request.signal, this.options.lifetime]);
        return { wait, left };
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
    stream = (request, next) => {
        const gate = this;
        return (async function* gated() {
            const held = gate.hold(request);
            try {
                if (held !== undefined)
                    await held.wait;
                // The race decides when to stop waiting; the signals decide whether
                // delegating is allowed at this exact moment. A request whose phase
                // aborted, or whose plugin unloaded, must never reach the adapter.
                if (request.signal?.aborted === true)
                    throw abortError(request.signal);
                if (gate.options.lifetime.aborted)
                    throw new Error(PLUGIN_UNLOADED);
                yield* next();
            }
            finally {
                // Leaving is what tells an observer the session stopped standing at
                // the park point — whether it delegated or aborted.
                held?.left();
            }
        })();
    };
    notify(sessionId, paused) {
        for (const listener of [...this.listeners])
            listener(sessionId, paused);
    }
    notifyHeld(sessionId, held) {
        for (const listener of [...this.heldListeners])
            listener(sessionId, held);
    }
}
//# sourceMappingURL=gate.js.map