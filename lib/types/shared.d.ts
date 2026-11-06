/**
 * The identities both halves of dsh-pause-session name, the status encodings they
 * share, and the one spelling a host log line gives a caught value.
 *
 * The browser bundle may value-import only the shell's baseline module table,
 * so this module imports nothing: the client half reads command names and the
 * decode functions from it directly, and the host half derives the branded
 * identities from the same strings.
 *
 * The browser reads the live state through the plugin's same-origin JSON
 * status route when the Web carrier mounts it; the command registry remains
 * the action channel and the fallback for carriers without that route. A
 * command descriptor's free-form field is its `description`, and a command
 * result's is its `text`, so the fallback park state travels as a prefix plus
 * `;`-separated fields on one of those. The text stays human-readable: the same
 * words are what the slash-command menu shows.
 *
 * Every value inside a field is escaped, so a decoded name is the exact name
 * that was encoded. Session ids, tool names, and call ids are the host's own
 * data and may contain the `;`, `,`, `/`, or newline a field is separated by; a
 * folded spelling would decode as a different name — a different row, looked up
 * again.
 * @module dsh-pause-session/shared
 */
/** Command that pauses the receiving session before its next model request. */
export declare const PAUSE_COMMAND = "pause";
/** Command that resumes the receiving session; registered only while that session is paused. */
export declare const RESUME_COMMAND = "pause-resume";
/** Command that resumes every parked session the registry remembers. */
export declare const RESUME_ALL_COMMAND = "pause-resume-all";
/** Command that registers and parks every running session tree in one action. */
export declare const PAUSE_ALL_COMMAND = "pause-all";
/** Command that reports the whole-app park state; registered globally, always. */
export declare const STATE_ALL_COMMAND = "pause-state-all";
/** Command that reports the receiving session's park state; registered only while it is paused. */
export declare const STATUS_COMMAND = "pause-state";
/** Command that turns the receiving session's own goal re-arm on or off; registered only while it is paused. */
export declare const GOAL_COMMAND = "pause-goal";
/** Command that reports every session that did not stop cleanly. */
export declare const TRIAGE_COMMAND = "pause-triage";
/** Command that resumes one session from the decision list exactly as the clean path would. */
export declare const TRIAGE_CONTINUE_COMMAND = "pause-triage-continue";
/** Command that resumes one session from the decision list with the unknown-outcome note. */
export declare const TRIAGE_NOTE_COMMAND = "pause-triage-note";
/** Command that opens one session from the decision list without spending a request. */
export declare const TRIAGE_REVIEW_COMMAND = "pause-triage-review";
/** Command that leaves one session from the decision list exactly as it is. */
export declare const TRIAGE_LEAVE_COMMAND = "pause-triage-leave";
/** Command that turns one listed session's goal re-arm on or off. */
export declare const TRIAGE_GOAL_COMMAND = "pause-triage-goal";
/** Stable definition id of the pause command, matched by identity rather than by copy. */
export declare const PAUSE_DEFINITION_ID = "dsh-pause-session/pause";
/** Stable definition id of the resume command: the host's own "this session is paused" fact. */
export declare const RESUME_DEFINITION_ID = "dsh-pause-session/resume";
/** Stable definition id of the global resume command, matched by identity rather than by copy. */
export declare const RESUME_ALL_DEFINITION_ID = "dsh-pause-session/resume-all";
/** Stable definition id of the whole-app pause command. */
export declare const PAUSE_ALL_DEFINITION_ID = "dsh-pause-session/pause-all";
/** Stable definition id of the whole-app status read. */
export declare const STATE_ALL_DEFINITION_ID = "dsh-pause-session/state-all";
/** Stable definition id of the status read, matched by identity rather than by copy. */
export declare const STATUS_DEFINITION_ID = "dsh-pause-session/status";
/** Stable definition id of the paused session's own goal re-arm toggle. */
export declare const GOAL_DEFINITION_ID = "dsh-pause-session/goal";
/** Stable definition id of the decision-list read. */
export declare const TRIAGE_DEFINITION_ID = "dsh-pause-session/triage";
/** Stable definition id of the decision-list "continue" verb. */
export declare const TRIAGE_CONTINUE_DEFINITION_ID = "dsh-pause-session/triage-continue";
/** Stable definition id of the decision-list "continue with the unknown-outcome note" verb. */
export declare const TRIAGE_NOTE_DEFINITION_ID = "dsh-pause-session/triage-note";
/** Stable definition id of the decision-list "open without activating" verb. */
export declare const TRIAGE_REVIEW_DEFINITION_ID = "dsh-pause-session/triage-review";
/** Stable definition id of the decision-list "leave it alone today" verb. */
export declare const TRIAGE_LEAVE_DEFINITION_ID = "dsh-pause-session/triage-leave";
/** Stable definition id of the decision-list goal re-arm toggle. */
export declare const TRIAGE_GOAL_DEFINITION_ID = "dsh-pause-session/triage-goal";
/** First token of every encoded status, so a descriptor is never parsed by accident. */
export declare const STATUS_PREFIX = "pause: ";
/**
 * One log line's text for a caught value.
 * @param error - the caught value.
 * @returns the error's message, or the value's own spelling.
 */
