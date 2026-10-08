/**
 * The client half's contract with the host page: which slot it contributes
 * to, under which id, and that it owns a locale namespace. Asserted through
 * the plugin's declared interface (`inject` + `apply`), not its internals.
 * @module dsh-safe-stop/test/client-slot
 */

import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.tsx'

interface Recorded {
  injected?: string
  options?: { name?: string; id?: string; locale?: string }
}

/** Minimal stand-in for the client Context: records what the plugin registers. */
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

  it('requires the slot registry and the locale service', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })
})
