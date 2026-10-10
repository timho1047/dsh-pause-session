/**
 * Task 04 acceptance at the seam the browser uses: after a pause press the
 * control reports what the session is doing, says "safe to close" only once the
 * session is parked AND the session-level flush has resolved, and can be taken
 * back at any point before that.
 *
 * The same read also carries the record's goal opt-out, and the session's own
 * verb switches it: a session that stopped CLEANLY has no row on the morning
 * decision list, so this is the only place its next resume can be told not to
 * re-open its goal — the very case where a silent resume spends its rounds.
 *
 * Every spec drives the plugin through the same host entry points the browser
 * half uses — `ctx.commands.execute` on the real registry, plus `commands.list`
 * to see what the host published.
 * @module dsh-safe-stop/test/park/park-state
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { UNATTENDED_TEXT } from '../../src/control.ts'
import {
  decodeGlobalStatus, decodeParkStatus, GOAL_COMMAND, PAUSE_COMMAND, RESUME_COMMAND, RESUME_DEFINITION_ID,
  STATE_ALL_COMMAND, STATUS_COMMAND, STATUS_DEFINITION_ID,
} from '../../src/shared.ts'
import type { GlobalStatus, ParkStatus } from '../../src/shared.ts'
import { textResponse } from '../assumptions/fake-provider.ts'
import { control, mountGatedLoop, until } from '../gate/loop.ts'
import type { GatedLoop } from '../gate/loop.ts'

const ask = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

/** One assistant response carrying a single tool call. */
function toolCallResponse(id: string, name: string, args: object): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) },
    },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * What the host published about one session, read the way the browser reads it:
 * the resume definition's presence is the pause, and the companion status
 * command answers with the park state as of this read.
 */
async function published(ctx: Context, agent: Agent): Promise<ParkStatus | undefined> {
  const listed = ctx.commands.list(agent)
  if (!listed.some(descriptor => descriptor.definitionId === RESUME_DEFINITION_ID)) return undefined
  const execution = await ctx.commands.execute(agent, `/${STATUS_COMMAND}`, [], new AbortController().signal)
  if (execution === undefined) throw new Error('safe-stop: the status command is not registered')
  if (execution.result.kind !== 'success') throw new Error(`safe-stop: status read failed: ${execution.result.text}`)
  const text = execution.result.text
  const decoded = text === undefined ? undefined : decodeParkStatus(text)
  if (decoded === undefined) throw new Error(`safe-stop: status read answered in an unknown vocabulary: ${String(text)}`)
  return decoded
}

/** Run one control command and hand back its answer, refusals included. */
async function answer(ctx: Context, agent: Agent, command: string): Promise<CommandResult> {
  const execution = await ctx.commands.execute(agent, `/${command}`, [], new AbortController().signal)
  if (execution === undefined) throw new Error(`safe-stop: /${command} is not registered for "${agent.id}"`)
  return execution.result
}

/**
 * Wait for a predicate that is only true once a moving part settles. Written
 * out rather than `vi.waitFor`: that helper does not await an async predicate,
 * so it would pass without ever looking at the answer.
 */
