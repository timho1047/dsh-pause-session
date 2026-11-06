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
export const PAUSE_COMMAND = 'pause';
/** Command that resumes the receiving session; registered only while that session is paused. */
export const RESUME_COMMAND = 'pause-resume';
/** Command that resumes every parked session the registry remembers. */
export const RESUME_ALL_COMMAND = 'pause-resume-all';
/** Command that registers and parks every running session tree in one action. */
export const PAUSE_ALL_COMMAND = 'pause-all';
/** Command that reports the whole-app park state; registered globally, always. */
export const STATE_ALL_COMMAND = 'pause-state-all';
/** Command that reports the receiving session's park state; registered only while it is paused. */
export const STATUS_COMMAND = 'pause-state';
/** Command that turns the receiving session's own goal re-arm on or off; registered only while it is paused. */
export const GOAL_COMMAND = 'pause-goal';
/** Command that reports every session that did not stop cleanly. */
export const TRIAGE_COMMAND = 'pause-triage';
/** Command that resumes one session from the decision list exactly as the clean path would. */
export const TRIAGE_CONTINUE_COMMAND = 'pause-triage-continue';
/** Command that resumes one session from the decision list with the unknown-outcome note. */
export const TRIAGE_NOTE_COMMAND = 'pause-triage-note';
/** Command that opens one session from the decision list without spending a request. */
export const TRIAGE_REVIEW_COMMAND = 'pause-triage-review';
/** Command that leaves one session from the decision list exactly as it is. */
export const TRIAGE_LEAVE_COMMAND = 'pause-triage-leave';
/** Command that turns one listed session's goal re-arm on or off. */
export const TRIAGE_GOAL_COMMAND = 'pause-triage-goal';
/** Stable definition id of the pause command, matched by identity rather than by copy. */
export const PAUSE_DEFINITION_ID = 'dsh-pause-session/pause';
/** Stable definition id of the resume command: the host's own "this session is paused" fact. */
export const RESUME_DEFINITION_ID = 'dsh-pause-session/resume';
/** Stable definition id of the global resume command, matched by identity rather than by copy. */
export const RESUME_ALL_DEFINITION_ID = 'dsh-pause-session/resume-all';
/** Stable definition id of the whole-app pause command. */
export const PAUSE_ALL_DEFINITION_ID = 'dsh-pause-session/pause-all';
/** Stable definition id of the whole-app status read. */
export const STATE_ALL_DEFINITION_ID = 'dsh-pause-session/state-all';
/** Stable definition id of the status read, matched by identity rather than by copy. */
export const STATUS_DEFINITION_ID = 'dsh-pause-session/status';
/** Stable definition id of the paused session's own goal re-arm toggle. */
export const GOAL_DEFINITION_ID = 'dsh-pause-session/goal';
/** Stable definition id of the decision-list read. */
export const TRIAGE_DEFINITION_ID = 'dsh-pause-session/triage';
/** Stable definition id of the decision-list "continue" verb. */
export const TRIAGE_CONTINUE_DEFINITION_ID = 'dsh-pause-session/triage-continue';
/** Stable definition id of the decision-list "continue with the unknown-outcome note" verb. */
export const TRIAGE_NOTE_DEFINITION_ID = 'dsh-pause-session/triage-note';
/** Stable definition id of the decision-list "open without activating" verb. */
export const TRIAGE_REVIEW_DEFINITION_ID = 'dsh-pause-session/triage-review';
/** Stable definition id of the decision-list "leave it alone today" verb. */
export const TRIAGE_LEAVE_DEFINITION_ID = 'dsh-pause-session/triage-leave';
/** Stable definition id of the decision-list goal re-arm toggle. */
export const TRIAGE_GOAL_DEFINITION_ID = 'dsh-pause-session/triage-goal';
/** First token of every encoded status, so a descriptor is never parsed by accident. */
export const STATUS_PREFIX = 'pause: ';
/**
 * One list field's text when the list is empty. A value that would itself spell
 * this marker is escaped by {@link escapeField}, so an empty list and a list
 * holding the marker stay different texts.
 */
const EMPTY_FIELD = '-';
/**
 * One field or item value, ready to sit inside an encoded text: every separator
 * (`;`, `,`, `/`, newline) and the escape character itself are escaped, and a
 * value that would spell {@link EMPTY_FIELD} is escaped so it is not read as an
 * empty list.
 * @param text - the value to encode, as the host holds it.
 * @returns the value as it appears inside an encoded field.
 */
function escapeField(text) {
    const escaped = text.replace(/[\\;,\n/]/g, character => character === '\n' ? '\\n' : `\\${character}`);
    return escaped.startsWith(EMPTY_FIELD) ? `\\${escaped}` : escaped;
}
/**
 * One value previously written by {@link escapeField}.
 * @param text - the encoded value, escapes included.
 * @returns the value the host holds.
 */
