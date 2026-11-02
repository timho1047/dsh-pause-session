/**
 * The re-read burst both browser controls share: a handful of reads after
 * something moved, and silence once it settles.
 *
 * What a control reads is published through the host's command channel, and
 * every read is two durable `command/run|done` records in the address session's
 * log plus an aggregate read on the host. Reading is therefore something the
 * host announces and the user asks for, never a heartbeat:
 *
 * - the host announces a transition by registering or unregistering the paused
 *   session's marker commands, and — for a phase change, which no registration
 *   of its own would show — by registering that session's status verb again.
 *   Each of those emits `commands/change`, and that event, plus the user's own
 *   press or decision, is what starts a burst;
 * - one transition announces itself several times: a park registers two or three
 *   marker commands per session and a phase change re-registers one, and the host
 *   emits one `commands/change` per step. The burst therefore waits out a short
 *   `windowMs` before its first read and any trigger inside that window
 *   postpones it, so the announcements of one transition start one burst rather
 *   than one each;
 * - a change that arrives within `ACTION_ABSORB_MS` of the user's own action is
 *   that action's own consequence, not news: the action already read the host,
 *   so the answer is on screen, and the unregistrations it caused — one event
 *   per marker command, measured seconds apart, which the window above cannot
 *   merge — would only be read back. Such a change is absorbed, and each one
 *   absorbed pushes the window out, because a storm that keeps arriving is
 *   still the same storm. The window always closes: the first change after
 *   `ACTION_ABSORB_MS` of quiet is news again, and a user action reads on its
 *   own whatever the window says;
 * - an absorbed change is deferred rather than lost: a control whose action left
 *   a phase still moving asks for one look at the moment the window closes
 *   ({@link ReadBurst.recheckAfterEcho}), which is the read that finds a
 *   transition the window hid — the park can reach its final phase inside that
 *   window and never announce anything again. One look per action, and only
 *   while the state it left is still moving;
 * - a burst is a fixed short list of waits, so at most that many reads answer
 *   one transition, however long the page stays open;
 * - a read that finds the verdict settled ends the burst at once, and the last
 *   reading stays on screen — "the park is settled" is not a state change, so
 *   it must not be re-asked;
 * - a read that finds a phase still moving ends it just as fast. Every phase
 *   transition is announced at its source, the flush that resolves `parking`
 *   into `safe` included, and that announcement is the very event that starts
 *   the next burst — so watching a moving phase from here spends records on a
 *   transition that will speak for itself;
 * - what the burst still owes after a read is delivery: the read one
 *   announcement bought, and one more when a change lands while a pass is in
 *   flight, which that pass cannot have answered. The bound is a bound, not a
 *   heartbeat: a phase that never settles is left on screen unread until
 *   something else moves;
 * - the bound is a trade, taken knowingly: a reading left on screen when the
 *   burst runs out is the host's own last answer, and the next trigger — a
 *   forwarded change, a press, or the shell handing a control its session again
 *   — reads the truth again. A reading nobody answered is never rendered as a
 *   confident state. A longer watch is a longer list of waits, at a linear price
 *   in the address session's log;
 * - while the page is hidden no read is armed at all, and the wait a burst
 *   still owed is armed again when the page comes back: hidden time is neither
 *   charged to the burst nor lost from it.
 *
 * A burst is not restarted by a trigger that lands while one is running: every
 * read it still owes happens after that trigger, so absorbing it loses nothing
 * and a storm of registry changes costs one burst rather than one each.
 * @module dsh-pause-session/client/burst
 */
/** The policy every control uses unless a caller says otherwise. */
export const DEFAULT_BURST_POLICY = {
    windowMs: 400,
    waitsMs: [400, 1_000, 2_400, 4_800],
    visible: defaultVisibility,
};
/**
 * How long after a client action a registry change is that action's own echo.
 *
 * A press, a release, a decision, a goal switch and an opened panel each read
 * the host as they run, so their answer is already on screen when the host
 * announces what they did — one `commands/change` per marker command, measured
 * 0.44 s to 2.04 s apart, a cadence the coalescing window cannot merge. Reading
 * those back is paying for an answer the user already has.
 *
 * The window is what makes `commands/change` mean "something moved that this
 * browser did not do". It is refreshed by every change it absorbs, so a storm
 * that keeps arriving stays absorbed rather than leaking one read per change,
 * and it ends for good `ACTION_ABSORB_MS` after the last change: a change after
 * that is news, and so is the next user action, which reads on its own.
 *
 * The margin over the measured 2.04 s gap is deliberate: a transition's own
 * storm has to fit inside the window for the whole storm to stay absorbed.
 */