async function settles(predicate: () => boolean, describe: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`safe-stop: never settled: ${describe}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The status descriptor the browser would see, if any. */
function statusDescriptor(ctx: Context, agent: Agent): { definitionId?: string } | undefined {
  return ctx.commands.list(agent).find(descriptor => descriptor.definitionId === STATUS_DEFINITION_ID)
}

/**
 * The aggregate as one whole-app read answers it, so a case can watch the
 * control's own claim rather than the per-session one beside it.
 */
async function aggregate(ctx: Context, agent: Agent): Promise<GlobalStatus> {
  const execution = await ctx.commands.execute(agent, `/${STATE_ALL_COMMAND}`, [], new AbortController().signal)
  const text = execution?.result.kind === 'success' ? execution.result.text : undefined
  const decoded = text === undefined ? undefined : decodeGlobalStatus(text)
  if (decoded === undefined) throw new Error(`safe-stop: the aggregate answered in an unknown vocabulary: ${String(text)}`)
  return decoded
}

/** Wait for one exact published phase, re-reading it as we go. */
async function phaseBecomes(ctx: Context, agent: Agent, wanted: ParkStatus['phase']): Promise<void> {
  let seen: string | undefined
  await settles(() => {
    void published(ctx, agent).then(status => { seen = status?.phase })
    return seen === wanted
  }, `phase ${wanted} (last seen: ${String(seen)})`)
}

/** A tool that blocks until the spec releases it, so "in flight" is a controlled fact. */
function blockingTool(): { tool: ReturnType<typeof defineContentToolFixture>; started: () => boolean; release: () => void } {
  let release: () => void = () => {}
  let started = false
  const tool = defineContentToolFixture({
    name: 'gated',
    description: 'blocks until the spec releases it',
    parameters: { id: { type: 'string', required: true } },
    async execute() {
      started = true
      await new Promise<void>((resolve) => { release = resolve })
      return [{ type: 'text', text: 'tool done' }]
    },
  })
  return { tool, started: () => started, release: () => { release() } }
}

/** A durability peer that holds every checkpoint open until the spec lets go. */
function heldFlush(ctx: Context): { calls: () => number; release: () => void } {
  let release: () => void = () => {}
  let calls = 0
  const flushing = new Promise<void>((resolve) => { release = resolve })
  ctx.effect(() => ctx.on('session/flush', async () => {
    calls += 1
    await flushing
  }), 'spec: slow flush')
  return { calls: () => calls, release }
}

/**
 * The live session behind an agent. A spec that installs a flush peer must take
 * one: `ctx.sessions.flush` is the only entry point that reaches it, so holding
 * the peer is what tells us the plugin came through the session level rather
 * than through a handle's own flush.
 */
function liveSession(loop: GatedLoop, agent: Agent): void {
  if (loop.ctx.sessions.get(agent.id) === undefined) {
    throw new Error(`safe-stop: no live session for "${agent.id}"`)
  }
}

describe('park state: what the control reports between the press and the park', () => {
  it('announces every phase transition once, so both readings reach safe with no further action', async () => {
    const loop = await mountGatedLoop('park-announce', [
      toolCallResponse('call-1', 'gated', { id: '1' }),
      textResponse('after the tool'),
    ])
    const { ctx, agent } = loop
    const blocking = blockingTool()
    ctx.tools.register(blocking.tool)
    liveSession(loop, agent)
    const flush = heldFlush(ctx)
    /** Every `commands/change` the host emits, which is the only live channel a client has. */
    let changes = 0
    ctx.on('commands/change', () => { changes += 1 })
    try {
      agent.followup(ask('run the tool'))
      await until(() => blocking.started())

      // The press while the tool runs: the session reports what it is doing, and
      // the marker set it publishes is what a browser reads the pause from.
      await control(ctx, agent, PAUSE_COMMAND)
      expect(await published(ctx, agent)).toEqual({ phase: 'draining', safe: false, runningTools: ['gated'], rearmGoal: true })
      expect(changes, 'the press published no marker').toBeGreaterThan(0)
      const atPress = changes

      // The drain itself is silent, and that is not a gap: the press's own read
      // answered this phase, and the next one announces itself below.
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(changes, 'a session still draining announced something').toBe(atPress)

      // The tool lands and the session reaches the park point. Nothing about the
      // registration changed — the markers were published at the press — so this
      // transition is exactly what the announcement exists for.
      blocking.release()
      await until(() => flush.calls() === 1)
      expect(await published(ctx, agent)).toEqual({ phase: 'parking', safe: false, runningTools: [], rearmGoal: true })
      // The host counts a session at the park point among the ones still on
      // their way — it is not safe yet — and names the flush in `parking`.
      expect(await aggregate(ctx, agent)).toMatchObject({ registered: 1, safe: 0, draining: ['park-announce'], parking: 1 })
      const atParkPoint = changes
      // One unregistration and one registration of the status verb: the pair is
      // one announcement, which is what a client's coalescing window turns into
      // one read.
      expect(atParkPoint - atPress, 'the park point was not announced exactly once').toBe(2)

      // The flush resolves. That is the transition no registration of its own
      // would ever show, and it is announced like the one before it.
      flush.release()
      await phaseBecomes(ctx, agent, 'safe')
      expect(changes - atParkPoint, 'the flush resolving was not announced exactly once').toBe(2)
      // Both readings are the truth now — the session's own and the aggregate's —
      // and neither took a press, a decision, or any other action to get there.
      // (The verdict also names the surfaces this composition does not mount, so
      // what is asserted here is the count of sessions it calls safe.)
      expect(await published(ctx, agent)).toEqual({ phase: 'safe', safe: true, runningTools: [], rearmGoal: true })
      expect(await aggregate(ctx, agent)).toMatchObject({ registered: 1, safe: 1, draining: [], parking: 0 })

      // A settled park is not announced again: the channel goes quiet with it.
      const atSafe = changes
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(changes, 'a settled park kept announcing itself').toBe(atSafe)
    } finally {
      blocking.release()
      flush.release()
      await ctx.fiber.dispose()
    }
  })

  it('reports the running tool, then parks once its result lands and the next request is held', async () => {
    const loop = await mountGatedLoop('park-tool', [
      toolCallResponse('call-1', 'gated', { id: '1' }),
      textResponse('after the tool'),
    ])
    const { ctx, provider, agent } = loop
    const blocking = blockingTool()
    ctx.tools.register(blocking.tool)
    liveSession(loop, agent)
    const flush = heldFlush(ctx)
    try {
      agent.followup(ask('run the tool'))
      await until(() => blocking.started())

      await control(ctx, agent, PAUSE_COMMAND)
      expect(await published(ctx, agent)).toEqual({ phase: 'draining', safe: false, runningTools: ['gated'], rearmGoal: true })
      // Only the response that asked for the tool has been sent; the request
      // that follows the tool is not built yet, let alone sent.
      expect(provider.requests).toHaveLength(1)

      // The tool's result lands; the loop builds its next request and stops at
      // the gate. That — and only that — is the park.
      blocking.release()
      await loop.requestSeen(1)
      await until(() => flush.calls() === 1)
      expect(await published(ctx, agent)).toEqual({ phase: 'parking', safe: false, runningTools: [], rearmGoal: true })
      // Nothing was sent while the session was on its way to the park.
      expect(provider.requests).toHaveLength(1)

      flush.release()
      await phaseBecomes(ctx, agent, 'safe')

      await control(ctx, agent, RESUME_COMMAND)
      await agent.whenIdle()
      expect(provider.requests).toHaveLength(2)
    } finally {
      blocking.release()
      flush.release()
      await ctx.fiber.dispose()
    }
  })

  it('reports safe when the drain ends without another request to hold', async () => {
    const loop = await mountGatedLoop('park-decided', [toolCallResponse('call-1', 'gated', { id: '1' })])
    const { ctx, provider, agent } = loop
    let started = false
    let release: () => void = () => {}
    ctx.tools.register(defineContentToolFixture({
      name: 'gated',
      description: 'blocks until the spec releases it',
      parameters: { id: { type: 'string', required: true } },
      async execute() {
        started = true
        await new Promise<void>((resolve) => { release = resolve })
        return [{ type: 'text', text: 'tool done' }]
      },
    }))
    try {
      agent.followup(ask('run the tool'))
      await until(() => started)
      await control(ctx, agent, PAUSE_COMMAND)
      expect((await published(ctx, agent))?.phase).toBe('draining')

      // The turn is cancelled, so it ends without ever building another
      // request. Nothing is left to hold and the session is standing still — a
      // control waiting for a hold that can never come would claim "draining"
      // forever, which is exactly the lie this predicate exists to avoid.
      release()
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      await phaseBecomes(ctx, agent, 'safe')
      expect(provider.requests).toHaveLength(1)
    } finally {
      release()
      await ctx.fiber.dispose()
    }
  })

  it('parks an idle session with nothing to drain', async () => {
    const loop = await mountGatedLoop('park-idle', [])
    const { ctx, agent } = loop
    liveSession(loop, agent)
    const flush = heldFlush(ctx)
    try {
      // No turn is open, so there is no next request to hold: the press has
      // nothing to wait for, and the only remaining gate is the flush.
      await control(ctx, agent, PAUSE_COMMAND)
      await until(() => flush.calls() === 1)
      expect(await published(ctx, agent)).toEqual({ phase: 'parking', safe: false, runningTools: [], rearmGoal: true })

      flush.release()
      await phaseBecomes(ctx, agent, 'safe')
    } finally {
      flush.release()
      await ctx.fiber.dispose()
    }
  })

  it('never reports "safe" before the session-level flush resolves', async () => {    const loop = await mountGatedLoop('park-flush', [])
    const { ctx, agent } = loop
    liveSession(loop, agent)
    const flush = heldFlush(ctx)
    try {
      await control(ctx, agent, PAUSE_COMMAND)
      await until(() => flush.calls() === 1)

      // Parked, and the checkpoint is still open: the durable promise is not
      // kept yet, so neither phase nor `safe` may say otherwise.
      expect(await published(ctx, agent)).toEqual({ phase: 'parking', safe: false, runningTools: [], rearmGoal: true })
      expect(statusDescriptor(ctx, agent)).toBeDefined()

      flush.release()
      await phaseBecomes(ctx, agent, 'safe')
    } finally {
      flush.release()
      await ctx.fiber.dispose()
    }
  })

  it('publishes a phase only once the registry has recorded it', async () => {
    const loop = await mountGatedLoop('park-durable', [], { heldWrites: true })
    const { ctx, agent } = loop
    liveSession(loop, agent)
    const held = loop.held
    if (held === undefined) throw new Error('safe-stop: this case asked for held registry writes')
    try {
      // The press is a durable promise: it answers only after `draining` is on
      // the medium, and the move to `parking` is the write after that.
      const pressing = control(ctx, agent, PAUSE_COMMAND)
      await held.untilRequested(1)
      expect(await published(ctx, agent)).toBeUndefined()
      held.release(0)
      await pressing
      await held.untilRequested(2)

      // Standing still, with the write that would record `parking` still in
      // flight. What the browser can read is the last phase the registry
      // confirmed: an answer that ran ahead of the record would claim a park
      // that a crash at this instant erases.
      expect(await published(ctx, agent)).toEqual({ phase: 'draining', safe: false, runningTools: [], rearmGoal: true })

      held.release(1)
      await phaseBecomes(ctx, agent, 'parking')
      held.release(2)
      await phaseBecomes(ctx, agent, 'safe')
    } finally {
      // A case that fails before releasing must not leave the plugin's writes
      // queued behind it.
      held.release(0)
      held.release(1)
      held.release(2)
      await ctx.fiber.dispose()
    }
  })

  it('never records "safe" for a session that left the store before its flush', async () => {
    const loop = await mountGatedLoop('park-vanished', [], { heldWrites: true })
    const { ctx } = loop
    const held = loop.held
    if (held === undefined) throw new Error('safe-stop: this case asked for held registry writes')
    const target = SessionId('park-vanished-target')
    // A session with a handle: the spec can take it away mid-press, which is
    // what closing a session the user just paused looks like to this plugin.
    const created = await ctx.agents.create({
      sessionId: target,
      agentOptions: { provider: 'fake', model: 'fake' },
    })
    try {
      const pressing = control(ctx, created.agent, PAUSE_COMMAND).catch(() => {})
      await held.untilRequested(1)
      // The session leaves the store while the press is still recording itself.
      await created.dispose()
      held.release(0)
      await pressing
      await until(() => held.requested.length >= 2)

      // The park point was reached with nothing live behind it. There is no
      // session to flush, so this process cannot call the session clean: the
      // record may only say that it stood still and the flush never happened.
      expect(held.requested.map(entry => (entry.value as { phase: string }).phase))
        .toEqual(['draining', 'parking'])

      // And the report says the same: this session will not finish parking in
      // this process, which is a fact the user is owed rather than a "still
      // finishing" that never ends.
      const answered = await ctx.commands.execute(loop.agent, '/safe-state-all', [], new AbortController().signal)
      const text = answered?.result.kind === 'success' ? answered.result.text : undefined
      expect(text === undefined ? undefined : decodeGlobalStatus(text)).toMatchObject({
        verdict: 'waiting',
        registered: 1,
        safe: 0,
        draining: [],
        stalled: ['park-vanished-target'],
      })
    } finally {
      // A case that fails before releasing must not leave the plugin's writes
      // queued behind it.
      held.release(0)
      held.release(1)
      held.release(2)
      await ctx.fiber.dispose()
    }
  })

  it('reports a failed flush instead of calling the session clean', async () => {    const loop = await mountGatedLoop('park-flush-failed', [])
    const { ctx, agent } = loop
    liveSession(loop, agent)
    // A durability peer whose checkpoint always fails. A failed flush is the
    // one case where "parked" and "safe to close" must not be the same answer.
    ctx.effect(() => ctx.on('session/flush', () => Promise.reject(new Error('disk full'))), 'spec: failing flush')
    try {
      await control(ctx, agent, PAUSE_COMMAND)
      await phaseBecomes(ctx, agent, 'flush-failed')
      expect(await published(ctx, agent)).toEqual({ phase: 'flush-failed', safe: false, runningTools: [], rearmGoal: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('cancels a pause while its tool is still in flight and lets the request through', async () => {
    const loop = await mountGatedLoop('park-cancel', [
      toolCallResponse('call-1', 'gated', { id: '1' }),
      textResponse('after the tool'),
    ])
    const { ctx, provider, agent } = loop
    const blocking = blockingTool()
    ctx.tools.register(blocking.tool)
    try {
      agent.followup(ask('run the tool'))
      await until(() => blocking.started())
      await control(ctx, agent, PAUSE_COMMAND)
      expect((await published(ctx, agent))?.phase).toBe('draining')

      // Pressed again while the tool is still in flight: the pause is taken
      // back, and nothing about the session is left in a stopped state.
      await control(ctx, agent, RESUME_COMMAND)
      expect(await published(ctx, agent)).toBeUndefined()
      expect(ctx.commands.list(agent).map(descriptor => descriptor.name)).not.toContain(RESUME_COMMAND)

      blocking.release()
      await agent.whenIdle()
      // The request that would have been held was issued normally.
      expect(provider.requests).toHaveLength(2)
      expect(agent.status).toBe('idle')
    } finally {
      blocking.release()
      await ctx.fiber.dispose()
    }
  })

  it('cancels a pause whose flush is still settling', async () => {
    const loop = await mountGatedLoop('park-cancel-flush', [])
    const { ctx, agent } = loop
    liveSession(loop, agent)
    const flush = heldFlush(ctx)
    try {
      // An idle session parks at once and starts flushing; the pause is taken
      // back while that checkpoint is still open.
      await control(ctx, agent, PAUSE_COMMAND)
      await until(() => flush.calls() === 1)
      expect((await published(ctx, agent))?.phase).toBe('parking')

      await control(ctx, agent, RESUME_COMMAND)
      expect(await published(ctx, agent)).toBeUndefined()

      // The late completion of that flush must not resurrect the park's
      // published state.
      flush.release()
      await settles(
        () => !ctx.commands.list(agent).some(descriptor => descriptor.definitionId === RESUME_DEFINITION_ID),
        'the late flush must not re-register the park commands',
      )
      expect(await published(ctx, agent)).toBeUndefined()
    } finally {
      flush.release()
      await ctx.fiber.dispose()
    }
  })
})

describe('the goal opt-out on a session\'s own record', () => {
  it('reports the record\'s opt-out and switches it through the session\'s own verb', async () => {
    const loop = await mountGatedLoop('park-goal', [])
    const { ctx, agent } = loop
    liveSession(loop, agent)
    try {
      await control(ctx, agent, PAUSE_COMMAND)
      await phaseBecomes(ctx, agent, 'safe')
      // The default is the product default: a goal session comes back running
      // its rounds unless its own record says otherwise.
      expect(await published(ctx, agent))
        .toEqual({ phase: 'safe', safe: true, runningTools: [], rearmGoal: true })

      // The switch is the session's own: it names no other session, which is
      // what makes it reachable on a session that stopped CLEANLY — the case
      // the decision list never shows, and the one a silent resume would
      // otherwise spend.
      const switched = await answer(ctx, agent, GOAL_COMMAND)
      expect(switched.kind, switched.text).toBe('success')
      // The control shows the host's new answer, and that answer is the
      // record's: the same read that reports the phase reports the switch.
      expect(await published(ctx, agent)).toMatchObject({ rearmGoal: false })

      // A second press reads before it flips, so the button cannot drift from
      // the record it describes.
      await control(ctx, agent, GOAL_COMMAND)
      expect(await published(ctx, agent)).toMatchObject({ rearmGoal: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the opt-out through every phase the record walks afterwards', async () => {
    const loop = await mountGatedLoop('park-goal-phases', [
      toolCallResponse('call-1', 'gated', { id: '1' }),
      textResponse('after the tool'),
    ])
    const { ctx, agent } = loop
    const blocking = blockingTool()
    ctx.tools.register(blocking.tool)
    liveSession(loop, agent)
    try {
      agent.followup(ask('run the tool'))
      await until(() => blocking.started())
      await control(ctx, agent, PAUSE_COMMAND)
      // The park is still draining, and the record already exists: a user who
      // switches the goal off now must not have it silently reset by the
      // `parking` and `safe` writes that follow.
      expect((await published(ctx, agent))?.phase).toBe('draining')
      await control(ctx, agent, GOAL_COMMAND)
      expect(await published(ctx, agent)).toMatchObject({ phase: 'draining', rearmGoal: false })

      blocking.release()
      await phaseBecomes(ctx, agent, 'safe')
      expect(await published(ctx, agent))
        .toEqual({ phase: 'safe', safe: true, runningTools: [], rearmGoal: false })
    } finally {
      blocking.release()
      await ctx.fiber.dispose()
    }
  })

  it('refuses the goal switch issued from inside a model turn', async () => {
    const loop = await mountGatedLoop('park-goal-unattended', [])
    const { ctx, agent } = loop
    liveSession(loop, agent)
    try {
      await control(ctx, agent, PAUSE_COMMAND)
      await phaseBecomes(ctx, agent, 'safe')

      // The switch changes durable state, and the record it changes decides
      // what the next resume spends; a model must not be able to flip it, even
      // though the verb names no session but its own.
      const refused = await ctx.agents.withInitiator(agent, () => answer(ctx, agent, GOAL_COMMAND))
      expect(refused.kind).toBe('error')
      expect(refused.text).toBe(UNATTENDED_TEXT)
      expect(await published(ctx, agent)).toMatchObject({ rearmGoal: true })

      // A person's channel is what it is for, and it still works after the
      // refusal.
      const allowed = await answer(ctx, agent, GOAL_COMMAND)
      expect(allowed.kind, allowed.text).toBe('success')
      expect(await published(ctx, agent)).toMatchObject({ rearmGoal: false })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