function unescapeField(text) {
    return text.replace(/\\(.)/g, (_escape, character) => character === 'n' ? '\n' : character);
}
/**
 * Split one encoded text on the separators that are not escaped, keeping each
 * escape beside the character it protects so {@link unescapeField} can read it.
 * @param text - an encoded text, without its prefix.
 * @param separator - the single character to split on.
 * @returns the parts, in order; always at least one.
 */
function splitFields(text, separator) {
    const parts = [];
    let part = '';
    for (let at = 0; at < text.length; at += 1) {
        const character = text[at] ?? '';
        if (character === '\\') {
            part += character + (text[at + 1] ?? '');
            at += 1;
            continue;
        }
        if (character === separator) {
            parts.push(part);
            part = '';
            continue;
        }
        part += character;
    }
    parts.push(part);
    return parts;
}
/**
 * One field of an encoded text, by its key.
 * @param fields - the separated fields of one encoded text.
 * @param key - the field's key, without its `:`.
 * @returns the field's value with its escapes still in place, or `undefined`
 * when the text does not carry that field.
 */
function fieldOf(fields, key) {
    const prefix = `${key}:`;
    const at = fields.findIndex(field => field.trim().startsWith(prefix));
    return at < 0 ? undefined : fields[at]?.trim().slice(prefix.length).trim();
}
/**
 * One log line's text for a caught value.
 * @param error - the caught value.
 * @returns the error's message, or the value's own spelling.
 */
export function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
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
export const PARK_PHASES = ['draining', 'parking', 'safe', 'flush-failed'];
/**
 * How far along a phase is, worst first. The direction is not the order a park
 * walks: it orders how much of the promise each outcome keeps, which is what a
 * fold over several sessions has to compare. `safe` keeps all of it, `draining`
 * and `parking` are on their way, `flush-failed` has stopped trying — a park
 * that failed its flush is further from clean than one that is still working at
 * it, so it must never be the outcome a report rounds down to.
 */
const PHASE_SEVERITY = {
    safe: 0,
    draining: 1,
    parking: 2,
    'flush-failed': 3,
};
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
export function foldTreePhases(phases) {
    let worst = 'safe';
    for (const phase of phases) {
        if (PHASE_SEVERITY[phase] > PHASE_SEVERITY[worst])
            worst = phase;
    }
    return { phase: worst, safe: worst === 'safe' };
}
/** The one word each phase is published as, and the whole decoding vocabulary. */
const PHASE_WORD = {
    draining: 'pausing',
    parking: 'saving',
    safe: 'paused',
    'flush-failed': 'save failed',
};
/**
 * The two states of one record's goal re-arm field, in the one spelling both
 * the per-session status and the decision list publish it with.
 */
const GOAL_ON = 'on';
const GOAL_OFF = 'off';
/**
 * Encode one status for a command descriptor.
 * @param status - the state to publish.
 * @returns the descriptor text, e.g. `pause: draining; tools: edit, bash; goal: on`.
 */
export function encodeParkStatus(status) {
    const head = `${STATUS_PREFIX}${PHASE_WORD[status.phase]}`;
    const tools = status.runningTools.length === 0
        ? ''
        : `; tools: ${status.runningTools.map(escapeField).join(', ')}`;
    const goal = status.rearmGoal === undefined ? '' : `; goal: ${status.rearmGoal ? GOAL_ON : GOAL_OFF}`;
    return `${head}${tools}${goal}`;
}
/**
 * Decode a status previously written by {@link encodeParkStatus}.
 * @param text - a command descriptor's description.
 * @returns the status, or `undefined` when this text carries none — a foreign
 * command, or a reading taken before the host published anything.
 */
export function decodeParkStatus(text) {
    if (!text.startsWith(STATUS_PREFIX))
        return undefined;
    const [head = '', ...rest] = splitFields(text.slice(STATUS_PREFIX.length), ';');
    const word = head.trim();
    const phase = Object.keys(PHASE_WORD).find(candidate => PHASE_WORD[candidate] === word);
    if (phase === undefined)
        return undefined;
    const goal = fieldOf(rest, 'goal');
    return {
        phase,
        safe: phase === 'safe',
        runningTools: decodeNames(fieldOf(rest, 'tools')),
        // A text without the field reports no goal state at all, rather than the
        // product default: only the host's own record may say what it says.
        ...goal === GOAL_ON ? { rearmGoal: true } : goal === GOAL_OFF ? { rearmGoal: false } : {},
    };
}
/**
 * First token of every encoded whole-app status. A different prefix from the
 * per-session status on purpose: one decoder must never read the other's text.
 */