export declare function describeError(error: unknown): string;
/**
 * The four park outcomes, listed in the order a park walks them — and the one
 * vocabulary the live status, the durable registry, and the published words all
 * derive from, so they cannot drift apart:
 *
 * - `draining`: paused, and the session is still working — a tool is running, or
 *   a turn is between steps.
 * - `parking`: standing still at the park point; the session-level flush has
 *   not resolved yet.
 * - `safe`: parked and flushed, so it is safe to walk away. The only clean one.
 * - `flush-failed`: parked, but the flush failed — the durable promise is not
 *   kept, and it must never be read as clean.
 */
export declare const PARK_PHASES: readonly ["draining", "parking", "safe", "flush-failed"];
/** One park outcome. */
export type ParkPhase = (typeof PARK_PHASES)[number];
/**
 * Fold several records into the one verdict that speaks for all of them: the
 * worst phase any of them reached, and whether every one of them is clean.
 *
 * This is how a session's control answers for its tree. "Safe to close" is a
 * promise about everything the press registered, so it may be said only when
 * every member reached the flushed park point; anything else is reported as the
 * least-clean state in the set, never rounded up to the session's own.
 * @param phases - the durable phases of the records being spoken for.
 * @returns the worst phase, and whether that verdict is the clean one.
 */
export declare function foldTreePhases(phases: Iterable<ParkPhase>): {
    phase: ParkPhase;
    safe: boolean;
};
/** Everything the browser is told about one paused session. */
export interface ParkStatus {
    /**
     * The phase of everything that session's press registered — the session and
     * the subagent members under it, folded by {@link foldTreePhases}. A member
     * still draining or stalled holds this at its own phase, because the control
     * that owns the tree may not say "safe to close" while any member of it is
     * not.
     */
    readonly phase: ParkPhase;
    /** Whether the host commits to "you can close the lid now". */
    readonly safe: boolean;
    /** Tools in flight when the status was published; empty once parked. */
    readonly runningTools: readonly string[];
    /**
     * Whether the resume that takes this pause back may re-open the session's
     * goal — the durable record's own opt-out, which outlives this process. It is
     * absent when this host could not read the record that holds it; a browser
     * that is not told shows no switch rather than a state it would have to
     * guess, and a guess here would tell the user their money is safe when
     * nobody knows whether it is.
     */
    readonly rearmGoal?: boolean;
}
/**
 * Encode one status for a command descriptor.
 * @param status - the state to publish.
 * @returns the descriptor text, e.g. `pause: draining; tools: edit, bash; goal: on`.
 */
export declare function encodeParkStatus(status: ParkStatus): string;
/**
 * Decode a status previously written by {@link encodeParkStatus}.
 * @param text - a command descriptor's description.
 * @returns the status, or `undefined` when this text carries none — a foreign
 * command, or a reading taken before the host published anything.
 */
