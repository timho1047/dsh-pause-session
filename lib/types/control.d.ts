/**
 * The session control the browser half drives: the pause verb, the park state
 * machine behind it, and the live state channel that accompanies both.
 *
 * A third-party plugin can add neither a `ctx.remote` namespace nor a forwarded
 * event: the Client's Remote namespaces and the forwarded-event allowlist are
 * compiled into the harness's own API assembly. The documented Client-callable
 * Host entry point is therefore a session command run through
 * `ctx.remote.commands.execute`, and the one live channel such a plugin can
 * publish through is the command registry itself — `commands/change` is a
 * forwarded event, and `commands.list(sessionId)` is a Client-callable read.
 *
 * That same registry is how a phase change leaves this process: a transition
 * re-registers the status verb, which emits the change a client needs to read
 * the new phase. It is the only way a third-party plugin can announce anything,
 * and it is what makes the flush that resolves `parking` into `safe` observable
 * at all — that step changes no registration of its own.
 *
 * So the resume definition IS the paused marker: it is registered on a paused
 * session's own agent context and removed on resume, and the browser half reads
 * "paused" from that registration rather than inventing it. A descriptor cannot
 * change after registration, so the park state rides a companion status
 * definition (registered beside the marker) whose answer is derived per call
 * rather than frozen into a descriptor — see `./shared.ts`. That one read
 * carries the record's goal opt-out too, so the session-header control can show
 * and switch it while the session is parked and clean — the state in which a
 * silent morning resume would otherwise spend the user's rounds unasked. The
 * switch is addressed to the session it changes, so it needs no listed row.
 *
 * The header control is the user's button for ONE session's work, and that work
 * includes the subagents under it: the press registers the session and its
 * descendant tree, the release takes the same tree back, and the status the
 * header shows is the worst phase among the members the press registered. The
 * whole-app control covers every running tree and answers for all of them; this
 * one answers for the tree it owns.
 *
 * A mark is not a park. A session is parked only once nothing is left to drain:
 * no call in flight AND either its next model request is held at the gate or no
 * turn is open at all (there will be no next request to hold). Only then is the
 * session flushed, at the session level — `SessionHandle.flush()` does not
 * drain the routed live buffer, so it would record a park that a crash erases.
 * The "safe to close" phase appears only after that flush resolves.
 *
 * Every phase a pause reaches is written to the durable registry before it is
 * published — including the move into `parking`, which the status command may
 * therefore never serve ahead of the record. A restart re-holds exactly the
 * sessions the last process left parked, and a phase that could not be recorded
 * is never shown as cleaner than the record says.
 *
 * A park verb changes state, so it acts only on a person's command: a command
 * dispatched from inside a model turn is refused. The listed verbs add the
 * one binding their target needs — the row must be one the calling session was
 * shown — and that rule lives with the list (`./triage.ts`).
 * @module dsh-pause-session/control
 */
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { PauseGate } from './gate.js';
import type { ParkWatch } from './park.js';
import type { ParkRegistry } from './registry.js';
import type { ResumeAttempt, ResumeOptions } from './resume.js';
import type { PauseSnapshot } from './shared.js';
/**
 * Result copy for a state-changing park verb issued from inside a model turn.
 * The invocation carries no origin of its own, so this refusal is the plugin's
 * own reading of the one signal that separates a person's command from a
 * model's.
 */
export declare const UNATTENDED_TEXT: string;
/** What one tree-wide press registered, and what it could not. */
export interface PressTreeOutcome {
    /** How many sessions this press covered: the session plus its descendants. */
    readonly members: number;
    /** How many of them now have a durable park record behind them. */
    readonly registered: number;
    /** Whether the pressed session itself is one of them. */
    readonly rootRegistered: boolean;
    /** The members whose record could not be written; they are not paused. */
    readonly unrecorded: readonly SessionId[];
    /** Whether the tree walk itself failed, so the session's subagents were not covered. */
    readonly unread: boolean;
}
/** What mounting the session control hands back to the plugin entry. */
export interface SessionControl {
    /**
     * Hold every session the registry remembers and can read, and publish the
     * marker for the ones that already have a live agent. Called once, right
     * after mount.
     */
    adopt(): Promise<void>;
    /**
     * Read the whole app and every live paused session as one JSON-safe snapshot.
     * The browser status route serves this; it never enters a Session log.
     * @param signal - cancellation for the tree reads this snapshot performs.
     * @returns the whole-app verdict and the paused sessions this process holds.
     */
    readSnapshot(signal?: AbortSignal): Promise<PauseSnapshot>;
}
/** How resuming all parked sessions answers the command that asked for it. */
export declare function summarizeResume(attempts: readonly ResumeAttempt[]): string;
/**
 * Everything the session control needs from the composition: the clean resume
 * path's route knowledge, plus the bound the decision list reads each parked
 * log under.
 */
export interface SessionControlOptions extends ResumeOptions {
    /** Events of each stored log the decision list may fold per row; see `./coldlog.ts`. */
    readonly maxListedLogEvents?: number;
}
/**
 * Contribute the session control: the pause verb, the per-session status read,
 * the global resume verb, and — for every paused session that has a live agent
 * — the resume marker.
 * @param ctx - host context carrying the command registry, the agent store, the
 * session store, and the projection registry.
 * @param gate - the pause gate this control drives and reflects.
 * @param watch - the per-session activity fold the park predicate reads.
 * @param registry - the durable pause list every phase change is written to.
 * @param options - route knowledge the clean resume path needs, and the decision list's read bound.
 * @returns the mount-time adoption step and the morning resume path.
 */
export declare function installSessionControl(ctx: Context, gate: PauseGate, watch: ParkWatch, registry: ParkRegistry, options: SessionControlOptions): SessionControl;
