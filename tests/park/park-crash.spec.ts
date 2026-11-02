/**
 * Task 04's durability acceptance, end to end through the plugin's own flow:
 * park a real session, let the plugin flush it, SIGKILL the writer process, and
 * find the pending input on disk.
 *
 * The child (`park-crash-child.ts`) runs the whole stack — real agent loop,
 * real JSONL backend, the plugin under test — and kills itself; this spec
 * re-reads the same storage from a fresh context, exactly as the premise probe
 * in `tests/assumptions/parked-input-durability.spec.ts` does. The difference
 * is who flushed: here it is the plugin's park flow, not a hand-written append.
 * @module dsh-pause/test/park/park-crash
 */

import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const crashChild = join(repositoryRoot, 'tests', 'park', 'park-crash-child.ts')

/** Every case shares one storage root; session ids keep the cases apart. */
const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-pause-park-crash-'))
afterAll(() => { rmSync(storageRoot, { recursive: true, force: true }) })

beforeAll(() => {
  // The child imports the plugin's BUILT entry: its own sources use `.js`
  // specifiers for relative imports, which Node's type stripping cannot
  // resolve. Building here keeps this spec runnable on its own.
  const build = spawnSync('pnpm run build:host', {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: true,
    timeout: 120_000,
  })
  expect(build.status, `build failed:\n${build.stdout}\n${build.stderr}`).toBe(0)
}, 120_000)

/** Run the child to its SIGKILL, or fail on any other outcome. */
async function crashCase(id: string): Promise<string> {
  const child = spawn(
    process.execPath,
    ['--experimental-transform-types', crashChild, storageRoot, id],
    { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  const transcript = (): string => `code ${String(code)} signal ${String(signal)}\n`
    + `stdout: ${Buffer.concat(stdout).toString()}\nstderr: ${Buffer.concat(stderr).toString()}`
  expect(signal, transcript()).toBe('SIGKILL')
  expect(Buffer.concat(stdout).toString(), transcript()).toContain('CRASH_READY')
  return transcript()
}

/** Re-read one session from a fresh context over the same storage. */
async function readStored(id: string): Promise<readonly SessionEvent[] | undefined> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot, compression: 'none' })
  try {
    const handle = await ctx.sessionPersistence.open(SessionId(id), 'read')
    try {
      return (await handle.read()).events
    } finally {
      await handle.close()
    }
  } catch (error: unknown) {
    if (error instanceof SessionPersistenceNotFoundError) return undefined
    throw error
  } finally {
    await ctx.fiber.dispose()
  }
}

/** Every user message on the stored log, in order. */
function storedUserTexts(events: readonly SessionEvent[] | undefined): string[] {
  return (events ?? [])
    .filter(event => event.type === 'user/message')
    .map(event => JSON.stringify(event.data))
}

describe('a parked session survives a hard kill', () => {
  it('keeps the input that was pending at the gate, because the plugin flushed the session', async () => {
    const id = 'parked-then-killed'
    await crashCase(id)
    const events = await readStored(id)
    // The log exists at all only because something flushed it.
    expect(events, 'the session never reached durable storage').toBeDefined()
    // The input the loop was holding at the gate is on disk.
    expect(storedUserTexts(events).join('\n')).toContain('pending while parked')
    // And so is the durable record of what the loop did with it.
    expect((events ?? []).map(event => event.type)).toContain('turn/start')
  })
})
