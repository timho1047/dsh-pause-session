/**
 * The browser half's state: what the Session-header control shows is the
 * host's answer, never a local flip.
 *
 * The controller is driven against a double of the real Client-callable command
 * namespace that answers exactly the way the host does — a resume marker, plus
 * a status command whose RESULT (not its descriptor) carries the park state, so
 * a phase that is still moving is observable at all. The contribution is
 * mounted on a real slot registry so the wiring — the forwarded
 * `commands/change` re-read and the injected face — is exercised too.
 * @module dsh-safe-stop/test/gate/client-control
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply, inject } from '../../src/client/index.tsx'
import type { SafeStopInjected } from '../../src/client/index.tsx'
import { SafeStopControl } from '../../src/client/control.ts'
import type { SafeStopReading } from '../../src/client/control.ts'
import { safeStopView, showsPauseControl } from '../../src/client/view.ts'
import {
  encodeParkStatus, foldTreePhases, GOAL_COMMAND, GOAL_DEFINITION_ID, PAUSE_COMMAND, PAUSE_DEFINITION_ID,
  RESUME_COMMAND, RESUME_DEFINITION_ID, STATUS_COMMAND, STATUS_DEFINITION_ID,
} from '../../src/shared.ts'
import type { ParkPhase } from '../../src/shared.ts'
import { until } from './loop.ts'

const SID = SessionId('client-control')

/** Host-side truth a test drives, plus the calls the browser made. */
interface HostDouble {
  paused: boolean
  phase: ParkPhase
  runningTools: string[]
  failList: boolean
  /** The record's goal opt-out; `undefined` is a host whose answer carries no such field. */
  rearmGoal: boolean | undefined
  /** Resolves the next status read; unset means "answer immediately". */
  holdStatus: (() => void) | undefined
  readonly lists: string[]
  readonly lines: string[]
}

/** A stand-in for `ctx.remote.commands` that answers like the host registry does. */
function hostDouble(): { commands: never; host: HostDouble; readsDone: (count: number) => Promise<void> } {
  const host: HostDouble = {
    paused: false,
    phase: 'draining',
    runningTools: [],
    failList: false,
    rearmGoal: true,
    holdStatus: undefined,
    lists: [],
    lines: [],
  }
  const readWaiters: { count: number; resolve: () => void }[] = []
  const commands = {
    list: (sessionId: SessionId) => {
      host.lists.push(String(sessionId))
      for (const waiter of [...readWaiters]) {
        if (host.lists.length >= waiter.count) {
          readWaiters.splice(readWaiters.indexOf(waiter), 1)
          waiter.resolve()
        }
      }
      if (host.failList) return Promise.resolve({ ok: false, error: { code: 'gateway/internal' } })
      return Promise.resolve({
        ok: true,
        value: [
          { name: PAUSE_COMMAND, description: 'pause', definitionId: PAUSE_DEFINITION_ID },
          ...host.paused
            ? [
              { name: RESUME_COMMAND, description: 'resume', definitionId: RESUME_DEFINITION_ID },
              { name: STATUS_COMMAND, description: 'status', definitionId: STATUS_DEFINITION_ID },
              { name: GOAL_COMMAND, description: 'goal', definitionId: GOAL_DEFINITION_ID },
            ]
            : [],
        ],
      })
    },
    execute: (_sessionId: SessionId, line: string) => {
      host.lines.push(line)
      if (line === `/${PAUSE_COMMAND}`) {
        host.paused = true
        return Promise.resolve({ ok: true, value: { commandId: 'command-1', result: { kind: 'success' } } })
      }
      if (line === `/${RESUME_COMMAND}`) {
        host.paused = false
        return Promise.resolve({ ok: true, value: { commandId: 'command-1', result: { kind: 'success' } } })
      }
      if (line === `/${GOAL_COMMAND}`) {
        host.rearmGoal = !(host.rearmGoal ?? true)
        return Promise.resolve({ ok: true, value: { commandId: 'command-1', result: { kind: 'success' } } })
      }
      const answer = () => ({
        ok: true as const,
        value: {
          commandId: 'command-2',
          result: {
            kind: 'success' as const,
            text: encodeParkStatus({
              phase: host.phase,
              safe: host.phase === 'safe',
              runningTools: host.runningTools,
              ...host.rearmGoal === undefined ? {} : { rearmGoal: host.rearmGoal },
            }),
          },
        },
      })
      const hold = host.holdStatus
      if (hold === undefined) return Promise.resolve(answer())
      return new Promise((resolve) => {
        host.holdStatus = () => { resolve(answer()) }
      })
    },
  }
  return {
    commands: commands as never,
    host,
    readsDone: (count: number) => (host.lists.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => { readWaiters.push({ count, resolve }) })),
  }
}

