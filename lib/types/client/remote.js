/**
 * Client-side bridge from the generated `pauseSession` Remote namespace to the
 * control state machines.
 *
 * The native namespace is the only transport: the stream supplies snapshots and
 * the action methods drive every button. No slash command is involved.
 * @module dsh-pause-session/client/remote
 */
/** Convert one wire snapshot to the host-status vocabulary the controls already use. */
function snapshotOf(wire) {
    return {
        global: {
            ...wire.global,
            parkedAt: wire.global.parkedAt,
            draining: wire.global.draining,
            stalled: wire.global.stalled,
            unresumable: wire.global.unresumable,
            unreadTrees: wire.global.unreadTrees,
            jobs: wire.global.jobs,
            blind: wire.global.blind,
        },
        sessions: Object.fromEntries(Object.entries(wire.sessions).map(([id, status]) => [id, status])),
    };
}
/** First retry delay after the stream drops, in milliseconds. */
const RECONNECT_BASE_MS = 300;
/** Ceiling for the reconnect backoff, in milliseconds. */
const RECONNECT_MAX_MS = 5_000;
/**
 * Open the native status stream and expose its latest snapshot to both controls.
 *
 * The stream owns no retry of its own: a carrier can drop it on a mux reconnect,
 * a host reload, or a network blip, and the controls must not stay unavailable
 * until the page is refreshed. This source reconnects with a bounded backoff and
 * republishes the new snapshot; while it is disconnected the last value is
 * discarded, so readers see "unavailable" rather than a stale claim.
 * @param remote - the generated Remote namespace.
 * @param lifetime - client lifetime; aborting it releases the stream.
 * @returns the cached source and its change subscription.
 */
export function openRemoteSource(remote, lifetime) {
    let latest;
    let attempt = 0;
    let timer;
    /** Readers waiting for the first snapshot of any attempt. */
    const waiters = new Set();
    const listeners = new Set();
    const snapshotListeners = new Set();
    const notify = () => {
        for (const wake of [...waiters])
            wake();
        waiters.clear();
        for (const listener of [...listeners])
            listener();
        for (const listener of [...snapshotListeners])
            listener(latest);
    };
    const schedule = () => {
        if (lifetime.aborted || timer !== undefined)
            return;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
        attempt += 1;
        timer = setTimeout(() => {
            timer = undefined;
            void pump();
        }, delay);
    };
    const pump = async () => {
        if (lifetime.aborted)
            return;
        try {
            for await (const snapshot of remote.observe(lifetime)) {
                // A delivered snapshot proves this attempt healthy; the next drop starts
                // its backoff from the short delay again.
                attempt = 0;
                latest = snapshotOf(snapshot);
                notify();
            }
        }
        catch {
            // The carrier failed. Everything this attempt could have delivered is
            // already published; the retry below owns the recovery.
        }
        if (lifetime.aborted)
            return;
        latest = undefined;
        notify();
        schedule();
    };
    void pump();
    return {
        onChange: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        onSnapshot: (listener) => {
            snapshotListeners.add(listener);
            return () => { snapshotListeners.delete(listener); };
        },
        read: async (signal) => {
            if (latest === undefined && !lifetime.aborted) {
                await new Promise((resolve) => {
                    // Every reader gets its own wakeup: the two header controls mount
                    // together and both ask before the opening snapshot lands.
                    const wake = () => {
                        waiters.delete(wake);
                        signal?.removeEventListener('abort', wake);
                        resolve();
                    };
                    waiters.add(wake);
                    signal?.addEventListener('abort', wake, { once: true });
                });
            }
            signal?.throwIfAborted();
            return latest;
        },
    };
}
/**
 * Build the direct transport over one mounted Remote namespace.
 * @param remote - the generated `pauseSession` namespace.
 * @param lifetime - client lifetime.
 * @returns the source and action methods the controls use.
 */
export function remoteTransport(remote, lifetime) {
    const source = openRemoteSource(remote, lifetime);
    const failed = () => ({ ok: false, message: 'pause action failed' });
    return {
        source,
        act: async (request, signal) => {
            const answer = await remote.act(request, signal);
            return answer.ok ? (answer.value ?? failed()) : failed();
        },
        triage: async (caller, signal) => {
            const answer = await remote.triage({ caller }, signal);
            return answer.ok ? answer.value : undefined;
        },
        decide: async (caller, target, decision, signal) => {
            const answer = await remote.decide({ caller, target, decision }, signal);
            return answer.ok ? (answer.value ?? failed()) : failed();
        },
    };
}
//# sourceMappingURL=remote.js.map