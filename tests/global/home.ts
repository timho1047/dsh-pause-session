/**
 * One process's worth of the whole-app park, for the global specs.
 *
 * The stack is the real one — agent loop, JSONL session logs, the
 * storage-backed park registry, the subagent runtime with its catalog, the
 * session-query service the catalog read goes through, and the process-local
 * job registry — with the plugin under test mounted on top. The specs drive it
 * through the very verbs the browser half drives: session commands on the real
 * command registry.
 *
 * The same root can be mounted twice (a second context over the first one's
 * logs and registry), which is the in-process form of the restart the resume
 * path is built for.
 * @module dsh-safe-stop/test/global/home
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { apply, inject, name } from '../../src/index.ts'
import { decodeGlobalStatus, decodeParkStatus, RESUME_COMMAND, STOP_ALL_COMMAND } from '../../src/shared.ts'
import type { GlobalStatus, ParkStatus } from '../../src/shared.ts'
import { FakeProvider, textResponse } from '../assumptions/fake-provider.ts'
import type { ScriptEntry } from '../assumptions/fake-provider.ts'
import { mountHeldParkStorage } from '../registry/held.ts'
import { mountParkStorage } from '../registry/storage.ts'

/** The registry root one case's park state lives in. */
export function storageOf(caseRoot: string): string {
  return join(caseRoot, 'storages')
}

/** The session-log root one case's sessions live in. */
export function sessionRootOf(caseRoot: string): string {
  return join(caseRoot, 'sessions')
}

/** A fresh case root, removed when the owning spec file settles. */
export function temporaryRoot(prefix: string, temporaryRoots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

/** A tool whose every call blocks until the spec releases that exact call. */
export interface BlockingTool {
  readonly definition: ReturnType<typeof defineContentToolFixture>
  /** How many calls have started. */
  started(): number
  /** Let the call at `index` (0-based, in start order) finish. */
  release(index: number): void
  /** Let every call that ever started finish. */
  releaseAll(): void
  /**
   * Let the call that carried this `id` argument finish. Which session's call
   * that is depends on request order, not on session order, so a case that must
   * hold one named member in flight addresses it by the id it passed in.
   * @param id - the value that call passed as its `id` argument.
   */
  releaseId(id: string): void
  /** Whether the call carrying this `id` argument has started. */
  startedId(id: string): boolean
}

/** Build the blocking tool the running-tree cases hold a session with. */
export function blockingTool(): BlockingTool {
  const releases: (() => void)[] = []
  const indexOfId = new Map<string, number>()
  let started = 0
  return {
    definition: defineContentToolFixture({
      name: 'gated',
      description: 'blocks until the spec releases this call',
      parameters: { id: { type: 'string', required: true } },
      async execute(args) {
        const index = started
        started += 1
        const id = args.id
        if (typeof id === 'string') indexOfId.set(id, index)
        await new Promise<void>((resolve) => { releases[index] = resolve })
        return [{ type: 'text', text: 'tool done' }]
      },
    }),
    started: () => started,
    release: (index) => { releases[index]?.() },
    releaseAll: () => { for (const release of releases) release() },
    releaseId: (id) => { releases[indexOfId.get(id) ?? -1]?.() },
    startedId: (id) => indexOfId.has(id),
  }
}

/** One background job this spec started, and the way to settle it. */
export interface StartedJob {
  readonly id: JobId
  /** Settle the job so context teardown is not held open by its producer. */
  finish(): void
}

/** Everything one mounted process offers the global specs. */
export interface GlobalHome {
  readonly ctx: Context
  readonly harness: AgentLoopTestHarness
  readonly provider: FakeProvider
  /** Requests the loop built, recorded upstream of the gate. */
  readonly seen: GenerateOptions[]
  readonly blocking: BlockingTool
  readonly plugin: { dispose(): Promise<void> }
  /** Create one live session the way a user's open session arrives. */
  create(id: string): Promise<Agent>
  /** Run one slash command on one session, exactly as the browser half does. */
  run(agent: Agent, command: string): Promise<CommandResult>
  /** Press the session-header pause verb on one session and hand back its answer. */
  stop(agent: Agent): Promise<CommandResult>
  /** Press the session-header release verb on one session and hand back its answer. */
  release(agent: Agent): Promise<CommandResult>
  /**
   * Read the park state of one session the way its header control does: the
   * marker's presence is the pause, and the status command's own answer carries
   * the phase.
   */
  headerStatus(agent: Agent): Promise<ParkStatus | undefined>
  /** Read the aggregate through the verb the whole-app control executes. */
  status(agent: Agent): Promise<GlobalStatus>
  /** Start a live background job owned by one session. */
  job(owner: SessionId, label: string): StartedJob
  /** Flush every live session, so a later context over the same root sees them whole. */
  flush(): Promise<void>
}

/** One assistant response carrying a single tool call. */
export function toolCallResponse(callId: string, toolName: string, args: object): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: ToolCallId(callId), name: toolName, arguments: JSON.stringify(args) },
    },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * One route entry that gives every session the same shape: a blocking tool call
 * for the step that has no tool result yet, a plain text answer afterwards.
 * Stateless on purpose — the script is shared by every session on the route, so
 * an entry may not assume which session's request it is answering.
 */
