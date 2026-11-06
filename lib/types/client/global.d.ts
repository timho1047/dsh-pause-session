/**
 * Browser-side reading and driving of the host's whole-app park state.
 *
 * On a browser Host the aggregate arrives from the same-origin JSON status
 * route, which keeps background reads out of every Session log. A carrier
 * without that route falls back to the session-addressed command channel:
 * `pause-state-all` carries the whole-app status as of the read, and the
 * forwarded `commands/change` event says when to read again.
 *
 * The fallback still needs one session to talk through. It picks a user
 * session the host can serve (never a subagent's own session), preferring the
 * one on screen; once the host's answer names the park's own session, later
 * reads are addressed there. That is the fallback's cost, not the normal Web
 * path: the JSON route is process-wide and writes nothing into any Session.
 *
 * Every phase a session reaches announces itself through the registry — a
 * transition re-registers that session's status verb — so a change is what buys
 * the next read, and the flush that settles a park is announced like every other
 * step (`./burst.ts`). A read that finds work still in flight is therefore the
 * answer to the transition that produced it rather than a reason to keep asking;
 * what the burst still owes is the delivery of a change, and the rows of a panel
 * whose own read did not answer. A settled answer is left on screen unread: the
 * panel stays readable and the pill keeps saying what it says, but the browser
 * stops spending host round-trips on a state that has stopped
 * moving. What owes a read is the host's forwarded registry change, the user's
 * own press or decision, and the first read at mount; once an answer is on
 * screen, the shell handing this control another session to ask through is none
 * of those. A press, a decision and an opened panel each read the host as they
 * run, and the changes they set off are that action's own echo: those are
 * absorbed for a short window (`./burst.ts`), so a forwarded change owes a read
 * exactly when something moved that this browser did not do — with one look owed
 * at the close of that window when the reading the action left is still moving,
 * which is how a park that reaches its final phase inside the echo window is
 * still read.
 * @module dsh-pause-session/client/global
 */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { GlobalStatus, TriageAction, TriageRow } from '../shared.js';
import type { BurstPolicy } from './burst.js';
import type { PauseStatusSource } from './status.js';
/** What the whole-app control knows: the host's answer, or that it could not ask. */
export type GlobalReading = {
    readonly kind: 'reported';
    readonly status: GlobalStatus;
} | {
    readonly kind: 'unavailable';
};
/** What the decision-list panel knows: the host's rows, or that it could not ask. */
export type TriageReading = {
    readonly kind: 'reported';
    readonly rows: readonly TriageRow[];
} | {
    readonly kind: 'unavailable';
};
/** Whole-app control state. */
export interface GlobalPauseState {
    /** The host's answer; absent until one arrives. Writable: the store updates through a draft. */
    global: GlobalReading | undefined;
    /** Whether the user asked for the decision list; the panel reads only when it is open. */
    panelOpen: boolean;
    /** The host's decision list; absent until the panel asks for it. */
    triage: TriageReading | undefined;
}
/** The command one listed verb runs, named from the one vocabulary the host registers. */
export declare const TRIAGE_DECISION_COMMAND: Readonly<Record<TriageAction, string>>;
/**
 * The session a whole-app command is addressed to.
 *
 * A subagent's own session is never addressed: its agent belongs to a parent
 * and is not the host's business to drive from the shell. Among the rest, the
 * one on screen is the best address (its agent is live by construction), then
 * any session the host reports as running, then any at all.
 * @param state - the session list snapshot the shell provides.
 * @returns the address, or `undefined` when the app has no session to ask through.
 */
export declare function addressingSession(state: {
    readonly ids: readonly SessionId[];
    readonly byId: Readonly<Record<string, {
        readonly running?: boolean;
        readonly origin?: string;
        readonly parentId?: unknown;
        readonly retainedBy?: {
            readonly mainView?: number;
        };
    } | undefined>>;
}): SessionId | undefined;
/**
 * The session a registered park owns, when the host's answer names one that is
 * still moving. This is how a read stops landing in whatever session the user
 * happens to be looking at.
 * @param status - the host's last whole-app answer.
 * @returns a draining session, or `undefined` when the answer names none.
 */
export declare function registeredAddress(status: GlobalStatus): SessionId | undefined;
/**
 * The session the host names as the park's own, whatever phase the park
 * reached — the address a whole-app read belongs at.
 *
 * This is the fact {@link registeredAddress} cannot carry once a park is clean:
 * a session that reached `safe` has nothing left to do, so no bucket names it,
 * and a reader in another window would fall back to whatever session it is
 * showing. An answer written before this field existed names no session here:
 * an absent address, never one to guess at.
 * @param status - the host's last whole-app answer.
 * @returns the session the park belongs to, or `undefined` when the answer names none.
 */
