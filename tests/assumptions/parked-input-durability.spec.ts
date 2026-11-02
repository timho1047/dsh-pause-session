/**
 * Premise 3 — a parked session's pending input survives a hard kill only after
 * an explicit flush.
 *
 * Each case runs a child process that appends one pending user message through
 * a chosen path and then SIGKILLs itself without unwinding, and re-reads the
 * stored log from this process afterwards. The child therefore exercises the
 * real JSONL backend and the real crash boundary; nothing is mocked.
 * @module dsh-pause/test/assumptions/parked-input-durability
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const crashScript = join(repositoryRoot, 'scripts', 'parked-input-crash.mjs')

/** Every case shares one storage root; session ids keep the cases apart. */
const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-pause-crash-'))
afterAll(() => { rmSync(storageRoot, { recursive: true, force: true }) })

/** Run one crash case to its SIGKILL, or fail on any other outcome. */
async function crashCase(mode: string, id: string): Promise<string> {
  const child = spawn(process.execPath, [crashScript, storageRoot, mode, id], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  const transcript = () => `mode ${mode}: code ${String(code)} signal ${String(signal)}\n`
    + `stdout: ${Buffer.concat(stdout).toString()}\nstderr: ${Buffer.concat(stderr).toString()}`
  expect(signal, transcript()).toBe('SIGKILL')
  return transcript()
}

/**
 * Re-read one session from a fresh context over the same storage, as a new
 * process would: `undefined` means the session never materialized at all.
 */
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

/** The recovered pending input, or a marker for "nothing to recover". */
function recovered(events: readonly SessionEvent[] | undefined): string[] {
  return (events ?? []).map(event => event.type)
}

describe('premise 3: pending input survives a hard kill after an explicit flush', () => {
  it('a live-routed append plus sessions.flush(session) survives SIGKILL', async () => {
    const id = 'live-session-flush'
    await crashCase('live-append-session-flush', id)
    const events = await readStored(id)
    expect(recovered(events)).toEqual(['user/message'])
    expect(events?.[0]?.data).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'pending while parked' }],
    })
  })

  it('the same append without a flush leaves no stored session at all', async () => {
    const id = 'live-no-flush'
    await crashCase('live-append', id)
    expect(await readStored(id)).toBeUndefined()
  })

  it('handle.flush() alone does not drain the routed live buffer', async () => {
    // The trap this premise exists to catch: the handle's own flush promises
    // the *handle's* writes, not the session's routed live events.
    const id = 'live-handle-flush'
    await crashCase('live-append-handle-flush', id)
    const events = await readStored(id)
    // The header materialized, so the session is listed — with the pending
    // input missing.
    expect(events).toBeDefined()
    expect(recovered(events)).toEqual([])
  })

  it('an explicit handle.append followed by handle.flush() survives SIGKILL', async () => {
    const id = 'handle-append-flush'
    await crashCase('handle-append-flush', id)
    expect(recovered(await readStored(id))).toEqual(['user/message'])
  })

  it('an explicit handle.append alone also survives on this backend', async () => {
    // Not a promise of the seam — the JSONL backend writes through on append
    // resolution. Recorded so the verdict does not claim more than it shows.
    const id = 'handle-append-only'
    await crashCase('handle-append', id)
    expect(recovered(await readStored(id))).toEqual(['user/message'])
  })
})
