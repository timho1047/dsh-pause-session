/**
 * The client half's contract with the host page: which slots it contributes
 * to, under which ids, that it owns a locale namespace, and that it requires
 * the host round-trip it cannot work without. Asserted through the plugin's
 * declared interface (`inject` + `apply`), not its internals.
 * @module dsh-pause-session/test/client-slot
 */

import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.tsx'

interface Recorded {
  injected?: string
  options?: { name?: string; id?: string; locale?: string }
}

/**
 * Minimal stand-in for the client Context: records what the plugin registers,
 * and answers the native Remote namespace the control consumes.
 */
function fakeClientContext() {
  const recorded: Recorded[] = []
  const namespaces: string[] = []
  const ctx = {
    effect(callback: () => unknown) {
      callback()
    },
    locale: {
      register(namespace: string) {
        namespaces.push(namespace)
        return () => {}
      },
    },
    remote: {
      pauseSession: {
        observe: async function* () {},
        act: () => Promise.resolve({ ok: true, value: { ok: true, message: 'done' } }),
        triage: () => Promise.resolve({ ok: true, value: [] }),
        decide: () => Promise.resolve({ ok: true, value: { ok: true, message: 'done' } }),
      },
    },
    inject(_names: readonly string[], callback: (child: typeof ctx) => unknown) {
      callback(ctx)
      return () => {}
    },
    slots: {
      inject(name: string, callback: () => unknown) {
        recorded.push({ injected: name })
        callback()
        return () => {}
      },
      register(options: Recorded['options']) {
        recorded.push({ options })
        return () => {}
      },
    },
  }
  return { ctx, recorded, namespaces }
}

describe('client slot contribution', () => {
  it('contributes both controls into the session header, under their own ids', () => {
    const { ctx, recorded } = fakeClientContext()
    apply(ctx as never)
    expect(recorded).toContainEqual({ injected: 'conversation.session.header.actions' })
    expect(recorded).toContainEqual({ injected: 'conversation.session.header.utilities' })
    const registrations = recorded.flatMap(entry => entry.options === undefined ? [] : [entry.options])
    expect(registrations).toMatchObject([
      { name: 'conversation.session.header.actions', id: 'pause', locale: 'pause' },
      { name: 'conversation.session.header.utilities', id: 'pause-all', locale: 'pause' },
    ])
  })

  it('leaves the frame-wide overlay layer alone', () => {
    // The whole-app control belongs to the conversation column it answers for:
    // a sidebar or drawer that covers that area covers the control with it,
    // while a frame-wide overlay entry floats above every column.
    const { ctx, recorded } = fakeClientContext()
    apply(ctx as never)
    expect(recorded.some(entry => entry.injected === 'shell.overlay')).toBe(false)
    expect(recorded.some(entry => entry.options?.name === 'shell.overlay')).toBe(false)
  })

  it('registers its own locale namespace', () => {
    const { ctx, namespaces } = fakeClientContext()
    apply(ctx as never)
    expect(namespaces).toEqual(['pause'])
  })

  it('requires the slot registry, the locale service, and the native Remote face', () => {
    // The generated Remote namespace is the only transport; without it the
    // control cannot know the host's state, so the plugin stays unloaded
    // instead of guessing.
    expect(inject).toEqual(['slots', 'locale', 'remote'])
  })
})
