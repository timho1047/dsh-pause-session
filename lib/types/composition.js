/**
 * Rebuild the scoped Agent composition a parked Session ran under.
 *
 * Activation is not only a persisted Session: the Agent preset supplies the
 * scoped tools, prompt sections, skills, and — for a subagent child — the
 * delegation context, persona, and tool restriction that were in force before
 * the park. A resume that loads the log without that setup starts a different
 * Agent on the same history.
 *
 * The preset a Session runs is the `agentPreset` projection, never the
 * creation-time header alone: a blank Session may select another preset before
 * its first turn, and the projection records the selection that actually ran.
 * A child with no independent selection joins its live parent's preset
 * generation; one that selected independently mounts the projected preset.
 * The durable child descriptor supplies the persona, tool filter, and route
 * that are reapplied only on cold resume.
 *
 * Both services are optional. A profile without `agentPresets` has no scoped
 * preset composition to restore, and this module leaves the resume unchanged.
 * A profile that mounts one but cannot read the Session projection cannot
 * prove what composition the Session ran, so it fails the resume instead of
 * silently starting a different Agent.
 * @module dsh-pause-session/composition
 */
import { applyChildComposition, foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent';
/**
 * A stored subagent route that no resume may reactivate.
 *
 * A one-shot child is terminal by contract; activating it as a root Agent
 * would turn a finished delegation into an ordinary conversation that happens
 * to share its Session id.
 */
export class UnresumableSessionError extends Error {
    constructor(sessionId) {
        super(`subagent session "${String(sessionId)}" has a one-shot route and cannot be resumed`);
        this.name = 'UnresumableSessionError';
    }
}
/**
 * Whether the child's own log selected a preset before its descriptor.
 *
 * The creation-time selection precedes the first `subagent/descriptor`; a
 * selection after the descriptor belongs to the child's own later history and
 * does not decide which composition cold resume joins. This mirrors the
 * subagent runtime's own cold-resume rule.
 * @param events - the child's own log suffix, without the fork-inherited prefix.
 * @returns whether the child carries an independent preset selection.
 */
export function hasIndependentPresetSelection(events) {
    for (const event of events) {
        if (event.type === 'subagent/descriptor')
            return false;
        if (event.type === 'agent-preset/selected')
            return true;
    }
    return false;
}
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
 * Read one parked Session's stored composition and build the resume options.
 *
 * The returned `setup` belongs to the unpublished Agent scope, so all
 * registrations exist before `agent/created`. For a root Session the setup
 * mounts the Session's projected preset, or the profile's default when the
 * Session never selected one. For a child under a live parent it applies the
 * child composition: an independent preset mounts separately, while an
 * inherited composition joins the parent's current generation; the historical
 * descriptor's persona and tool filter are reapplied in both cases.
 * @param ctx - host context carrying the optional preset and Session-query services.
 * @param sessionId - the parked Session being resumed.
 * @param parent - the live direct parent, when a child is resumed under it.
 * @param signal - cancellation for the observation read.
 * @returns the Agent options and setup to pass to `agents.resume`.
 * @throws {UnresumableSessionError} when the stored child route is one-shot.
 * @throws when a mounted preset roster cannot read the Session projection, or
 * a recorded preset cannot be restored.
 */
export async function restoreComposition(ctx, sessionId, parent, signal) {
    const presets = ctx.get('agentPresets');
    const query = ctx.get('sessionQuery');
    if (query === undefined) {
        if (presets !== undefined) {
            throw new Error('resuming a composed Agent requires the session-query service');
        }
        return {};
    }
    const observation = await query.observeSession(sessionId, {
        ...(signal === undefined ? {} : { signal }),
    });
    try {
        const projections = observation.projections;
        const ownEvents = observation.events.slice(observation.inheritedEventCount);
        const descriptor = foldSubagentDescriptor(ownEvents);
        if (descriptor?.mode === 'one-shot')
            throw new UnresumableSessionError(sessionId);
        if (presets === undefined || projections === undefined) {
            if (presets !== undefined) {
                throw new Error('resuming a composed Agent requires projected Session state');
            }
            return {};
        }
        if (parent === undefined) {
            // A root names its own preset; a Session that never selected one follows
            // the roster's default, exactly as the official Session controller does.
            const resolved = await presets.resolve(projections.values.agentPreset ?? undefined);
            return {
                setup: async (agentCtx) => { await presets.mount(agentCtx, resolved.id); },
            };
        }
        const independentlySelected = hasIndependentPresetSelection(ownEvents);
        const presetId = independentlySelected ? projections.values.agentPreset : undefined;
        if (independentlySelected && typeof presetId !== 'string') {
            throw new Error(`subagent "${String(sessionId)}" has no projected agent preset to restore`);
        }
        const composition = {
            ...typeof presetId === 'string' ? { agentPreset: presetId } : {},
            ...descriptor?.mode === 'continuable' && descriptor.persona !== undefined
                ? { persona: descriptor.persona }
                : {},
            ...descriptor?.mode === 'continuable' && descriptor.toolFilter !== undefined
                ? { toolFilter: descriptor.toolFilter }
                : {},
        };
        const agentOptions = descriptor?.mode === 'continuable'
            ? {
                ...descriptor.agentProvider === undefined ? {} : { provider: descriptor.agentProvider },
                ...descriptor.agentModel === undefined ? {} : { model: descriptor.agentModel },
                ...descriptor.agentReasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: descriptor.agentReasoningEffort },
            }
            : undefined;
        return {
            ...agentOptions === undefined ? {} : { agentOptions },
            setup: async (agentCtx) => { await applyChildComposition(agentCtx, parent, composition); },
        };
    }
    finally {
        observation[Symbol.dispose]();
    }
}
//# sourceMappingURL=composition.js.map