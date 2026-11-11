/**
 * What a parked Session needs to come back as itself.
 *
 * A root Session is loaded directly: the Agent preset it ran supplies the
 * scoped tools, prompt sections, and skills, so the resume mounts that preset
 * before the Agent is published. A subagent child is not loaded here at all —
 * the subagent runtime owns its activation, composition, and tree membership,
 * and cold-resumes it when this plugin delivers the wake through
 * `ctx.subagents.prompt`.
 *
 * The two cases are told apart by one read of the Session's own log, which is
 * the same read the press-time resumability check already pays for.
 * @module dsh-pause-session/composition
 */
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent';
/**
 * Whether a local Session may be parked under a promise of a later resume.
 *
 * A normal root Session has no child descriptor and is resumable. A local
 * subagent child is resumable only when its own durable descriptor is
 * `continuable`; a historical `one-shot` child is terminal and must never be
 * registered as a park the morning path would later have to refuse. External
 * executions have no local Session, so callers never reach this check.
 *
 * A profile without the optional Session-query service cannot prove the
 * descriptor's mode; it keeps the previous permissive behavior rather than
 * dropping every subagent. The web profile mounts the query service.
 * @param ctx - host context carrying the optional Session-query service.
 * @param sessionId - the local Session to inspect.
 * @param signal - cancellation for the observation read.
 * @returns whether a park of this Session may be resumed.
 * @throws the cancellation reason when `signal` aborts the read.
 */
export async function isResumableSession(ctx, sessionId, signal) {
    const query = ctx.get('sessionQuery');
    if (query === undefined)
        return true;
    const observation = await query.observeSession(sessionId, {
        ...signal === undefined ? {} : { signal },
    });
    try {
        const ownEvents = observation.events.slice(observation.inheritedEventCount);
        return foldSubagentDescriptor(ownEvents)?.mode !== 'one-shot';
    }
    finally {
        observation[Symbol.dispose]();
    }
}
/**
 * Read one parked Session's own log and decide how it comes back.
 *
 * A child returns as `child` with no setup: the subagent runtime restores the
 * composition from the descriptor and the preset projection, and mounting a
 * second one here would start a different Agent on the same history.
 *
 * A root resolves the preset it ran — the projection, never the creation-time
 * header alone, because a blank Session may select another preset before its
 * first turn — and hands back the setup that mounts it. A profile with no
 * preset roster has no scoped composition to restore and resumes unchanged.
 * @param ctx - host context carrying the optional preset and Session-query services.
 * @param sessionId - the parked Session being resumed.
 * @param signal - cancellation for the observation read.
 * @returns how this Session comes back.
 * @throws when a mounted preset roster cannot read the Session projection.
 */
export async function readParkedComposition(ctx, sessionId, signal) {
    const presets = ctx.get('agentPresets');
    const query = ctx.get('sessionQuery');
    if (query === undefined) {
        // Without the query service nothing can prove the Session's composition; a
        // profile that mounts a preset roster must not start a different Agent.
        if (presets !== undefined) {
            throw new Error('resuming a composed Agent requires the session-query service');
        }
        return { kind: 'root' };
    }
    const observation = await query.observeSession(sessionId, {
        ...signal === undefined ? {} : { signal },
    });
    try {
        const ownEvents = observation.events.slice(observation.inheritedEventCount);
        // A durable descriptor is the child's own record; `origin` covers a child
        // whose descriptor predates the current format. An ordinary fork also
        // carries `parentSession`, so that field alone is not a child signal.
        if (foldSubagentDescriptor(ownEvents) !== undefined || observation.header.origin === 'subagent') {
            return { kind: 'child' };
        }
        if (presets === undefined)
            return { kind: 'root' };
        const projections = observation.projections;
        if (projections === undefined) {
            throw new Error('resuming a composed Agent requires projected Session state');
        }
        // A root names its own preset; a Session that never selected one follows
        // the roster's default, exactly as the official Session controller does.
        const resolved = await presets.resolve(projections.values.agentPreset ?? undefined);
        return {
            kind: 'root',
            setup: async (agentCtx) => { await presets.mount(agentCtx, resolved.id); },
        };
    }
    finally {
        observation[Symbol.dispose]();
    }
}
//# sourceMappingURL=composition.js.map