export const ACTION_ABSORB_MS = 2_500;
/**
 * The waits one burst uses when its first wait is `first`: four reads spread
 * over roughly ten times that. Long enough that a read a hidden page or an
 * in-flight pass deferred is still taken, short enough that a state which never
 * settles costs a handful of log records rather than a night of them.
 * @param first - milliseconds before the burst's first read, after its window; `<= 0` disables bursting.
 * @returns the waits, in order; empty when bursting is disabled.
 */
export function burstWaits(first) {
    return first > 0 ? [first, first * 2.5, first * 6, first * 12] : [];
}
/**
 * Whether the browser reports the page as on screen. A shell without a
 * `document` (a test harness, a non-browser host) counts as visible: a control
 * that could never read would be a worse lie than one that reads.
 * @returns whether the page is visible now.
 */
function defaultVisibility() {
    const state = typeof document === 'undefined' ? undefined : document.visibilityState;
    return state !== 'hidden';
}
/** The real clock: `setTimeout` clearing itself. */
const SYSTEM_CLOCK = {
    set: (callback, ms) => setTimeout(callback, ms),
    clear: (timer) => { clearTimeout(timer); },
};
/**
 * One control's re-read burst. Every method is safe to call in any order and as
 * often as the caller likes: a trigger starts at most one burst, and one burst
 * never arms more than one read at a time.
 */
