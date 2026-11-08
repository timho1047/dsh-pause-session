/**
 * Browser-side reading and driving of the host's park state for one session.
 *
 * The browser reads the native `pauseSession` stream; actions travel through
 * the same Remote namespace. No slash command is involved. The stream is
 * host-authoritative, so this module never derives a state from its own press.
 * The snapshot also carries the record's goal opt-out, so the switch beside the
 * pause button can show it without a second host round-trip.
 *
 * The stream is the change feed: a fresh snapshot wakes the controls' own
 * coalescing burst, which reads the cached snapshot and publishes it. A press or
 * a goal switch reads as it runs, and the snapshot it causes is that action's
 * own echo, absorbed for a short window (`./burst.ts`).
 * @module dsh-pause-session/client/control
 */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { PauseTransport } from './remote.js';
import type { BurstPolicy } from './burst.js';
import type { GlobalReading } from './global.js';
/**
 * The whole-app answer as the session headers read it, or `undefined` before
 * that control has heard from the host. Reading it costs nothing: it is the
 * published snapshot, not a host round-trip.
 */
export type AggregateSource = () => GlobalReading | undefined;
/**
 * What the Session-header control knows about one session: what the host
 * reported, or that no answer has arrived (`undefined`) or the last read
 * failed. Neither of the latter claims a state the host never reported.
 *
 * `draining` and `parking` are the host's own two answers on the way to
 * `safe`; the control shows them rather than rounding them up, because only
 * `safe` means the pending input is durably stored.
 */
