/**
 * What a cold resume reads from a parked Session's stored composition.
 *
 * A root Session is loaded by this plugin, so the test asserts the preset it
 * mounts. A subagent child is not loaded here at all: the subagent runtime owns
 * its activation and composition, so the only contract this module has is to
 * classify it as a child without touching the preset roster.
 *
 * The cases drive the seam with a real Cordis Context and replace only the two
 * optional services the module reads — the Session projection service and the
 * preset roster. The durable side is the real descriptor format.
 * @module dsh-pause-session/test/resume/composition
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { readParkedComposition } from '../../src/composition.ts'
import {
  continuableDescriptor, observationOf, oneShotDescriptor, presetRoster, selectedEvent,
} from './composition-fixtures.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

/** One context owned by this spec, disposed after the case. */
function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

describe('readParkedComposition for a root Session', () => {
  it('mounts the preset its own projection selected', async () => {
    const ctx = context()
    const presets = presetRoster()
    const query = {
      observeSession: vi.fn(async () => observationOf({ projection: { agentPreset: 'coding' } })),
    }
    ctx.provide('sessionQuery', query as never)
    ctx.provide('agentPresets', presets as never)

    const composition = await readParkedComposition(ctx, SessionId('root'))

    expect(composition.kind).toBe('root')
    if (composition.kind !== 'root') throw new Error('expected a root composition')
    expect(composition.setup).toBeTypeOf('function')
    const agentCtx = context()
    await composition.setup!(agentCtx, {} as Agent)
    expect(presets.resolve).toHaveBeenCalledOnce()
    expect(presets.resolve).toHaveBeenCalledWith('coding')
    expect(presets.mount).toHaveBeenCalledOnce()
    expect(presets.mount.mock.calls[0]?.[0]).toBe(agentCtx)
    expect(presets.mount.mock.calls[0]?.[1]).toBe('coding')
  })

  it('mounts the catalog default when the Session never selected a preset', async () => {
    const ctx = context()
    const presets = presetRoster()
    const query = {
      observeSession: vi.fn(async () => observationOf({ projection: { agentPreset: null } })),
    }
    ctx.provide('sessionQuery', query as never)
    ctx.provide('agentPresets', presets as never)

    const composition = await readParkedComposition(ctx, SessionId('root'))
    if (composition.kind !== 'root') throw new Error('expected a root composition')
    const agentCtx = context()
    await composition.setup!(agentCtx, {} as Agent)

    expect(presets.resolve).toHaveBeenCalledWith(undefined)
    expect(presets.mount).toHaveBeenCalledOnce()
    expect(presets.mount.mock.calls[0]?.[1]).toBe('default')
  })

  it('leaves the resume unchanged when no composition service is mounted', async () => {
    await expect(readParkedComposition(context(), SessionId('bare'))).resolves.toEqual({ kind: 'root' })
  })

  it('refuses a preset-composed resume when sessionQuery is absent', async () => {
    const ctx = context()
    ctx.provide('agentPresets', presetRoster() as never)

    await expect(readParkedComposition(ctx, SessionId('root')))
      .rejects.toThrow('requires the session-query service')
  })

  it('refuses a preset-composed resume when the projection is unavailable', async () => {
    const ctx = context()
    ctx.provide('agentPresets', presetRoster() as never)
    ctx.provide('sessionQuery', {
      observeSession: vi.fn(async () => observationOf({ projection: 'none' })),
    } as never)

    await expect(readParkedComposition(ctx, SessionId('root')))
      .rejects.toThrow('requires projected Session state')
  })

  it('forwards its signal to observeSession', async () => {
    const ctx = context()
    const presets = presetRoster()
    const query = {
      observeSession: vi.fn(async () => observationOf({ projection: { agentPreset: null } })),
    }
    ctx.provide('sessionQuery', query as never)
    ctx.provide('agentPresets', presets as never)
    const controller = new AbortController()

    await readParkedComposition(ctx, SessionId('root'), controller.signal)

    expect(query.observeSession).toHaveBeenCalledWith(SessionId('root'), { signal: controller.signal })
  })

  it('rejects with the abort reason when the observation is cancelled mid-read', async () => {
    const ctx = context()
    const query = {
      observeSession: vi.fn((_sessionId: SessionId, options: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })),
    }
    ctx.provide('sessionQuery', query as never)
    const controller = new AbortController()
    const reason = new Error('stop')

    const pending = readParkedComposition(ctx, SessionId('root'), controller.signal)
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })
})

describe('readParkedComposition for a child Session', () => {
  it('classifies a continuable child without touching the preset roster', async () => {
    const ctx = context()
    const presets = presetRoster()
    ctx.provide('sessionQuery', {
      observeSession: vi.fn(async () => observationOf({
        events: [selectedEvent(0, 'reviewing'), continuableDescriptor(1)],
        projection: { agentPreset: 'reviewing' },
      })),
    } as never)
    ctx.provide('agentPresets', presets as never)

    await expect(readParkedComposition(ctx, SessionId('child'))).resolves.toEqual({ kind: 'child' })
    // The subagent runtime restores the child's composition from the same
    // descriptor and projection; a second mount here would start another Agent.
    expect(presets.resolve).not.toHaveBeenCalled()
    expect(presets.mount).not.toHaveBeenCalled()
  })

  it('classifies a one-shot child the same way: the runtime owns that refusal', async () => {
    const ctx = context()
    const presets = presetRoster()
    ctx.provide('sessionQuery', {
      observeSession: vi.fn(async () => observationOf({ events: [oneShotDescriptor(0)] })),
    } as never)
    ctx.provide('agentPresets', presets as never)

    await expect(readParkedComposition(ctx, SessionId('one-shot'))).resolves.toEqual({ kind: 'child' })
    expect(presets.mount).not.toHaveBeenCalled()
  })
})
