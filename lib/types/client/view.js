/**
 * The controls' phase → view mapping.
 *
 * Kept pure functions of the published reading so the rendering decision — what
 * the button says, whether it accepts a press, and which state label is visible
 * — is asserted without a browser renderer. Labels are KEYS, not copy: the
 * visible sentence is localized, and the host's own names join it as data.
 * @module dsh-pause-session/client/view
 */
/**
 * Whether the pause control renders on one session at all.
 *
 * The control is the user's button for a session's work, and that work includes
 * the subagents under it — which is why the press covers the tree and why the
 * button does not belong inside the tree. The client can tell: a Session
 * snapshot carries a `subagent` field, the same signal the read-only composer
 * reads. A subagent's service is not the user's to pause: its parent's control
 * already speaks for it, and a second button here would offer to stop "a
 * session" from inside a child.
 * @param subagent - the session snapshot's own subagent fact, absent when unknown.
 * @returns whether this session's header renders the control.
 */
export function showsPauseControl(subagent) {
    return subagent === null || subagent === undefined;
}
/**
 * One reading's goal opt-out, as the view carries it. Only an answered flag
 * becomes a field: a missing one must stay missing through the mapping, or the
 * renderer would show the product default as if the host had said it.
 * @param reading - the host's answer.
 * @returns the field to spread into the view, empty when the host said nothing.
 */
function goalOf(reading) {
    return reading.rearmGoal === undefined ? {} : { rearmGoal: reading.rearmGoal };
}
/**
 * Map one reading to its view.
 * @param reading - the host-reported reading, or `undefined` before the first answer.
 * @returns the view for that reading.
 */
export function pauseView(reading, running = true) {
    switch (reading?.phase) {
        case 'active':
            // Not parked, so no record exists for a resume to obey: there is nothing
            // to switch, and an idle session has no work to park.
            return { paused: false, enabled: running, ariaKey: 'pause.aria', runningTools: [] };
        case 'draining':
            // Still working: pressing again is exactly how the user takes the pause
            // back, so the control stays live.
            return {
                paused: true,
                enabled: true,
                ariaKey: 'draining.aria',
                labelKey: 'state.draining',
                runningTools: reading.runningTools,
            };
        case 'parking':
            return {
                paused: true,
                enabled: true,
                ariaKey: 'parking.aria',
                labelKey: 'state.parking',
                runningTools: [],
            };
        case 'safe':
            return {
                paused: true,
                enabled: true,
                ariaKey: 'safe.aria',
                labelKey: 'state.safe',
                runningTools: [],
                ...goalOf(reading),
            };
        case 'flush-failed':
            return {
                paused: true,
                enabled: true,
                ariaKey: 'flushFailed.aria',
                labelKey: 'state.flushFailed',
                runningTools: [],
            };
        case 'unavailable':
            return { paused: false, enabled: false, ariaKey: 'unavailable.aria', runningTools: [] };
        case undefined:
            return { paused: false, enabled: false, ariaKey: 'checking.aria', runningTools: [] };
    }
}
/** The four decisions, in the order a user reads them: least to most cautious. */
export const TRIAGE_ACTION_VIEWS = [
    { action: 'continue', labelKey: 'triage.continue', ariaKey: 'triage.continue.aria' },
    { action: 'note', labelKey: 'triage.note', ariaKey: 'triage.note.aria' },
    { action: 'review', labelKey: 'triage.review', ariaKey: 'triage.review.aria' },
    { action: 'leave', labelKey: 'triage.leave', ariaKey: 'triage.leave.aria' },
];
/**
 * The decisions one row may offer. Continue and note both deliver the owed
 * request, so they are absent when the log is unreadable or the host says it
 * cannot wake the entry; the remaining decisions still give the user a way out.
 * @param row - the rendered row.
 * @returns the actions that can be taken on it.
 */
export function triageActionsFor(row) {
    return TRIAGE_ACTION_VIEWS.filter(action => action.action !== 'continue' && action.action !== 'note' ? true : row.readable && row.wakeable);
}
/**
 * The fifth listed verb, rendered apart from the four decisions: it is a
 * switch on what the NEXT resume may spend, not a way to decide this row.
 */
export const TRIAGE_GOAL_VIEW = {
    action: 'goal',
    labelKey: 'triage.goal',
    ariaKey: 'triage.goal.aria',
};
/** The word each non-clean phase is shown as. */
const PHASE_KEY = {
    draining: 'triage.phase.draining',
    parking: 'triage.phase.parking',
    'flush-failed': 'triage.phase.flushFailed',
};
/**
 * Map one decision-list reading to its view.
 * @param reading - the host-reported list, or `undefined` before the panel asked.
 * @returns the rows as the panel renders them.
 */
