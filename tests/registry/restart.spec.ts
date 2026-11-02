/**
 * Task 05's restart acceptance, end to end across a real process boundary.
 *
 * A child process runs the whole stack — real agent loop, real JSONL session
 * storage, real storage hub and JSON backend, the plugin under test — parks a
 * session, lets the plugin flush it, and then either SIGKILLs itself or exits
 * cleanly. This spec then mounts the plugin again in a fresh context over the
 * same registry root and proves, through the provider, that the registered
 * session's next message is held while a session the registry never named is
 * served normally. The empty-registry case is the control that makes the first
 * one mean something: the pause is in the registry, not in the session log.
 * @module dsh-pause-session/test/registry/restart
 */

import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { apply, inject, name } from '../../src/index.ts'
import { RESUME_DEFINITION_ID } from '../../src/shared.ts'
import { FakeProvider, textResponse } from '../assumptions/fake-provider.ts'
import { until, turnEnd } from '../gate/loop.ts'
import { readParkRegistry } from './read.ts'
import { mountParkStorage } from './storage.ts'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const restartChild = join(repositoryRoot, 'tests', 'registry', 'restart-child.ts')

/** Every temporary root this spec creates, removed once the file settles. */
const temporaryRoots: string[] = []
afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

/** Where one case's registry lives: beside the session logs, never inside them. */
function storageOf(caseRoot: string): string {
  return join(caseRoot, 'storages')
}

beforeAll(() => {
  // The child imports the plugin's BUILT entry, which only the full build
  // produces (tsc alone refreshes `lib/types`, not the bundled `lib/index.js`).
  // Without this, the child would run whatever bundle was left behind.
  const build = spawnSync('pnpm run build', {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: true,
    timeout: 120_000,
  })
  expect(build.status, `build failed:\n${build.stdout}\n${build.stderr}`).toBe(0)
}, 120_000)

/** Run one child to its intended end, and fail on any other outcome. */
async function parkAndLeave(
  caseRoot: string,
  sessionId: string,
  mode: 'kill' | 'exit',
): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '--experimental-transform-types', restartChild,
      storageOf(caseRoot), join(caseRoot, 'sessions'), sessionId, mode,
    ],
    { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  const transcript = (): string => `code ${String(code)} signal ${String(signal)}\n`
    + `stdout: ${Buffer.concat(stdout).toString()}\nstderr: ${Buffer.concat(stderr).toString()}`
  // SIGKILL is the point of the kill mode; a clean exit must be a clean exit.
  if (mode === 'kill') expect(signal, transcript()).toBe('SIGKILL')
  else expect(code, transcript()).toBe(0)
  expect(Buffer.concat(stdout).toString(), transcript()).toContain('RESTART_READY')
}

/** One fresh process: the loop, the command registry, the storage, and the plugin under test. */
interface RevivedProcess {
  readonly ctx: Context
  readonly harness: AgentLoopTestHarness
  readonly provider: FakeProvider
  /** Requests the loop built, recorded upstream of the gate. */
  readonly seen: GenerateOptions[]
}

/**
 * Mount the same stack the child ran, in a fresh context, over one case's roots
 * — with no agent yet, so the mount-time registry read is what decides whether
 * a session that wakes up later is held. Session persistence is mounted because
 * this process is what the morning really is: the registered session is brought
 * back from its own log, and the registry is the only thing that decides it is
 * held.
 */
async function revive(caseRoot: string): Promise<RevivedProcess> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(caseRoot, 'sessions'), compression: 'none' })
  await ctx.plugin(CommandRuntime)
  await mountParkStorage(ctx, storageOf(caseRoot))
  const harness = await mountAgentLoopTestHarness(ctx)
  const provider = new FakeProvider([textResponse('an answer for a free session')])
  ctx.llm.registerAdapter(['fake'], provider)
  const seen: GenerateOptions[] = []
  ctx.on('llm/stream', (request, next) => {
    seen.push(request)
    return next()
  })
  await ctx.plugin({ name, inject, apply })
  return { ctx, harness, provider, seen }
}

/**
 * The three deliveries that can wake a session while nobody is watching, each
 * named for the source that sends it. All three reach the session the same way
 * — through its Agent inbox: `ctx.schedule` delivers with `followup`
 * (dsh-schedule `runtime.ts`), a webhook rule likewise (dsh-webhook
 * `session.ts`), and a teammate's `send_message` lands in that same inbox
 * (dsh-subagent `inbox.ts`). The gate keys on the session, not on the source,
 * so what this spec has to prove is that a delivery through that one entry
 * never becomes a provider call.
 */
const WAKE_UPS = [
  'a scheduled reminder',
  'a webhook notice',
  "a teammate's message",
] as const

