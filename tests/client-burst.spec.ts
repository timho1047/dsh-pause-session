/**
 * The read burst: a handful of reads after something moved, and silence once it
 * settles. These cases pin the budget itself with the clock faked, so a night of
 * waiting costs no real time.
 * @module dsh-pause-session/test/client-burst
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACTION_ABSORB_MS, ReadBurst, burstWaits } from '../src/client/burst.ts'

describe('the read burst', () => {
  afterEach(() => { vi.useRealTimers() })

  /** One burst whose every read asks for the next one, as a control with a moving state does. */
  function movingBurst(waitsMs: readonly number[] = [10, 20, 40]): { burst: ReadBurst; reads: () => number } {
    let reads = 0
    const burst: ReadBurst = new ReadBurst(
      () => { reads += 1; burst.next() },
      { waitsMs, visible: () => true },
    )
    return { burst, reads: () => reads }
  }

  it('spends its waits once and stops for good', async () => {
    vi.useFakeTimers()
    const { burst, reads } = movingBurst()
    burst.trigger()
    expect(burst.live).toBe(true)
    expect(burst.armed).toBe(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(reads()).toBe(1)
    await vi.advanceTimersByTimeAsync(20)
    expect(reads()).toBe(2)
    await vi.advanceTimersByTimeAsync(40)
    expect(reads()).toBe(3)
    // Three waits buy three reads and no more, however long the state moves.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(reads(), 'a burst that spent its waits kept reading').toBe(3)
    expect(burst.live).toBe(false)
    expect(burst.armed).toBe(false)
  })

  it('absorbs every trigger that lands while it is running', async () => {
    vi.useFakeTimers()
    const { burst, reads } = movingBurst()
    // One park announces several transitions, so the burst sees several
    // triggers in a row.
    for (let at = 0; at < 12; at += 1) burst.trigger()
    await vi.advanceTimersByTimeAsync(10)
    expect(reads(), 'twelve triggers became this many bursts').toBe(1)
    // One burst still owes its later reads: absorbing a trigger is not dropping
    // the state it announced.
    await vi.advanceTimersByTimeAsync(60)
    expect(reads()).toBe(3)
  })

  it('stops on a settled state, and a later trigger starts a fresh burst', async () => {
    vi.useFakeTimers()
    const { burst, reads } = movingBurst()
    burst.trigger()
    await vi.advanceTimersByTimeAsync(10)
    expect(reads()).toBe(1)
    burst.stop()
    expect(burst.armed).toBe(false)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(reads()).toBe(1)

    // The user acts again: that is worth the whole burst once more, not the
    // remainder of the last one.
    burst.trigger()
    await vi.advanceTimersByTimeAsync(10)
    expect(reads()).toBe(2)
    await vi.advanceTimersByTimeAsync(20)
    expect(reads()).toBe(3)
  })

  it('turns itself off entirely when it is given no waits', async () => {
    vi.useFakeTimers()
    const { burst, reads } = movingBurst([])
    expect(burst.enabled).toBe(false)
    burst.trigger()
    burst.next()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(reads()).toBe(0)
    expect(burst.live).toBe(false)
  })

  it('derives the default waits from the first one', () => {
    expect(burstWaits(0)).toEqual([])
    expect(burstWaits(25)).toEqual([25, 62.5, 150, 300])
  })

  it('absorbs every change a client action causes, and reads one after the window closes', async () => {
    vi.useFakeTimers()
    const { burst, reads } = movingBurst()
    // The user acted and the action read the host: what arrives for the next
    // `ACTION_ABSORB_MS` is that action's own echo, not news.
    burst.absorb()
    expect(burst.absorbing).toBe(true)
    burst.trigger()
    await vi.advanceTimersByTimeAsync(ACTION_ABSORB_MS + 1)
    expect(reads(), 'a change the action caused was read back').toBe(0)
    expect(burst.absorbing).toBe(false)

    // The window has closed, so the next change is news and buys its burst.
    burst.trigger()
    await vi.advanceTimersByTimeAsync(10)
    expect(reads(), 'a change after the absorption window was dropped').toBe(1)
  })

  it('keeps the window open while the echo keeps arriving', async () => {
    vi.useFakeTimers()
    const { burst, reads } = movingBurst()
    burst.absorb()
    // The measured resume's unregistration storm, at the gaps it actually had:
    // three changes the 400 ms trailing window cannot merge, the last of them
    // 2.04 s after the one before — the case that leaked a read when the window
    // was 2 s. Each one absorbed is another window, so the storm costs nothing
    // rather than one read per change.
    burst.trigger()
    await vi.advanceTimersByTimeAsync(640)
    burst.trigger()
    await vi.advanceTimersByTimeAsync(440)
    burst.trigger()
    await vi.advanceTimersByTimeAsync(2_040)
    expect(reads(), 'the storm the action caused was read back').toBe(0)
    expect(burst.absorbing).toBe(true)

    // The window after the storm's last change is the storm's end.
    await vi.advanceTimersByTimeAsync(ACTION_ABSORB_MS + 1)
    expect(burst.absorbing).toBe(false)
    burst.trigger()
    await vi.advanceTimersByTimeAsync(10)
    expect(reads(), 'the change after the storm was dropped').toBe(1)
  })
})