export const GLOBAL_STATUS_PREFIX = 'pause all: ';
/** The one path the Browser reads the host's live pause snapshot from. */
export const STATUS_PATH = '/dsh-pause-session/status';
/** Encode one list field. */
function encodeNames(names) {
    return names.length === 0 ? EMPTY_FIELD : names.map(escapeField).join(', ');
}
/**
 * Encode one optional session id: the empty marker when the park names none.
 * @param id - the session id, as the host holds it.
 * @returns the id as it appears inside an encoded field.
 */
function encodeId(id) {
    return id === undefined ? EMPTY_FIELD : escapeField(id);
}
/**
 * Decode one id previously written by {@link encodeId}.
 * @param field - the encoded field, escapes included.
 * @returns the id; `undefined` when the text carries none — an absent field and
 * the empty marker both mean the answer names no session, and a client that
 * read either as one would address a session the host never named.
 */
function decodeId(field) {
    const text = field?.trim();
    if (text === undefined || text.length === 0 || text === EMPTY_FIELD)
        return undefined;
    return unescapeField(text);
}
/** Decode one list field. */
function decodeNames(field) {
    const text = field?.trim();
    if (text === undefined || text.length === 0 || text === EMPTY_FIELD)
        return [];
    return splitFields(text, ',')
        .map(name => unescapeField(name.trim()))
        .filter(name => name.length > 0);
}
/**
 * Encode one whole-app status for a command result.
 * @param status - the state to publish.
 * @returns the result text, e.g.
 * `pause all: waiting; registered: 3; safe: 1; parked-at: overnight; draining: overnight; parking: 1; stalled: -; unresumable: -; unread-trees: -; jobs: bash-1; blind: -`.
 */
export function encodeGlobalStatus(status) {
    return `${GLOBAL_STATUS_PREFIX}${status.verdict}`
        + `; registered: ${status.registered}`
        + `; safe: ${status.safe}`
        + `; parked-at: ${encodeId(status.parkedAt)}`
        + `; draining: ${encodeNames(status.draining)}`
        + `; parking: ${status.parking}`
        + `; stalled: ${encodeNames(status.stalled)}`
        + `; unresumable: ${encodeNames(status.unresumable)}`
        + `; unread-trees: ${encodeNames(status.unreadTrees)}`
        + `; jobs: ${encodeNames(status.jobs)}`
        + `; blind: ${encodeNames(status.blind)}`;
}
/**
 * Decode a whole-app status previously written by {@link encodeGlobalStatus}.
 * @param text - a command result's text.
 * @returns the status, or `undefined` when this text carries none.
 */
export function decodeGlobalStatus(text) {
    if (!text.startsWith(GLOBAL_STATUS_PREFIX))
        return undefined;
    const [head = '', ...fields] = splitFields(text.slice(GLOBAL_STATUS_PREFIX.length), ';');
    const verdict = head.trim();
    if (verdict !== 'idle' && verdict !== 'waiting' && verdict !== 'safe')
        return undefined;
    const byKey = new Map();
    for (const field of fields) {
        const at = field.indexOf(':');
        if (at < 0)
            continue;
        byKey.set(field.slice(0, at).trim(), field.slice(at + 1).trim());
    }
    const count = (key) => {
        const value = Number(byKey.get(key));
        return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    };
    const parkedAt = decodeId(byKey.get('parked-at'));
    return {
        verdict,
        registered: count('registered'),
        safe: count('safe'),
        // A text written before this field existed names no parked session, and a
        // park that holds nothing names none either: both decode as no address
        // rather than as a session to look up.
        ...parkedAt === undefined ? {} : { parkedAt },
        draining: decodeNames(byKey.get('draining')),
        // An answer written before this field existed reports no session standing
        // still: the oldest reading is the one with nothing known to watch.
        parking: count('parking'),
        stalled: decodeNames(byKey.get('stalled')),
        unresumable: decodeNames(byKey.get('unresumable')),
        unreadTrees: decodeNames(byKey.get('unread-trees')),
        jobs: decodeNames(byKey.get('jobs')),
        blind: decodeNames(byKey.get('blind')).filter((spot) => spot === 'trees' || spot === 'jobs'),
    };
}
/**
 * First token of every encoded decision list. Separate from the per-session and
 * whole-app status prefixes on purpose, for the same reason those two are
 * separate: one decoder must never read another's text.
 */
export const TRIAGE_PREFIX = 'pause triage: ';
/**
 * The decisions the list offers for one row. The first four carry the row out;
 * `goal` changes what the next resume may spend without touching the park
 * itself.
 */
