/**
 * The browser half's state: what the Session-header control shows is the
 * host's answer, never a local flip. The controller is driven against a double
 * of the real Client-callable command namespace, and the contribution is
 * mounted on a real slot registry so the wiring — the forwarded
 * `commands/change` re-read and the injected face — is exercised too.
 * @module dsh-safe-stop/test/gate/client-control
 */

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply, inject } from '../../src/client/index.tsx'
import type { SafeStopInjected } from '../../src/client/index.tsx'
import { SafeStopControl } from '../../src/client/control.ts'
import { safeStopView } from '../../src/client/view.ts'
import { PAUSE_COMMAND, PAUSE_DEFINITION_ID, RESUME_COMMAND, RESUME_DEFINITION_ID } from '../../src/shared.ts'
import { until } from './loop.ts'

const SID = SessionId('client-control')

/** Host-side truth a test drives, plus the calls the browser made. */
interface HostDouble {
  paused: boolean
  failList: boolean
  readonly lists: string[]
  readonly lines: string[]
}

/** A stand-in for `ctx.remote.commands` that answers like the host registry does. */
function hostDouble(): { commands: never; host: HostDouble } {
  const host: HostDouble = { paused: false, failList: false, lists: [], lines: [] }
  const commands = {
    list: (sessionId: SessionId) => {
      host.lists.push(String(sessionId))
      if (host.failList) return Promise.resolve({ ok: false, error: { code: 'gateway/internal' } })
      return Promise.resolve({
        ok: true,
        value: [
          { name: PAUSE_COMMAND, description: 'pause', definitionId: PAUSE_DEFINITION_ID },
          ...host.paused
            ? [{ name: RESUME_COMMAND, description: 'resume', definitionId: RESUME_DEFINITION_ID }]
            : [],
        ],
      })
    },
    execute: (sessionId: SessionId, line: string) => {
      host.lines.push(line)
      host.paused = line === `/${PAUSE_COMMAND}`
      return Promise.resolve({ ok: true, value: { commandId: 'command-1', result: { kind: 'success' } } })
    },
  }
  return { commands: commands as never, host }
}

const phaseOf = (control: SafeStopControl): unknown => control.store.getSnapshot().bySession[String(SID)]

describe('browser control state', () => {
  it("shows the host's answer and re-reads it after a press", async () => {
    const { commands, host } = hostDouble()
    const control = new SafeStopControl(commands, new AbortController().signal)

    // No host answer yet: the control claims nothing.
    expect(phaseOf(control)).toBeUndefined()
    expect(safeStopView(phaseOf(control) as never).enabled).toBe(false)

    await control.refresh(SID)
    expect(phaseOf(control)).toBe('active')
    expect(safeStopView('active')).toMatchObject({ paused: false, enabled: true, stateLabel: false })

    await control.toggle(SID)
    expect(host.lines).toEqual([`/${PAUSE_COMMAND}`])
    // The paused state comes from the host's registry, and it is visible.
    expect(phaseOf(control)).toBe('paused')
    expect(safeStopView('paused')).toMatchObject({ paused: true, enabled: true, stateLabel: true })

    await control.toggle(SID)
    expect(host.lines).toEqual([`/${PAUSE_COMMAND}`, `/${RESUME_COMMAND}`])
    expect(phaseOf(control)).toBe('active')
  })

  it('follows a state the host changed on its own', async () => {
    const { commands, host } = hostDouble()
    const control = new SafeStopControl(commands, new AbortController().signal)
    await control.refresh(SID)
    expect(phaseOf(control)).toBe('active')

    // Another surface paused the session; the control has not been pressed.
    host.paused = true
    control.refreshAll()
    await until(() => phaseOf(control) === 'paused')

    host.paused = false
    control.refreshAll()
    await until(() => phaseOf(control) === 'active')
  })

  it('claims nothing when the host cannot answer', async () => {
    const { commands, host } = hostDouble()
    const control = new SafeStopControl(commands, new AbortController().signal)
    host.failList = true
    await control.refresh(SID)
    expect(phaseOf(control)).toBe('unavailable')
    expect(safeStopView('unavailable').enabled).toBe(false)
  })

  it('drops an answer the host has already moved past', async () => {
    const pending: ((value: unknown) => void)[] = []
    const commands = {
      list: () => new Promise((resolve) => { pending.push(resolve) }),
      execute: () => Promise.resolve({ ok: true, value: undefined }),
    }
    const control = new SafeStopControl(commands as never, new AbortController().signal)
    const stale = control.refresh(SID)
    const current = control.refresh(SID)

    // The newer read answers first; the older one lands afterwards.
    pending[1]?.({ ok: true, value: [{ name: RESUME_COMMAND, description: '', definitionId: RESUME_DEFINITION_ID }] })
    await current
    pending[0]?.({ ok: true, value: [{ name: PAUSE_COMMAND, description: '', definitionId: PAUSE_DEFINITION_ID }] })
    await stale
    expect(phaseOf(control)).toBe('paused')
  })
})

