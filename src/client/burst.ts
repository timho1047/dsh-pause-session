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
 *   session's marker commands, which emits `commands/change` — that event, and
 *   the user's own press or decision, is what starts a burst;
 * - one transition announces itself several times: a park registers two or three
 *   marker commands per session, and the host emits one `commands/change` per
 *   registration. The burst therefore waits out a short `windowMs` before its
 *   first read and any trigger inside that window postpones it, so the
 *   registrations of one park start one burst rather than one each;
 * - a change that arrives within `ACTION_ABSORB_MS` of the user's own action is
 *   that action's own consequence, not news: the action already read the host,
 *   so the answer is on screen, and the unregistrations it caused — one event
 *   per marker command, measured seconds apart, which the window above cannot
 *   merge — would only be read back. Such a change is absorbed, and each one
 *   absorbed pushes the window out, because a storm that keeps arriving is
 *   still the same storm. The window always closes: the first change after
 *   `ACTION_ABSORB_MS` of quiet is news again, and a user action reads on its
 *   own whatever the window says;
 * - a burst is a fixed short list of waits, so at most that many reads answer
 *   one transition, however long the page stays open;
 * - a read that finds the verdict settled ends the burst at once, and the last
 *   reading stays on screen — "the park is settled" is not a state change, so
 *   it must not be re-asked;
 * - a read that finds work still in flight ends it just as fast. The park
 *   announces the end of that work by registering or unregistering its markers,
 *   which is the very event that starts the next burst, so watching the work
 *   from here spends records on a transition that will announce itself;
 * - the flush that settles a park is the one thing that emits no event of its
 *   own, so a verdict that is merely settling — stopped, flush still pending —
 *   keeps the rest of the burst. That is the whole reason a transition can buy
 *   a few reads over a few seconds rather than exactly one;
 * - the bound is a trade, taken knowingly: a flush that outlasts the burst
 *   leaves the last reading on screen until the next trigger. A longer watch is
 *   a longer list of waits, at a linear price in the address session's log;
 * - while the page is hidden no read is armed at all, and the wait a burst
 *   still owed is armed again when the page comes back: hidden time is neither
 *   charged to the burst nor lost from it.
 *
 * A burst is not restarted by a trigger that lands while one is running: every
 * read it still owes happens after that trigger, so absorbing it loses nothing
 * and a storm of registry changes costs one burst rather than one each.
 * @module dsh-safe-stop/client/burst
 */

/** Whether the page is on screen, as the shell reports it. */
export type PageVisibility = () => boolean

/**
 * One control's burst policy.
 *
 * `waitsMs` is the whole bound: a burst spends at most one read per wait, and
 * an empty list turns bursting off entirely — which is how a test or a
 * composition disables it without touching anything else.
 */
export interface BurstPolicy {
  /** How long the burst collects triggers before its first wait starts. */
  readonly windowMs: number
  /** Waits between the reads of one burst, in order; the first follows a trigger. */
  readonly waitsMs: readonly number[]
  /** Whether the page is on screen now. */
  readonly visible: PageVisibility
}

/** The policy every control uses unless a caller says otherwise. */
export const DEFAULT_BURST_POLICY: BurstPolicy = {
  windowMs: 400,
  waitsMs: [400, 1_000, 2_400, 4_800],
  visible: defaultVisibility,
}

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
export const ACTION_ABSORB_MS = 2_500

/**
 * The waits one burst uses when its first wait is `first`: four reads spread
 * over roughly ten times that. Long enough to watch a park flush settle, short
 * enough that a state which never settles costs a handful of log records rather
 * than a night of them.
 * @param first - milliseconds before the burst's first read, after its window; `<= 0` disables bursting.
 * @returns the waits, in order; empty when bursting is disabled.
 */
export function burstWaits(first: number): readonly number[] {
  return first > 0 ? [first, first * 2.5, first * 6, first * 12] : []
}

/**
 * Whether the browser reports the page as on screen. A shell without a
 * `document` (a test harness, a non-browser host) counts as visible: a control
 * that could never read would be a worse lie than one that reads.
 * @returns whether the page is visible now.
 */
function defaultVisibility(): boolean {
  const state = typeof document === 'undefined' ? undefined : document.visibilityState
  return state !== 'hidden'
}

/** Start and clear one timer, spelled so a test can drive the clock. */
export interface BurstClock {
  /**
   * @param callback - the read to run.
   * @param ms - how long to wait.
   * @returns the scheduled timer.
   */
  set(callback: () => void, ms: number): ReturnType<typeof setTimeout>
  /**
   * @param timer - the timer to clear.
   */
  clear(timer: ReturnType<typeof setTimeout>): void
}

/** The real clock: `setTimeout` clearing itself. */
const SYSTEM_CLOCK: BurstClock = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (timer) => { clearTimeout(timer) },
}

/**
 * One control's re-read burst. Every method is safe to call in any order and as
 * often as the caller likes: a trigger starts at most one burst, and one burst
 * never arms more than one read at a time.
 */
export class ReadBurst {
  /** The armed wait, when one is counting down. */
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Whether the burst is waiting out its collection window rather than a wait between reads. */
  private window = false
  /** Waits this burst has not spent yet, front first. */
  private left: readonly number[] = []
  /** Whether a burst is in progress: it may be collecting, waiting, reading, or reading again. */
  private running = false
  /** The absorption window a client action opened, while one is open. */
  private absorbed: ReturnType<typeof setTimeout> | undefined