const readingOf = (control: SafeStopControl): unknown => control.store.getSnapshot().bySession[String(SID)]

describe('browser control state', () => {
  afterEach(() => { vi.useRealTimers() })

  it("shows the host's answer and re-reads it after a press", async () => {
    const { commands, host } = hostDouble()
    const control = new SafeStopControl(commands, new AbortController().signal)

    // No host answer yet: the control claims nothing.
    expect(readingOf(control)).toBeUndefined()
    expect(safeStopView(undefined).enabled).toBe(false)

    await control.refresh(SID)
    expect(readingOf(control)).toEqual({ phase: 'active', runningTools: [] })
    expect(safeStopView({ phase: 'active', runningTools: [] }))
      .toEqual({ paused: false, enabled: true, ariaKey: 'pause.aria', runningTools: [] })

    await control.toggle(SID)
    // The press runs the pause verb; reading the state afterwards is the
    // status read, which is a command call like any other.
    expect(host.lines).toEqual([`/${PAUSE_COMMAND}`, `/${STATUS_COMMAND}`])
    // The paused state comes from the host's registry, and it is visible.
    expect(readingOf(control)).toEqual({ phase: 'draining', runningTools: [], rearmGoal: true })
    expect(safeStopView({ phase: 'draining', runningTools: [] }))
      .toMatchObject({ paused: true, enabled: true, labelKey: 'state.draining' })

    await control.toggle(SID)
    expect(host.lines).toEqual([`/${PAUSE_COMMAND}`, `/${STATUS_COMMAND}`, `/${RESUME_COMMAND}`])
    expect(readingOf(control)).toEqual({ phase: 'active', runningTools: [] })
  })

  it('names the running tool and stops claiming "safe" until the host says so', () => {
    // The screen never rounds a moving phase up to "safe to close", and it
    // passes the host's own tool names through as data.
    expect(safeStopView({ phase: 'draining', runningTools: ['edit', 'bash'] }))
      .toMatchObject({ paused: true, enabled: true, labelKey: 'state.draining', runningTools: ['edit', 'bash'] })
    expect(safeStopView({ phase: 'parking', runningTools: [] }))
      .toMatchObject({ paused: true, enabled: true, labelKey: 'state.parking', runningTools: [] })
    expect(safeStopView({ phase: 'safe', runningTools: [] }))
      .toMatchObject({ paused: true, enabled: true, labelKey: 'state.safe' })
    // A failed flush is a pause the host will not call clean.
    expect(safeStopView({ phase: 'flush-failed', runningTools: [] }))
      .toMatchObject({ paused: true, enabled: true, labelKey: 'state.flushFailed' })
  })

  it("carries the record's goal opt-out, and switches it through the session's own verb", async () => {
    const { commands, host } = hostDouble()
    const control = new SafeStopControl(commands, new AbortController().signal)
    host.paused = true
    host.phase = 'safe'
    await control.refresh(SID)
    expect(readingOf(control)).toEqual({ phase: 'safe', runningTools: [], rearmGoal: true })
    expect(safeStopView(readingOf(control) as SafeStopReading)).toMatchObject({ rearmGoal: true })

    await control.toggleGoal(SID)
    // One verb, addressed to the session whose record it changes — the switch
    // needs no listed row, which is what puts it on the header of a session
    // that stopped cleanly. What it shows afterwards is the host's next answer,
    // never this control's own flip.
    expect(host.lines).toEqual([`/${STATUS_COMMAND}`, `/${GOAL_COMMAND}`, `/${STATUS_COMMAND}`])
    expect(readingOf(control)).toEqual({ phase: 'safe', runningTools: [], rearmGoal: false })
    expect(safeStopView(readingOf(control) as SafeStopReading)).toMatchObject({ rearmGoal: false })
  })

  it('shows no goal state when the host did not answer one', async () => {
    const { commands, host } = hostDouble()
    const control = new SafeStopControl(commands, new AbortController().signal)
    // A host whose status text carries the phase but no goal field: the control
    // reports exactly what it was told and renders no switch, rather than
    // falling back to the product default and calling it an answer.
    host.paused = true
    host.phase = 'safe'
    host.rearmGoal = undefined
    await control.refresh(SID)
    expect(readingOf(control)).toEqual({ phase: 'safe', runningTools: [] })
    expect(safeStopView(readingOf(control) as SafeStopReading).rearmGoal).toBeUndefined()
    // The mapping cannot invent it either: only an answered flag becomes a view
    // field, so a reading without one renders no switch at all.
    expect(safeStopView({ phase: 'safe', runningTools: [] }).rearmGoal).toBeUndefined()

    // A host that cannot be reached claims nothing about the goal, like the
    // rest of the control.
    host.failList = true
    const unreachable = new SafeStopControl(commands, new AbortController().signal)
    await unreachable.refresh(SID)
    expect(safeStopView(readingOf(unreachable) as SafeStopReading).rearmGoal).toBeUndefined()
  })

  it('follows a state the host changed on its own', async () => {
    const { commands, host } = hostDouble()
    const control = new SafeStopControl(commands, new AbortController().signal)
    await control.refresh(SID)
    expect(readingOf(control)).toEqual({ phase: 'active', runningTools: [] })

    // Another surface paused the session; the control has not been pressed.
    host.paused = true
    control.refreshAll()
    await until(() => (readingOf(control) as { phase?: string } | undefined)?.phase === 'draining')

    host.paused = false
    control.refreshAll()
    await until(() => (readingOf(control) as { phase?: string } | undefined)?.phase === 'active')
  })

  it('reads once per announced transition and stops once the phase settles', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    const control = new SafeStopControl(commands, new AbortController().signal, 25)
    host.paused = true
    host.phase = 'draining'
    host.runningTools = ['edit']
    await control.refresh(SID)
    expect(readingOf(control)).toMatchObject({ phase: 'draining', runningTools: ['edit'] })
    const readsAtMount = host.lists.length

    // A phase that is still moving is not watched: the host announces its next
    // transition on the command channel, and that announcement is what makes the
    // browser look. Nothing here spends a read on the drain itself.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(host.lists.length, 'a moving phase was watched instead of announced').toBe(readsAtMount)

    // The flush resolves, the host announces it, and the header shows the truth.
    host.phase = 'safe'
    host.runningTools = []
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(100)
    expect(readingOf(control)).toEqual({ phase: 'safe', runningTools: [], rearmGoal: true })

    // A settled phase is not polled: no further host round-trip is issued.
    const readsAtSettled = host.lists.length
    await vi.advanceTimersByTimeAsync(500)
    expect(host.lists.length).toBe(readsAtSettled)
  })

  it('reaches the truth on the next trigger when the announcement never arrived', async () => {
    vi.useFakeTimers()
    const { commands, host } = hostDouble()
    const control = new SafeStopControl(commands, new AbortController().signal, 25)
    // This page was not listening when the phase moved: all it has is the reading
    // it took itself.
    host.paused = true
    host.phase = 'draining'
    await control.refresh(SID)
    expect(readingOf(control)).toMatchObject({ phase: 'draining' })

    // The transition happened and no change was delivered for it. The next
    // trigger — any registry change, a press, the shell handing this control its
    // session again — reads the host rather than leaving the stale reading up.
    host.phase = 'safe'
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(100)
    expect(readingOf(control)).toEqual({ phase: 'safe', runningTools: [], rearmGoal: true })

    // And a host that cannot answer claims nothing at all: the last reading is
    // replaced by the honest "unavailable", never kept as if it were current.
    host.failList = true
    control.refreshAll()
    await vi.advanceTimersByTimeAsync(100)
    expect(readingOf(control)).toEqual({ phase: 'unavailable', runningTools: [] })
  })

  it('claims nothing when the host cannot answer', async () => {
    const { commands, host } = hostDouble()
    const control = new SafeStopControl(commands, new AbortController().signal)
    host.failList = true
    await control.refresh(SID)
    expect(readingOf(control)).toEqual({ phase: 'unavailable', runningTools: [] })
    expect(safeStopView({ phase: 'unavailable', runningTools: [] }).enabled).toBe(false)
  })

  it('claims nothing while a paused session\'s status read is still in flight', async () => {
    const { commands, host } = hostDouble()
    const control = new SafeStopControl(commands, new AbortController().signal, 0)
    host.paused = true
    host.phase = 'safe'
    // The status read never settles. The marker says paused and the host's own
    // last answer was "safe", but a read that did not answer may not borrow it,
    // so the control must not publish "safe to close" either.
    host.holdStatus = () => {}
    void control.refresh(SID)
    await until(() => host.holdStatus !== undefined)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(readingOf(control)).toBeUndefined()

    host.holdStatus?.()
    await until(() => readingOf(control) !== undefined)
    expect(readingOf(control)).toEqual({ phase: 'safe', runningTools: [], rearmGoal: true })
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
    expect(readingOf(control)).toEqual({ phase: 'parking', runningTools: [] })
  })
})