export declare function decodeParkStatus(text: string): ParkStatus | undefined;
/**
 * First token of every encoded whole-app status. A different prefix from the
 * per-session status on purpose: one decoder must never read the other's text.
 */
export declare const GLOBAL_STATUS_PREFIX = "pause all: ";
/** The one path the Browser reads the host's live pause snapshot from. */
export declare const STATUS_PATH = "/dsh-pause-session/status";
/** One JSON snapshot: the whole-app verdict plus every live paused session. */
export interface PauseSnapshot {
    readonly global: GlobalStatus;
    readonly sessions: Readonly<Record<string, ParkStatus>>;
}
/** The whole-app answer to "can I close the lid?". */
export type GlobalVerdict = 'idle' | 'waiting' | 'safe';
/** A surface the whole-app report could not read at all. */
export type GlobalBlindSpot = 'trees' | 'jobs';
/**
 * Everything the whole-app control publishes about the park as a whole.
 *
 * The counts and the names are one answer, not two: a report that says
 * "3 registered, 1 safe" and then fails to say which two are missing is the
 * kind of silence this control exists to prevent. The verdict is the only
 * summary, and it is derived here so the host and the browser cannot disagree
 * about it.
 */
export interface GlobalStatus {
    /** `idle` with nothing registered, `safe` only when every registered session is. */
    readonly verdict: GlobalVerdict;
    /** Sessions this park owns — the durable list plus anything pressed since. */
    readonly registered: number;
    /** How many of them reached the flushed park point. */
    readonly safe: number;
    /**
     * The session this park belongs to — the first registered one this host can
     * hold, whatever phase it reached, so a client can address its reads at the
     * park instead of at whatever session the user happens to be looking at. A
     * park whose every record is unreadable here names the first of those: the
     * name is a fact about the park, and an address that cannot answer is the
     * client's fallback to take.
     *
     * The buckets below name a session only while it has something left to do,
     * and the clean case — every registered session `safe`, which is the ordinary
     * one — leaves all of them empty: without this field a park that finished
     * cleanly names no session at all. `undefined` when the park holds nothing,
     * and absent from a reading written before this field existed; a client must
     * not treat either absence as an address.
     */
    readonly parkedAt?: string;
    /**
     * Registered sessions still working: a tool is in flight or a turn is between
     * steps. Their park point is announced by the marker commands the park
     * registers, so a reader has nothing to watch here.
     */
    readonly draining: readonly string[];
    /**
     * How many registered sessions stand at the park point with their flush still
     * pending — the host's `parking` phase. Nothing announces a flush resolving,
     * so this is the one state a reader can only learn by asking again. A count
     * rather than names: it says how long to keep watching, not which transcript
     * a row belongs in, which is what `draining` is for.
     */
    readonly parking: number;
    /**
     * Registered sessions that will not reach the park point in this process: a
     * flush that failed, a pause adopted from an earlier process, a press whose
     * registry write failed, or a record whose session this host cannot read and
     * therefore did not hold. Named, never folded into the count and forgotten.
     */
    readonly stalled: readonly string[];
    /** Registered sessions whose tree contains a route a restart cannot resume. */
    readonly unresumable: readonly string[];
    /** Registered sessions whose subagent tree could not be read — unknown, not clean. */
    readonly unreadTrees: readonly string[];
    /** Live background jobs owned by the registered trees; nothing here can stop them. */
    readonly jobs: readonly string[];
    /** Whole surfaces the report could not read, so their emptiness is not a fact. */
    readonly blind: readonly GlobalBlindSpot[];
}
/**
 * Encode one whole-app status for a command result.
 * @param status - the state to publish.
 * @returns the result text, e.g.
 * `pause all: waiting; registered: 3; safe: 1; parked-at: overnight; draining: overnight; parking: 1; stalled: -; unresumable: -; unread-trees: -; jobs: bash-1; blind: -`.
 */