export class ReadBurst {
    onRead;
    policy;
    clock;
    /** The armed wait, when one is counting down. */
    timer;
    /** Whether the burst is waiting out its collection window rather than a wait between reads. */
    window = false;
    /** Waits this burst has not spent yet, front first. */
    left = [];
    /** Whether a burst is in progress: it may be collecting, waiting, reading, or reading again. */
    running = false;
    /** The absorption window a client action opened, while one is open. */
    absorbed;
    /** Whether a control asked for the one look owed when the echo window closes. */
    recheck = false;
    /**
     * @param onRead - one more read. Called only for a read the burst owes and the page can show.
     * @param policy - the collection window, the waits, and the visibility source.
     * @param clock - the timer implementation.
     */
    constructor(onRead, policy, clock = SYSTEM_CLOCK) {
        this.onRead = onRead;
        this.policy = policy;
        this.clock = clock;
    }
    /** Whether this control bursts at all. */
    get enabled() {
        return this.policy.waitsMs.length > 0;
    }
    /** Whether one more read is already counting down. */
    get armed() {
        return this.timer !== undefined;
    }
    /** Whether a burst is in progress, with or without a read counting down. */
    get live() {
        return this.running;
    }
    /** Whether a change right now is a client action's own echo. */
    get absorbing() {
        return this.absorbed !== undefined;
    }
    /**
     * The user acted on this control and the action reads: a press, a release, a
     * decision, a goal switch, an opened panel. Its read is the answer, and the
     * registry changes it sets off announce themselves for a while afterwards, so
     * until the window closes a trigger is that echo rather than news.
     *
     * Called as the action is taken, before its read lands, because the echo can
     * arrive while the action is still running.
     */
    absorb() {
        if (!this.enabled)
            return;
        this.armAbsorb();
    }
    /**
     * Ask for one read at the moment the echo window closes, because the action's
     * own read left a state that is still moving.
     *
     * The echo window swallows a transition announced inside it — the forwarded
     * event carries no payload, so nothing distinguishes a marker registration
     * from a phase change — and after the window no change is guaranteed to come:
     * the transition that was hidden may be the last one this park makes. The
     * look owed here is the read that finds it, one per action, and it is not a
     * watch: once the window has closed, every further change is news and buys its
     * own read. A control whose action left a settled state owes nothing and asks
     * for nothing.
     */
    recheckAfterEcho() {
        if (!this.enabled)
            return;
        this.recheck = true;
    }
    /**
     * Something moved — a registry change. The burst first waits out its
     * collection window, and every trigger that lands inside it restarts that
     * window: the two or three registrations of one park start one burst rather
     * than one each. A burst already past its window takes this as covered —
     * every read it still owes happens after the change.
     *
     * @returns whether the change is news rather than a client action's own echo.
     * The echo announces what the action's read already answered, so only a news
     * trigger is a change a control still owes a read for; a change that lands
     * while a burst is under way is covered by the read that burst already owes.
     * `false` also for a disabled burst, which reads nothing at all.
     */
    trigger() {
        if (!this.enabled)
            return false;
        if (this.absorbing) {
            // The action's own echo: it announces what the action's read already
            // answered. Keeping the window open while the echo lasts is what makes a
            // storm of one-change-per-marker cost nothing at all.
            this.armAbsorb();
            return false;
        }
        if (!this.running) {
            this.running = true;
            this.left = this.policy.waitsMs;
            this.armWindow();
            return true;
        }
        // Already running and still collecting: this change belongs to the burst
        // being collected, so it postpones that burst's read rather than adding one.
        if (this.window)
            this.armWindow();
        return true;
    }
    /**
     * The control knows it still owes a read: a change that is news has arrived,
     * or a reading just revealed something only a read can answer. A call outside
     * any burst starts one. Absorption never applies here — this is not a change
     * some action caused, it is a read the control already knows it needs.
     */
    next() {
        if (this.armed || this.window)
            return;
        if (!this.running) {
            this.running = true;
            this.left = this.policy.waitsMs;
        }
        this.owe();
    }
    /**
     * Nothing is moving: end the burst and forget it. The last reading stays
     * published, and the next trigger starts a fresh burst. Two things outlive
     * this: an action's absorption window, which is about what the action caused
     * rather than about the state, and the one look it may still owe — see
     * {@link recheckAfterEcho}.
     */
    stop() {
        this.running = false;
        this.left = [];
        this.window = false;
        this.cancel();
    }
    /** Drop the armed wait. A burst that is still owed its read survives it; see {@link checkVisibility}. */
    cancel() {
        if (this.timer === undefined)
            return;
        this.clock.clear(this.timer);
        this.timer = undefined;
    }
    /**
     * Re-evaluate one page-visibility change. Going off screen drops the armed
     * wait — a hidden page is not being read — and coming back arms it again, so
     * the burst resumes where it stopped instead of being spent while nobody was
     * looking. A burst still collecting resumes its window, restarted from the
     * moment the page came back: a trigger that arrived while it was hidden still
     * postpones the read.
     */
    checkVisibility() {
        if (this.visibleNow()) {
            this.arm();
            return;
        }
        this.cancel();
    }
    /** Spend the next wait of the burst, or end it when the bound is reached. */
    owe() {
        const wait = this.left[0];
        if (wait === undefined) {
            // The burst spent its whole bound. The state may still be moving, and
            // that is the point: the bound is what stops a state that never settles
            // from being read about forever.
            this.running = false;
            return;
        }
        this.armWait(wait);
    }
    /**
     * (Re)start the collection window. While the page is hidden nothing is armed
     * — hidden time is not charged to the burst — and a trigger that lands then
     * is still collected, because coming back starts a whole window.
     */
    armWindow() {
        const wait = Math.max(this.policy.windowMs, 0);
        if (!this.visibleNow()) {
            this.window = true;
            return;
        }
        this.cancel();
        this.window = true;
        this.timer = this.clock.set(() => {
            this.timer = undefined;
            this.window = false;
            this.owe();
        }, wait);
    }
    /** Put back whatever the burst still owed: its window, or the wait after a read. */
    arm() {
        if (this.window) {
            this.armWindow();
            return;
        }
        const wait = this.left[0];
        if (wait !== undefined)
            this.armWait(wait);
    }
    /**
     * (Re)start the absorption window a client action opened. A hidden page keeps
     * absorbing: this window is about what the action caused, not about what the
     * page is doing. When the window closes, the one look an unsettled action owes
     * is taken; the window is restarted by every change it absorbs, so that look
     * waits for the echo to actually stop.
     */
    armAbsorb() {
        this.cancelAbsorb();
        this.absorbed = this.clock.set(() => {
            this.absorbed = undefined;
            if (!this.recheck)
                return;
            this.recheck = false;
            // A read may already be owed or counting down; the burst never arms two.
            this.next();
        }, Math.max(ACTION_ABSORB_MS, 0));
    }
    /** Close the absorption window: changes are news again. */
    cancelAbsorb() {
        if (this.absorbed === undefined)
            return;
        this.clock.clear(this.absorbed);
        this.absorbed = undefined;
    }
    /**
     * Arm one wait, spending it when it fires. The wait stays in `left` until
     * then, so a page hidden mid-wait takes the whole wait again: hidden time is
     * neither charged to the burst nor lost from it.
     */
    armWait(wait) {
        if (this.timer !== undefined || !this.visibleNow())
            return;
        this.timer = this.clock.set(() => {
            this.timer = undefined;
            this.left = this.left.slice(1);
            this.onRead();
        }, Math.max(wait, 0));
    }
    /** Whether the page counts as on screen now, with an absent `document` read as on screen. */
    visibleNow() {
        try {
            return this.policy.visible();
        }
        catch {
            // A visibility source that cannot answer is not a reason to stop reading.
            return true;
        }
    }
}
//# sourceMappingURL=burst.js.map