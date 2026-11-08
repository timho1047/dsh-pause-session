/**
 * The identities both halves of dsh-pause-session name, the phase vocabulary
 * they share, and the one spelling a host log line gives a caught value.
 *
 * The browser bundle may value-import only the shell's baseline module table,
 * so this module imports nothing. The native Remote payloads are the live
 * vocabulary; there is no command encoding or slash-command surface here.
 * @module dsh-pause-session/shared
 */
/** Result copy for a press or a release the durable registry refused to record. */
export const UNRECORDED_TEXT = 'pause could not write the pause registry, so it did not change the pause state.';
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
/**
 * The decisions the list offers for one row. The first four carry the row out;
 * `goal` changes what the next resume may spend without touching the park
 * itself.
 */
export const TRIAGE_ACTIONS = ['continue', 'note', 'review', 'leave', 'goal'];
//# sourceMappingURL=shared.js.map