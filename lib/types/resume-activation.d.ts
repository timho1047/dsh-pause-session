/**
 * Reactivate one parked Session and deliver the wake it owes.
 *
 * The two Session kinds come back through different owners. An ordinary
 * Session is loaded by this plugin and given the route its own log recorded.
 * A subagent child belongs to the subagent runtime: delivering the wake through
 * `ctx.subagents.prompt` is what cold-resumes it as a managed activation, under
 * its live tree root, with its persisted composition and tree membership
 * restored by the runtime itself.
 *
 * Both paths keep the same release order: the durable record goes first, then
 * the gate, so a record that cannot be dropped leaves the Session parked.
 * @module dsh-pause-session/resume-activation
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { PauseGate } from './gate.js';
import type { ParkRegistry } from './registry.js';
import type { ResumeAttempt, ResumeOptions, WakeRequest } from './resume-text.js';
/** The activation entry points the resume path composes. */
export interface Activator {
    activate(sessionId: SessionId, request: WakeRequest, rearm: boolean, signal?: AbortSignal): Promise<ResumeAttempt>;
    ensureRoute(agent: Agent): void;
    wake(agent: Agent, request: WakeRequest): void;
    rearmGoal(agent: Agent): void;
}
/**
 * Build the activation closure.
 * @param ctx - host context carrying the agent store, subagent runtime, and goal service.
 * @param gate - the pause gate released after activation.
 * @param registry - the durable list the release forgets from.
 * @param options - the route knowledge the root wake content depends on.
 * @returns the activation methods the resume path uses.
 */
export declare function createActivator(ctx: Context, gate: PauseGate, registry: ParkRegistry, options: ResumeOptions): Activator;
