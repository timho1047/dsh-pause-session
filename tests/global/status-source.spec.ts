/**
 * The JSON status source is the no-log read path: when it answers, neither
 * control asks the command registry for status, so no background poll writes
 * `command/run`/`command/done` into a Session.
 * @module dsh-pause-session/test/global/status-source
 */

import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PauseControl } from '../../src/client/control.ts'
import { PauseGlobalControl } from '../../src/client/global.ts'
import type { PauseStatusSource } from '../../src/client/status.ts'
import type { GlobalStatus, ParkStatus, PauseSnapshot } from '../../src/shared.ts'

const ADDRESS = SessionId('status-source-address')

/** One host aggregate shaped like the real one. */
function globalStatus(): GlobalStatus {
  return {
    verdict: 'safe',
    registered: 1,
    safe: 1,
    draining: [],
    parking: 0,
    stalled: [],
    unresumable: [],
    unreadTrees: [],
    jobs: [],
    blind: [],
  }
}

/** One paused session shaped like the real one. */
const paused: ParkStatus = { phase: 'safe', safe: true, runningTools: [], rearmGoal: true }

/** A source whose one snapshot the controls read. */
function sourceOf(snapshot: PauseSnapshot | undefined): PauseStatusSource {
  return { read: vi.fn(async () => snapshot) }
}

describe('the JSON status source replaces background command reads', () => {
  it('publishes the aggregate without executing a command', async () => {
    const commands = { list: vi.fn(), execute: vi.fn() }
    const source = sourceOf({ global: globalStatus(), sessions: {} })
    const control = new PauseGlobalControl(commands as never, new AbortController().signal, undefined, undefined, source)

    await control.refresh(ADDRESS)

    expect(control.store.getSnapshot().global).toEqual({ kind: 'reported', status: globalStatus() })
    expect(commands.list).not.toHaveBeenCalled()
    expect(commands.execute).not.toHaveBeenCalled()
  })

  it('publishes one session status without listing its commands or executing one', async () => {
    const commands = { list: vi.fn(), execute: vi.fn() }
    const source = sourceOf({ global: globalStatus(), sessions: { [String(ADDRESS)]: paused } })
    const control = new PauseControl(
      commands as never,
      new AbortController().signal,
      undefined,
      undefined,
      () => ({ kind: 'reported', status: globalStatus() }),
      source,
    )

    await control.refresh(ADDRESS)

    expect(control.store.getSnapshot().bySession[String(ADDRESS)]).toEqual({
      phase: paused.phase,
      runningTools: paused.runningTools,
      rearmGoal: paused.rearmGoal,
    })
    expect(commands.list).not.toHaveBeenCalled()
    expect(commands.execute).not.toHaveBeenCalled()
  })
})
