/**
 * One morning, over the state a killed process left: the real stack with the
 * plugin under test mounted, a fresh context, and no live agent for the parked
 * session — so acting on the decision list is the only way anything gets
 * resumed.
 *
 * The stack is the one the resume suites use, deliberately: the decision list
 * reads the same durable registry, the same session logs and the same resume
 * path, and a fixture that shared none of them would be proving something else.
 * @module dsh-safe-stop/test/triage/home
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { apply, Config, inject, name } from '../../src/index.ts'
import { openParkRegistry } from '../../src/registry.ts'
import { decodeTriageList, TRIAGE_COMMAND } from '../../src/shared.ts'
import type { TriageAction, TriageList } from '../../src/shared.ts'
import { FakeProvider, textResponse } from '../assumptions/fake-provider.ts'
import { readParkRegistry } from '../registry/read.ts'
import { mountParkStorage } from '../registry/storage.ts'
import type { ParkMode } from '../resume/case.ts'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const parkChild = join(repositoryRoot, 'tests', 'resume', 'park-child.ts')

/**
 * The child is handed absolute roots: it runs with the repository as its cwd,
 * and a relative root would put its session log somewhere the parent never
 * looks.
 */
function absolute(path: string): string {
  return resolve(path)
}

/** The registry root one case's park state lives in. */
export function storageOf(caseRoot: string): string {
  return join(caseRoot, 'storages')
}

/** The session-log root one case's parked session lives in. */
export function sessionRootOf(caseRoot: string): string {
  return join(caseRoot, 'sessions')
}

/**
 * Run one park child to its SIGKILL over the case's roots.
 * @param caseRoot - the case's roots.
 * @param sessionId - the session the child parks.
 * @param mode - how the child leaves it.
 * @param flushBeforeKill - whether the child performs the session-level checkpoint a real request path performs.
 */
export async function parkAndLeave(caseRoot: string, sessionId: string, mode: ParkMode, flushBeforeKill = true): Promise<void> {
  const child = spawn(
    process.execPath,
    ['--experimental-transform-types', parkChild, absolute(storageOf(caseRoot)), absolute(sessionRootOf(caseRoot)), sessionId, mode, 'deepseek-official', String(flushBeforeKill)],
    { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  // SIGKILL is the point: nothing this child appended was unwound.
  if (signal !== 'SIGKILL') {
    throw new Error(`park child did not hard-exit (code ${String(code)}, signal ${String(signal)})\n`
      + `stdout: ${Buffer.concat(stdout).toString()}\nstderr: ${Buffer.concat(stderr).toString()}`)
  }
}

/** One fresh morning over a killed process's park state. */
export interface TriageHome {
  readonly ctx: Context
  readonly harness: AgentLoopTestHarness
  readonly provider: FakeProvider
  /** Requests the loop built, recorded upstream of the gate. */
  readonly seen: GenerateOptions[]
  /** The session the user has open this morning; every command is addressed to it. */
  readonly desk: Agent
  /** Run one slash command on the desk session, exactly as the browser half does. */
  run(line: string): Promise<CommandResult>
  /** Read the decision list through the verb the browser half executes. */
  triage(): Promise<TriageList>
  /** Take one of the four decisions on one listed session. */
  decide(sessionId: string, action: TriageAction): Promise<CommandResult>
}

/** Options of one morning. */
export interface TriageHomeOptions {
  /** Provider route the parked sessions recorded; the morning must serve the same one. */
  readonly route?: string
}

/**
 * Mount the morning stack over one case's roots.
 * @param caseRoot - directory holding the killed process's registry and session logs.
 * @param options - the composition variants a case needs.
 * @returns the mounted morning and the verbs the browser half drives.
 */
export async function reviveTriageHome(caseRoot: string, options: TriageHomeOptions = {}): Promise<TriageHome> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: sessionRootOf(caseRoot), compression: 'none' })
  await ctx.plugin(CommandRuntime)
  await mountParkStorage(ctx, storageOf(caseRoot))
  // The tool the child's session called has to exist here too, or its own
  // tool-history projection reports the call's tool as removed.
  ctx.tools.register(defineContentToolFixture({
    name: 'gated',
    description: 'the tool the parked session was running',
    parameters: { id: { type: 'string', required: true } },
    async execute() {
      return [{ type: 'text', text: 'tool done' }]
    },
  }))
  const harness = await mountAgentLoopTestHarness(ctx)
  const route = options.route ?? 'deepseek-official'
  const provider = new FakeProvider(Array.from({ length: 12 }, (_unused, index) => textResponse(`answer ${index + 1}`)))
  ctx.llm.registerAdapter([route], provider)
  const seen: GenerateOptions[] = []
  ctx.on('llm/stream', (request, next) => {
    seen.push(request)
    return next()
  })
  await ctx.plugin({ name, inject, apply, Config })
  const desk = await harness.create(SessionId('morning-desk'), { provider: route, model: 'model' })
  const signal = new AbortController().signal

  const run = async (line: string): Promise<CommandResult> => {
    const execution = await ctx.commands.execute(desk, line, [], signal)
    if (execution === undefined) throw new Error(`safe-stop: "${line}" did not resolve`)
    return execution.result
  }

  return {
    ctx,
    harness,
    provider,
    seen,
    desk,
    run,
    triage: async () => {
      const answer = await run(`/${TRIAGE_COMMAND}`)
      const list = answer.text === undefined ? undefined : decodeTriageList(answer.text)
      if (list === undefined) throw new Error(`safe-stop: the decision list answered in an unknown vocabulary: ${String(answer.text)}`)
      return list
    },
    decide: async (sessionId, action) => await run(`/safe-triage-${action} ${sessionId}`),
  }
}

