/**
 * Reactivate one parked session: restore its composition, give it the route its
 * log recorded, deliver the wake it owes, and only then drop the gate and record.
 * @module dsh-pause-session/resume-activation
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { UnresumableSessionError, restoreComposition } from './composition.js';
import { owesReply } from './history.js';
import { describeError, UNRECORDED_TEXT } from './shared.js';
import { ACTIVATION_FAILED_TEXT, RESUMED_TEXT, UNRESUMABLE_TEXT, WAKE_MARKER, } from './resume-text.js';
/**
 * Build the activation closure.
 * @param ctx - host context carrying the agent store and goal service.
 * @param gate - the pause gate released after activation.
 * @param registry - the durable list the release forgets from.
 * @param options - the route knowledge the wake content depends on.
 * @returns the activation methods the resume path uses.
 */
export function createActivator(ctx, gate, registry, options) {
    const routeOf = (session) => session.requestHeader()?.config;
    const ensureRoute = (agent) => {
        if (agent.model.current() !== undefined)
            return;
        const config = routeOf(agent.session);
        if (config === undefined)
            return;
        agent.model.select({
            provider: config.provider,
            model: config.model,
            ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
        });
    };
    const wakeContent = (provider) => options.silentWakeRoutes.includes(provider) ? [] : [{ type: 'text', text: WAKE_MARKER }];
    const wake = (agent, request) => {
        if (request.kind === 'none')
            return;
        if (gate.isHeld(agent.id) || agent.status !== 'idle')
            return;
        if (!owesReply(agent.session.deriveMessages()))
            return;
        const provider = routeOf(agent.session)?.provider;
        if (provider === undefined)
            return;
        const content = request.kind === 'message'
            ? [{ type: 'text', text: request.text }]
            : wakeContent(provider);
        agent.followup(createUserMessage({ content, source: { kind: 'pause' } }));
    };
    const rearmGoal = (agent) => {
        const goals = ctx.get('goals');
        if (goals === undefined)
            return;
        try {
            const goal = goals.get(agent);
            if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'disarmed')
                return;
            if (goal.roundsStarted >= goal.maxGoalRounds)
                return;
            goals.resume(agent, { id: goal.id, revision: goal.revision });
        }
        catch (error) {
            ctx.logger.warn(`pause: could not re-open the goal of "${agent.id}": ${describeError(error)}`);
        }
    };
    const activate = async (sessionId, request, rearm, parentId, signal) => {
        const parent = parentId === undefined ? undefined : ctx.agents.get(parentId);
        let agent;
        try {
            const composition = await restoreComposition(ctx, sessionId, parent, signal);
            agent = (await ctx.root.agents.resume({
                resumeSessionId: sessionId,
                ...parent === undefined ? {} : { parentAgent: parent },
                ...composition,
                ...signal === undefined ? {} : { signal },
            })).agent;
        }
        catch (error) {
            if (error instanceof UnresumableSessionError) {
                return {
                    sessionId,
                    resumed: false,
                    refusal: 'unresumable',
                    answer: { kind: 'error', text: UNRESUMABLE_TEXT },
                };
            }
            ctx.logger.warn(`pause: could not open "${sessionId}" from its stored log: ${describeError(error)}`);
            return {
                sessionId,
                resumed: false,
                refusal: 'activation-failed',
                answer: { kind: 'error', text: ACTIVATION_FAILED_TEXT },
            };
        }
        ensureRoute(agent);
        wake(agent, request);
        try {
            await registry.forget(sessionId);
        }
        catch (error) {
            ctx.logger.warn(`pause: could not drop "${sessionId}" from the pause registry: ${describeError(error)}`);
            return { sessionId, resumed: false, refusal: 'unrecorded', answer: { kind: 'error', text: UNRECORDED_TEXT } };
        }
        gate.resume(sessionId);
        if (rearm)
            rearmGoal(agent);
        return { sessionId, resumed: true, answer: { kind: 'success', text: RESUMED_TEXT } };
    };
    return { activate, ensureRoute, wake, rearmGoal };
}
//# sourceMappingURL=resume-activation.js.map