/** The native Remote transport: stream snapshots and button actions. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PauseRemote } from '../src/remote.ts'
import type { PauseRemoteApi, PauseSnapshotWire } from '../src/remote.ts'
import { openRemoteSource, remoteCommands } from '../src/client/remote.ts'

const snapshot: PauseSnapshotWire = {
  global: {
    verdict: 'idle', registered: 0, safe: 0, draining: [], parking: 0,
    stalled: [], unresumable: [], unreadTrees: [], jobs: [], blind: [],
  },
  sessions: {},
}

/** A Remote API double with a mutable snapshot and a listener set. */
function apiDouble(): { api: PauseRemoteApi; fire(): void; set(next: PauseSnapshotWire): void; actions: unknown[] } {
  let current = snapshot
  const listeners = new Set<() => void>()
  const actions: unknown[] = []
  return {
    actions,
    api: {
      snapshot: async () => current,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      act: async (request) => { actions.push(request); return { ok: true, message: request.action } },
      triage: async () => [],
      decide: async (request) => { actions.push(request); return { ok: true, message: request.decision } },
    },
    fire: () => { for (const listener of listeners) listener() },
    set: (next) => { current = next },
  }
}

describe('native Remote transport', () => {
  afterEach(() => { vi.useRealTimers() })

  it('serves the opening snapshot and one update per host change', async () => {
    const { api, fire, set } = apiDouble()
    const remote = new PauseRemote(new Context(), api)
    const abort = new AbortController()
    const stream = remote.observe(abort.signal)[Symbol.asyncIterator]()

    await expect(stream.next()).resolves.toMatchObject({ value: snapshot })
    const next = { ...snapshot, global: { ...snapshot.global, registered: 1 } }
    set(next)
    fire()
    await expect(stream.next()).resolves.toMatchObject({ value: next })
    abort.abort()
    await expect(stream.next()).rejects.toBeTruthy()
  })

  it('forwards an action to the engine', async () => {
    const { api, actions } = apiDouble()
    const remote = new PauseRemote(new Context(), api)
    await expect(remote.act({ action: 'pause', sessionId: 's1' }, new AbortController().signal))
      .resolves.toEqual({ ok: true, message: 'pause' })
    expect(actions).toEqual([{ action: 'pause', sessionId: 's1' }])
  })

  it('maps the command-shaped adapter onto the native stream and actions', async () => {
    const { api, actions } = apiDouble()
    const remote = new PauseRemote(new Context(), api)
    const source = openRemoteSource(remote, new AbortController().signal)
    const commands = remoteCommands(remote, source)
    await expect(commands.list('s1' as never)).resolves.toEqual({ ok: true, value: [] })
    const answer = await commands.execute('s1' as never, '/pause', [], new AbortController().signal)
    expect(answer.ok).toBe(true)
    expect(actions).toEqual([{ action: 'pause', sessionId: 's1' }])
  })
})
