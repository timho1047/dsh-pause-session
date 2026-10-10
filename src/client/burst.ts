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
 * - a burst is a fixed short list of waits, so at most that many reads answer
 *   one transition, however long the page stays open;
 * - a read that finds nothing moving ends the burst at once, and the last
 *   reading stays on screen — "the park is settled" is not a state change, so
 *   it must not be re-asked;
 * - the flush that settles a park emits no event of its own (the marker is
 *   registered when the pause is pressed, not when the flush resolves), which
 *   is the whole reason a transition buys a few reads over a few seconds
 *   rather than exactly one;
 * - the bound is a trade, taken knowingly: a drain that outlasts the burst
 *   leaves the last reading on screen until the next trigger instead of being
 *   watched to its end. A longer watch is a longer list of waits, at a linear
 *   price in the address session's log;
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
  /** Waits between the reads of one burst, in order; the first follows a trigger. */
  readonly waitsMs: readonly number[]
  /** Whether the page is on screen now. */
  readonly visible: PageVisibility
}

/** The policy every control uses unless a caller says otherwise. */
export const DEFAULT_BURST_POLICY: BurstPolicy = {
  waitsMs: [400, 1_000, 2_400, 4_800],
  visible: defaultVisibility,
}

/**
 * The waits one burst uses when its first wait is `first`: four reads spread
 * over roughly ten times that. Long enough to watch a park flush settle, short
 * enough that a state which never settles costs a handful of log records rather
 * than a night of them.
 * @param first - milliseconds before the burst's first read; `<= 0` disables bursting.
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
  /**
   * The wait this burst owes. It stays set while the wait is counting down, so
   * a page that goes off screen mid-wait keeps the read it was about to take.
   */
  private owed: number | undefined
  /** Waits this burst has not spent yet, front first. */
  private left: readonly number[] = []
  /** Whether a burst is in progress: it may be waiting, reading, or reading again. */
  private running = false

  /**
   * @param onRead - one more read. Called only for a read the burst owes and the page can show.
   * @param policy - the waits and the visibility source.
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

  /**
   * Something moved — a registry change. A burst already running absorbs this:
   * every read it still owes happens after the change.
   */
  trigger(): void {
    if (this.running || !this.enabled) return
    this.running = true
    this.left = this.policy.waitsMs
    this.owe()
  }

  /**
   * A read found the state still moving, so the burst owes the next read. A
   * read outside any burst — a mount, a press, a decision — starts one, because
   * a user action that changes the park is worth watching settle.
   */
  next(): void {
    if (this.timer !== undefined || this.owed !== undefined) return
    if (!this.running) {
      this.running = true
      this.left = this.policy.waitsMs
    }
    this.owe()
  }

  /**
   * Nothing is moving: end the burst and forget it. The last reading stays
   * published, and the next trigger starts a fresh burst.
   */
  stop(): void {
    this.running = false
    this.left = []
    this.owed = undefined
    this.cancel()
  }

  /** Drop the armed wait. A wait the burst still owes survives it; see {@link checkVisibility}. */
  cancel(): void {
    if (this.timer === undefined) return
    this.clock.clear(this.timer)
    this.timer = undefined
  }

  /**
   * Re-evaluate one page-visibility change. Going off screen drops the armed
   * wait — a hidden page is not being read — and coming back arms it again, so
   * the burst resumes where it stopped instead of being spent while nobody was
   * looking.
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
    this.left = this.left.slice(1)
    this.owed = wait
    this.arm()
  }

  /** Arm the owed wait, when there is one and the page can show the read. */
  private arm(): void {
    const wait = this.owed
    if (wait === undefined || this.timer !== undefined || !this.visibleNow()) return
    this.timer = this.clock.set(() => {
      this.timer = undefined
      this.owed = undefined
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
