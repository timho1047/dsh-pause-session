/**
 * One process's worth of park state, and a fresh process that resumes it.
 *
 * The child runs the real stack, parks, and SIGKILLs itself; this module runs
 * that child and then mounts the same stack — real agent loop, real JSONL
 * session storage, real storage hub and JSON backend, the plugin under test —
 * in a fresh context over the same roots. The parent keeps a recorder upstream
 * of the gate, so "what reached the model" is observable without a network.
 * @module dsh-pause/test/resume/home
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { apply, Config, inject, name } from '../../src/index.ts'
import type { Config as PauseConfig } from '../../src/index.ts'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { FakeProvider, textResponse } from '../assumptions/fake-provider.ts'
import { mountParkStorage } from '../registry/storage.ts'
import type { ParkMode } from './case.ts'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const parkChild = join(repositoryRoot, 'tests', 'resume', 'park-child.ts')

/** The registry root one case's park state lives in. */
export function storageOf(caseRoot: string): string {
  return join(caseRoot, 'storages')
}

/** The session-log root one case's parked session lives in. */
export function sessionRootOf(caseRoot: string): string {
  return join(caseRoot, 'sessions')
}

/** The request the child's loop built and the gate was holding, as it left it. */
export interface ParkedRequest {
  readonly provider: string
  readonly model: string
  readonly system?: string
  readonly messages: readonly unknown[]
  readonly tools?: readonly unknown[]
  readonly purpose?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
}

/** What one child left behind. */
export interface ParkedChild {
  readonly sessionId: string
  readonly route: string
  /** The request standing at the gate, for a child that parked at one. */
  readonly request?: ParkedRequest
}

/** Run one park child to its SIGKILL and read what it left. */
export async function parkAndLeave(
  caseRoot: string,
  sessionId: string,
  mode: ParkMode,
  route = 'deepseek-official',
): Promise<ParkedChild> {
  const child = spawn(
    process.execPath,
    ['--experimental-transform-types', parkChild, storageOf(caseRoot), sessionRootOf(caseRoot), sessionId, mode, route],
    { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  const transcript = (): string => `code ${String(code)} signal ${String(signal)}\n`
    + `stdout: ${Buffer.concat(stdout).toString()}\nstderr: ${Buffer.concat(stderr).toString()}`
  // SIGKILL is the point: nothing this child appended was unwound.
  if (signal !== 'SIGKILL') throw new Error(`park child did not hard-exit\n${transcript()}`)
  const line = Buffer.concat(stdout).toString().split('\n').find(entry => entry.startsWith('RESUME_READY '))
  if (line === undefined) throw new Error(`park child reported no state\n${transcript()}`)
  const payload = JSON.parse(line.slice('RESUME_READY '.length)) as ParkedChild & { request?: ParkedRequest }
  return { sessionId: payload.sessionId, route: payload.route, ...payload.request === undefined ? {} : { request: payload.request } }
}

/** One fresh process: the loop, the command registry, the storage, the plugin under test. */
export interface ResumeHome {
  readonly ctx: Context
  readonly harness: AgentLoopTestHarness
  readonly provider: FakeProvider
  /** Requests the loop built, recorded upstream of the gate. */
  readonly seen: GenerateOptions[]
  /** The session the user has open this morning; the global resume verb is invoked on it. */
  readonly desk: Agent
  readonly plugin: { dispose(): Promise<void> }
}

/** Options of one fresh process. */
export interface ResumeHomeOptions {
  /** Provider route the parked session recorded; the parent must serve it. */
  readonly route?: string
  /** Mount the goal service and its round driver, for the goal cases. */
  readonly goals?: boolean
  /**
   * Register the `gated` tool the tool cases parked with. The same composition
   * has to offer the same tools in the morning, or the loop reports a tool the
   * parked request used as removed and the payload comparison measures that
   * instead of the wake.
   */
  readonly tools?: boolean
  /** The plugin's own route knowledge, when a case declares it. */
  readonly config?: PauseConfig
}

/**
 * Mount the same stack the child ran, in a fresh context, over one case's
 * roots — with no agent for the parked session, which is what makes the mount
 * read of the registry the only thing holding it.
 */
export async function reviveHome(caseRoot: string, options: ResumeHomeOptions = {}): Promise<ResumeHome> {
  const route = options.route ?? 'deepseek-official'
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // The same log the child wrote: activating a parked session means opening it
  // for write, so the parent cannot resume anything without it.
  await ctx.plugin(JsonlSessionPersistence, { root: sessionRootOf(caseRoot), compression: 'none' })
  await ctx.plugin(CommandRuntime)
  await mountParkStorage(ctx, storageOf(caseRoot))
  if (options.goals === true) {
    await ctx.plugin(GoalService)
    await ctx.plugin(GoalRoundDriver)
  }
  if (options.tools === true) {
    ctx.tools.register(defineContentToolFixture({
      name: 'gated',
      description: 'the tool the parked session was running',
      parameters: { id: { type: 'string', required: true } },
      async execute() {
        return [{ type: 'text', text: 'tool done' }]
      },
    }))
  }
  const harness = await mountAgentLoopTestHarness(ctx)
  const provider = new FakeProvider(Array.from({ length: 12 }, (_unused, index) => textResponse(`answer ${index + 1}`)))
  ctx.llm.registerAdapter([route], provider)
  const seen: GenerateOptions[] = []
  ctx.on('llm/stream', (request, next) => {
    seen.push(request)
    return next()
  })
  const plugin = await ctx.plugin({ name, inject, apply, Config }, options.config)
  const desk = await harness.create(SessionId('morning-desk'), { provider: route, model: 'model' })
  return { ctx, harness, provider, seen, desk, plugin }
}

/** Press the morning verb the way the browser half does, and read its answer. */
export async function resumeAll(home: ResumeHome): Promise<string> {
  const execution = await home.ctx.commands.execute(home.desk, '/pause-resume-all', [], new AbortController().signal)
  if (execution === undefined) throw new Error('pause: the global resume verb is not registered')
  if (execution.result.kind !== 'success') {
    throw new Error(`pause: resume-all failed: ${execution.result.text}`)
  }
  return execution.result.text ?? ''
}

/** Poll until `predicate` holds, letting the loop's own microtasks run. */
export async function until(predicate: () => boolean, describe: string): Promise<void> {
  for (let attempt = 0; attempt < 2000 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 0))
  if (!predicate()) throw new Error(`until: condition never held: ${describe}`)
}

/** Let a session the resume must not wake have every chance to run. */
export async function settles(ms = 50): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}