export function triageView(reading) {
    if (reading === undefined)
        return { visible: false, unavailable: false, rows: [] };
    if (reading.kind === 'unavailable')
        return { visible: true, unavailable: true, rows: [] };
    return {
        visible: true,
        unavailable: false,
        rows: reading.rows.map(row => ({
            sessionId: row.sessionId,
            phaseKey: PHASE_KEY[row.phase],
            ...row.lastEvent === undefined
                ? {}
                : {
                    stopped: row.turn === undefined
                        ? row.lastEvent
                        : `${row.lastEvent} · turn ${String(row.turn)}${row.step === undefined ? '' : ` step ${String(row.step)}`}`,
                },
            unknownTools: row.traces.map(trace => trace.tool),
            wakeable: row.wakeable,
            readable: row.reading === 'read',
            rearmGoal: row.rearmGoal,
        })),
    };
}
/**
 * Map one whole-app reading to its view.
 * @param reading - the host-reported reading, or `undefined` before the first answer.
 * @returns the view for that reading.
 */
export function globalPauseView(reading, sessions) {
    if (reading === undefined) {
        return { visible: false, enabled: false, ariaKey: 'all.checking.aria', action: 'none', detail: '', caveats: [], unclean: 0 };
    }
    // A host that cannot answer gets no control: this plugin never renders a
    // button whose state it would have to invent.
    // A transient transport failure keeps the control on screen, disabled: it
    // claims nothing, but it does not vanish and come back while reconnecting.
    if (reading.kind === 'unavailable') {
        return { visible: true, enabled: false, ariaKey: 'all.unavailable.aria', action: 'none', detail: '', caveats: [], unclean: 0 };
    }
    const { status } = reading;
    const caveats = [];
    // A missing surface subsumes its per-session names: the absence itself is the
    // fact, and listing every session it blinds would say less.
    if (status.blind.includes('jobs'))
        caveats.push({ key: 'all.caveat.blindJobs', names: [] });
    else if (status.jobs.length > 0)
        caveats.push({ key: 'all.caveat.jobs', names: status.jobs });
    if (status.blind.includes('trees'))
        caveats.push({ key: 'all.caveat.blindTrees', names: [] });
    else if (status.unreadTrees.length > 0)
        caveats.push({ key: 'all.caveat.unread', names: status.unreadTrees });
    if (status.unresumable.length > 0)
        caveats.push({ key: 'all.caveat.unresumable', names: status.unresumable });
    const verdict = status.verdict;
    // The stalled names are the sessions this process will not wake, so they
    // belong on the tooltip whenever there are any — as the whole story when
    // nothing is still moving, and beside the moving ones when there are.
    if (verdict !== 'safe' && status.stalled.length > 0) {
        caveats.push({ key: 'all.caveat.stalled', names: status.stalled });
    }
    // The whole-app verdict calls these "not safe"; the list is where the user
    // decides them, so the panel's entry point counts the same set.
    const unclean = status.stalled.length;
    const base = { visible: true, enabled: true, caveats, unclean };
    switch (verdict) {
        case 'idle':
            // Nothing parked: the pill is the affordance itself, so it carries no
            // sentence about a park that does not exist.
            return { ...base, ariaKey: 'all.pause.aria', action: 'pause-all', detail: '' };
        case 'safe':
            return {
                ...base,
                ariaKey: 'all.resume.aria',
                action: 'resume-all',
                labelKey: 'all.safe',
                detail: `${String(status.safe)}/${String(status.registered)}`,
            };
        case 'waiting':
            // Only a session still on its way can be released from here. When every
            // registered session is one this process will not wake — an adopted
            // pause, a failed flush, a record it cannot read — the release would be
            // an action the host refuses, so the pill states the fact and hands the
            // user to the list instead of offering it. A session holding the park
            // point with its flush pending is still releasable, so it keeps the verb.
            return status.draining.length > 0 || status.parking > 0
                ? {
                    ...base,
                    ariaKey: 'all.cancel.aria',
                    action: 'cancel-all',
                    labelKey: 'all.finishing',
                    detail: `${String(status.safe)}/${String(status.registered)}`,
                    running: status.draining.map((id) => {
                        const tools = sessions?.[id]?.runningTools ?? [];
                        return tools.length === 0 ? id : `${id}: ${tools.join(', ')}`;
                    }).join(', ') || undefined,
                }
                : {
                    ...base,
                    enabled: false,
                    ariaKey: 'all.unclean.aria',
                    action: 'none',
                    labelKey: 'all.unclean',
                    detail: String(status.stalled.length),
                };
    }
}
//# sourceMappingURL=view.js.map