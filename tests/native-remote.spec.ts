/** The native Remote transport: stream snapshots, button actions, and the browser bridge. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PauseRemote } from '../src/remote.ts'
import type { PauseRemoteApi, PauseSnapshotWire } from '../src/remote.ts'
import { remoteTransport } from '../src/client/remote.ts'

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

/** The generated Client face as the runtime hands it over: outcomes wrapped in an envelope. */
function namespaceOf(remote: PauseRemote) {
  return {
    observe: (signal?: AbortSignal) => remote.observe(signal),
    act: async (request: Parameters<PauseRemote['act']>[0], signal?: AbortSignal) =>
      ({ ok: true, value: await remote.act(request, signal) }),
    triage: async (request: Parameters<PauseRemote['triage']>[0], signal?: AbortSignal) =>
      ({ ok: true, value: await remote.triage(request, signal) }),
    decide: async (request: Parameters<PauseRemote['decide']>[0], signal?: AbortSignal) =>
      ({ ok: true, value: await remote.decide(request, signal) }),
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

  it('builds the direct browser transport over the generated namespace', async () => {
    const { api, actions } = apiDouble()
    const remote = new PauseRemote(new Context(), api)
    const lifetime = new AbortController()
    const transport = remoteTransport(namespaceOf(remote), lifetime.signal)

    await expect(transport.source.read(lifetime.signal)).resolves.toMatchObject({ sessions: {} })
    await expect(transport.act({ action: 'pause', sessionId: 's1' }, lifetime.signal))
      .resolves.toEqual({ ok: true, message: 'pause' })
    await expect(transport.triage('s1', lifetime.signal)).resolves.toEqual([])
    await expect(transport.decide('s1', 's2', 'continue', lifetime.signal))
      .resolves.toEqual({ ok: true, message: 'continue' })
    expect(actions).toEqual([
      { action: 'pause', sessionId: 's1' },
      { caller: 's1', target: 's2', decision: 'continue' },
    ])
  })
})
