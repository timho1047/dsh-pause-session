/**
 * Browser-side reading and driving of the host's whole-app park state.
 *
 * The aggregate arrives from the native `pauseSession` stream. The stream is
 * process-wide and writes nothing into any Session; actions travel through the
 * same Remote namespace. The burst reads the cached snapshot only after the
 * host announces a change, so a settled park stops spending requests while its
 * last answer stays on screen.
 * @module dsh-pause-session/client/global
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import { burstWaits, DEFAULT_BURST_POLICY, ReadBurst } from './burst.js';
import { globalPauseView } from './view.js';
/** Map one Remote row to the list's structured row. */
function wireTriageRow(row) {
    return {
        sessionId: row.sessionId,
        phase: row.phase,
        updatedAt: row.updatedAt,
        reading: row.reading,
        ...row.lastEvent === undefined ? {} : { lastEvent: row.lastEvent },
        ...row.turn === undefined ? {} : { turn: row.turn },
        ...row.step === undefined ? {} : { step: row.step },
        traces: row.traces.map(trace => ({ tool: trace.tool, callId: trace.callId ?? '' })),
        owed: row.owed,
        wakeable: row.wakeable,
        rearmGoal: row.rearmGoal,
    };
}
const INITIAL = { global: undefined, panelOpen: false, triage: undefined };
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
export function addressingSession(state) {
    const usable = state.ids.filter((id) => {
        const row = state.byId[String(id)];
        return row !== undefined && row.origin !== 'subagent' && row.parentId === undefined;
    });
    return usable.find(id => (state.byId[String(id)]?.retainedBy?.mainView ?? 0) > 0)
        ?? usable.find(id => state.byId[String(id)]?.running === true)
        ?? usable[0];
}
/**
 * The registered sessions one whole-app answer names, best address first: the
 * one still draining is the one this host is executing against right now, the
 * rest is the host's own vocabulary for a registered session it is not going to
 * move any further.
 *
 * A stalled or unreadable record is deliberately not an address for a read —
 * this host may not hold that session at all, and a read that could not be
 * delivered would report "unavailable" for a transport reason rather than a
 * state — but it is still a registered session, which is all the remembered
 * address is for. The host's own answer is JSON: the branded ids arrive as the
 * strings they were encoded as, exactly like the ids the shell hands the pill.
 * @param status - the host's last whole-app answer.
 * @returns the registered sessions the answer names, best first.
 */
function registeredSessions(status) {
    return [
        ...status.draining,
        ...status.stalled,
        ...status.unresumable,
        ...status.unreadTrees,
    ];
}
/**
 * The session a registered park owns, when the host's answer names one that is
 * still moving. This is how a read stops landing in whatever session the user
 * happens to be looking at.
 * @param status - the host's last whole-app answer.
 * @returns a draining session, or `undefined` when the answer names none.
 */
