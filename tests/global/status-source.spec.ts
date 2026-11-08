/**
 * The native snapshot source is the no-log read path: both controls read the
 * host's stream snapshot and nothing else, so a background status read can never
 * write `command/run`/`command/done` into a Session.
 * @module dsh-pause-session/test/global/status-source
 */

import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PauseTransport } from '../../src/client/remote.ts'
import { PauseControl } from '../../src/client/control.ts'
import { PauseGlobalControl } from '../../src/client/global.ts'
import type { PauseSnapshot } from '../../src/shared.ts'
import type { GlobalStatus, ParkStatus } from '../../src/shared.ts'
import type { PauseActionResultWire, TriageRowWire } from '../../src/remote.ts'

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

/** A transport whose only populated seam is the snapshot source. */
function transportOf(snapshot: PauseSnapshot | undefined): {
  transport: PauseTransport
  acts: unknown[]
  triage: () => number
  decide: () => number
} {
  let triage = 0
  let decide = 0
  const acts: unknown[] = []
  const transport: PauseTransport = {
    source: { read: vi.fn(async () => snapshot as never) },
    act: async (request): Promise<PauseActionResultWire> => {
      acts.push(request)
      return { ok: true, message: 'done' }
    },
    triage: async (): Promise<readonly TriageRowWire[]> => {
      triage += 1
      return []
    },
    decide: async (): Promise<PauseActionResultWire> => {
      decide += 1
      return { ok: true, message: 'done' }
    },
  }
  return { transport, acts, triage: () => triage, decide: () => decide }
}

describe('the native snapshot source replaces background command reads', () => {
  it('publishes the aggregate from the snapshot alone', async () => {
    const { transport, acts, triage, decide } = transportOf({ global: globalStatus(), sessions: {} })
    const control = new PauseGlobalControl(transport, new AbortController().signal)

    await control.refresh(ADDRESS)

    expect(control.store.getSnapshot().global).toEqual({ kind: 'reported', status: globalStatus() })
    expect(transport.source.read).toHaveBeenCalledTimes(1)
    expect(acts).toEqual([])
    expect(triage()).toBe(0)
    expect(decide()).toBe(0)
  })

  it('publishes one session status from the same snapshot', async () => {
    const { transport } = transportOf({ global: globalStatus(), sessions: { [String(ADDRESS)]: paused } })
    const control = new PauseControl(transport, new AbortController().signal)

    await control.refresh(ADDRESS)

    expect(control.store.getSnapshot().bySession[String(ADDRESS)]).toEqual({
      phase: paused.phase,
      runningTools: paused.runningTools,
      rearmGoal: paused.rearmGoal,
    })
    expect(transport.source.read).toHaveBeenCalledTimes(1)
  })
})
