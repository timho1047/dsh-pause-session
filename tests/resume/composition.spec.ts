/**
 * What a cold resume rebuilds from a parked Session's stored composition.
 *
 * The tests drive the composition seam with a real Cordis Context and replace
 * only the two optional services the module reads — the Session projection
 * service and the preset roster. The durable side is the real descriptor
 * format, so the cases stay about what a resume restores rather than about how
 * a preset is implemented.
 * @module dsh-pause/test/resume/composition
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { UnresumableSessionError, restoreComposition } from '../../src/composition.ts'
import {
  continuableDescriptor, observationOf, oneShotDescriptor, parentAgent, presetRoster, selectedEvent,
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

/** A child scope exposing the services `applyChildComposition` writes through. */
function childContext(presets: ReturnType<typeof presetRoster>) {
  const ctx = context()
  const prompt = {
    context: vi.fn(),
    section: vi.fn(),
    getContextOrder: vi.fn(() => 0),
    getSectionOrder: vi.fn(() => 0),
  }
  const tools = { restrict: vi.fn() }
  ctx.provide('agentPresets', presets as never)
  ctx.provide('systemPrompt', prompt as never)
  ctx.provide('tools', tools as never)
  return { ctx, prompt, tools }
}

describe('restoreComposition for a root Session', () => {
  it('mounts the preset its own projection selected', async () => {
    const ctx = context()
    const presets = presetRoster()
    const query = {
      observeSession: vi.fn(async () => observationOf({ projection: { agentPreset: 'coding' } })),
    }
    ctx.provide('sessionQuery', query as never)
    ctx.provide('agentPresets', presets as never)

    const composition = await restoreComposition(ctx, SessionId('root'), undefined)

    expect(composition.agentOptions).toBeUndefined()
    expect(composition.setup).toBeTypeOf('function')
    const agentCtx = context()
    await composition.setup!(agentCtx, {} as Agent)
    expect(presets.resolve).toHaveBeenCalledOnce()
    expect(presets.resolve).toHaveBeenCalledWith('coding')
    expect(presets.mount).toHaveBeenCalledOnce()
    expect(presets.mount.mock.calls[0]?.[0]).toBe(agentCtx)
    expect(presets.mount.mock.calls[0]?.[1]).toBe('coding')
    expect(presets.composeFrom).not.toHaveBeenCalled()
  })

  it('mounts the catalog default when the Session never selected a preset', async () => {
    const ctx = context()
    const presets = presetRoster()
    const query = {
      observeSession: vi.fn(async () => observationOf({ projection: { agentPreset: null } })),
    }
    ctx.provide('sessionQuery', query as never)
    ctx.provide('agentPresets', presets as never)

    const composition = await restoreComposition(ctx, SessionId('root'), undefined)
    const agentCtx = context()
    await composition.setup!(agentCtx, {} as Agent)

    expect(presets.resolve).toHaveBeenCalledWith(undefined)
    expect(presets.mount).toHaveBeenCalledOnce()
    expect(presets.mount.mock.calls[0]?.[1]).toBe('default')
  })
})

