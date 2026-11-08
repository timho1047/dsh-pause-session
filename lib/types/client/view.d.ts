/**
 * The controls' phase → view mapping.
 *
 * Kept pure functions of the published reading so the rendering decision — what
 * the button says, whether it accepts a press, and which state label is visible
 * — is asserted without a browser renderer. Labels are KEYS, not copy: the
 * visible sentence is localized, and the host's own names join it as data.
 * @module dsh-pause-session/client/view
 */
import type { GlobalReading, TriageReading } from './global.js';
import type { PauseReading } from './control.js';
import type { PauseKey } from './locales.js';
import type { TriageAction } from '../shared.js';
/** What one reading renders as. */
export interface PauseView {
    /** Whether the host reported this session paused. */
    readonly paused: boolean;
    /** Whether the control accepts a press; an unknown or failed reading does not. */
    readonly enabled: boolean;
    /** Accessible name of the button. */
    readonly ariaKey: PauseKey;
    /** Label shown beside the button while the control has something to say. */
    readonly labelKey?: PauseKey;
    /** Tools in flight, taken verbatim from the host; rendered only with `labelKey`. */
    readonly runningTools: readonly string[];
    /**
     * The host-reported goal opt-out, or `undefined` when the host did not answer
     * it. Absent means the goal switch is not rendered at all: a switch has to
     * state a fact, and the only fact available is the one the record holds.
     */
    readonly rearmGoal?: boolean;
}
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
export declare function showsPauseControl(subagent: {
    readonly address: unknown;
} | null | undefined): boolean;
/**
 * Map one reading to its view.
 * @param reading - the host-reported reading, or `undefined` before the first answer.
 * @returns the view for that reading.
 */
export declare function pauseView(reading: PauseReading | undefined, running?: boolean): PauseView;
/** One named fact from the whole-app report, with the copy key that introduces it. */
export interface GlobalCaveat {
    /** What this list of names is. */
    readonly key: PauseKey;
    /** Host names, rendered verbatim. */
    readonly names: readonly string[];
}
/** Which verb a whole-app press runs. */
export type GlobalAction = 'pause-all' | 'resume-all' | 'cancel-all' | 'none';
/** One decision as the list renders it. */
export interface TriageActionView {
    /** The decision this button takes. */
    readonly action: TriageAction;
    /** Visible label. */
    readonly labelKey: PauseKey;
    /** What it does, for the accessible name. */
    readonly ariaKey: PauseKey;
}
/** The four decisions, in the order a user reads them: least to most cautious. */
export declare const TRIAGE_ACTION_VIEWS: readonly TriageActionView[];
/**
 * The decisions one row may offer. Continue and note both deliver the owed
 * request, so they are absent when the log is unreadable or the host says it
 * cannot wake the entry; the remaining decisions still give the user a way out.
 * @param row - the rendered row.
 * @returns the actions that can be taken on it.
 */
export declare function triageActionsFor(row: TriageRowView): readonly TriageActionView[];
/**
 * The fifth listed verb, rendered apart from the four decisions: it is a
 * switch on what the NEXT resume may spend, not a way to decide this row.
 */
export declare const TRIAGE_GOAL_VIEW: TriageActionView;
/** One listed session, as the panel renders it. */
export interface TriageRowView {
    /** Host data, rendered verbatim. */
    readonly sessionId: string;
    /** The durable outcome, as a word. */
    readonly phaseKey: PauseKey;
    /** Stop position: the event the log ends on and the step it belongs to. */
    readonly stopped?: string;
    /** The tools whose outcomes were never recorded. */
    readonly unknownTools: readonly string[];
    /** Whether the host said it can hand this session the request it owes. */
    readonly wakeable: boolean;
    /** Whether the log could be read at all. */
    readonly readable: boolean;
    /** Whether resuming this session may re-open its goal and spend its rounds. */
    readonly rearmGoal: boolean;
}
/** What the decision-list panel renders. */
export interface TriageView {
    /** Whether the host answered the list read at all. */
    readonly visible: boolean;
    /** Whether the last list read failed rather than returning rows. */
    readonly unavailable: boolean;
    /** The rows the host reported. */
    readonly rows: readonly TriageRowView[];
}
/**
 * Map one decision-list reading to its view.
 * @param reading - the host-reported list, or `undefined` before the panel asked.
 * @returns the rows as the panel renders them.
 */
export declare function triageView(reading: TriageReading | undefined): TriageView;
/** What the whole-app reading renders as. */
export interface GlobalPauseView {
    /** Whether the control renders at all; a control with no host answer claims nothing. */
    readonly visible: boolean;
    /** Whether the control accepts a press. */
    readonly enabled: boolean;
    /** Accessible name of the button. */
    readonly ariaKey: PauseKey;
    /**
     * Headline shown beside the button. Absent while there is nothing to report:
     * an untouched park renders the bare affordance, not a sentence about itself.
     */
    readonly labelKey?: PauseKey;
    /** Verb the press runs. */
    readonly action: GlobalAction;
    /** Host numbers, rendered verbatim beside the label. */
    readonly detail: string;
    /** How many decisions are waiting; shown on the panel's own entry point. */
    readonly unclean: number;
    /** Named facts the user must not miss; rendered on the tooltip. */
    readonly caveats: readonly GlobalCaveat[];
    /** Draining sessions and what each is running, when the host still has work. */
    readonly running?: string;
}
/**
 * Map one whole-app reading to its view.
 * @param reading - the host-reported reading, or `undefined` before the first answer.
 * @returns the view for that reading.
 */
export declare function globalPauseView(reading: GlobalReading | undefined, sessions?: Readonly<Record<string, {
    readonly runningTools: readonly string[];
}>>): GlobalPauseView;
