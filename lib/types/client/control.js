/**
 * Browser-side reading and driving of the host's park state for one session.
 *
 * The browser reads the host's same-origin JSON status route when the Web
 * carrier mounts it. That route is the normal path and keeps background status
 * reads out of the Session log. On a carrier without the route, the control
 * falls back to the host's command registry: `commands.list(sessionId)` marks
 * whether this session is paused, and the status command's answer carries the
 * phase. Either path is host-authoritative; this module never derives a state
 * from its own press. The answer also carries the record's goal opt-out, so the
 * switch beside the pause button can show it without a second host round-trip.
 *
 * Every phase the host reaches announces itself on that channel: a transition
 * re-registers the status verb, so a transition is what buys the next read and a
 * read that finds a phase still moving is the answer to the transition that
 * produced it rather than a reason to keep asking (`./burst.ts`). One transition
 * arrives as several registry changes — parking a session also registers its
 * three commands — so the burst's own collection window is what turns a tick of
 * changes into one read per shown session. A press or a goal switch reads as it
 * runs, and the marker changes it causes are that action's own echo: those are
 * absorbed for a short window (`./burst.ts`) rather than read back — except for
 * the one look an action owes when that window closes, if the reading it left
 * behind is still moving, because a transition announced inside the window would
 * otherwise never be read at all.
 *
 * The whole-app control reads the same park and publishes what it found
 * (`./global.ts`), and a header consults that answer before spending a read of
 * its own: with nothing registered, no session can be paused, so a header that
 * already says "running" is left saying it rather than paying a round-trip to
 * hear it again. A header the host last showed on its way to a park is never
 * answered that way — that reading is the newer fact — and the derivation is
 * voided by the next whole-app answer that names a registered session, which
 * the forwarded change a park causes is what brings in.
 * @module dsh-pause-session/client/control
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import { decodeParkStatus, GOAL_COMMAND, PAUSE_COMMAND, RESUME_COMMAND, RESUME_DEFINITION_ID, STATUS_COMMAND, STATUS_DEFINITION_ID, } from '../shared.js';
import { burstWaits, DEFAULT_BURST_POLICY, ReadBurst } from './burst.js';
const INITIAL = { bySession: {} };
/** Phases that name a moment on the way to a park rather than a state it reached. */
const MOVING = new Set(['draining', 'parking']);
/** Owns the published reading per session; nothing else writes that state. */
export class PauseControl {
    commands;
    lifetime;
    aggregate;
    source;
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
    constructor(commands, lifetime, windowMs = 400, policy = DEFAULT_BURST_POLICY, aggregate = () => undefined, source) {
        this.commands = commands;
        this.lifetime = lifetime;
        this.aggregate = aggregate;
        this.source = source;
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
        const line = current === undefined || current === 'active'
            ? `/${PAUSE_COMMAND}`
            : `/${RESUME_COMMAND}`;
        // The press is a client action: the markers the host registers or
        // unregisters as it runs are its own echo, and the read below is the answer
        // to all of it.
        this.burst.absorb();
        const executed = await this.commands.execute(sessionId, line, [], this.lifetime);
        if (!executed.ok) {
            this.publish(sessionId, { phase: 'unavailable', runningTools: [] });
            this.follow();
            return;
        }
        // `undefined` means the host resolved no such command, i.e. this reading
        // was stale; re-reading is the only honest response.
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
        await this.commands.execute(sessionId, `/${GOAL_COMMAND}`, [], this.lifetime);
        await this.refresh(sessionId);
    }
    /** Ask the host what this session's park state is, in the browser's vocabulary. */
    async read(sessionId) {
        // The JSON route is the no-log path; the command registry below is the
        // fallback for carriers that do not mount a browser web server.
        if (this.source !== undefined) {
            const snapshot = await this.source.read(this.lifetime);
            if (snapshot !== undefined) {
                const status = snapshot.sessions[String(sessionId)];
                if (status === undefined)
                    return { phase: 'active', runningTools: [] };
                return {
                    phase: status.phase,
                    runningTools: status.runningTools,
                    ...status.rearmGoal === undefined ? {} : { rearmGoal: status.rearmGoal },
                };
            }
        }
        const listed = await this.commands.list(sessionId);
        if (!listed.ok)
            return { phase: 'unavailable', runningTools: [] };
        const paused = listed.value.some(descriptor => descriptor.definitionId === RESUME_DEFINITION_ID);
        if (!paused)
            return { phase: 'active', runningTools: [] };
        const status = listed.value.find(descriptor => descriptor.definitionId === STATUS_DEFINITION_ID);
        if (status === undefined)
            return { phase: 'parking', runningTools: [] };
        // The descriptor is only a marker; the command itself reports the state as
        // of this read, which is what makes a moving phase observable at all.
        const answered = await this.commands.execute(sessionId, `/${STATUS_COMMAND}`, [], this.lifetime);
        if (!answered.ok || answered.value === undefined)
            return { phase: 'unavailable', runningTools: [] };
        const text = answered.value.result.kind === 'success' ? answered.value.result.text : undefined;
        const decoded = text === undefined ? undefined : decodeParkStatus(text);
        if (decoded === undefined) {
            // The marker says paused but the status read did not answer in the shared
            // vocabulary: report the pause without inventing a phase or a goal state.
            return { phase: 'parking', runningTools: [] };
        }
        return {
            phase: decoded.phase,
            runningTools: decoded.runningTools,
            ...decoded.rearmGoal === undefined ? {} : { rearmGoal: decoded.rearmGoal },
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