/**
 * The client half's contract with the host page: which slot it contributes
 * to, under which id, that it owns a locale namespace, and that it requires
 * the host round-trip it cannot work without. Asserted through the plugin's
 * declared interface (`inject` + `apply`), not its internals.
 * @module dsh-safe-stop/test/client-slot
 */

import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.tsx'

interface Recorded {
  injected?: string
  options?: { name?: string; id?: string; locale?: string }
}

/**
 * Minimal stand-in for the client Context: records what the plugin registers,
 * and answers the two Client-callable calls the control makes.
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
      commands: {
        list: () => Promise.resolve({ ok: true, value: [] }),
        execute: () => Promise.resolve({ ok: true, value: undefined }),
      },
      $on: () => () => {},
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
  it('contributes a control into the session header actions slot', () => {
    const { ctx, recorded } = fakeClientContext()
    apply(ctx as never)
    expect(recorded).toContainEqual({ injected: 'conversation.session.header.actions' })
    const registration = recorded.find(entry => entry.options !== undefined)
    expect(registration?.options).toMatchObject({
      name: 'conversation.session.header.actions',
      id: 'safe-stop',
      locale: 'safe-stop',
    })
  })

  it('registers its own locale namespace', () => {
    const { ctx, namespaces } = fakeClientContext()
    apply(ctx as never)
    expect(namespaces).toEqual(['safe-stop'])
  })

  it('requires the slot registry, the locale service, and the host command round-trip', () => {
    // A third-party client half reaches its host half only through a
    // Client-callable command namespace; without it the control cannot know
    // the host's state, so the plugin stays unloaded instead of guessing.
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.commands'])
  })
})
