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
/**
 * Open the native status stream and expose its latest snapshot to both controls.
 * @param remote - the generated Remote namespace.
 * @param lifetime - client lifetime; aborting it releases the stream.
 * @returns the cached source and its change subscription.
 */
export function openRemoteSource(remote, lifetime) {
    let latest;
    let failed = false;
    let first;
    const listeners = new Set();
    const snapshotListeners = new Set();
    const notify = () => {
        for (const listener of [...listeners])
            listener();
        for (const listener of [...snapshotListeners])
            listener(failed ? undefined : latest);
    };
    const ready = new Promise((resolve) => { first = resolve; });
    void (async () => {
        try {
            for await (const snapshot of remote.observe(lifetime)) {
                latest = snapshotOf(snapshot);
                first?.();
                first = undefined;
                notify();
            }
        }
        catch {
            failed = true;
            latest = undefined;
            notify();
        }
        finally {
            // A stream that ended without a cancellation is not a live transport; the
            // controls must report unavailable rather than keep serving the last value.
            if (!lifetime.aborted) {
                failed = true;
                latest = undefined;
            }
            first?.();
            first = undefined;
            notify();
        }
    })();
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
            if (latest === undefined && !failed) {
                await new Promise((resolve) => {
                    const done = () => { signal?.removeEventListener('abort', done); resolve(); };
                    first = () => { first = undefined; done(); };
                    signal?.addEventListener('abort', done, { once: true });
                    if (latest !== undefined || failed)
                        done();
                });
            }
            signal?.throwIfAborted();
            return failed ? undefined : latest;
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