/** Poll until `predicate` holds, letting the loop's own microtasks run. */
export async function until(predicate: () => boolean, describe: string): Promise<void> {
  for (let attempt = 0; attempt < 2000 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 0))
  if (!predicate()) throw new Error(`until: condition never held: ${describe}`)
}

/** Let a session a decision must not touch have every chance to run. */
export async function settles(ms = 50): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Read the durable registry once the JSON backend has published it.
 *
 * The backend keeps the authoritative state in memory and republishes the whole
 * unit file asynchronously, so a second process reading the file immediately
 * after a write can still open the previous document. Polling an independent
 * read is the honest way to wait for that publish — the spec's subject is what
 * the next process sees, not how long the current one took to flush.
 * @param root - the case's storage root.
 * @param expected - the records the read must show.
 */
export async function recordsUntil(root: string, expected: readonly [string, string][]): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      if (JSON.stringify(await records(root)) === JSON.stringify(expected)) return
    } catch {
      // A unit being republished is not a failure of the subject; look again.
    }
    await settles(10)
  }
  throw new Error(`the registry never showed ${JSON.stringify(expected)}; it shows ${JSON.stringify(await records(root))}`)
}

/** Session id and phase, in registry order. */
export async function records(root: string): Promise<[string, string][]> {
  return (await readParkRegistry(storageOf(root))).map(entry => [String(entry.sessionId), entry.phase] as [string, string])
}

/**
 * Write one park record through the plugin's own registry API, without any
 * session behind it.
 *
 * This is how a host meets a record it cannot read the log for — a session
 * whose stored log never materialized, or one whose session root is gone.
 * Inventing that state at the registry seam is honest: the record is real and
 * durable, only the log is missing.
 * @param caseRoot - the case's storage root.
 * @param sessionId - the session id to record.
 * @param phase - the park outcome to record.
 */
export async function recordParkWithoutLog(caseRoot: string, sessionId: string, phase: 'draining' | 'parking' | 'flush-failed'): Promise<void> {
  const ctx = new Context()
  try {
    await mountParkStorage(ctx, storageOf(caseRoot))
    const registry = await openParkRegistry(ctx)
    await registry.record(SessionId(sessionId), phase)
  } finally {
    await ctx.fiber.dispose()
  }
}