describe('restoreComposition for a child Session', () => {
  it('mounts the child selection independently and reapplies its descriptor overrides', async () => {
    const ctx = context()
    const presets = presetRoster()
    const parentCtx = context()
    const child = childContext(presets)
    const query = {
      observeSession: vi.fn(async () => observationOf({
        events: [
          selectedEvent(0, 'reviewing'),
          continuableDescriptor(1, {
            persona: 'Review this child work carefully.',
            toolFilter: { deny: ['bash'] },
            agentProvider: 'child-provider',
            agentModel: 'child-model',
            agentReasoningEffort: ReasoningEffortId('high'),
          }),
        ],
        projection: { agentPreset: 'reviewing' },
      })),
    }
    ctx.provide('sessionQuery', query as never)
    ctx.provide('agentPresets', presets as never)

    const composition = await restoreComposition(ctx, SessionId('child'), parentAgent(parentCtx))

    expect(composition.agentOptions).toEqual({
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: 'high',
    })
    expect(composition.setup).toBeTypeOf('function')
    await composition.setup!(child.ctx, {} as Agent)
    expect(presets.mount).toHaveBeenCalledOnce()
    expect(presets.mount.mock.calls[0]?.[0]).toBe(child.ctx)
    expect(presets.mount.mock.calls[0]?.[1]).toBe('reviewing')
    expect(presets.composeFrom).not.toHaveBeenCalled()
    expect(child.prompt.context).toHaveBeenCalledWith(expect.objectContaining({ name: 'subagent:delegation' }))
    expect(child.prompt.section).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deployment:persona-prefix',
      text: 'Review this child work carefully.',
    }))
    expect(child.tools.restrict).toHaveBeenCalledWith({ deny: ['bash'] })
  })

  it('joins the live parent composition when the child selected no preset before its descriptor', async () => {
    const ctx = context()
    const presets = presetRoster()
    const parentCtx = context()
    const child = childContext(presets)
    const query = {
      observeSession: vi.fn(async () => observationOf({
        events: [
          continuableDescriptor(0, {
            persona: 'Keep the child scope.',
            toolFilter: { allow: ['read'] },
            agentProvider: 'child-provider',
            agentModel: 'child-model',
          }),
          // A selection after the descriptor belongs to the child's later
          // history; it does not opt the cold resume out of the parent world.
          selectedEvent(1, 'late-selection'),
        ],
        projection: { agentPreset: 'late-selection' },
      })),
    }
    ctx.provide('sessionQuery', query as never)
    ctx.provide('agentPresets', presets as never)

    const composition = await restoreComposition(ctx, SessionId('child'), parentAgent(parentCtx))
    await composition.setup!(child.ctx, {} as Agent)

    expect(composition.agentOptions).toEqual({
      provider: 'child-provider',
      model: 'child-model',
    })
    expect(presets.mount).not.toHaveBeenCalled()
    expect(presets.composeFrom).toHaveBeenCalledOnce()
    expect(presets.composeFrom.mock.calls[0]?.[0]).toBe(child.ctx)
    expect(presets.composeFrom.mock.calls[0]?.[1]).toBe(parentCtx)
    expect(child.prompt.section).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deployment:persona-prefix',
      text: 'Keep the child scope.',
    }))
    expect(child.tools.restrict).toHaveBeenCalledWith({ allow: ['read'] })
  })

  it('refuses an independently selected child with no projected preset', async () => {
    const ctx = context()
    const presets = presetRoster()
    const parentCtx = context()
    const query = {
      observeSession: vi.fn(async () => observationOf({
        events: [selectedEvent(0, 'reviewing'), continuableDescriptor(1)],
        projection: {},
      })),
    }
    ctx.provide('sessionQuery', query as never)
    ctx.provide('agentPresets', presets as never)

    await expect(restoreComposition(ctx, SessionId('child'), parentAgent(parentCtx)))
      .rejects.toThrow('has no projected agent preset to restore')
  })

  it('refuses a one-shot child route before consulting the preset roster', async () => {
    const ctx = context()
    const presets = presetRoster()
    const query = {
      observeSession: vi.fn(async () => observationOf({ events: [oneShotDescriptor(0)] })),
    }
    ctx.provide('sessionQuery', query as never)
    ctx.provide('agentPresets', presets as never)

    await expect(restoreComposition(ctx, SessionId('one-shot'), parentAgent(context())))
      .rejects.toBeInstanceOf(UnresumableSessionError)
    expect(presets.resolve).not.toHaveBeenCalled()
    expect(presets.mount).not.toHaveBeenCalled()
    expect(presets.composeFrom).not.toHaveBeenCalled()
  })
})

describe('restoreComposition service and cancellation edges', () => {
  it('leaves the resume unchanged when no composition service is mounted', async () => {
    await expect(restoreComposition(context(), SessionId('bare'), undefined)).resolves.toEqual({})
  })

  it('refuses a preset-composed resume when sessionQuery is absent', async () => {
    const ctx = context()
    ctx.provide('agentPresets', presetRoster() as never)

    await expect(restoreComposition(ctx, SessionId('root'), undefined))
      .rejects.toThrow('requires the session-query service')
  })

  it('refuses a preset-composed resume when the projection is unavailable', async () => {
    const ctx = context()
    ctx.provide('agentPresets', presetRoster() as never)
    ctx.provide('sessionQuery', {
      observeSession: vi.fn(async () => observationOf({ projection: 'none' })),
    } as never)

    await expect(restoreComposition(ctx, SessionId('root'), undefined))
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

    await restoreComposition(ctx, SessionId('root'), undefined, controller.signal)

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

    const pending = restoreComposition(ctx, SessionId('root'), undefined, controller.signal)
    controller.abort(new Error('cancelled while reading the projection'))

    await expect(pending).rejects.toThrow('cancelled while reading the projection')
  })
})
