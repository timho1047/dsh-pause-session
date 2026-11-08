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
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import { burstWaits, DEFAULT_BURST_POLICY, ReadBurst } from './burst.js';
const INITIAL = { bySession: {} };
/** Phases that name a moment on the way to a park rather than a state it reached. */
const MOVING = new Set(['draining', 'parking']);
/** Owns the published reading per session; nothing else writes that state. */
export class PauseControl {
    transport;
    lifetime;
    aggregate;
    /** State source the Session-header contribution binds its selector hook to. */
    store = createSnapshotStore(INITIAL);
    /** Sessions this control has shown; a host registry change re-reads every one of them. */
    shown = new Set();
    /** Highest read sequence requested per session: an answer older than it is dropped. */
    latest = new Map();
    /**
     * Sessions a change has put back on the list of ones to read once — a
     * transition this browser has been told about and has not answered yet.
     */
    owed = new Set();
    /**
     * Whether the look owed at the close of an echo window is still to be taken.
     * It reads every shown session, exactly as a change does: the look exists
     * because a change may have been swallowed, and a swallowed change carries no
     * payload either.
     */
    trailing = false;
    /**
     * Sessions whose header was answered from the whole-app "nothing is
     * registered" instead of a read of their own, and which therefore have to be
     * read for real if that answer stops holding.
     */
    derived = new Set();
    /** The bounded burst of reads one transition buys; see `./burst.ts`. */
    burst;
    reads = 0;
    /**
     * @param commands - the Client-callable command namespace.
     * @param lifetime - aborts in-flight calls and the burst when the plugin unloads.
     * @param windowMs - how long the burst collects the registrations of one
     * transition before its first read; also the wait after a press.
     * @param policy - the burst waits and visibility source; defaults to the real page.
     * @param aggregate - the whole-app control's published answer; absent means it is never consulted.
     */
    constructor(transport, lifetime, windowMs = 400, policy = DEFAULT_BURST_POLICY, aggregate = () => undefined) {
        this.transport = transport;
        this.lifetime = lifetime;
        this.aggregate = aggregate;
        this.burst = new ReadBurst(() => { void this.readAll(); }, { ...policy, windowMs, waitsMs: burstWaits(windowMs) });
    }
    /**
     * Read the host's state for one session.
     * @param sessionId - session whose control was rendered.
     * @returns after this read's answer is published or superseded by a newer one.
     */
    async refresh(sessionId) {
        await this.readOne(sessionId);
        this.follow();
    }
    /**
     * The host's command registry changed, so every session this control has
     * shown may have moved — the forwarded event carries no payload, so the only
     * honest answer is to look at all of them once. The reads run on the burst's
     * own schedule rather than here, which is what makes a tick's worth of changes
     * — parking a session registers three commands, and a phase change re-registers
     * one more — one burst instead of one each. A change that is this browser's own
     * action's echo owes nothing: the action read the host as it ran.
     */
    refreshAll() {
        if (this.shown.size === 0 || this.lifetime.aborted)
            return;
        if (!this.burst.trigger())
            return;
        for (const sessionId of this.shown)
            this.owed.add(sessionId);
    }
    /**
     * One pass of the burst: every shown session a change still owes a read. The
     * forwarded event carries no payload, so a change may have touched any of
     * them and each is read once. A session the whole-app answer has already
     * spoken for is answered from it instead of being asked about; see
     * {@link answerIsKnown}.
     */
    async readAll() {
        if (this.lifetime.aborted) {
            this.burst.stop();
            return;
        }
        const pass = this.owed.size > 0 ? [...this.owed] : this.trailing ? [...this.shown] : [];
        // Cleared before the reads, not after: a change that lands while this pass
        // is in flight is one this pass cannot have answered, so it survives into
        // the next read rather than being absorbed into this one.
        this.owed.clear();
        this.trailing = false;
        for (const sessionId of pass) {
            if (this.answerIsKnown(sessionId)) {
                this.deriveActive(sessionId);
                continue;
            }
            await this.readOne(sessionId);
        }
        this.follow();
    }
    /** One session's read, published unless a newer read of that session supersedes it. */
    async readOne(sessionId) {
        this.shown.add(sessionId);
        // A host answer replaces whatever the aggregate said about this header.
        this.derived.delete(sessionId);
        const sequence = ++this.reads;
        this.latest.set(sessionId, sequence);
        const reading = await this.read(sessionId);
        // A newer read was requested while this one was in flight; its answer is
        // the current one, so publishing this stale one would show the browser a
        // state the host has already moved past.
        if (this.latest.get(sessionId) !== sequence)
            return;
        this.publish(sessionId, reading);
    }
    /**
     * Press the control: pause an active session, or take back a pause that is
     * still on its way in (or already settled). The phase shown afterwards is the
     * host's answer, never an assumed flip.
     * @param sessionId - session whose control was pressed.
     * @returns after the control re-reads the host.
     */
    async toggle(sessionId) {
        const current = this.store.getSnapshot().bySession[String(sessionId)]?.phase;
        const action = current === undefined || current === 'active' ? 'pause' : 'resume';
        this.burst.absorb();
        const answer = await this.transport.act({ action, sessionId: String(sessionId) }, this.lifetime);
        if (!answer.ok) {
            this.publish(sessionId, { phase: 'unavailable', runningTools: [] });
            this.follow();
            return;
        }
        await this.refresh(sessionId);
    }
    /**
     * Flip this session's goal opt-out. The verb belongs to the session it
     * changes — the host registers it there, and it takes no other target — so
     * this press needs no listed row. What the switch shows afterwards is the
     * host's next answer, never a local flip: a refused switch leaves the record
     * exactly as it was, and the re-read is what says so.
     * @param sessionId - session whose switch was pressed.
     * @returns after the control re-reads the host.
     */
    async toggleGoal(sessionId) {
        // The switch is a client action too: the record change it causes announces
        // itself through the registry, and the re-read below is the answer.
        this.burst.absorb();
        await this.transport.act({ action: 'goal', sessionId: String(sessionId) }, this.lifetime);
        await this.refresh(sessionId);
    }
    /** Ask the native stream what this session's park state is. */
    async read(sessionId) {
        const snapshot = await this.transport.source.read(this.lifetime);
        if (snapshot === undefined)
            return { phase: 'unavailable', runningTools: [] };
        const status = snapshot.sessions[String(sessionId)];
        if (status === undefined)
            return { phase: 'active', runningTools: [] };
        return {
            phase: status.phase,
            runningTools: status.runningTools,
            ...status.rearmGoal === undefined ? {} : { rearmGoal: status.rearmGoal },
        };
    }
    publish(sessionId, reading) {
        this.store.update((state) => {
            state.bySession = { ...state.bySession, [String(sessionId)]: reading };
        });
    }
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
    answerIsKnown(sessionId) {
        const phase = this.store.getSnapshot().bySession[String(sessionId)]?.phase;
        if (phase !== undefined && phase !== 'active')
            return false;
        return this.nothingParked();
    }
    /**
     * Whether the whole-app answer says the park holds nothing at all: the one
     * predicate the derivation below and its revocation share.
     */
    nothingParked() {
        const aggregate = this.aggregate();
        return aggregate?.kind === 'reported' && aggregate.status.registered === 0;
    }
    /**
     * Answer one header from the whole-app verdict, and remember that it was that
     * kind of answer: the sessions to read for real are exactly the ones the
     * aggregate may have been wrong about.
     */
    deriveActive(sessionId) {
        this.derived.add(sessionId);
        this.publish(sessionId, { phase: 'active', runningTools: [] });
    }
    /**
     * The whole-app answer moved. Whatever was answered from "nothing is
     * registered" is read for real the moment that stops holding — the session a
     * header stood in for may be the one the park just took, possibly parked from
     * another window whose change this browser only sees as the forwarded event.
     * Called on every published aggregate, so it must do nothing while the
     * derivation still holds.
     */
    reconsider() {
        if (this.derived.size === 0 || this.lifetime.aborted || this.nothingParked())
            return;
        for (const sessionId of this.derived)
            this.owed.add(sessionId);
        this.derived.clear();
        // What these headers say is known to be wrong now, so this does not wait out
        // anything — least of all the absorption window of an action the user took
        // in the same moment. Absorption is for the changes an action caused, never
        // for what a reading just revealed.
        this.burst.next();
    }
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
    follow() {
        if (this.lifetime.aborted) {
            this.burst.stop();
            return;
        }
        if (this.owed.size === 0) {
            // The look is owed only while both hold: the window is still swallowing
            // changes, and the reading the action left is one of the phases whose next
            // step a change would have announced.
            const hidden = this.burst.absorbing && this.moving();
            if (hidden)
                this.burst.recheckAfterEcho();
            this.trailing = hidden;
            this.burst.stop();
            return;
        }
        this.burst.next();
    }
    /**
     * Whether any shown session's last reading is a phase the host has not
     * finished walking — the only states an action's own echo could be hiding a
     * transition behind.
     */
    moving() {
        const shown = this.store.getSnapshot().bySession;
        for (const sessionId of this.shown) {
            const phase = shown[String(sessionId)]?.phase;
            if (phase !== undefined && MOVING.has(phase))
                return true;
        }
        return false;
    }
    /**
     * Follow the page in and out of view. A hidden page is not being read — and
     * the read the burst was about to take is not lost, it waits for the page to
     * come back.
     */
    watchVisibility() {
        this.burst.checkVisibility();
    }
}
//# sourceMappingURL=control.js.map