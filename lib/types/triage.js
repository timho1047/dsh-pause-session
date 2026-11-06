/**
 * The morning decision list: every session that did not stop cleanly, the facts
 * its own log carries about where it stopped, and the listed verbs the user can
 * take on it.
 *
 * A session gets here by NOT being on the clean path. A record whose phase is
 * `safe` is woken silently by `./resume.ts` and never appears here; the other
 * three phases describe work nobody can vouch for, and guessing on them would
 * spend the owner's money on a guess. This module is the other half of that
 * rule, not a second copy of it: the reading is taken from the session's own
 * stored log through a read handle that claims no ownership and writes nothing,
 * so asking what happened cannot itself change what happened.
 *
 * WHAT ONE READ COSTS. The list is read when the panel opens and when a native
 * action changes the park, and what it publishes is about the end of a log that
 * only grows, so `./coldlog.ts` bounds each row's read to that end. A row whose
 * facts the bound cannot hold reports itself unreadable rather than publishing
 * a fragment.
 *
 * WHAT A ROW REPORTS. "Where it stopped" is the last event of the stored log
 * with the turn and step it belongs to. "Which tool was in flight" is the
 * `tool/call` events that no durable `tool/result` answers — a call event is
 * only written once the loop reached the dispatch, so an unanswered one is
 * exactly a tool the real world ran and the log never heard back from. The
 * harness turns each of those into a synthetic `TOOL_OUTCOME_UNKNOWN` error
 * result when it next reads the log; this module derives the same answer from
 * the stored events instead of writing it back. Nothing here is inferred from
 * the fact that the session is listed.
 *
 * WHAT THE ROW PROMISES. `wake` says the host can hand this session the request
 * it owes, and the wake that keeps that promise is `./resume.ts`'s. Both read
 * one rule from `./history.ts` over the same derivation the loop reads, so a
 * promise this list publishes is a promise that wake keeps. When the log cannot
 * be folded into that derivation, the promise is withheld and the reading is
 * reported; a withheld promise costs a user nothing, a broken one spends their
 * money.
 *
 * WHO MAY DECIDE. A decision carries the calling session and its target as wire
 * input, so this list acts only on rows its most recent read published to the
 * calling session: the caller's own read is what makes a target actionable.
 * Anything else is refused, not looked up.
 *
 * TWO OF THE FIVE VERBS PUT THE SESSION BACK ON THE CLEAN PATH. Continue and
 * continue-with-the-note go through `ResumePath.decideUnclean`, which activates
 * the session, wakes it and drops the durable record before the gate opens.
 *
 * THE OTHER THREE TOUCH NOTHING. Leave writes nothing at all: the record stays,
 * the session stays held, and the row is still on tomorrow's list. Review
 * answers without activating anything or writing anything — opening a session
 * to read it is the user's own action in their session history, and starting an
 * agent on their behalf is precisely what they declined. Goal flips the row's
 * own re-arm opt-out: it is the user path for the one thing a resume can spend
 * without the user watching it, and it takes effect on whatever resume comes
 * next. All five carry the same binding — the row must be one this caller was
 * shown — because each changes, or declines to change, durable state of a
 * parked session.
 * @module dsh-pause-session/triage
 */
import { coldRead, logFacts, positionOf, TRIAGE_WINDOW_EVENTS } from './coldlog.js';
/** Result copy for a decision the list itself could not carry out. */
export const TRIAGE_FAILED_TEXT = 'pause could not carry out that decision; the session is exactly as it was.';
/** Result copy for leaving one listed session alone. */
export const TRIAGE_LEFT_TEXT = 'pause left this session paused; it is still on the list.';
/** Result copy for a decision aimed at a session that is not on the list. */
export const TRIAGE_NOT_LISTED_TEXT = 'pause has no unfinished pause for this session.';
/**
 * Result copy for a decision aimed at a row the calling session was not shown.
 * The list is the only thing that legitimizes a target, so a target nobody read
 * is refused rather than acted on.
 */
export const TRIAGE_UNSHOWN_TEXT = 'pause did not act: this Session has not been shown that row.'
    + ' Read the decision list first.';
/**
 * Model-facing text that goes with a wake when the user chooses to continue
 * with a note.
 *
 * It is written the way the harness writes its own recovery text: the same two
 * facts the synthetic tool result states (the call's outcome was never recorded;
 * verify before retrying anything with side effects), in the same voice, with no
 * mention of the stop mechanism. The harness's own version lives in the tool
 * result for that call, which is why this one does not repeat the call's name —
 * it warns about the step as a whole, and the specific result sits directly
 * above it in the history.
 */
export const UNKNOWN_OUTCOME_NOTE = 'A tool call from this step was interrupted: its call was recorded but no '
    + 'result was durably recorded, so its outcome is unknown. If it had side effects, verify the external state '
    + 'before doing anything else, and do not retry it blindly. Then continue with what I asked for.';
