/**
 * Reading one parked session's stored log through a bound, and the facts the
 * morning list may claim from what it read.
 *
 * The decision list reads the same log the wake reads, but for the opposite
 * reason: the wake has to reproduce the session, so it reads everything. The
 * list only has to name where the session stopped, which tool call the log
 * never heard back from, and whether an answer is still owed — all of them
 * facts about the log's END. Reading from seq 0 to the end for every row, on
 * every time the panel opens, would make a long
 * session's cost grow with a log nobody is asking about.
 *
 * WHAT THE BOUND BUYS. A stored log is append-only, so the tail is stable: the
 * read takes the last {@link TRIAGE_WINDOW_EVENTS} events, or the whole log when
 * it is shorter, and the answer is derived from that. The window is complete
 * whenever the log fits inside it, which is the common case; the fold the rest
 * of this plugin reads history through is then the harness's own, over exactly
 * the events the harness would fold.
 *
 * WHAT THE TAIL ALONE PROVES. A truncated window still answers the list's
 * questions, for one reason the harness guarantees: a dangling tool call exists
 * only inside the step that is still open, because a step's end is written
 * after its results. So an unanswered call is always inside the final open
 * span, and the tail that contains that span contains every one of them. What
 * the window cannot prove — a log a replacement event rewrote from further back
 * — is not guessed at: {@link logFacts} reports `undefined` and the row says
 * `unreadable`, because a list that invents a stop position is worse than a
 * list that says it could not read one.
 * @module dsh-pause-session/coldlog
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type { TriageTrace } from './shared.js';
/**
 * Events the read looks at before it gives up. Sized to hold a whole final
 * step — the model exchange, its tool calls, and their results — with room to
 * spare, at a cost that does not grow with the session.
 */
export declare const TRIAGE_WINDOW_EVENTS = 2000;
/**
 * The longest log the read will walk while locating where its tail starts.
 *
 * The window's start is found by probing for the log's length, so a log longer
 * than this cannot be located from its end at a cost worth paying for a panel
 * left open. Such a log — a million stored events — is reported unreadable
 * rather than read from the front, which is the read this module exists to
 * avoid.
 */
export declare const TRIAGE_LOG_MAX_EVENTS = 1000000;
/** How one stored log was seen by the bounded read. */
export type ColdLog =
/** The events the read returned, and whether they are the whole stored log. */
{
    readonly kind: 'read';
    readonly events: readonly SessionEvent[];
    readonly complete: boolean;
}
/** The log could not be opened or read, or it is longer than this read will walk. */
 | {
    readonly kind: 'unreadable';
};
/** The facts the decision list claims, all of them read off the log's end. */
export interface ColdFacts {
    /** What the stored log's last event was, and the turn/step it belongs to. */
    readonly last: SessionEvent | undefined;
    /** Tool calls the stored events record and no stored result answers. */
    readonly traces: readonly TriageTrace[];
    /** Whether the stored log ends owing the model an answer. */
    readonly owed: boolean;
    /** Whether the log names the route a wake would be addressed to. */
    readonly wakeable: boolean;
}
/**
 * The turn and step an event belongs to, when it carries them.
 * @param event - one stored event.
 * @returns the position fields the event has, and nothing for the fields it does not.
 */
export declare function positionOf(event: SessionEvent): {
    readonly turn?: number;
    readonly step?: number;
};
/**
 * The facts one bounded read of a stored log supports.
 *
 * A complete read is folded by the harness's own derivation, so the list and
 * the wake answer the "does it still owe a reply" question through one rule.
 * A truncated read answers from the tail, and only where the tail is proof: a
 * replacement event that rewrote a surface range from outside the window is
 * not visible here, so a log whose tail a later event could have rewritten is
 * reported unreadable rather than guessed at.
 * @param events - the stored events the read returned, in sequence order.
 * @param complete - whether those events are the whole stored log.
 * @param projections - this process's registered message projections.
 * @returns the row's facts, or `undefined` when this read cannot support them.
 */
export declare function logFacts(events: readonly SessionEvent[], complete: boolean, projections: Context['sessions']['messageProjections']): ColdFacts | undefined;
/**
 * Read one session's stored log, bounded to the events the list's facts need.
 *
 * The window is the last `windowEvents` events, found by probing for the log's
 * length and then reading exactly that slice. A short log is returned whole and
 * marked complete; a log longer than {@link TRIAGE_LOG_MAX_EVENTS} is reported
 * unreadable without being read at all.
 * @param ctx - host context carrying the optional persistence service.
 * @param sessionId - the stored session to read.
 * @param windowEvents - how many events of the log's end one row may fold.
 * @param signal - cancellation for the open, probe, and read.
 * @returns the bounded read, or `unreadable` when no read seam exists, it refused, or the log is too long to walk.
 * @throws the cancellation reason when `signal` aborts the read.
 */
export declare function coldRead(ctx: Context, sessionId: SessionId, windowEvents?: number, signal?: AbortSignal): Promise<ColdLog>;
