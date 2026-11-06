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
import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session';
import { derivedHistory, owesReply, routeNamed } from './history.js';
import { describeError } from './shared.js';
/**
 * Events the read looks at before it gives up. Sized to hold a whole final
 * step — the model exchange, its tool calls, and their results — with room to
 * spare, at a cost that does not grow with the session.
 */
export const TRIAGE_WINDOW_EVENTS = 2000;
/**
 * The longest log the read will walk while locating where its tail starts.
 *
 * The window's start is found by probing for the log's length, so a log longer
 * than this cannot be located from its end at a cost worth paying for a panel
 * left open. Such a log — a million stored events — is reported unreadable
 * rather than read from the front, which is the read this module exists to
 * avoid.
 */
export const TRIAGE_LOG_MAX_EVENTS = 1_000_000;
/**
 * Events that are not the session's own story: the bookkeeping of the pause
 * pre-0.2.0 command records the user pressed, and the pending-input splices the
 * inbox writes. They are real and durable, but "it stopped right after the
 * action finished"
 * is not what "where did it stop" means.
 */
const BOOKKEEPING_EVENTS = new Set(['command/run', 'command/done', 'agent/inbox/spliced']);
/**
 * The turn and step an event belongs to, when it carries them.
 * @param event - one stored event.
 * @returns the position fields the event has, and nothing for the fields it does not.
 */
export function positionOf(event) {
    const data = event.data;
    if (typeof data !== 'object' || data === null)
        return {};
    const turn = 'turn' in data && typeof data.turn === 'number' ? data.turn : undefined;
    const step = 'step' in data && typeof data.step === 'number' ? data.step : undefined;
    return { ...turn === undefined ? {} : { turn }, ...step === undefined ? {} : { step } };
}
/**
 * Every tool call the STORED events record and no stored result answers.
 *
 * Deliberately the stored prefix rather than the repaired view: what a row
 * reports is the state of the session's own log, and the harness's synthetic
 * unknown-outcome results are exactly what that log is missing. Taking the
 * repaired view here would subtract the very traces the row exists to show.
 *
 * A call is answered only by a result the SAME window holds, which is what the
 * harness's own repair rule reads too: an unanswered call lives in the step
 * that is still open, so it is inside this window or it is answered.
 * @param events - the stored events the read returned, in sequence order.
 * @returns one trace per call with no result, in call order.
 */
function unansweredCalls(events) {
    const names = new Map();
    const answered = new Set();
    for (const event of events) {
        if (event.type === 'tool/call') {
            names.set(String(event.data.callId), event.data.name);
            continue;
        }
        if (event.type !== 'tool/result')
            continue;
        answered.add(String(event.data.message.toolCallId));
    }
    return [...names].flatMap(([callId, tool]) => answered.has(callId) ? [] : [{ tool, callId }]);
}
/**
 * Whether a log ends owing the model an answer, read from the tail alone.
 *
 * This is the harness's own rule — the last thing on the model-visible surface
 * is not an assistant message — read the way the harness reads it: the surface
 * fold over the events at hand, then the message the last node derives to. The
 * fold is handed a window rather than the whole log, so it refuses rather than
 * guesses when it meets a replacement it cannot resolve; a log it cannot fold
 * falls back to the last event that produces a message at all, which is the
 * same answer by a narrower route.
 * @param events - the stored events the read returned, in sequence order.
 * @param traces - the unanswered calls, as the row reports them.
 * @returns whether the session still owes the model a reply.
 */
