/**
 * The wake's route resolution, and the fallback that keeps it honest.
 *
 * Whether an empty user message survives to the wire is a property of the route
 * in use, not of the loop, so the plugin resolves it per session: routes the
 * composition declares as dropping an empty user message get an empty wake,
 * every other route gets one fixed visible marker. This spec drives a parked
 * session on a route that was never declared, asserts the marker on the wire,
 * and then re-runs the same parked log with that route declared to show the
 * empty wake coming back — both paths, both payloads.
 * @module dsh-safe-stop/test/resume/wake-route
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WAKE_MARKER } from '../../src/resume.ts'
import { PENDING_INPUT } from './case.ts'
import { ensureHostEntry } from './build.ts'
import { parkAndLeave, resumeAll, reviveHome, until } from './home.ts'
import { wireMessages, wireText } from './wire.ts'

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

beforeAll(() => { ensureHostEntry() })

/** The route the parked session used; the shipped default list does not name it. */
const OTHER_ROUTE = 'acme-chat'

describe('the wake content follows the route in use', () => {
  it('sends one fixed marker instead of an empty turn on an undeclared route', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-resume-marker-')
    const parked = await parkAndLeave(caseRoot, 'overnight-marker', 'clean', OTHER_ROUTE)
    const home = await reviveHome(caseRoot, { route: OTHER_ROUTE })
    try {
      await resumeAll(home)
      await until(() => home.provider.requests.length === 1, 'the model answering the pending input')
      const woken = home.seen[0]!

      // The loop's request gained exactly one message, and it is the marker.
      expect(woken.messages.slice(0, parked.request!.messages.length)).toEqual(parked.request!.messages)
      expect(woken.messages).toHaveLength(parked.request!.messages.length + 1)
      expect(woken.messages.at(-1)).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: WAKE_MARKER }],
      })
      // The marker names the plugin that put it there: it lands in the same user
      // turn as the input the model owes an answer to, and it must be readable
      // as an aside rather than as part of that input.
      expect(WAKE_MARKER).toContain('safe-stop')

      // On the wire it is visible, and it is still nothing but the marker: it
      // lands as one extra text block in the user turn the model owes an answer
      // to, never as words about the interruption.
      const parkedWire = wireMessages(parked.request!)
      const wokenWire = wireMessages(woken)
      expect(wokenWire).toHaveLength(parkedWire.length)
      expect(wireText(wokenWire.at(-1)!)).toBe(PENDING_INPUT + WAKE_MARKER)
    } finally {
      await home.ctx.fiber.dispose()
    }
  })

  it('drops the wake entirely once the composition declares that route silent', async () => {
    const caseRoot = temporaryRoot('dsh-safe-stop-resume-declared-')
    const parked = await parkAndLeave(caseRoot, 'overnight-declared', 'clean', OTHER_ROUTE)
    const home = await reviveHome(caseRoot, {
      route: OTHER_ROUTE,
      config: { silentWakeRoutes: [OTHER_ROUTE] },
    })
    try {
      await resumeAll(home)
      await until(() => home.provider.requests.length === 1, 'the model answering the pending input')
      const woken = home.seen[0]!

      // The wake is still in the loop's request…
      expect(woken.messages).toHaveLength(parked.request!.messages.length + 1)
      expect(woken.messages.filter(message => message.role === 'user' && message.content.length === 0)).toHaveLength(1)
      // …and the payload is again exactly the parked request.
      expect(wireMessages(woken)).toEqual(wireMessages(parked.request!))
    } finally {
      await home.ctx.fiber.dispose()
    }
  })
})
