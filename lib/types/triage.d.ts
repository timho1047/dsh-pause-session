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
 * WHAT ONE READ COSTS. The list is read again on every command-registry change
 * while the panel is open, and what it publishes is about the end of a log that
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
 * WHO MAY DECIDE. A decision names its target as command input, and the command
 * channel carries no origin of its own, so this list acts only on rows its most
 * recent read published to the calling session: the caller's own read is what
 * makes a target actionable. Anything else is refused, not looked up.
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
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import type { ParkRegistry } from './registry.js';
import type { ResumePath } from './resume.js';
import type { TriageAction, TriageList } from './shared.js';
/** Result copy for a decision the list itself could not carry out. */
export declare const TRIAGE_FAILED_TEXT = "pause could not carry out that decision; the session is exactly as it was.";
/** Result copy for leaving one listed session alone. */
export declare const TRIAGE_LEFT_TEXT = "pause left this session paused; it is still on the list.";
/** Result copy for a decision aimed at a session that is not on the list. */
export declare const TRIAGE_NOT_LISTED_TEXT = "pause has no unfinished pause for this session.";
/**
 * Result copy for a decision aimed at a row the calling session was not shown.
 * The list is the only thing that legitimizes a target, so a target nobody read
 * is refused rather than acted on.
 */
export declare const TRIAGE_UNSHOWN_TEXT: string;
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
export declare const UNKNOWN_OUTCOME_NOTE: string;
/** What mounting the decision list hands back. */
export interface TriageListService {
    /**
     * Read the list for one calling session, and record the rows it was shown.
     * @param caller - the session the read was addressed to.
     * @param signal - cancellation for the stored-log reads.
     * @returns every session that did not stop cleanly, with the facts its own log carries.
     */
    read(caller: SessionId, signal?: AbortSignal): Promise<TriageList>;
    /**
     * Carry out one decision on one listed session, for the caller that read it.
     * @param caller - the session the decision was addressed to.
     * @param sessionId - the listed session to act on.
     * @param action - which of the listed decisions was taken.
     * @param signal - cancellation for the cold load and setup.
     * @returns the outcome for whoever asked.
     */
    decide(caller: SessionId, sessionId: SessionId, action: TriageAction, signal?: AbortSignal): Promise<CommandResult>;
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
export declare function mountTriageList(ctx: Context, registry: ParkRegistry, resumePath: ResumePath, windowEvents?: number): TriageListService;
