/** The native Remote transport: stream snapshots, button actions, and the browser bridge. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PauseRemote } from '../src/remote.ts'
import type { PauseRemoteApi, PauseSnapshotWire } from '../src/remote.ts'
import type { RemotePauseNamespace } from '../src/client/remote.ts'
import { openRemoteSource, remoteTransport } from '../src/client/remote.ts'

const snapshot: PauseSnapshotWire = {
  global: {
    verdict: 'idle', registered: 0, safe: 0, draining: [], parking: 0,
    stalled: [], unresumable: [], unreadTrees: [], jobs: [], blind: [],
  },
  sessions: {},
}

/** A Remote API double with a mutable snapshot and a listener set. */
function apiDouble(): { api: PauseRemoteApi; fire(): void; set(next: PauseSnapshotWire): void; actions: unknown[]; snapshots(): number } {
  let current = snapshot
  let snapshotCalls = 0
  const listeners = new Set<() => void>()
  const actions: unknown[] = []
  return {
    actions,
    snapshots: () => snapshotCalls,
    api: {
      snapshot: async () => { snapshotCalls += 1; return current },
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

  it('serves one shared snapshot to concurrent observers', async () => {
    const { api, snapshots } = apiDouble()
    const remote = new PauseRemote(new Context(), api)
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const first = remote.observe(firstAbort.signal)[Symbol.asyncIterator]()
    const second = remote.observe(secondAbort.signal)[Symbol.asyncIterator]()

    await Promise.all([first.next(), second.next()])
    expect(snapshots()).toBe(1)
    firstAbort.abort()
    secondAbort.abort()
    await expect(first.next()).rejects.toBeTruthy()
    await expect(second.next()).rejects.toBeTruthy()
  })

  it('wakes every concurrent reader from the same opening snapshot', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const namespace: RemotePauseNamespace = {
      observe: async function* () {
        await gate
        yield snapshot
        for (;;) await new Promise(() => {})
      },
      act: async () => ({ ok: true, value: { ok: true, message: 'pause' } }),
      triage: async () => ({ ok: true, value: [] }),
      decide: async () => ({ ok: true, value: { ok: true, message: 'continue' } }),
    }
    const lifetime = new AbortController()
    const source = openRemoteSource(namespace, lifetime.signal)

    // Both header controls mount together and ask before the stream answers;
    // neither may be left waiting for the other's wakeup.
    const first = source.read(lifetime.signal)
    const second = source.read(lifetime.signal)
    release()

    await expect(first).resolves.toMatchObject({ sessions: {} })
    await expect(second).resolves.toMatchObject({ sessions: {} })
    lifetime.abort()
  })

  it('reconnects after the stream drops and republishes the new snapshot', async () => {
    let attempts = 0
    const seen: (object | undefined)[] = []
    const namespace: RemotePauseNamespace = {
      observe: async function* () {
        attempts += 1
        if (attempts === 1) {
          yield snapshot
          return
        }
        yield { ...snapshot, global: { ...snapshot.global, registered: 2 } }
        for (;;) await new Promise(() => {})
      },
      act: async () => ({ ok: true, value: { ok: true, message: 'pause' } }),
      triage: async () => ({ ok: true, value: [] }),
      decide: async () => ({ ok: true, value: { ok: true, message: 'continue' } }),
    }
    const lifetime = new AbortController()
    const source = openRemoteSource(namespace, lifetime.signal)
    source.onSnapshot(snapshot => { seen.push(snapshot) })

    await expect(source.read(lifetime.signal)).resolves.toMatchObject({ global: { registered: 0 } })
    // A dropped stream publishes "unavailable" once, then retries on its own.
    await vi.waitFor(() => {
      expect(seen).toContain(undefined)
    })
    await vi.waitFor(() => {
      expect(attempts).toBeGreaterThan(1)
    })
    await vi.waitFor(async () => {
      await expect(source.read(lifetime.signal)).resolves.toMatchObject({ global: { registered: 2 } })
    })
    lifetime.abort()
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