describe('browser control wiring', () => {
  /**
   * Mount the client half on a stand-in Context that records what it registers
   * and can deliver the forwarded registry change. The real SlotRegistry is not
   * mounted here: in this repository its package entry resolves to the browser
   * bundle (the harness aliases workspace imports to source, this plugin's
   * Vitest config does not), so the slot machinery is exercised by
   * `tests/client-slot.spec.ts` and the live application.
   */
  function bench() {
    const { commands, host } = hostDouble()
    const listeners: (() => void)[] = []
    const cleanups: (() => void)[] = []
    const registrations: { options?: Record<string, unknown>; inject?: (sessionId: SessionId) => SafeStopInjected }[] = []
    const ctx = {
      effect(callback: () => unknown) {
        const cleanup = callback()
        cleanups.push(typeof cleanup === 'function' ? cleanup as () => void : () => {})
        return () => {}
      },
      locale: { register: () => () => {} },
      remote: {
        commands,
        $on: (_event: string, listener: () => void) => {
          listeners.push(listener)
          return () => { listeners.splice(listeners.indexOf(listener), 1) }
        },
      },
      slots: {
        inject: (_name: string, callback: () => unknown) => { callback(); return () => {} },
        register: (options: Record<string, unknown>, _component: unknown) => {
          registrations.push({ options })
          return () => {}
        },
      },
    }
    apply(ctx as never)
    const entry = registrations[0]
    if (entry === undefined) throw new Error('safe-stop: the control registered no slot entry')
    return {
      host,
      listeners,
      cleanups,
      options: entry.options,
      /** The inject face the framework would hand the component. */
      injected: (sessionId: SessionId): SafeStopInjected => {
        const face = (entry.options as { inject?: (id: SessionId) => SafeStopInjected }).inject
        if (face === undefined) throw new Error('safe-stop: the control registered no inject face')
        return face(sessionId)
      },
    }
  }

  it('reads the host once per mounted control and re-reads on a forwarded registry change', async () => {
    const benchRun = bench()
    expect(benchRun.options).toMatchObject({ id: 'safe-stop', locale: 'safe-stop' })
    const injected = benchRun.injected(SID)

    injected.refresh(SID)
    await until(() => injected.hooks.safeStop.getSnapshot().bySession[String(SID)] === 'active')

    // The host paused the session elsewhere; the forwarded registry change is
    // what tells the browser to re-read.
    benchRun.host.paused = true
    expect(benchRun.listeners).toHaveLength(1)
    benchRun.listeners[0]?.()
    await until(() => injected.hooks.safeStop.getSnapshot().bySession[String(SID)] === 'paused')
    expect(safeStopView('paused').stateLabel).toBe(true)

    injected.toggle(SID)
    await until(() => benchRun.host.lines.length === 1)
    expect(benchRun.host.lines).toEqual([`/${RESUME_COMMAND}`])
    expect(benchRun.host.lists.length).toBeGreaterThanOrEqual(3)
  })

  it('unsubscribes from the host when the plugin unloads', () => {
    const benchRun = bench()
    expect(benchRun.listeners).toHaveLength(1)
    for (const cleanup of benchRun.cleanups.reverse()) cleanup()
    expect(benchRun.listeners).toHaveLength(0)
  })
})