export type PausePhase = 'active' | 'draining' | 'parking' | 'safe' | 'flush-failed' | 'unavailable';
/** One host answer about one session. */
export interface PauseReading {
    readonly phase: PausePhase;
    /** Tools the host reported in flight; empty unless the phase is `draining`. */
    readonly runningTools: readonly string[];
    /**
     * Whether the host's own record lets the next resume re-open this session's
     * goal. Absent — not `true` — when the host did not say: the control shows no
     * switch rather than the product default, because a default here would tell
     * the user their rounds are safe when nobody has answered.
     */
    readonly rearmGoal?: boolean;
}
/** Per-session control state, keyed by Session id so a slot selector can watch one session. */
export interface PauseState {
    /** Reading per Session id; absent means no host answer yet. Writable: the store updates through a draft. */
    bySession: Record<string, PauseReading | undefined>;
}
/** Owns the published reading per session; nothing else writes that state. */
export declare class PauseControl {
    private readonly transport;
    private readonly lifetime;
    private readonly aggregate;
    /** State source the Session-header contribution binds its selector hook to. */
    readonly store: SnapshotStore<PauseState>;
    /** Sessions this control has shown; a host registry change re-reads every one of them. */
    private readonly shown;
    /** Highest read sequence requested per session: an answer older than it is dropped. */
    private readonly latest;
    /**
     * Sessions a change has put back on the list of ones to read once — a
     * transition this browser has been told about and has not answered yet.
     */
    private readonly owed;
    /**
     * Whether the look owed at the close of an echo window is still to be taken.
     * It reads every shown session, exactly as a change does: the look exists
     * because a change may have been swallowed, and a swallowed change carries no
     * payload either.
     */
    private trailing;
    /**
     * Sessions whose header was answered from the whole-app "nothing is
     * registered" instead of a read of their own, and which therefore have to be
     * read for real if that answer stops holding.
     */
    private readonly derived;
    /** The bounded burst of reads one transition buys; see `./burst.ts`. */
    private readonly burst;
    private reads;
    /**
     * @param commands - the Client-callable command namespace.
     * @param lifetime - aborts in-flight calls and the burst when the plugin unloads.
     * @param windowMs - how long the burst collects the registrations of one
     * transition before its first read; also the wait after a press.
     * @param policy - the burst waits and visibility source; defaults to the real page.
     * @param aggregate - the whole-app control's published answer; absent means it is never consulted.
     */
    constructor(transport: PauseTransport, lifetime: AbortSignal, windowMs?: number, policy?: Omit<BurstPolicy, 'windowMs' | 'waitsMs'>, aggregate?: AggregateSource);
    /**
     * Read the host's state for one session.
     * @param sessionId - session whose control was rendered.
     * @returns after this read's answer is published or superseded by a newer one.
     */
    refresh(sessionId: SessionId): Promise<void>;
    /**
     * The host's command registry changed, so every session this control has
     * shown may have moved — the forwarded event carries no payload, so the only
     * honest answer is to look at all of them once. The reads run on the burst's
     * own schedule rather than here, which is what makes a tick's worth of changes
     * — parking a session registers three commands, and a phase change re-registers
     * one more — one burst instead of one each. A change that is this browser's own
     * action's echo owes nothing: the action read the host as it ran.
     */
    refreshAll(): void;
    /**
     * One pass of the burst: every shown session a change still owes a read. The
     * forwarded event carries no payload, so a change may have touched any of
     * them and each is read once. A session the whole-app answer has already
     * spoken for is answered from it instead of being asked about; see
     * {@link answerIsKnown}.
     */
    private readAll;
    /** One session's read, published unless a newer read of that session supersedes it. */
    private readOne;
    /**
     * Press the control: pause an active session, or take back a pause that is
     * still on its way in (or already settled). The phase shown afterwards is the
     * host's answer, never an assumed flip.
     * @param sessionId - session whose control was pressed.
     * @returns after the control re-reads the host.
     */
    toggle(sessionId: SessionId): Promise<void>;
    /**
     * Flip this session's goal opt-out. The verb belongs to the session it
     * changes — the host registers it there, and it takes no other target — so
     * this press needs no listed row. What the switch shows afterwards is the
     * host's next answer, never a local flip: a refused switch leaves the record
     * exactly as it was, and the re-read is what says so.
     * @param sessionId - session whose switch was pressed.
     * @returns after the control re-reads the host.
     */
    toggleGoal(sessionId: SessionId): Promise<void>;
    /** Ask the native stream what this session's park state is. */
    private read;
    private publish;
    /**
     * Whether the park has already answered for this header: with nothing
     * registered, no session can be paused, so a header that says this session is
     * running carries the whole fact; the status request that would confirm it is
     * a round-trip for nothing.
     *
     * A header the host last showed on its way to a park is never answered this
     * way: that reading is newer than the aggregate the derivation rests on, and
     * only a fresh host answer may replace it.
     */
    private answerIsKnown;
    /**
     * Whether the whole-app answer says the park holds nothing at all: the one
     * predicate the derivation below and its revocation share.
     */
    private nothingParked;
    /**
     * Answer one header from the whole-app verdict, and remember that it was that
     * kind of answer: the sessions to read for real are exactly the ones the
     * aggregate may have been wrong about.
     */
    private deriveActive;
    /**
     * The whole-app answer moved. Whatever was answered from "nothing is
     * registered" is read for real the moment that stops holding — the session a
     * header stood in for may be the one the park just took, possibly parked from
     * another window whose change this browser only sees as the forwarded event.
     * Called on every published aggregate, so it must do nothing while the
     * derivation still holds.
     */
    reconsider(): void;
    /**
     * Decide what the burst owes after a read: another look while a change this
     * browser has not answered is still outstanding, and nothing once none is.
     *
     * A phase that is still moving is left alone. The host announces every
     * transition on its command channel — the flush that settles a park included,
     * which changes no registration of its own — so a read that finds `draining`
     * or `parking` is the answer to the transition that produced it, and watching
     * that phase from here would spend reads on a move that is going to speak for
     * itself. What the burst still owes is the delivery of an announcement: a read
     * still armed when the change arrived, and a read for a change that landed
     * while the last pass was in flight.
     *
     * The one transition that cannot speak for itself is the one this browser's
     * own echo window swallowed: a press reads the host, the park moves while the
     * window is still open, and the changes that would have announced it look
     * exactly like the press's own registrations. So an action that left a phase
     * still moving asks for one look when that window closes, and only then — the
     * read is owed at a moment, not watched. Once nothing is owed, the last
     * reading stays on screen; the next change, the next user action, or the shell
     * handing this control a session again is what asks next.
     */
    private follow;
    /**
     * Whether any shown session's last reading is a phase the host has not
     * finished walking — the only states an action's own echo could be hiding a
     * transition behind.
     */
    private moving;
    /**
     * Follow the page in and out of view. A hidden page is not being read — and
     * the read the burst was about to take is not lost, it waits for the page to
     * come back.
     */
    watchVisibility(): void;
}