function tailOwesReply(events, traces) {
    // A log whose last step is open closes with a synthetic tool result for
    // every unanswered call, and a tool result is a message.
    if (traces.length > 0)
        return true;
    const bySequence = new Map(events.map(event => [event.seq, event]));
    const lastNode = () => {
        for (const seq of [...foldSurface(events).nodes].reverse()) {
            const event = bySequence.get(seq);
            if (event !== undefined)
                return event;
        }
        return undefined;
    };
    let anchor;
    try {
        anchor = lastNode();
    }
    catch {
        // The window cannot be folded as a log — an event it holds was rewritten
        // by something it does not. The narrower route still reads the same fact
        // off the end: the last event that derives a message.
        for (let at = events.length - 1; at >= 0; at -= 1) {
            const event = events[at];
            if (event === undefined || deriveEventMessage(event) === null)
                continue;
            anchor = event;
            break;
        }
    }
    if (anchor === undefined)
        return false;
    const message = deriveEventMessage(anchor);
    if (message === null)
        return false;
    // System and developer entries are request framing, not conversation.
    if (message.role === 'system' || message.role === 'developer')
        return false;
    return message.role !== 'assistant';
}
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
export function logFacts(events, complete, projections) {
    let last;
    for (let at = events.length - 1; at >= 0; at -= 1) {
        const event = events[at];
        if (event === undefined || BOOKKEEPING_EVENTS.has(event.type))
            continue;
        last = event;
        break;
    }
    const traces = unansweredCalls(events);
    const wakeableRoute = routeNamed(events);
    if (!complete) {
        // A truncated window has to hold the stop position, or it does not hold
        // the answer this row exists to publish: the log continued before what the
        // window saw, so "no event to name" would claim a session that left no
        // trace. That window is reported unreadable, not summarized.
        if (last === undefined)
            return undefined;
        const owed = tailOwesReply(events, traces);
        return { last, traces, owed, wakeable: owed && wakeableRoute };
    }
    let owed;
    try {
        owed = owesReply(derivedHistory(events, projections));
    }
    catch {
        return undefined;
    }
    return { last, traces, owed, wakeable: owed && wakeableRoute };
}
/**
 * Whether one handle holds at least `count` events, asked without materializing
 * more than one of them.
 * @param handle - an open read handle onto the log.
 * @param count - the event count to test for.
 * @param signal - cancellation for the probe.
 * @returns whether the log reaches that far.
 */
async function reaches(handle, count, signal) {
    return (await handle.read(count, 1, { ...signal === undefined ? {} : { signal } })).events.length > 0;
}
/**
 * The stored log's own length, found by probing rather than by reading it.
 *
 * The handle's read seam is the only way to ask a backend anything, and it
 * takes an offset — so the count has to be probed for. The probe doubles until
 * it passes the end and then bisects, so a log of any length costs a handful
 * of one-event reads, and none of them materializes the prefix it skips.
 * @param handle - an open read handle onto the log.
 * @param signal - cancellation for the probe.
 * @returns the event count, or `undefined` when the log is longer than this read will walk.
 */
async function eventCount(handle, signal) {
    let high = 1;
    while (await reaches(handle, high, signal)) {
        if (high >= TRIAGE_LOG_MAX_EVENTS)
            return undefined;
        high = Math.min(high * 2, TRIAGE_LOG_MAX_EVENTS);
    }
    let low = 0;
    while (high - low > 1) {
        const mid = low + Math.floor((high - low) / 2);
        if (await reaches(handle, mid, signal))
            low = mid;
        else
            high = mid;
    }
    // `reaches(n)` answers whether the event at zero-based index n exists; the
    // event count is one past the last existing index.
    return await reaches(handle, 0, signal) ? low + 1 : 0;
}
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
export async function coldRead(ctx, sessionId, windowEvents = TRIAGE_WINDOW_EVENTS, signal) {
    const persistence = ctx.get('sessionPersistence');
    if (persistence === undefined)
        return { kind: 'unreadable' };
    let handle;
    try {
        handle = await persistence.open(sessionId, 'read', {
            ...signal === undefined ? {} : { signal },
        });
    }
    catch (error) {
        if (signal?.aborted === true)
            throw error;
        ctx.logger.warn(`pause: could not open the stored log of "${sessionId}": ${describeError(error)}`);
        return { kind: 'unreadable' };
    }
    try {
        const window = Math.max(1, Math.floor(windowEvents));
        const count = await eventCount(handle, signal);
        if (count === undefined) {
            ctx.logger.warn(`pause: the stored log of "${sessionId}" is longer than this read will walk`);
            return { kind: 'unreadable' };
        }
        const start = Math.max(0, count - window);
        const stored = await handle.read(start, window, {
            ...signal === undefined ? {} : { signal },
        });
        return { kind: 'read', events: stored.events, complete: start === 0 };
    }
    catch (error) {
        if (signal?.aborted === true)
            throw error;
        ctx.logger.warn(`pause: could not read the stored log of "${sessionId}": ${describeError(error)}`);
        return { kind: 'unreadable' };
    }
    finally {
        await handle.close();
    }
}
//# sourceMappingURL=coldlog.js.map