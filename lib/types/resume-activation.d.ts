/**
 * Reactivate one parked session: restore its composition, give it the route its
 * log recorded, deliver the wake it owes, and only then drop the gate and record.
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
    activate(sessionId: SessionId, request: WakeRequest, rearm: boolean, parentId?: SessionId, signal?: AbortSignal): Promise<ResumeAttempt>;
    ensureRoute(agent: Agent): void;
    wake(agent: Agent, request: WakeRequest): void;
    rearmGoal(agent: Agent): void;
}
/**
 * Build the activation closure.
 * @param ctx - host context carrying the agent store and goal service.
 * @param gate - the pause gate released after activation.
 * @param registry - the durable list the release forgets from.
 * @param options - the route knowledge the wake content depends on.
 * @returns the activation methods the resume path uses.
 */
export declare function createActivator(ctx: Context, gate: PauseGate, registry: ParkRegistry, options: ResumeOptions): Activator;
