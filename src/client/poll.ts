/**
 * The re-read timer both browser controls share: bounded, backed off, and
 * silent while the page is not on screen.
 *
 * What a control reads is published through the host's command channel, and
 * every read is two durable `command/run|done` records in the address
 * session's log plus an aggregate read on the host. A verdict that never
 * settles — a park that is permanently `waiting`, a row that stays
 * `draining` — therefore has to stop being re-read, or a browser left open
 * overnight writes a record every poll interval until morning.
 *
 * So this timer is a budget, not a heartbeat:
 *
 * - the wait between reads doubles from an initial interval to a maximum, so
 *   a state that has not moved for minutes is looked at rarely;
 * - the whole episode stops after a maximum amount of VISIBLE time, which is
 *   the largest amount of polling one user action can buy;
 * - while the page is hidden nothing is scheduled at all, and hidden time is
 *   not charged to the budget, so closing the lid neither spends the budget
 *   nor stops the control from looking again when the user comes back.
 *
 * Stopping is not a state change. The last reading stays published and the
 * control stays usable: it just stops re-asking a question whose answer has
 * stopped moving. {@link Poller.reset} starts a fresh episode, which is what
 * a user action — a press, a decision — is worth.
 * @module dsh-safe-stop/client/poll
 */

/** Whether the page is on screen, as the shell reports it. */
export type PageVisibility = () => boolean

/**
 * One control's polling budget.
 *
 * `initialMs` is also the on/off switch: a non-positive interval disables
 * re-reading entirely, which is how a test or a composition turns the timer
 * off without touching anything else.
 */
export interface PollPolicy {
  /** First interval after a read, and the switch that disables polling at `<= 0`. */
  readonly initialMs: number
  /** Ceiling the interval doubles up to. */
  readonly maxMs: number
  /** Visible milliseconds one episode may spend polling before it stops. */
  readonly maxVisibleMs: number
  /** Whether the page is on screen now. */
  readonly visible: PageVisibility
}

/** The policy every control uses unless a caller says otherwise. */
export const DEFAULT_POLL_POLICY: PollPolicy = {
  initialMs: 400,
  maxMs: 15_000,
  maxVisibleMs: 300_000,
  visible: defaultVisibility,
}

/**
 * Whether the browser reports the page as on screen. A shell without a
 * `document` (a test harness, a non-browser host) counts as visible: a
 * control that could never poll would be a worse lie than one that polls
 * until its budget runs out.
 * @returns whether the page is visible now.
 */
function defaultVisibility(): boolean {
  const state = typeof document === 'undefined' ? undefined : document.visibilityState
  return state !== 'hidden'
}

/** Start and clear one timer, spelled so a test can drive the clock. */
export interface PollClock {
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

/** The real clock: `setTimeout` clearing itself, exactly as before. */
const SYSTEM_CLOCK: PollClock = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (timer) => { clearTimeout(timer) },
}

/**
 * One control's re-read timer. Every method is safe to call in any order and
 * as often as the caller likes; the timer arms at most once.
 */
export class Poller {
  /** The armed timer, when one is waiting. */
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Visible milliseconds this episode spent before the current on-screen stretch. */
  private spent = 0
  /** When the current on-screen stretch began, or `undefined` while the page is hidden. */
  private visibleSince: number | undefined
  /** Whether this control has an episode with budget left. */
  private running = false
  /**
   * Set once an episode has spent its whole budget. It is what makes the budget
   * a budget: every read republishes the reading, and a control that starts a
   * fresh episode on every publish would ask forever. Only an explicit
   * {@link reset} — a user action on the park — clears it.
   */
  private exhausted = false
  /** Interval the next wait uses; doubles up to `policy.maxMs`. */
  private interval: number

  /**
   * @param onRead - one more read. Called only while an episode is armed and the page is visible.
   * @param policy - the budget and the visibility source.
   * @param clock - the timer implementation.
   * @param now - the visible-time clock.
   */
  constructor(
    private readonly onRead: () => void,
    private readonly policy: PollPolicy,
    private readonly clock: PollClock = SYSTEM_CLOCK,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.interval = policy.initialMs
  }

  /** Whether this control polls at all. */
  get enabled(): boolean {
    return this.policy.initialMs > 0
  }

  /** Whether one more read is already waiting on the timer. */
  get armed(): boolean {
    return this.timer !== undefined
  }

  /**
   * Keep re-reading until the budget runs out. A no-op when the timer is
   * already waiting, so a caller may ask on every publish.
   */
  start(): void {
    if (!this.enabled || this.exhausted) return
    if (!this.running) {
      this.running = true
      this.spent = 0
      this.visibleSince = this.policy.visible() ? this.now() : undefined
      this.interval = this.policy.initialMs
    }
    this.arm()
  }

  /**
   * Stop re-reading, and forget the episode: the next {@link start} begins a
   * fresh budget. This is the explicit end of an episode — the state stopped
   * moving — not the exhaustion of one.
   */
  stop(): void {
    this.cancel()
    this.running = false
    this.spent = 0
    this.visibleSince = undefined
    this.interval = this.policy.initialMs
  }

  /**
   * Begin a fresh episode now, without reading. This is what a user action is
   * worth: the state it changed is moving again, so the timer gets its budget
   * back and looks again after the first interval.
   */
  reset(): void {
    this.exhausted = false
    this.stop()
  }

  /** Drop the waiting read. An episode keeps its budget and looks again when the page returns. */
  cancel(): void {
    if (this.timer === undefined) return
    this.clock.clear(this.timer)
    this.timer = undefined
  }

  /**
   * Re-evaluate one page-visibility change. Coming back into view continues an
   * episode that was paused and leaves a spent or stopped one alone: showing
   * the page again is not a user action on the park.
   */
  checkVisibility(): void {
    const visible = this.visibleNow()
    if (!visible) {
      if (this.visibleSince === undefined) return
      this.spent += this.now() - this.visibleSince
      this.visibleSince = undefined
      this.cancel()
      return
    }
    if (this.visibleSince !== undefined) return
    this.visibleSince = this.now()
    if (!this.running) return
    this.arm()
  }

  /**
   * Arm the next read at the current interval, when the budget allows it.
   * A timer already waiting is left alone: the interval is fixed at the
   * moment the wait begins.
   */
  private arm(): void {
    if (!this.enabled || !this.running || this.exhausted || this.timer !== undefined || !this.visibleNow()) return
    const left = this.remaining()
    if (left <= 0) {
      this.exhausted = true
      this.stop()
      return
    }
    const wait = Math.min(Math.max(this.interval, 1), left)
    this.timer = this.clock.set(() => {
      this.timer = undefined
      this.spent += wait
      this.visibleSince = this.now()
      // The next wait is armed before the read runs, so a read that throws
      // cannot leave the control with no timer and no record of why.
      this.interval = Math.min(Math.max(this.interval * 2, this.policy.initialMs), this.policy.maxMs)
      this.arm()
      this.onRead()
    }, wait)
  }

  /** Whether the page counts as on screen now, with an absent `document` read as on screen. */
  private visibleNow(): boolean {
    try {
      return this.policy.visible()
    } catch {
      // A visibility source that cannot answer is not a reason to stop
      // reading; it is a reason to keep the old behaviour.
      return true
    }
  }

  /** Visible milliseconds this episode may still spend. */
  private remaining(): number {
    return this.policy.maxVisibleMs - this.spent - this.visibleElapsed()
  }

  /** Visible milliseconds since this episode's last accounting point. */
  private visibleElapsed(): number {
    return this.visibleSince === undefined ? 0 : Math.max(this.now() - this.visibleSince, 0)
  }
}