export function blockingEntry(): ScriptEntry {
  return (options: GenerateOptions): StreamChunk[] => options.messages.some(message => message.role === 'tool')
    ? textResponse('after the tool')
    : toolCallResponse('call-gated', 'gated', { id: '1' })
}

/** A route script for a case whose sessions block in the `gated` tool. */
export function blockingScript(count = 16): ScriptEntry[] {
  return Array.from({ length: count }, () => blockingEntry())
}

/** Options of one mounted process. */
export interface GlobalHomeOptions {
  /** What the fake route answers with; defaults to plain text so any session can run. */
  readonly script?: readonly ScriptEntry[]
  /** Mount the optional subagent runtime (default true); false is a composition without it. */
  readonly subagents?: boolean
  /** Mount the optional job registry (default true); false is a composition without it. */
  readonly jobs?: boolean
  /** Make every session-level flush fail, for the "could not flush" outcome. */
  readonly failingFlush?: boolean
  /**
   * Mount the goal service, so a case can put a goal on a session. Mounted
   * before any agent exists on purpose: the goal projection has to be
   * registered while the session that will carry the goal is created.
   */
  readonly goals?: boolean
  /**
   * Whether a mounted goal service comes with its round driver (default true).
   * A process that must not advance a goal on its own — the evening half of a
   * park-then-resume case, where rounds would otherwise start the moment the
   * goal exists — mounts the service alone.
   */
  readonly goalRounds?: boolean
  /**
   * Router for the park registry's writes: a key this predicate accepts has
   * every record write refused. It is how a case puts a write failure on one
   * member of a tree, which is where the press's per-member rollback shows.
   */
  readonly failingRecordKeys?: (key: string) => boolean
}

/**
 * Mount the whole stack over one case root.
 * @param caseRoot - directory holding this case's registry and session logs.
 * @param options - the failure modes a case needs.
 * @returns the mounted process and the verbs the browser half drives.
 */
