/**
 * How a parked Session reaches the owner that can bring it back.
 *
 * A root Session is loaded by this plugin, so the test asserts what reaches
 * `agents.resume`. A subagent child belongs to the subagent runtime, so the test
 * asserts the wake goes through `ctx.subagents.prompt` and that the plugin never
 * creates an unmanaged Agent for it.
 *
 * The last group runs the root path against the real agent loop over a Session
 * a killed process left parked, proving the preset setup is called before
 * publication.
 * @module dsh-pause-session/test/resume/composition-resume
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { installResumePath } from '../../src/resume.ts'
import { WAKE_MARKER } from '../../src/resume-text.ts'
import { readParkRegistry } from '../registry/read.ts'
import {
  continuableDescriptor, observationOf, oneShotDescriptor, presetRoster, selectedEvent,
} from './composition-fixtures.ts'
import { ensureHostEntry } from './build.ts'
import { parkAndLeave, resumeAll, reviveHome, storageOf, until } from './home.ts'

const contexts: Context[] = []
const temporaryRoots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

afterAll(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One context owned by this spec, disposed after the case. */
function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

/** One temporary case root, removed after the file settles. */
function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

/** A fake resumed Agent with only the faces this path reads after activation. */
function resumedAgent(id: SessionId): Agent {
  return {
    id,
    status: 'idle',
    session: {
      requestHeader: () => undefined,
      deriveMessages: () => [],
    },
    model: { current: () => ({ provider: 'fake', model: 'fake' }) },
  } as unknown as Agent
}

/** The resume path with fake external services and its calls recorded. */
function resumePathFixture(options: {
  readonly sessionId: SessionId
  readonly observation: ReturnType<typeof observationOf>
  readonly prompt?: (request: unknown, signal: AbortSignal) => Promise<{ messageId: string }>
}) {
  const ctx = context()
  const presets = presetRoster()
  const agentCtx = context()
  agentCtx.provide('agentPresets', presets as never)
  const resume = vi.fn(async (request: ResumeAgentOptions) => {
    await request.setup?.(agentCtx, resumedAgent(request.resumeSessionId))
    return { agent: resumedAgent(request.resumeSessionId), dispose: async () => {} }
  })
  const agents = {
    get: vi.fn(() => undefined),
    resume,
  }
  ctx.provide('agents', agents as never)
  const prompt = vi.fn(options.prompt ?? (async () => ({ messageId: 'message-1' })))
  ctx.provide('subagents', { prompt } as never)
  const query = { observeSession: vi.fn(async () => options.observation) }
  ctx.provide('sessionQuery', query as never)
  ctx.provide('agentPresets', presets as never)

  const record = {
    sessionId: options.sessionId,
    phase: 'safe' as const,
    updatedAt: 1,
    rearmGoal: true,
  }
  const registry = {
    get: vi.fn((id: SessionId) => id === options.sessionId ? record : undefined),
    list: vi.fn(() => [record]),
    forget: vi.fn(async () => {}),
  }
  const gate = { isHeld: vi.fn(() => false), isPaused: vi.fn(() => false), resume: vi.fn() }
  const deps = {
    release: vi.fn(async () => ({ kind: 'success' as const, text: 'released' })),
    adopted: vi.fn(() => false),
  }
  const path = installResumePath(ctx, gate as never, registry as never, { silentWakeRoutes: [] }, deps)
  return { ctx, presets, agentCtx, resume, prompt, query, registry, gate, deps, path }
}

