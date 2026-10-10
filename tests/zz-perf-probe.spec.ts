/** Temporary measurement probe: deleted after the numbers are read. */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SafeStopGlobalControl } from '../src/client/global.ts'
import { encodeGlobalStatus } from '../src/shared.ts'

const SID = SessionId('probe')

/** A host double answering `waiting` forever, counting every round trip. */
function waitingHost(): { commands: never; calls: () => number; frames: () => number } {
  let calls = 0
  let frames = 0
  const text = encodeGlobalStatus({
    verdict: 'waiting', registered: 3, safe: 1, draining: ['a'], stalled: ['b'],
    unresumable: [], unreadTrees: [], jobs: [], blind: [],
  })
  const commands = {
    list: async () => ({ ok: true as const, value: [] }),
    execute: async () => {
      calls += 1
      frames += 1
      // A command call is 2 durable records in the address session's log.
      return { ok: true as const, value: { result: { kind: 'success' as const, text } } }
    },
  }
  return { commands: commands as never, calls: () => calls, frames: () => frames }
}

describe('probe', () => {
  it('counts round trips while the verdict stays waiting', async () => {
    const host = waitingHost()
    const control = new SafeStopGlobalControl(host.commands, new AbortController().signal, 400)
    const started = Date.now()
    await control.refresh(SID)
    await new Promise(resolve => setTimeout(resolve, 2000))
    const elapsed = (Date.now() - started) / 1000
    console.log(`PROBE waiting-poll: ${host.calls()} executes in ${elapsed.toFixed(2)}s (${(host.calls() / elapsed).toFixed(2)}/s)`)
    expect(host.calls()).toBeGreaterThan(1)
  })

  it('counts reads spawned by a burst of commands/change', async () => {
    const host = waitingHost()
    const control = new SafeStopGlobalControl(host.commands, new AbortController().signal, 400)
    await control.refresh(SID)
    const before = host.calls()
    // The wiring is `$on('commands/change', () => refreshAll())`; the host emits
    // one event per register and one per unregister.
    for (let i = 0; i < 10; i += 1) control.refreshAll()
    await new Promise(resolve => setTimeout(resolve, 50))
    console.log(`PROBE change-burst: 10 events -> ${host.calls() - before} executes`)
    expect(host.calls()).toBeGreaterThan(before)
  })
})
