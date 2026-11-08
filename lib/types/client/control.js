/**
 * Browser-side reading and driving of the host's park state for one session.
 *
 * The browser reads the native `pauseSession` stream; actions travel through
 * the same Remote namespace. No slash command is involved. The stream is
 * host-authoritative, so this module never derives a state from its own press.
 * The snapshot also carries the record's goal opt-out, so the switch beside the
 * pause button can show it without a second host round-trip.
 *
 * The stream is the change feed. A pushed snapshot triggers one cached read per
 * shown header; a press or goal switch reads the host's answer once after the
 * action.
 * @module dsh-pause-session/client/control
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
const INITIAL = { bySession: {} };
/** Owns the published reading per session; nothing else writes that state. */
export class PauseControl {
    transport;
    lifetime;
    /** State source the Session-header contribution binds its selector hook to. */
    store = createSnapshotStore(INITIAL);
    /** Sessions this control has shown; a pushed snapshot applies to every one. */
    shown = new Set();
    /** Highest read sequence requested per session: an answer older than it is dropped. */
    latest = new Map();
    reads = 0;
    /**
     * @param transport - the native namespace source and actions.
     * @param lifetime - aborts in-flight reads when the plugin unloads.
     */
    constructor(transport, lifetime) {
        this.transport = transport;
        this.lifetime = lifetime;
    }
    /**
     * Read the host's state for one session.
     * @param sessionId - session whose control was rendered.
     * @returns after this read's answer is published or superseded by a newer one.
     */
    async refresh(sessionId) {
        await this.readOne(sessionId);
    }
    /** Apply one pushed snapshot without spending a read per shown header. */
    apply(snapshot) {
        for (const sessionId of this.shown) {
            if (snapshot === undefined) {
                this.publish(sessionId, { phase: 'unavailable', runningTools: [] });
                continue;
            }
            const status = snapshot.sessions[String(sessionId)];
            this.publish(sessionId, status === undefined
                ? { phase: 'active', runningTools: [] }
                : {
                    phase: status.phase,
                    runningTools: status.runningTools,
                    ...status.rearmGoal === undefined ? {} : { rearmGoal: status.rearmGoal },
                });
        }
    }
    /** A new pushed snapshot may have moved every header; read them once. */
    refreshAll() {
        if (this.shown.size === 0 || this.lifetime.aborted)
            return;
        void this.readAll();
    }
    async readAll() {
        if (this.lifetime.aborted)
            return;
        for (const sessionId of [...this.shown])
            await this.readOne(sessionId);
    }
    /** One session's read, published unless a newer read of that session supersedes it. */
    async readOne(sessionId) {
        this.shown.add(sessionId);
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
        const answer = await this.transport.act({ action, sessionId: String(sessionId) }, this.lifetime);
        if (!answer.ok) {
            this.publish(sessionId, { phase: 'unavailable', runningTools: [] });
            return;
        }
        await this.refresh(sessionId);
    }
    /**
     * Flip this session's goal opt-out. The verb belongs to the session it
     * changes; the switch shows the host's next answer, never a local flip.
     * @param sessionId - session whose switch was pressed.
     * @returns after the control re-reads the host.
     */
    async toggleGoal(sessionId) {
        const answer = await this.transport.act({ action: 'goal', sessionId: String(sessionId) }, this.lifetime);
        if (!answer.ok) {
            this.publish(sessionId, { phase: 'unavailable', runningTools: [] });
            return;
        }
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
            const previous = state.bySession[String(sessionId)];
            if (previous !== undefined
                && previous.phase === reading.phase
                && previous.rearmGoal === reading.rearmGoal
                && previous.runningTools.length === reading.runningTools.length
                && previous.runningTools.every((tool, index) => tool === reading.runningTools[index]))
                return;
            state.bySession = { ...state.bySession, [String(sessionId)]: reading };
        });
    }
}
//# sourceMappingURL=control.js.map