export const TRIAGE_ACTIONS = ['continue', 'note', 'review', 'leave', 'goal'];
/** How one row is spelled in the published list; the wake field's state when the host can hand over the owed request. */
const WAKE_YES = 'yes';
/** One row's traces, as a list of `tool/callId` items. */
function encodeTraces(traces) {
    if (traces.length === 0)
        return EMPTY_FIELD;
    return traces
        .map(trace => `${escapeField(trace.tool)}/${escapeField(trace.callId)}`)
        .join(', ');
}
/** Decode {@link encodeTraces}; an item without a tool name is not a trace. */
function decodeTraces(field) {
    const text = field?.trim();
    if (text === undefined || text.length === 0 || text === EMPTY_FIELD)
        return [];
    return splitFields(text, ',').flatMap((item) => {
        // Only the separator between the two halves is unescaped, so the split is
        // exact even for a tool name or a call id that carries a slash itself.
        const [tool = '', callId = ''] = splitFields(item.trim(), '/');
        if (tool.length === 0)
            return [];
        return [{ tool: unescapeField(tool), callId: unescapeField(callId) }];
    });
}
/** One row's stop position, encoded as `<last event>` plus the step it belongs to. */
function encodeStop(row) {
    if (row.lastEvent === undefined)
        return EMPTY_FIELD;
    const position = row.turn === undefined
        ? ''
        : `/turn ${String(row.turn)}${row.step === undefined ? '' : ` step ${String(row.step)}`}`;
    return `${escapeField(row.lastEvent)}${position}`;
}
/**
 * Encode one decision list for a command result.
 * @param list - the rows to publish.
 * @returns the result text, e.g. `pause triage: 1; row: overnight; phase: draining; stopped: tool/call/turn 1 step 1; tools: gated; wake: yes`.
 */
export function encodeTriageList(list) {
    const head = `${TRIAGE_PREFIX}${String(list.rows.length)}`;
    return list.rows.reduce((text, row) => {
        const stopped = row.reading === 'unreadable' ? 'unreadable' : encodeStop(row);
        return `${text}; row: ${escapeField(row.sessionId)}`
            + `; phase: ${row.phase}`
            + `; stopped: ${stopped}`
            + `; traces: ${row.reading === 'unreadable' ? EMPTY_FIELD : encodeTraces(row.traces)}`
            + `; tools: ${row.reading === 'unreadable' || row.traces.length === 0 ? EMPTY_FIELD : encodeNames(row.traces.map(trace => trace.tool))}`
            + `; owed: ${row.owed ? WAKE_YES : 'no'}`
            + `; wake: ${row.wakeable ? WAKE_YES : 'no'}`
            + `; goal: ${row.rearmGoal ? GOAL_ON : GOAL_OFF}`;
    }, head);
}
/**
 * Decode a decision list previously written by {@link encodeTriageList}.
 * @param text - a command result's text.
 * @returns the list, or `undefined` when this text carries none.
 */
export function decodeTriageList(text) {
    if (!text.startsWith(TRIAGE_PREFIX))
        return undefined;
    const [head = '', ...rest] = splitFields(text.slice(TRIAGE_PREFIX.length), ';');
    if (!Number.isSafeInteger(Number(head.trim())) || Number(head.trim()) < 0)
        return undefined;
    const rows = [];
    let fields = [];
    const flush = () => {
        if (fields.length === 0)
            return;
        const sessionId = fieldOf(fields, 'row');
        const phase = fieldOf(fields, 'phase');
        if (sessionId === undefined || phase === undefined || phase === 'safe')
            return;
        const stopped = fieldOf(fields, 'stopped');
        const reading = stopped === 'unreadable' ? 'unreadable' : 'read';
        // An encoded event name has every slash escaped, so the `/turn` suffix is
        // the field's only raw slash and the lazy match ends exactly there. A row
        // the host could not read has no event to name, and a row whose log ends on
        // no event at all carries the empty marker instead.
        const position = reading === 'unreadable' || stopped === undefined || stopped === EMPTY_FIELD
            ? null
            : /^(.*?)(?:\/turn (\d+)(?: step (\d+))?)?$/.exec(stopped);
        rows.push({
            sessionId: unescapeField(sessionId),
            phase: phase,
            updatedAt: 0,
            reading,
            ...position === null
                ? {}
                : {
                    lastEvent: unescapeField(position[1] ?? ''),
                    ...position[2] === undefined ? {} : { turn: Number(position[2]) },
                    ...position[3] === undefined ? {} : { step: Number(position[3]) },
                },
            traces: reading === 'unreadable' ? [] : decodeTraces(fieldOf(fields, 'traces')),
            owed: fieldOf(fields, 'owed') === WAKE_YES,
            wakeable: fieldOf(fields, 'wake') === WAKE_YES,
            // A list published before this field existed reads as the product
            // default: a goal session comes back running its rounds.
            rearmGoal: fieldOf(fields, 'goal') !== GOAL_OFF,
        });
        fields = [];
    };
    for (const field of rest) {
        if (field.trim().startsWith('row:'))
            flush();
        fields.push(field);
    }
    flush();
    return { rows };
}
//# sourceMappingURL=shared.js.map