/**
 * One row's facts, as the session's own log reports them.
 * @param ctx - host context carrying the registered message projections.
 * @param entry - the durable park record this row is built from.
 * @param events - the events the bounded read returned, in sequence order.
 * @param complete - whether those events are the whole stored log.
 * @returns the row, ready to publish, or `undefined` when the read cannot support it.
 */
function rowOf(ctx, entry, events, complete) {
    const { sessionId, phase, updatedAt, rearmGoal } = entry;
    const facts = logFacts(events, complete, ctx.sessions.messageProjections);
    // A log this read cannot fold into those facts says nothing rather than
    // something: the row reports itself unreadable, which is what a list that
    // must not lie does when it does not know.
    if (facts === undefined)
        return undefined;
    const { last, traces, owed, wakeable } = facts;
    return {
        sessionId: String(sessionId),
        phase,
        updatedAt,
        reading: 'read',
        ...last === undefined ? {} : { lastEvent: last.type, ...positionOf(last) },
        traces,
        owed,
        rearmGoal,
        // Two facts have to hold before this host can hand the session its owed
        // request: the log must name the route the wake would be addressed to, and
        // there must be an answer still owed for the wake to ask for.
        wakeable,
    };
}
/**
 * Mount the decision list over the durable registry and the clean resume path.
 *
 * The list is the registry's own complement: it asks for every record whose
 * phase is not `safe`, so a session that cleaned up is off the list by the same
 * fact that puts it on the silent path, and nothing has to be reconciled.
 * @param ctx - host context carrying the optional persistence service.
 * @param registry - the durable list of park outcomes.
 * @param resumePath - the path all three resuming decisions go through.
 * @param windowEvents - how many events of each stored log one read may fold.
 * @returns the list read and the decision verbs.
 */
export function mountTriageList(ctx, registry, resumePath, windowEvents = TRIAGE_WINDOW_EVENTS) {
    /**
     * The rows each calling session was last shown by its own read. A decision
     * names its target as command input, and the command channel carries no
     * origin of its own, so this is what ties a target to the list the user read:
     * only a row this caller has been shown is acted on.
     */
    const shown = new Map();
    const unreadable = (entry) => ({
        sessionId: String(entry.sessionId),
        phase: entry.phase,
        updatedAt: entry.updatedAt,
        reading: 'unreadable',
        traces: [],
        owed: false,
        wakeable: false,
        rearmGoal: entry.rearmGoal,
    });
    const readable = async (entry, signal) => {
        const read = await coldRead(ctx, entry.sessionId, windowEvents, signal);
        // A log this host could not read says so. An empty row would claim the
        // session left no traces, which is precisely the verdict nobody has.
        if (read.kind === 'unreadable')
            return unreadable(entry);
        // Facts this bounded read cannot support say the same thing: the row is
        // reported unreadable rather than filled with a guess.
        return rowOf(ctx, entry, read.events, read.complete) ?? unreadable(entry);
    };
    /**
     * One decision, as the resume path's own verbs plus the two local verbs that
     * change nothing but the record. Review is the list's own "do not run it"
     * answer: it activates nothing and writes nothing, so the park is exactly as
     * it was. The goal toggle is the user path for the one thing a resume can
     * spend unasked.
     */
    const decide = async (caller, sessionId, action, signal) => {
        if (!(shown.get(caller)?.has(String(sessionId)) ?? false))
            return { kind: 'error', text: TRIAGE_UNSHOWN_TEXT };
        const record = registry.get(sessionId);
        // `safe` is not a decision this list owns: that session belongs to the
        // silent path, and acting here would be a second resume.
        if (record === undefined || record.phase === 'safe') {
            return { kind: 'error', text: TRIAGE_NOT_LISTED_TEXT };
        }
        if (action === 'leave')
            return { kind: 'success', text: TRIAGE_LEFT_TEXT };
        if (action === 'goal')
            return await resumePath.setRearmGoal(sessionId, !record.rearmGoal);
        // Review is its own kind of decision, not a wake-less resume: it leaves the
        // park exactly as it was, so the row is still there for tomorrow and
        // nothing has been continued — or even activated — on the user's behalf.
        if (action === 'review') {
            return (await resumePath.decideUnclean(sessionId, { kind: 'none' }, 'review', undefined, signal)).answer;
        }
        const wake = action === 'continue' ? { kind: 'silent' } : { kind: 'message', text: UNKNOWN_OUTCOME_NOTE };
        return (await resumePath.decideUnclean(sessionId, wake, 'release', undefined, signal)).answer;
    };
    return {
        read: async (caller, signal) => {
            signal?.throwIfAborted();
            const rows = await Promise.all([...registry.parked.values()]
                .flatMap(entry => entry.phase === 'safe' ? [] : [readable({ ...entry, phase: entry.phase }, signal)]));
            shown.set(caller, new Set(rows.map(row => row.sessionId)));
            return { rows };
        },
        decide,
    };
}
//# sourceMappingURL=triage.js.map