describe('the header control\'s seat', () => {
  /** A loaded snapshot of a top-level session. */
  const mainSession = { subagent: null }
  /** A session snapshot carrying the subagent fact, as the read-only composer reads it. */
  const subagentSession = {
    subagent: { address: { mode: 'continuable', parentSessionId: 'parent-session', childSessionId: String(SID) } },
  }

  it('renders nothing on a subagent session, and its control on a top-level one', () => {
    // The header control is the user's button for a session's work, and that
    // work includes the subagents under it — so the button does not belong
    // inside the tree. The snapshot's own `subagent` field is what tells them
    // apart; a session whose snapshot has not loaded yet claims nothing and
    // keeps the control.
    expect(showsPauseControl(subagentSession.subagent)).toBe(false)
    expect(showsPauseControl(mainSession.subagent)).toBe(true)
    expect(showsPauseControl(undefined)).toBe(true)
  })

  it('answers a still-draining member with the tree\'s phase, not the session\'s', () => {
    // The host folds the registered members of the tree into one phase; the
    // browser only has to read it, and it must never round a phase up. A
    // `draining` reading keeps the control live so pressing again can take the
    // whole tree back.
    expect(safeStopView({ phase: 'draining', runningTools: [] }))
      .toMatchObject({ paused: true, enabled: true, labelKey: 'state.draining' })
    expect(safeStopView({ phase: 'parking', runningTools: [] }))
      .toMatchObject({ paused: true, enabled: true, labelKey: 'state.parking' })
    expect(safeStopView({ phase: 'safe', runningTools: [] }))
      .toMatchObject({ paused: true, enabled: true, labelKey: 'state.safe' })
  })

  it('folds a tree to its least-clean member, and to safe only when all are', () => {
    // The direction the fold compares in: a failed flush is further from clean
    // than work still on its way, and one clean member never carries a set.
    expect(foldTreePhases(new Set(['safe']))).toEqual({ phase: 'safe', safe: true })
    expect(foldTreePhases(new Set(['safe', 'safe', 'safe']))).toEqual({ phase: 'safe', safe: true })
    expect(foldTreePhases(new Set(['safe', 'draining']))).toEqual({ phase: 'draining', safe: false })
    expect(foldTreePhases(new Set(['draining', 'safe', 'parking']))).toEqual({ phase: 'parking', safe: false })
    expect(foldTreePhases(new Set(['safe', 'flush-failed']))).toEqual({ phase: 'flush-failed', safe: false })
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
    const { commands, host, readsDone } = hostDouble()
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
    const entry = registrations.find(registration =>
      registration.options?.name === 'conversation.session.header.actions')
    if (entry === undefined) throw new Error('safe-stop: the control registered no slot entry')
    return {
      host,
      readsDone,
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

  const phaseAt = (injected: SafeStopInjected, sessionId: SessionId): string | undefined =>
    injected.hooks.safeStop.getSnapshot().bySession[String(sessionId)]?.phase

  it('reads the host once per mounted control and re-reads on a forwarded registry change', async () => {
    const benchRun = bench()
    expect(benchRun.options).toMatchObject({ id: 'safe-stop', locale: 'safe-stop' })
    const injected = benchRun.injected(SID)

    // Mounting the control reads the host once: the host reports the session
    // paused elsewhere (this test presses nothing before this point) and still
    // draining, so the read goes through the status command to learn that.
    benchRun.host.paused = true
    benchRun.host.phase = 'draining'
    injected.refresh(SID)
    await benchRun.readsDone(1)
    await until(() => phaseAt(injected, SID) === 'draining')
    expect(safeStopView(injected.hooks.safeStop.getSnapshot().bySession[String(SID)])).toMatchObject({
      paused: true,
      enabled: true,
      labelKey: 'state.draining',
    })

    // The forwarded registry change is what makes the browser look again.
    const before = benchRun.host.lists.length
    expect(benchRun.listeners).toHaveLength(1)
    benchRun.listeners[0]?.()
    await until(() => benchRun.host.lists.length > before)

    // Draining is a pause: pressing again takes it back, which is the whole
    // point of showing a moving phase instead of blocking the button.
    injected.toggle(SID)
    await until(() => benchRun.host.lines.includes(`/${RESUME_COMMAND}`))
    await until(() => phaseAt(injected, SID) === 'active')

    // The goal switch rides the same face: pressing it runs the session's own
    // goal verb, and the switch's next state is the host's answer again.
    benchRun.host.paused = true
    injected.refresh(SID)
    await until(() => injected.hooks.safeStop.getSnapshot().bySession[String(SID)]?.rearmGoal === true)
    injected.toggleGoal(SID)
    await until(() => benchRun.host.lines.includes(`/${GOAL_COMMAND}`))
    await until(() => injected.hooks.safeStop.getSnapshot().bySession[String(SID)]?.rearmGoal === false)
  })

  it('unsubscribes from the host when the plugin unloads', () => {
    const benchRun = bench()
    expect(benchRun.listeners).toHaveLength(1)
    for (const cleanup of benchRun.cleanups.reverse()) cleanup()
    expect(benchRun.listeners).toHaveLength(0)
  })
})
