/**
 * One session's park episode: the durable phase writes, the activity walk that
 * settles them, and the press/release lifecycle. The control composes this with
 * the aggregate, the resume path, and the decision list.
 * @module dsh-pause-session/park-state
 */
import { isResumableSession } from './composition.js';
import { describeError, UNRECORDED_TEXT } from './shared.js';
/**
 * Mount the park episode state machine over the gate, registry, and activity fold.
 * @param ctx - host context carrying the session store and logger.
 * @param gate - the pause gate this state drives.
 * @param registry - the durable pause list every phase write goes to.
 * @param watch - the activity fold the park predicate reads.
 * @returns the park lifecycle the control composes.
 */
export function installParkState(ctx, gate, registry, watch) {
    const marks = new Map();
    const unrecorded = new Set();
    const unheld = new Set();
    const listeners = new Set();
    let notification;
    let generation = 0;
    /** One snapshot per burst of host changes, not one per phase write. */
    const notify = () => {
        if (notification !== undefined)
            return;
        notification = setTimeout(() => {
            notification = undefined;
            for (const listener of [...listeners])
                listener();
        }, 20);
    };
    const drop = (sessionId) => {
        marks.delete(sessionId);
        notify();
    };
    const commit = async (sessionId, mark, phase) => {
        try {
            await registry.record(sessionId, phase);
        }
        catch (error) {
            ctx.logger.warn(`pause: could not record the park state of "${sessionId}" as ${phase}: ${describeError(error)}`);
            return false;
        }
        const changed = mark.phase !== phase;
        mark.phase = phase;
        if (changed)
            notify();
        return true;
    };
    const parked = (sessionId) => {
        const activity = watch.activity(sessionId);
        if (activity.runningTools.length > 0)
            return false;
        return gate.isHeld(sessionId) || !activity.turnOpen;
    };
    const advance = (sessionId) => {
        const mark = marks.get(sessionId);
        if (mark === undefined || mark.phase !== 'draining' || mark.advancing)
            return false;
        if (mark.origin === 'registry')
            return false;
        if (!parked(sessionId))
            return false;
        mark.advancing = true;
        return true;
    };
    const settle = async (sessionId, attempt) => {
        const mark = marks.get(sessionId);
        if (mark === undefined || mark.generation !== attempt)
            return;
        const owned = () => marks.get(sessionId) === mark && mark.generation === attempt;
        const session = ctx.sessions.get(sessionId);
        try {
            if (session === undefined) {
                await commit(sessionId, mark, 'parking');
                return;
            }
            await commit(sessionId, mark, 'parking');
            if (!owned())
                return;
            try {
                const flushed = await ctx.sessions.flush(session);
                if (!flushed) {
                    await commit(sessionId, mark, 'flush-failed');
                    return;
                }
            }
            catch (error) {
                if (!owned())
                    return;
                ctx.logger.warn(`pause: flush failed for "${sessionId}": ${describeError(error)}`);
                await commit(sessionId, mark, 'flush-failed');
                return;
            }
            if (!owned())
                return;
            await commit(sessionId, mark, 'safe');
        }
        finally {
            if (marks.get(sessionId) === mark && mark.phase === 'draining')
                mark.advancing = false;
        }
    };
    const look = (sessionId) => {
        if (marks.has(sessionId))
            notify();
        if (!advance(sessionId))
            return;
        const attempt = marks.get(sessionId)?.generation;
        if (attempt !== undefined)
            void settle(sessionId, attempt);
    };
    const press = async (sessionId, signal, knownResumable = false) => {
        if (ctx.sessions.get(sessionId) === undefined)
            return 'not-live';
        if (!knownResumable && !await isResumableSession(ctx, sessionId, signal))
            return 'not-resumable';
        if (!gate.pause(sessionId))
            return 'already-paused';
        const mark = { phase: 'draining', generation: ++generation, origin: 'press', advancing: false };
        marks.set(sessionId, mark);
        if (await commit(sessionId, mark, 'draining')) {
            unheld.delete(sessionId);
            notify();
            return 'registered';
        }
        drop(sessionId);
        gate.resume(sessionId);
        return 'unrecordable';
    };
    const release = async (sessionId, text) => {
        if (!gate.isPaused(sessionId))
            return { kind: 'success', text };
        try {
            await registry.forget(sessionId);
        }
        catch (error) {
            ctx.logger.warn(`pause: could not drop "${sessionId}" from the pause registry: ${describeError(error)}`);
            return { kind: 'error', text: UNRECORDED_TEXT };
        }
        gate.resume(sessionId);
        notify();
        return { kind: 'success', text };
    };
    const sync = (sessionId) => {
        if (!gate.isPaused(sessionId)) {
            drop(sessionId);
            return;
        }
    };
    return {
        marks,
        unrecorded,
        unheld,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        notify,
        press,
        adopt: (sessionId, phase) => {
            marks.set(sessionId, { phase, generation: ++generation, origin: 'registry', advancing: false });
        },
        look,
        drop,
        sync,
        release,
        markUnrecorded: (sessionId, blocked) => {
            if (blocked)
                unrecorded.add(sessionId);
            else
                unrecorded.delete(sessionId);
        },
        live: () => new Map([...marks].map(([sessionId, mark]) => [sessionId, {
                phase: mark.phase,
                moving: mark.origin === 'press' && mark.phase !== 'flush-failed' && ctx.sessions.get(sessionId) !== undefined,
            }])),
        cleanup: () => {
            if (notification !== undefined)
                clearTimeout(notification);
            marks.clear();
            listeners.clear();
        },
    };
}
//# sourceMappingURL=park-state.js.map