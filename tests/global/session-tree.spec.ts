/**
 * The session-header control's own unit of work: one session AND its subagent
 * tree, nested members included.
 *
 * These cases drive the very verbs the header control runs — `/pause` and
 * `/pause-resume` on the session they sit on — through the real command registry
 * and assert what is durable afterwards plus what the header's own status read
 * says. The tree is a real one: each parent's own subagent catalog records its
 * child, and the recursive walk is the harness's.
 *
 * Which session's tool call runs first is request order, not session order, so
 * a case that must hold a named member in flight addresses its call by the id
 * argument it passed rather than by a start index.
 * @module dsh-pause/test/global/session-tree
 */

import { afterAll, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { UNATTENDED_TEXT } from '../../src/control.ts'
import { RESUME_DEFINITION_ID } from '../../src/shared.ts'
import { textResponse } from '../assumptions/fake-provider.ts'
import type { ScriptEntry } from '../assumptions/fake-provider.ts'
import { readParkRegistry } from '../registry/read.ts'
import {
  cleanRoots, mountGlobalHome, storageOf, temporaryRoot, toolCallResponse, untilAsync,
} from './home.ts'

/** Every temporary root this spec creates, removed once the file settles. */
const temporaryRoots: string[] = []
afterAll(() => { cleanRoots(temporaryRoots) })

const ask = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

/**
 * A route script that plays a chosen entry for the named sessions and answers
 * every other request outright. Which session's request runs first is request
 * order, not session order, so a case that must hold one named member in flight
 * addresses it by the id its own request carried.
 * @param bySession - the entry each named session's request should play.
 * @returns entries the fake route plays in request order.
 */
function scriptFor(bySession: ReadonlyMap<string, ScriptEntry>): ScriptEntry[] {
  const entry: ScriptEntry = (options: GenerateOptions) => {
    const chosen = bySession.get(String(options.sessionId))
    if (chosen === undefined) return textResponse('after the tool')
    return typeof chosen === 'function' ? chosen(options) : chosen
  }
  return Array.from({ length: 16 }, () => entry)
}

/**
 * The common case: exactly the named sessions call the blocking tool.
 * @param gated - the sessions whose request should call the blocking tool.
 * @returns entries the fake route plays in request order.
 */
function gatedIn(gated: readonly string[]): ScriptEntry[] {
  return scriptFor(new Map(gated.map(session => [
    session,
    (options: GenerateOptions) => toolCallResponse(`call-${String(options.sessionId)}`, 'gated', { id: session }),
  ])))
}

/**
 * Record one parent's catalog row for a child, the way a real delegation does.
 * @param parent - the session whose catalog gains the child.
 * @param child - the child session.
 */
function delegate(parent: Agent, child: Agent): void {
  parent.session.append('subagent/catalog', {
    version: 0,
    childId: child.session.id,
    childCreatedAt: child.session.header.createdAt,
    mode: 'continuable',
    label: 'continuable child',
  })
}

/** The recorded phases, keyed by session id, as the durable registry holds them. */
async function phases(caseRoot: string): Promise<Record<string, string>> {
  const entries = await readParkRegistry(storageOf(caseRoot))
  return Object.fromEntries(entries.map(entry => [String(entry.sessionId), entry.phase]))
}

/**
 * Wait until the durable registry holds exactly the phases a case expects.
 *
 * Two things make this a settled read rather than a single one: the check is
 * positive, so a registry read that comes back empty cannot pass a wait for a
 * park nobody has recorded yet; and it takes the reading twice, so a phase the
 * plugin is still walking through is not mistaken for the one it lands on.
 * @param caseRoot - the case's storage root.
 * @param expected - the phases every named session must hold, and nobody else.
 */
async function settleAt(caseRoot: string, expected: Readonly<Record<string, string>>): Promise<void> {
  let holding = 0
  await untilAsync(async () => {
    const now = await phases(caseRoot)
    const matches = Object.keys(now).length === Object.keys(expected).length
      && Object.entries(expected).every(([id, phase]) => now[id] === phase)
    holding = matches ? holding + 1 : 0
    return holding >= 3
  }, `the registry to hold ${JSON.stringify(expected)}`)
}

/**
 * Whether every member of a tree holds the flushed park point, read until the
 * answer settles.
 *
 * A single read is not enough to act on: under load the registry can be caught
 * mid-walk, and a phase the plugin is still passing through would then be
 * mistaken for the one it lands on — which is exactly the mistake `settleAt`
 * exists to avoid below.
 * @param caseRoot - the case's storage root.
 * @param expected - every member of the tree, with the phase it must settle at.
 */
async function allSafe(caseRoot: string, expected: Readonly<Record<string, string>>): Promise<void> {
  await settleAt(caseRoot, expected)
}

describe('the session-header press covers the tree it owns', () => {
  it('registers a nested tree in one press and says how many it registered', async () => {
    const caseRoot = temporaryRoot('dsh-pause-tree-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: gatedIn(['tree-root', 'tree-child', 'tree-grandchild']) })
    try {
      const root = await home.create('tree-root')
      const child = await home.create('tree-child')
      const grandchild = await home.create('tree-grandchild')
      delegate(root, child)
      delegate(child, grandchild)
      root.followup(ask('run the tool'))
      child.followup(ask('run the tool'))
      grandchild.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 3, 'three tools in flight')

      const answer = await home.stop(root)
      expect(answer.kind, answer.text).toBe('success')
      // The count is what makes the press unmistakable for stopping one thing:
      // the session plus the two subagents under it.
      expect(answer.text).toBe('Paused this session and 2 subagents.'
        + ' A running tool will finish first; no new model request will be sent. Press again to resume.')
      expect(await phases(caseRoot)).toEqual({
        'tree-root': 'draining',
        'tree-child': 'draining',
        'tree-grandchild': 'draining',
      })

      // Every member honours the pause: each holds the request that follows its
      // tool, so nothing was sent after the press.
      const sent = home.provider.requests.length
      home.blocking.releaseAll()
      await allSafe(caseRoot, { 'tree-root': 'safe', 'tree-child': 'safe', 'tree-grandchild': 'safe' })
      expect(home.provider.requests).toHaveLength(sent)
    } finally {
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })

  it('leaves a one-shot child out of the registry instead of promising a resume', async () => {
    const caseRoot = temporaryRoot('dsh-pause-tree-one-shot-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: gatedIn(['one-shot-root']) })
    try {
      const root = await home.create('one-shot-root')
      const child = await home.create('one-shot-child')
      root.session.append('subagent/catalog', {
        version: 0,
        childId: child.session.id,
        childCreatedAt: child.session.header.createdAt,
        mode: 'one-shot',
        label: 'bridge',
      })
      child.session.append('subagent/descriptor', snapshotSubagentDescriptor({
        mode: 'one-shot',
        provider: 'spawn',
        label: 'bridge',
      }))
      root.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 1, 'the tool in flight')

      const answer = await home.stop(root)
      expect(answer.kind, answer.text).toBe('success')
      expect(answer.text).toBe('Paused this session.'
        + ' A running tool will finish first; no new model request will be sent. Press again to resume.')
      expect(await phases(caseRoot)).toEqual({ 'one-shot-root': 'draining' })

      home.blocking.releaseAll()
      await allSafe(caseRoot, { 'one-shot-root': 'safe' })
      expect(await phases(caseRoot)).toEqual({ 'one-shot-root': 'safe' })
    } finally {
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })

  it('releases the same tree symmetrically, parents before children', async () => {
    const caseRoot = temporaryRoot('dsh-pause-tree-release-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: gatedIn(['release-root', 'release-child', 'release-grandchild']) })
    try {
      const root = await home.create('release-root')
      const child = await home.create('release-child')
      const grandchild = await home.create('release-grandchild')
      delegate(root, child)
      delegate(child, grandchild)
      root.followup(ask('run the tool'))
      child.followup(ask('run the tool'))
      grandchild.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.started() === 3, 'three tools in flight')

      expect((await home.stop(root)).kind).toBe('success')
      home.blocking.releaseAll()
      await allSafe(caseRoot, { 'release-root': 'safe', 'release-child': 'safe', 'release-grandchild': 'safe' })
      const sent = home.provider.requests.length

      // One press on the same control, and the whole tree comes back: nothing
      // is left parked, and each member answers the input it stopped in front
      // of rather than sitting there as a record.
      const answer = await home.release(root)
      expect(answer.kind, answer.text).toBe('success')
      expect(await readParkRegistry(storageOf(caseRoot))).toEqual([])
      await untilAsync(async () => home.provider.requests.length === sent + 3, 'every member to continue')
      expect(home.ctx.commands.list(root).map(descriptor => descriptor.definitionId))
        .not.toContain(RESUME_DEFINITION_ID)
      expect(home.ctx.commands.list(grandchild).map(descriptor => descriptor.definitionId))
        .not.toContain(RESUME_DEFINITION_ID)
    } finally {
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })

  it('leaves a member that did not stop cleanly parked and named while the others resume', async () => {
    const caseRoot = temporaryRoot('dsh-pause-tree-unclean-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, { script: gatedIn(['unclean-root', 'unclean-child', 'unclean-grandchild']) })
    try {
      const root = await home.create('unclean-root')
      const child = await home.create('unclean-child')
      const grandchild = await home.create('unclean-grandchild')
      delegate(root, child)
      delegate(child, grandchild)
      root.followup(ask('run the tool'))
      child.followup(ask('run the tool'))
      grandchild.followup(ask('run the tool'))
      await untilAsync(
        async () => ['unclean-root', 'unclean-child', 'unclean-grandchild'].every(id => home.blocking.startedId(id)),
        'three tools in flight',
      )

      expect((await home.stop(root)).kind).toBe('success')
      // Only the grandchild's own call lands, so it is the one member that
      // reaches the park point and gets its session-level flush.
      home.blocking.releaseId('unclean-grandchild')
      await settleAt(caseRoot, {
        'unclean-root': 'draining',
        'unclean-child': 'draining',
        'unclean-grandchild': 'safe',
      })

      // The clean-only rule is per record: the one member that finished its
      // park resumes, and the two still draining keep their pause — and stay
      // named, because an unclean session is never silently woken.
      const answer = await home.release(root)
      expect(answer.kind, answer.text).toBe('error')
      expect(answer.text).toBe('pause resumed 1 session from where it stopped;'
        + ' "unclean-root", "unclean-child" did not pause completely.')
      expect(await phases(caseRoot)).toEqual({
        'unclean-root': 'draining',
        'unclean-child': 'draining',
      })
      const aggregate = await home.status(root)
      expect(aggregate.draining).toEqual(['unclean-child', 'unclean-root'])
      expect(aggregate.safe).toBe(0)

      // The resumed member really continues: it answers the input it stopped in
      // front of instead of merely losing its record.
      await untilAsync(async () => home.provider.requests.length >= 4, 'the clean member to continue')

      // The ones that stayed parked finish on their own once their work lands.
      home.blocking.releaseId('unclean-root')
      home.blocking.releaseId('unclean-child')
      await allSafe(caseRoot, { 'unclean-root': 'safe', 'unclean-child': 'safe' })
    } finally {
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })

  it('reports the tree\'s phase, so a still-draining member is never called safe', async () => {
    const caseRoot = temporaryRoot('dsh-pause-tree-status-', temporaryRoots)
    // The child's request is the one that calls the tool; the root answers
    // outright, so the child is the member still draining once the root has
    // nothing left to do.
    const home = await mountGlobalHome(caseRoot, {
      script: scriptFor(new Map<string, ScriptEntry>([
        ['status-child', (options: GenerateOptions) => toolCallResponse('call-gated', 'gated', { id: String(options.sessionId) })],
        ['status-root', textResponse('just answering')],
      ])),
    })
    try {
      const child = await home.create('status-child')
      const root = await home.create('status-root')
      delegate(root, child)
      child.followup(ask('run the tool'))
      await untilAsync(async () => home.blocking.startedId('status-child'), 'the child tool in flight')
      root.followup(ask('just answer'))

      expect((await home.stop(root)).kind).toBe('success')
      // The root itself has nothing to drain, so its own record reaches the
      // flushed park point while the child is still inside its tool.
      await untilAsync(async () => (await phases(caseRoot))['status-root'] === 'safe', 'the root itself to park')

      // Its record is clean; the header may not say so, because the tree the
      // press registered is not. The reading is the worst of the tree, and it
      // is a reading the control keeps showing: three in a row, not one look.
      let holding = 0
      await untilAsync(async () => {
        holding = (await home.headerStatus(root))?.phase === 'draining' ? holding + 1 : 0
        return holding >= 3
      }, 'the header to keep reporting the draining member')
      const asking = await home.headerStatus(root)
      expect(asking?.phase).toBe('draining')
      expect(asking?.safe).toBe(false)
      expect((await home.status(root)).draining).toEqual(['status-child'])

      // The member reaches its park point and the header follows it there.
      home.blocking.releaseId('status-child')
      await untilAsync(async () => (await home.headerStatus(root))?.phase === 'safe', 'the tree to finish parking')
      const settled = await home.headerStatus(root)
      expect(settled?.phase).toBe('safe')
      expect(settled?.safe).toBe(true)
    } finally {
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })

  it('names the member whose record it could not write instead of counting it as paused', async () => {
    const caseRoot = temporaryRoot('dsh-pause-tree-unrecorded-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot, {
      script: gatedIn(['unrecorded-root', 'unrecorded-child', 'unrecorded-grandchild']),
      failingRecordKeys: key => key === 'unrecorded-grandchild',
    })
    try {
      const root = await home.create('unrecorded-root')
      const child = await home.create('unrecorded-child')
      const grandchild = await home.create('unrecorded-grandchild')
      delegate(root, child)
      delegate(child, grandchild)
      root.followup(ask('run the tool'))
      child.followup(ask('run the tool'))
      grandchild.followup(ask('run the tool'))
      await untilAsync(
        async () => ['unrecorded-root', 'unrecorded-child', 'unrecorded-grandchild']
          .every(id => home.blocking.startedId(id)),
        'three tools in flight',
      )

      // The registry refuses that one member: it is rolled back and named, and
      // the press does not report the tree as registered.
      const answer = await home.stop(root)
      expect(answer.kind, answer.text).toBe('error')
      expect(answer.text).toBe('pause could not save the pause for "unrecorded-grandchild";'
        + ' they are still running. Everything else in the tree is paused.')
      expect(await phases(caseRoot)).toEqual({ 'unrecorded-root': 'draining', 'unrecorded-child': 'draining' })

      // The refused member keeps running, and the whole-app report still names
      // it: an unregistered tree member must not vanish from the park's account.
      expect(home.ctx.commands.list(grandchild).map(descriptor => descriptor.definitionId))
        .not.toContain(RESUME_DEFINITION_ID)
      home.blocking.releaseId('unrecorded-root')
      home.blocking.releaseId('unrecorded-child')
      // The whole-app answer is read until it carries the fact, rather than
      // once at a moment a member may still be walking to its park point: what
      // is asserted is what the report settles on.
      await untilAsync(async () => (await home.status(root)).safe === 2, 'the two registered members to park')
      const aggregate = await home.status(root)
      expect(aggregate.stalled).toEqual(['unrecorded-grandchild'])
      expect(aggregate.verdict).toBe('waiting')
    } finally {
      home.blocking.releaseAll()
      await home.ctx.fiber.dispose()
    }
  })

  it('refuses the tree-wide press issued from inside a model turn', async () => {
    const caseRoot = temporaryRoot('dsh-pause-tree-unattended-', temporaryRoots)
    const home = await mountGlobalHome(caseRoot)
    try {
      const root = await home.create('unattended-root')
      const child = await home.create('unattended-child')
      delegate(root, child)

      const refused = await home.ctx.agents.withInitiator(root, () => home.stop(root))
      expect(refused.kind).toBe('error')
      expect(refused.text).toBe(UNATTENDED_TEXT)
      // Nothing was registered on the tree either: the refusal is the whole
      // press, not a note about it.
      expect(await readParkRegistry(storageOf(caseRoot))).toEqual([])
      expect(home.ctx.commands.list(child).map(descriptor => descriptor.definitionId))
        .not.toContain(RESUME_DEFINITION_ID)
    } finally {
      await home.ctx.fiber.dispose()
    }
  })
})