export declare function parkedAddress(status: GlobalStatus): SessionId | undefined;
/** Owns the published whole-app reading; nothing else writes that state. */
export declare class PauseGlobalControl {
    private readonly commands;
    private readonly lifetime;
    private readonly source?;
    /** State source the whole-app contribution binds its selector hook to. */
    readonly store: SnapshotStore<GlobalPauseState>;
    /** The session the shell asked this control through; reads start here. */
    private address;
    /**
     * The last session an answer reported as registered — the address a read
     * falls back to when the host's own answer names no parked session, which is
     * every reading written before that field existed.
     *
     * The buckets that feed it name only what is still moving, so they say
     * nothing about a park that finished cleanly; the park's own name is the live
     * fact, and this memory is what keeps the rows in the park's transcript for an
     * answer that predates it. An empty registry does not clear it: a park whose
     * sessions stopped moving has not moved out of its sessions.
     */
    private lastRegistered;
    /**
     * The session the fallback command read was last served through. Later
     * fallback reads keep going there: each one is two records in that address
     * session's log, and the shell's address follows whatever the user is looking
     * at, which is not where a row about the park belongs. The Web status route
     * bypasses this address entirely.
     */
    private served;
    /** Highest decision-list read requested: an answer older than it is dropped. */
    private latestTriage;
    /** Highest read sequence requested: an answer older than it is dropped. */
    private latest;
    /**
     * Whether a registry change has arrived that no completed read pass has
     * answered. Set only for a change that is news — an absorbed echo of this
     * browser's own action is already answered by that action's read.
     */
    private owed;
    /** The bounded burst of reads one transition buys; see `./burst.ts`. */
    private readonly burst;
    /**
     * @param commands - the Client-callable command namespace.
     * @param lifetime - aborts in-flight calls and the burst when the plugin unloads.
     * @param windowMs - how long the burst collects the registrations of one
     * transition before its first read; also the wait after a press.
     * @param policy - the burst waits and visibility source; defaults to the real page.
     */
    constructor(commands: ClientRemote['commands'], lifetime: AbortSignal, windowMs?: number, policy?: Omit<BurstPolicy, 'windowMs' | 'waitsMs'>, source?: PauseStatusSource | undefined);
    /**
     * The shell handed this control a session: the one the pill mounted on, or
     * the one the user has just moved to. Only a control with no answer yet reads
     * here — the view moving is not the park moving, and after the first answer
     * the forwarded registry change and the user's own press are what ask again.
     * A read that came back with nothing is not an answer, so moving to another
     * session is one more chance to reach the host rather than a control that
     * stays mute until something else happens to change. The address is kept
     * either way: it is where this control's presses and its decision list go, and
     * the fallback a remembered address falls back to.
     * @param sessionId - the session the shell asks through.
     * @returns after this read's answer is published or superseded by a newer one.
     */
    refresh(sessionId: SessionId): Promise<void>;
    /** Whether the host has answered: a state, not the absence of one it never sent. */
    private answered;
    /**
     * The host's command registry changed: something may have moved, so a burst
     * is owed. The reads run on the burst's own schedule rather than here, which
     * is what coalesces a tick's worth of changes — parking N sessions announces
     * three registrations each, and a phase change re-registers one more — into
     * one burst. A change that is this browser's own action's echo owes nothing:
     * the action read the host as it ran.
     */
    refreshAll(): void;
    /**
     * One read of the whole screen: the aggregate, plus the decision list while
     * the user has it open. A closed panel spends no command calls on rows nobody
     * is reading.
     */
    private readAll;
    /**
     * The session a read goes through: the one the park is still draining, else
     * the one the host names as the park's own, else the one a read was last
     * served through, else the session the shell is on now. The park's own address
     * comes first because a read's rows land in the transcript it was taken
     * through, and the park — not the reader — is what they are about; its name
     * survives the clean case, where every bucket above is empty and a park that
     * finished would otherwise have no address at all.
     * @param skip - an address this read already tried and could not reach. The
     * fallback is the next candidate rather than the same one again.
     */
    private target;
    /**
     * Ask the host for the aggregate through the session a read goes through,
     * with the one fallback an address that stopped answering is worth: the
     * remembered address is forgotten, and the read is taken again through the
     * next one — the session the shell is on at the latest. A memory of a session
     * this host no longer holds would otherwise leave the control unable to say
     * anything at all, and a single retry is the whole price of keeping it honest.
     */
    private readAggregate;
    /**
     * Publish one aggregate answer, unless a newer read was requested while this
     * one was in flight: that answer would show a state the host has moved past.
     * A served address is remembered, and one that did not answer is forgotten —
     * that is what makes the read fall back to the next address rather than ask
     * it again.
     * @param sessionId - the session this read goes through.
     * @returns whether this read came back without an answer; a superseded read is
     * not one, because the newer read already owns the outcome.
     */
    private readAt;
    /**
     * Open or close the decision list. Opening asks the host for the rows; there
     * is no state to show without that answer. Opening is also a client action
     * that reads, so the changes it sets off are absorbed rather than read back,
     * and whether the burst owes anything is what its own read decides.
     * @param open - whether the panel should be showing.
     */
    setPanel(open: boolean): void;
    /**
     * Ask the host for the decision list through the session the user is on. The
     * list is recorded per calling session and the decisions act only on rows
     * that session was shown, so this read — unlike the aggregate — stays on the
     * shell's own address.
     */
    refreshTriage(): Promise<void>;
    /**
     * Read the aggregate again because the user asked this control to act: the
     * address is the session the shell is on, since a press is a user action on
     * the session the user is looking at, and the host's answer is what the
     * control shows next.
     * @param sessionId - the session the shell is on.
     */
    private reread;
    /** One decision-list read, addressed at the session the user is on. */
    private readTriage;
    /**
     * Take one listed verb on one listed session, addressed through the session
     * the user is on. The list is read first, because the host acts only on rows
     * it has shown the calling session, and read again afterwards because the
     * host's answer — not this control's assumption — is what the next render
     * shows: a decision can release a session, and the goal switch changes what
     * the row itself says.
     * @param sessionId - the listed session to act on.
     * @param action - which listed verb was taken.
     */
    decide(sessionId: string, action: TriageAction): Promise<void>;
    /**
     * Press the pill: park everything, or release everything the park owns.
     * Which one it is comes from the host's own last answer, never from a local
     * flip; the state shown afterwards is the host's answer again. A reading the
     * view does not turn into a verb — every registered session is one the host
     * will not wake — is not pressed at all.
     * @param sessionId - the session to address the verb to.
     * @returns after the control re-reads the host.
     */
    toggle(sessionId: SessionId): Promise<void>;
    /** Ask the host for the decision list, in the browser's vocabulary. */
    private readTriageRows;
    /** Ask the host what the whole-app park state is, in the browser's vocabulary. */
    private read;
    private publish;
    /**
     * Decide what the burst owes after a read: another look while a change this
     * browser has not answered is outstanding, or while the open panel is still
     * owed rows, and nothing once neither holds.
     *
     * A registered session standing at the park point is left alone: the flush
     * that settles it announces itself on the command channel like every other
     * transition, so watching it from here would spend reads on a move that is
     * going to speak for itself. A verdict that stays `waiting` because a record
     * is stalled, unresumable or unread is not settling either: nothing in this
     * process will change it, and a session that starts moving again registers its
     * markers, which is what asks next.
     *
     * The one transition that cannot speak for itself is the one this browser's
     * own echo window swallowed: a press reads the host, the park reaches its
     * final phase while the window is still open, and the changes that would have
     * announced it look exactly like the press's own registrations. An action that
     * left the park moving therefore asks for one look when that window closes,
     * and only then. Once nothing is owed, the last reading stays published — the
     * verdict, the pill and the rows are exactly what the host last reported.
     */
    private follow;
    /**
     * Whether the park this control last read still has work on its way — the only
     * state an action's own echo could be hiding a transition behind. A record
     * that is stalled, unresumable or unread is not moving: nothing in this
     * process will finish it.
     */
    private moving;
    /**
     * Whether the open panel is still owed its rows. Opening the panel reads them,
     * so this holds only after a read that did not answer — the one debt no change
     * created, and the one place a retry is the difference between an empty panel
     * and the facts the host has. It is bounded by the burst like everything else.
     */
    private unansweredPanel;
    /**
     * Follow the page in and out of view. A hidden page is not being read — and
     * the read the burst was about to take is not lost, it waits for the page to
     * come back.
     */
    watchVisibility(): void;
}