export function registeredAddress(status) {
    const draining = status.draining[0];
    return draining === undefined ? undefined : draining;
}
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
export function parkedAddress(status) {
    return status.parkedAt === undefined ? undefined : status.parkedAt;
}
/** Owns the published whole-app reading; nothing else writes that state. */
export class PauseGlobalControl {
    transport;
    lifetime;
    /** State source the whole-app contribution binds its selector hook to. */
    store = createSnapshotStore(INITIAL);
    /** The session the shell asked this control through; reads start here. */
    address;
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
    lastRegistered;
    /**
     * The session the fallback command read was last served through. Later
     * fallback reads keep going there: each one is two records in that address
     * session's log, and the shell's address follows whatever the user is looking
     * at, which is not where a row about the park belongs. The Web status route
     * bypasses this address entirely.
     */
    served;
    /** Highest decision-list read requested: an answer older than it is dropped. */
    latestTriage = 0;
    /** Highest read sequence requested: an answer older than it is dropped. */
    latest = 0;
    /**
     * Whether a registry change has arrived that no completed read pass has
     * answered. Set only for a change that is news — an absorbed echo of this
     * browser's own action is already answered by that action's read.
     */
    owed = false;
    /** The bounded burst of reads one transition buys; see `./burst.ts`. */
    burst;
    /**
     * @param commands - the Client-callable command namespace.
     * @param lifetime - aborts in-flight calls and the burst when the plugin unloads.
     * @param windowMs - how long the burst collects the registrations of one
     * transition before its first read; also the wait after a press.
     * @param policy - the burst waits and visibility source; defaults to the real page.
     */
    constructor(transport, lifetime, windowMs = 400, policy = DEFAULT_BURST_POLICY) {
        this.transport = transport;
        this.lifetime = lifetime;
        this.burst = new ReadBurst(() => { void this.readAll(); }, { ...policy, windowMs, waitsMs: burstWaits(windowMs) });
    }
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
    async refresh(sessionId) {
        this.address = sessionId;
        if (this.answered())
            return;
        await this.readAggregate();
        this.follow();
    }
    /** Whether the host has answered: a state, not the absence of one it never sent. */
    answered() {
        return this.store.getSnapshot().global?.kind === 'reported';
    }
    /**
     * The host's command registry changed: something may have moved, so a burst
     * is owed. The reads run on the burst's own schedule rather than here, which
     * is what coalesces a tick's worth of changes — parking N sessions announces
     * three registrations each, and a phase change re-registers one more — into
     * one burst. A change that is this browser's own action's echo owes nothing:
     * the action read the host as it ran.
     */
    refreshAll() {
        if (this.address === undefined || this.lifetime.aborted)
            return;
        if (!this.burst.trigger())
            return;
        this.owed = true;
    }
    /**
     * One read of the whole screen: the aggregate, plus the decision list while
     * the user has it open. A closed panel spends no command calls on rows nobody
     * is reading.
     */
    async readAll() {
        if (this.target() === undefined || this.lifetime.aborted) {
            this.owed = false;
            this.burst.stop();
            return;
        }
        // Cleared before the reads, not after: a change that lands while this pass
        // is in flight is one this pass cannot have answered, so it survives into
        // the next read rather than being absorbed into this one.
        this.owed = false;
        await this.readAggregate();
        if (this.store.getSnapshot().panelOpen)
            await this.readTriage();
        // One burst decision per pass: taken per read, two reads that disagree
        // about what is moving would end the burst and start it again, which is a
        // heartbeat with extra steps.
        this.follow();
    }
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
    target(skip) {
        const current = this.store.getSnapshot().global;
        const named = current?.kind === 'reported' ? current.status : undefined;
        const candidates = [
            named === undefined ? undefined : registeredAddress(named),
            named === undefined ? undefined : parkedAddress(named),
            this.lastRegistered,
            this.served,
            this.address,
        ];
        return candidates.find(candidate => candidate !== undefined && candidate !== skip);
    }
    /**
     * Ask the host for the aggregate through the session a read goes through,
     * with the one fallback an address that stopped answering is worth: the
     * remembered address is forgotten, and the read is taken again through the
     * next one — the session the shell is on at the latest. A memory of a session
     * this host no longer holds would otherwise leave the control unable to say
     * anything at all, and a single retry is the whole price of keeping it honest.
     */
    async readAggregate() {
        const snapshot = await this.transport.source.read(this.lifetime);
        if (snapshot !== undefined)
            this.publish({ kind: 'reported', status: snapshot.global });
    }
    /**
     * Open or close the decision list. Opening asks the host for the rows; there
     * is no state to show without that answer. Opening is also a client action
     * that reads, so the changes it sets off are absorbed rather than read back,
     * and whether the burst owes anything is what its own read decides.
     * @param open - whether the panel should be showing.
     */
    setPanel(open) {
        this.store.update((state) => { state.panelOpen = open; });
        if (open) {
            this.burst.absorb();
            void this.refreshTriage();
            return;
        }
        this.follow();
    }
    /**
     * Ask the host for the decision list through the session the user is on. The
     * list is recorded per calling session and the decisions act only on rows
     * that session was shown, so this read — unlike the aggregate — stays on the
     * shell's own address.
     */
    async refreshTriage() {
        await this.readTriage();
        this.follow();
    }
    /**
     * Read the aggregate again because the user asked this control to act: the
     * address is the session the shell is on, since a press is a user action on
     * the session the user is looking at, and the host's answer is what the
     * control shows next.
     * @param sessionId - the session the shell is on.
     */
    async reread(sessionId) {
        this.address = sessionId;
        await this.readAggregate();
        this.follow();
    }
    /** One decision-list read, addressed at the session the user is on. */
    async readTriage() {
        const address = this.address;
        if (address === undefined)
            return;
        const sequence = ++this.latestTriage;
        const reading = await this.readTriageRows(address);
        // A newer read was requested while this one was in flight; its answer is
        // the current one.
        if (this.latestTriage !== sequence)
            return;
        this.store.update((state) => { state.triage = reading; });
    }
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
    async decide(sessionId, action) {
        const address = this.address;
        if (address === undefined)
            return;
        // A decision reads as it runs, so the marker changes it causes are its own
        // echo; the state shown afterwards is the host's answers below.
        this.burst.absorb();
        await this.refreshTriage();
        await this.transport.decide(String(address), sessionId, action, this.lifetime);
        await this.refreshTriage();
        // A decision can release a session, which the whole-app verdict reports.
        await this.reread(address);
    }
    /**
     * Press the pill: park everything, or release everything the park owns.
     * Which one it is comes from the host's own last answer, never from a local
     * flip; the state shown afterwards is the host's answer again. A reading the
     * view does not turn into a verb — every registered session is one the host
     * will not wake — is not pressed at all.
     * @param sessionId - the session to address the verb to.
     * @returns after the control re-reads the host.
     */
    async toggle(sessionId) {
        const current = this.store.getSnapshot().global;
        // Nothing to press against: a state that could not be read is not a state
        // this control may act on.
        if (current === undefined || current.kind !== 'reported')
            return;
        const action = globalPauseView(current).action;
        if (action === 'none')
            return;
        this.burst.absorb();
        const answer = await this.transport.act({ action, sessionId: String(sessionId) }, this.lifetime);
        if (!answer.ok) {
            this.publish({ kind: 'unavailable' });
            this.follow();
            return;
        }
        await this.reread(sessionId);
    }
    /** Ask the native namespace for the decision list. */
    async readTriageRows(sessionId) {
        const rows = await this.transport.triage(String(sessionId), this.lifetime);
        return { kind: 'reported', rows: rows.map(wireTriageRow) };
    }
    publish(reading) {
        this.store.update((state) => { state.global = reading; });
    }
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
    follow() {
        if (this.lifetime.aborted) {
            this.burst.stop();
            return;
        }
        if (!this.owed && !this.unansweredPanel()) {
            if (this.burst.absorbing && this.moving())
                this.burst.recheckAfterEcho();
            this.burst.stop();
            return;
        }
        this.burst.next();
    }
    /**
     * Whether the park this control last read still has work on its way — the only
     * state an action's own echo could be hiding a transition behind. A record
     * that is stalled, unresumable or unread is not moving: nothing in this
     * process will finish it.
     */
    moving() {
        const current = this.store.getSnapshot().global;
        return current?.kind === 'reported'
            && (current.status.draining.length > 0 || current.status.parking > 0);
    }
    /**
     * Whether the open panel is still owed its rows. Opening the panel reads them,
     * so this holds only after a read that did not answer — the one debt no change
     * created, and the one place a retry is the difference between an empty panel
     * and the facts the host has. It is bounded by the burst like everything else.
     */
    unansweredPanel() {
        const state = this.store.getSnapshot();
        return state.panelOpen && (state.triage === undefined || state.triage.kind === 'unavailable');
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
//# sourceMappingURL=global.js.map