export declare function encodeGlobalStatus(status: GlobalStatus): string;
/**
 * Decode a whole-app status previously written by {@link encodeGlobalStatus}.
 * @param text - a command result's text.
 * @returns the status, or `undefined` when this text carries none.
 */
export declare function decodeGlobalStatus(text: string): GlobalStatus | undefined;
/**
 * First token of every encoded decision list. Separate from the per-session and
 * whole-app status prefixes on purpose, for the same reason those two are
 * separate: one decoder must never read another's text.
 */
export declare const TRIAGE_PREFIX = "pause triage: ";
/** How one decision-list row was read out of the session's own stored log. */
export type TriageReading = 'read' | 'unreadable';
/**
 * What one stored log says about a tool call whose outcome was never recorded.
 *
 * The call event itself is durable; the harness turns every such call into a
 * synthetic `TOOL_OUTCOME_UNKNOWN` error result when it next reads the log, and
 * this is that same derivation taken without writing anything back. The marker
 * itself is never in the stored log of a session still on the list: the resume
 * that appends it is also the resume that drops the record putting it here.
 */
export interface TriageTrace {
    /** The tool's own name, from the call event the model produced. */
    readonly tool: string;
    /** The provider-issued id pairing the call with the result that never arrived. */
    readonly callId: string;
}
/**
 * One session that did not stop cleanly, as the decision list presents it.
 *
 * Every field is read from the session's own log or from the durable park
 * record; nothing here is derived from the fact that the session is merely
 * listed. `reading` is the honesty field: a log this host could not read says
 * `unreadable` and carries no facts, rather than an empty row that would read
 * as "no traces".
 */
export interface TriageRow {
    /** The parked session. */
    readonly sessionId: string;
    /** The durable park outcome; never `safe`, which is the clean path's business. */
    readonly phase: Exclude<ParkPhase, 'safe'>;
    /** When that outcome was last written. */
    readonly updatedAt: number;
    /** Whether the facts below came from the log. */
    readonly reading: TriageReading;
    /** What the stored log's last event was, with the step it belongs to when it has one. */
    readonly lastEvent?: string;
    /** The turn and step that last event belongs to. */
    readonly turn?: number;
    readonly step?: number;
    /** Tools whose call event is durable and whose result is not — the unknown outcomes. */
    readonly traces: readonly TriageTrace[];
    /** Whether the stored log ends owing the model an answer. */
    readonly owed: boolean;
    /**
     * Whether resuming this session may re-open its goal. Re-arming is what makes
     * a resumed goal spend its owner's rounds, so it is a per-session choice the
     * row shows and the list can flip.
     */
    readonly rearmGoal: boolean;
    /**
     * Whether the host could hand this session its owed request at all: a log it
     * could not read, or one whose last request recorded no route, cannot be
     * woken — which is a fact about the entry, not a refusal of the user's choice.
     */
    readonly wakeable: boolean;
}
/** The decision list: what did not stop cleanly, and each row's facts. */
export interface TriageList {
    /** Every listed session, in registry order. */
    readonly rows: readonly TriageRow[];
}
/**
 * The decisions the list offers for one row. The first four carry the row out;
 * `goal` changes what the next resume may spend without touching the park
 * itself.
 */
export declare const TRIAGE_ACTIONS: readonly ["continue", "note", "review", "leave", "goal"];
/** One decision the list offers. */
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];
/**
 * Encode one decision list for a command result.
 * @param list - the rows to publish.
 * @returns the result text, e.g. `pause triage: 1; row: overnight; phase: draining; stopped: tool/call/turn 1 step 1; tools: gated; wake: yes`.
 */
export declare function encodeTriageList(list: TriageList): string;
/**
 * Decode a decision list previously written by {@link encodeTriageList}.
 * @param text - a command result's text.
 * @returns the list, or `undefined` when this text carries none.
 */
export declare function decodeTriageList(text: string): TriageList | undefined;