describe('a parked Session reaches the owner that can bring it back', () => {
  it('hands a subagent child to the subagent runtime instead of loading an Agent', async () => {
    const childId = SessionId('child')
    const fixture = resumePathFixture({
      sessionId: childId,
      observation: observationOf({
        events: [
          selectedEvent(0, 'reviewing'),
          continuableDescriptor(1, { agentProvider: 'child-provider', agentModel: 'child-model' }),
        ],
        projection: { agentPreset: 'reviewing' },
      }),
    })

    const outcome = await fixture.path.resumeSession(childId, { kind: 'silent' })

    expect(outcome).toEqual({
      sessionId: childId,
      resumed: true,
      answer: { kind: 'success', text: 'This session resumed from where it paused.' },
    })
    // The runtime owns the activation: it cold-resumes the child under its live
    // tree root with the persisted composition, so the plugin must not create a
    // second, unmanaged Agent on the same Session.
    expect(fixture.resume).not.toHaveBeenCalled()
    expect(fixture.prompt).toHaveBeenCalledOnce()
    expect(fixture.prompt.mock.calls[0]?.[0]).toMatchObject({
      childSessionId: childId,
      delivery: 'queue',
      content: [{ type: 'text', text: WAKE_MARKER }],
    })
    expect(fixture.presets.mount).not.toHaveBeenCalled()
    expect(fixture.registry.forget).toHaveBeenCalledWith(childId)
    expect(fixture.gate.resume).toHaveBeenCalledWith(childId)
  })

  it('maps the runtime\'s one-shot refusal to an unresumable answer and leaves the park in place', async () => {
    const sessionId = SessionId('one-shot')
    const fixture = resumePathFixture({
      sessionId,
      observation: observationOf({ events: [oneShotDescriptor(0)] }),
      prompt: async () => {
        throw new RemoteError('subagent/not-resumable', 'one-shot', {})
      },
    })

    const outcome = await fixture.path.resumeSession(sessionId, { kind: 'silent' })

    expect(outcome).toEqual({
      sessionId,
      resumed: false,
      refusal: 'unresumable',
      answer: {
        kind: 'error',
        text: 'pause did not resume this session: it is a one-shot subagent route and cannot be resumed.',
      },
    })
    expect(fixture.resume).not.toHaveBeenCalled()
    expect(fixture.registry.forget).not.toHaveBeenCalled()
    expect(fixture.gate.resume).not.toHaveBeenCalled()
  })

  it('forwards the resume signal to the projection read and agents.resume', async () => {
    const sessionId = SessionId('cancellable-root')
    const fixture = resumePathFixture({
      sessionId,
      observation: observationOf({ projection: { agentPreset: 'coding' } }),
    })
    const controller = new AbortController()

    const outcome = await fixture.path.resumeSession(sessionId, { kind: 'silent' }, controller.signal)

    expect(outcome.resumed).toBe(true)
    expect(fixture.query.observeSession).toHaveBeenCalledWith(sessionId, { signal: controller.signal })
    expect(fixture.resume.mock.calls[0]?.[0].signal).toBe(controller.signal)
    expect(fixture.prompt).not.toHaveBeenCalled()
  })
})

describe('composition through the real agent loop', () => {
  beforeAll(() => { ensureHostEntry() })

  it('mounts the projected preset through agents.resume before the agent is published', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-composition-resume-')
    await parkAndLeave(caseRoot, 'composition-root', 'clean')
    const home = await reviveHome(caseRoot)
    try {
      const presets = presetRoster()
      const query = {
        observeSession: vi.fn(async () => observationOf({ projection: { agentPreset: 'coding' } })),
      }
      home.ctx.provide('sessionQuery', query as never)
      home.ctx.provide('agentPresets', presets as never)
      const order: string[] = []
      home.ctx.on('agent/created', ({ agent }) => {
        if (agent.id === SessionId('composition-root')) order.push('agent/created')
      })
      const mountPreset = presets.mount.getMockImplementation()!
      presets.mount.mockImplementation(async (agentCtx, presetId) => {
        order.push('preset/mounted')
        return mountPreset(agentCtx, presetId)
      })
      const resume = vi.spyOn(home.ctx.agents, 'resume')

      expect(await resumeAll(home)).toBe('pause resumed 1 session from where it stopped.')

      expect(order).toEqual(['preset/mounted', 'agent/created'])
      expect(resume).toHaveBeenCalledOnce()
      const request = resume.mock.calls[0]![0]
      expect(request.resumeSessionId).toBe(SessionId('composition-root'))
      expect(request.agentOptions).toBeUndefined()
      expect(request.setup).toBeTypeOf('function')
      expect(presets.resolve).toHaveBeenCalledWith('coding')
      expect(presets.mount).toHaveBeenCalledOnce()
      expect(presets.mount.mock.calls[0]?.[1]).toBe('coding')

      const resumed = home.ctx.agents.get(SessionId('composition-root'))
      expect(resumed, 'the parked session was not activated').toBeDefined()
      await until(() => home.provider.requests.length === 1, 'the resumed model request')
      await resumed!.whenIdle()
    } finally {
      await home.ctx.fiber.dispose()
    }
    expect(await readParkRegistry(storageOf(caseRoot))).toEqual([])
  })
})