/**
 * Bring one parked session back the way a wake-up source does: from its own
 * stored log, in this process. The route comes from the case's own composition,
 * exactly as the app's activation path supplies it.
 */
async function reopen(loop: RevivedProcess, sessionId: string): Promise<Agent> {
  const handle = await loop.ctx.agents.resume({
    resumeSessionId: SessionId(sessionId),
    agentOptions: { provider: 'fake', model: 'fake' },
  })
  return handle.agent
}

/** Deliver each message through the session's inbox, where every wake-up lands. */
function deliver(agent: Agent, ...deliveries: readonly string[]): void {
  for (const text of deliveries) {
    // The schedule source is the one descriptor these tests can build without
    // depending on the sending packages; the delivery entry is the same for all
    // three, which is what the hold is about.
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'schedule' } }))
  }
}

/** Open a session nothing was parked under, then deliver each message to it. */
async function openFresh(
  loop: RevivedProcess,
  sessionId: string,
  ...deliveries: readonly string[]
): Promise<Agent> {
  const agent = await loop.harness.create(SessionId(sessionId), { provider: 'fake', model: 'fake' })
  deliver(agent, ...deliveries)
  return agent
}

/** Let a hold that must never settle have every chance to do so. */
async function settles(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50))
}

describe('the park registry across a real process restart', () => {
  it('holds a session the previous process parked, and only that one', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-restart-')
    await parkAndLeave(caseRoot, 'restart-registered', 'kill')
    expect((await readParkRegistry(storageOf(caseRoot))).map(entry => [String(entry.sessionId), entry.phase]))
      .toEqual([['restart-registered', 'safe']])

    const loop = await revive(caseRoot)
    try {
      // Scheduled task, webhook, and teammate deliveries all reach the session
      // through its Agent, and none of them may reach the provider. The session
      // itself comes back from the log the previous process left, which is the
      // only thing the registry alone could not have supplied.
      const woken = await reopen(loop, 'restart-registered')
      deliver(woken, 'wake up and spend tokens', ...WAKE_UPS)
      await until(() => loop.seen.length === 1)
      expect(JSON.stringify(loop.seen[0]?.messages)).toContain('wake up and spend tokens')
      await settles()
      // The hold is a wall, not a delay: no further request is even built, and
      // the deliveries behind it are still waiting in the inbox.
      expect(loop.seen).toHaveLength(1)
      expect(loop.provider.requests).toHaveLength(0)
      expect(woken.inbox.nextTurn.length + woken.inbox.nextStep.length).toBe(WAKE_UPS.length)
      // The host publishes its own "paused" fact for a session that woke up
      // long after the mount read the registry.
      expect(loop.ctx.commands.list(woken).map(descriptor => descriptor.definitionId))
        .toContain(RESUME_DEFINITION_ID)

      // A session created after the restart is not on the list: it sends and
      // receives normally.
      const fresh = await openFresh(loop, 'restart-created-after', 'work I started tonight')
      await until(() => loop.provider.requests.length === 1)
      await fresh.whenIdle()
      expect(loop.provider.requests[0]).toBe(loop.seen[1])
      expect(turnEnd(fresh)).toEqual({ turn: 1, reason: { kind: 'completed' } })

      // Held, not dropped: releasing the pause sends the very request that was
      // standing at the gate, and the release is durable.
      await loop.ctx.commands.execute(woken, '/pause-resume', [], new AbortController().signal)
      await until(() => loop.provider.requests.length === 2)
      expect(loop.provider.requests).toContain(loop.seen[0])
      expect(await readParkRegistry(storageOf(caseRoot))).toEqual([])
    } finally {
      await loop.ctx.fiber.dispose()
    }
  })

  it('does not hold the same session when the registry is empty', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-restart-empty-')
    const loop = await revive(caseRoot)
    try {
      const agent = await openFresh(loop, 'restart-registered', 'nothing was ever parked here')
      await until(() => loop.provider.requests.length === 1)
      await agent.whenIdle()
      expect(turnEnd(agent)).toEqual({ turn: 1, reason: { kind: 'completed' } })
    } finally {
      await loop.ctx.fiber.dispose()
    }
  })

  it('re-applies the pause after a clean exit too', async () => {
    const caseRoot = temporaryRoot('dsh-pause-session-restart-clean-')
    await parkAndLeave(caseRoot, 'restart-clean-exit', 'exit')
    expect((await readParkRegistry(storageOf(caseRoot))).map(entry => entry.phase)).toEqual(['safe'])

    const loop = await revive(caseRoot)
    try {
      const parked = await reopen(loop, 'restart-clean-exit')
      deliver(parked, 'still asleep?')
      await until(() => loop.seen.length === 1)
      await settles()
      expect(loop.provider.requests).toHaveLength(0)
    } finally {
      await loop.ctx.fiber.dispose()
    }
  })
})