export async function mountGlobalHome(caseRoot: string, options: GlobalHomeOptions = {}): Promise<GlobalHome> {
  const ctx = new Context()
  // The subagent runtime injects `workingDirectory`; without it the runtime's
  // fiber stays pending and the tree walk below silently finds no children.
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root: sessionRootOf(caseRoot), compression: 'none' })
  await ctx.plugin(CommandRuntime)
  if (options.failingRecordKeys === undefined) await mountParkStorage(ctx, storageOf(caseRoot))
  else {
    // A case that only needs a write refused wants that refusal to land at the
    // press, not to wait for the spec's hand: nothing here holds a write open.
    await mountHeldParkStorage(ctx, storageOf(caseRoot), {
      hold: () => false,
      failingKeys: options.failingRecordKeys,
    })
  }
  // Registered while no session exists yet: the goal projection has to be in
  // place when the session that will carry the goal is created.
  if (options.goals === true) {
    await ctx.plugin(GoalService)
    if (options.goalRounds !== false) await ctx.plugin(GoalRoundDriver)
  }
  // The catalog read observes a session through the query service. Exact reads
  // need no search index — a live session, or one prepared from its own JSONL
  // log, is enough — so the memory backend is never opened.
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })
  if (options.subagents !== false) await ctx.plugin(SubagentRuntime)
  if (options.jobs !== false) {
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('spec')
  }
  const harness = await mountAgentLoopTestHarness(ctx)
  const provider = new FakeProvider(options.script === undefined
    ? Array.from({ length: 64 }, () => () => textResponse('an answer'))
    : [...options.script])
  ctx.llm.registerAdapter(['fake'], provider)
  const seen: GenerateOptions[] = []
  ctx.on('llm/stream', (request, next) => {
    seen.push(request)
    return next()
  })
  const blocking = blockingTool()
  ctx.tools.register(blocking.definition)
  if (options.failingFlush === true) {
    ctx.effect(() => ctx.on('session/flush', () => Promise.reject(new Error('disk full'))), 'spec: failing flush')
  }
  const plugin = await ctx.plugin({ name, inject, apply })
  const signal = new AbortController().signal

  const run = async (agent: Agent, command: string): Promise<CommandResult> => {
    const execution = await ctx.commands.execute(agent, `/${command}`, [], signal)
    if (execution === undefined) throw new Error(`safe-stop: /${command} did not resolve for "${agent.id}"`)
    return execution.result
  }

  return {
    ctx,
    harness,
    provider,
    seen,
    blocking,
    plugin,
    create: (id) => harness.create(SessionId(id), { provider: 'fake', model: 'fake' }),
    run,
    stop: agent => run(agent, 'safe-stop'),
    release: agent => run(agent, RESUME_COMMAND),
    headerStatus: async (agent) => {
      const answer = await run(agent, 'safe-state')
      const text = answer.text
      const status = text === undefined ? undefined : decodeParkStatus(text)
      if (status === undefined) {
        throw new Error(`safe-stop: the header status answered in an unknown vocabulary: ${String(text)}`)
      }
      return status
    },
    status: async (agent) => {
      const answer = await run(agent, 'safe-state-all')
      const status = answer.text === undefined ? undefined : decodeGlobalStatus(answer.text)
      if (status === undefined) throw new Error(`safe-stop: the aggregate read answered in an unknown vocabulary: ${String(answer.text)}`)
      return status
    },
    job: (owner, label) => {
      if (options.jobs === false) throw new Error('safe-stop: this home mounts no job registry')
      let finish: () => void = () => {}
      const done = new Promise<{ status: 'completed' }>((resolve) => {
        finish = () => { resolve({ status: 'completed' }) }
      })
      const id = ctx.jobs.start({
        kind: 'bash',
        label,
        owner,
        run: () => ({ done, cancel: () => { finish() } }),
      })
      return { id, finish }
    },
    flush: async () => {
      for (const session of ctx.sessions.list()) await ctx.sessions.flush(session)
    },
  }
}

/**
 * Poll until `predicate` holds, letting the loop's own microtasks run. The
 * budget is generous because these specs run in parallel workers beside the
 * child-process suites, and what they wait for is a park reaching disk.
 */
export async function until(predicate: () => boolean, describe: string): Promise<void> {
  for (let attempt = 0; attempt < 5000 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  if (!predicate()) throw new Error(`until: condition never held: ${describe}`)
}

/** Poll an asynchronous predicate; written out because `vi.waitFor` does not await one. */
export async function untilAsync(predicate: () => Promise<boolean>, describe: string): Promise<void> {
  for (let attempt = 0; attempt < 5000; attempt++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`until: condition never held: ${describe}`)
}

/** Let a session the park must not wake have every chance to run. */
export async function settles(ms = 50): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Remove every temporary root a spec created.
 * @param roots - the roots to delete.
 */
export function cleanRoots(roots: readonly string[]): void {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}