  /**
   * @param onRead - one more read. Called only for a read the burst owes and the page can show.
   * @param policy - the collection window, the waits, and the visibility source.
   * @param clock - the timer implementation.
   */
  constructor(
    private readonly onRead: () => void,
    private readonly policy: BurstPolicy,
    private readonly clock: BurstClock = SYSTEM_CLOCK,
  ) {}

  /** Whether this control bursts at all. */
  get enabled(): boolean {
    return this.policy.waitsMs.length > 0
  }

  /** Whether one more read is already counting down. */
  get armed(): boolean {
    return this.timer !== undefined
  }

  /** Whether a burst is in progress, with or without a read counting down. */
  get live(): boolean {
    return this.running
  }

  /** Whether a change right now is a client action's own echo. */
  get absorbing(): boolean {
    return this.absorbed !== undefined
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
  absorb(): void {
    if (!this.enabled) return
    this.armAbsorb()
  }

  /**
   * Something moved — a registry change. The burst first waits out its
   * collection window, and every trigger that lands inside it restarts that
   * window: the two or three registrations of one park start one burst rather
   * than one each. A burst already past its window absorbs this — every read it
   * still owes happens after the change.
   */
  trigger(): void {
    if (!this.enabled) return
    if (this.absorbing) {
      // The action's own echo: it announces what the action's read already
      // answered. Keeping the window open while the echo lasts is what makes a
      // storm of one-change-per-marker cost nothing at all.
      this.armAbsorb()
      return
    }
    if (!this.running) {
      this.running = true
      this.left = this.policy.waitsMs
      this.armWindow()
      return
    }
    // Already running and still collecting: this change belongs to the burst
    // being collected, so it postpones that burst's read rather than adding one.
    if (this.window) this.armWindow()
  }

  /**
   * A read found the state still moving, so the burst owes the next read. A
   * read outside any burst — a mount, a press, a decision — starts one, because
   * a user action that changes the park is worth watching settle. This is also
   * how a reading that just revealed something gets read, as opposed to a
   * change that announced it, so an absorption window never applies here.
   */
  next(): void {
    if (this.armed || this.window) return
    if (!this.running) {
      this.running = true
      this.left = this.policy.waitsMs
    }
    this.owe()
  }

  /**
   * Nothing is moving: end the burst and forget it. The last reading stays
   * published, and the next trigger starts a fresh burst. An action's
   * absorption window is not the burst's to end — it outlives the read that
   * settled the state, which is the whole point of it.
   */
  stop(): void {
    this.running = false
    this.left = []
    this.window = false
    this.cancel()
  }

  /** Drop the armed wait. A burst that is still owed its read survives it; see {@link checkVisibility}. */
  cancel(): void {
    if (this.timer === undefined) return
    this.clock.clear(this.timer)
    this.timer = undefined
  }

  /**
   * Re-evaluate one page-visibility change. Going off screen drops the armed
   * wait — a hidden page is not being read — and coming back arms it again, so
   * the burst resumes where it stopped instead of being spent while nobody was
   * looking. A burst still collecting resumes its window, restarted from the
   * moment the page came back: a trigger that arrived while it was hidden still
   * postpones the read.
   */
  checkVisibility(): void {
    if (this.visibleNow()) {
      this.arm()
      return
    }
    this.cancel()
  }

  /** Spend the next wait of the burst, or end it when the bound is reached. */
  private owe(): void {
    const wait = this.left[0]
    if (wait === undefined) {
      // The burst spent its whole bound. The state may still be moving, and
      // that is the point: the bound is what stops a state that never settles
      // from being read about forever.
      this.running = false
      return
    }
    this.armWait(wait)
  }

  /**
   * (Re)start the collection window. While the page is hidden nothing is armed
   * — hidden time is not charged to the burst — and a trigger that lands then
   * is still collected, because coming back starts a whole window.
   */
  private armWindow(): void {
    const wait = Math.max(this.policy.windowMs, 0)
    if (!this.visibleNow()) {
      this.window = true
      return
    }
    this.cancel()
    this.window = true
    this.timer = this.clock.set(() => {
      this.timer = undefined
      this.window = false
      this.owe()
    }, wait)
  }

  /** Put back whatever the burst still owed: its window, or the wait after a read. */
  private arm(): void {
    if (this.window) {
      this.armWindow()
      return
    }
    const wait = this.left[0]
    if (wait !== undefined) this.armWait(wait)
  }

  /**
   * (Re)start the absorption window a client action opened. A hidden page keeps
   * absorbing: this window is about what the action caused, not about what the
   * page is doing.
   */
  private armAbsorb(): void {
    this.cancelAbsorb()
    this.absorbed = this.clock.set(() => { this.absorbed = undefined }, Math.max(ACTION_ABSORB_MS, 0))
  }

  /** Close the absorption window: changes are news again. */
  private cancelAbsorb(): void {
    if (this.absorbed === undefined) return
    this.clock.clear(this.absorbed)
    this.absorbed = undefined
  }

  /**
   * Arm one wait, spending it when it fires. The wait stays in `left` until
   * then, so a page hidden mid-wait takes the whole wait again: hidden time is
   * neither charged to the burst nor lost from it.
   */
  private armWait(wait: number): void {
    if (this.timer !== undefined || !this.visibleNow()) return
    this.timer = this.clock.set(() => {
      this.timer = undefined
      this.left = this.left.slice(1)
      this.onRead()
    }, Math.max(wait, 0))
  }

  /** Whether the page counts as on screen now, with an absent `document` read as on screen. */
  private visibleNow(): boolean {
    try {
      return this.policy.visible()
    } catch {
      // A visibility source that cannot answer is not a reason to stop reading.
      return true
    }
  }
}
