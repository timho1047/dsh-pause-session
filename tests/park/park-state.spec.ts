/**
 * Task 04 acceptance at the seam the browser uses: after a pause press the
 * control reports what the session is doing, says "safe to close" only once the
 * session is parked AND the session-level flush has resolved, and can be taken
 * back at any point before that.
 *
 * The same read also carries the record's goal opt-out, and the session's own
 * action switches it: a session that stopped CLEANLY has no row on the morning
 * decision list, so this is the only place its next resume can be told not to
 * re-open its goal — the very case where a silent resume spends its rounds.
 *
 * Every spec drives the plugin through the same native entry points the browser
 * half uses: `pauseSession.act` for the buttons, `pauseSession.snapshot` for the
 * state, and `pauseSession.observe` for the transitions the host announces.
 * @module dsh-pause-session/test/park/park-state
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import {
  aggregate, pause, pauseRemote, resume, statusOf, toggleGoal,
} from '../native-driver.ts'
import type { GlobalStatusWire } from '../../src/remote.ts'
import type { ParkPhase, ParkStatus } from '../../src/shared.ts'
import { textResponse } from '../assumptions/fake-provider.ts'
import { mountGatedLoop, until } from '../gate/loop.ts'
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
 * the session's presence in the native snapshot is the pause, and its entry
 * carries the park state as of this read.
 */
async function published(ctx: Context, agent: Agent): Promise<ParkStatus | undefined> {
  return await statusOf(ctx, agent)
}

/** The aggregate as one whole-app snapshot answers it. */
async function status(ctx: Context): Promise<GlobalStatusWire> {
  return await aggregate(ctx)
}

/**
 * Wait for a predicate that is only true once a moving part settles. Written
 * out rather than `vi.waitFor`: that helper does not await an async predicate,
 * so it would pass without ever looking at the answer.
 */
async function settles(predicate: () => boolean, describe: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`pause: never settled: ${describe}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Wait for one exact published phase, re-reading it as we go. */
async function phaseBecomes(ctx: Context, agent: Agent, wanted: ParkStatus['phase']): Promise<void> {
  let seen: string | undefined
  await settles(() => {
    void published(ctx, agent).then(status => { seen = status?.phase })
    return seen === wanted
  }, `phase ${wanted} (last seen: ${String(seen)})`)
}

/**
 * Record every phase the host announces on its native stream for one session.
 * The opening item is the current state; each later item is one notification,
 * which is what a browser's live channel receives.
 */
function observePhases(ctx: Context, agent: Agent): { phases: ParkPhase[]; stop(): Promise<void> } {
  const abort = new AbortController()
  const phases: ParkPhase[] = []
  const done = (async () => {
    try {
      for await (const snapshot of pauseRemote(ctx).observe(abort.signal)) {
        const phase = snapshot.sessions[String(agent.id)]?.phase
        if (phase !== undefined) phases.push(phase)
      }
    } catch {
      // The read was aborted on purpose when the case settled.
    }
  })()
  return {
    phases,
    stop: async () => {
      abort.abort()
      await done
    },
  }
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
    throw new Error(`pause: no live session for "${agent.id}"`)
  }
}

describe('park state: what the control reports between the press and the park', () => {
  it('announces every transition it owns once, so both readings reach safe with no further action', async () => {
    const loop = await mountGatedLoop('park-announce', [
      toolCallResponse('call-1', 'gated', { id: '1' }),
      textResponse('after the tool'),
    ])
    const { ctx, agent } = loop
    const blocking = blockingTool()
    ctx.tools.register(blocking.tool)
    liveSession(loop, agent)
    const flush = heldFlush(ctx)
    const watched = observePhases(ctx, agent)
    try {
      agent.followup(ask('run the tool'))
      await until(() => blocking.started())

      // The press while the tool runs: the session reports what it is doing, and
      // the snapshot's own entry is what a browser reads the pause from. The
      // action's answer is the press's own read; the stream speaks next when the
      // state actually moves.
      await pause(ctx, agent)
      expect(await published(ctx, agent)).toEqual({ phase: 'draining', safe: false, runningTools: ['gated'], rearmGoal: true })
      const atPress = watched.phases.length

      // The drain itself is silent: nothing about the session changes until its
      // tool lands, so the stream owes no item.
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(watched.phases.length, 'a session still draining announced something').toBe(atPress)

      // The tool lands and the session reaches the park point. The state moves,
      // so the host announces it on the same native stream.
      blocking.release()
      await until(() => flush.calls() === 1)
      expect(await published(ctx, agent)).toEqual({ phase: 'parking', safe: false, runningTools: [], rearmGoal: true })
      // The host counts a session at the park point among the ones still on
      // their way — it is not safe yet — and names the flush in `parking`.
      expect(await status(ctx)).toMatchObject({ registered: 1, safe: 0, draining: ['park-announce'], parking: 1 })
      await settles(() => watched.phases.includes('parking'), 'the park point to be announced')
      const atParkPoint = watched.phases.length
      // Exactly one announcement for the transition, not a poll loop.
      expect(watched.phases.filter(phase => phase === 'parking'), 'the park point was not announced exactly once').toHaveLength(1)

      // The flush resolves. That is the transition no registration of its own
      // would ever show, and it is announced like the one before it.
      flush.release()
      await phaseBecomes(ctx, agent, 'safe')
      await settles(() => watched.phases.includes('safe'), 'the flush resolving to be announced')
      expect(watched.phases.filter(phase => phase === 'safe'), 'the flush resolving was not announced exactly once').toHaveLength(1)
      // Both readings are the truth now — the session's own and the aggregate's —
      // and neither took a press, a decision, or any other action to get there.
      // (The verdict also names the surfaces this composition does not mount, so
      // what is asserted here is the count of sessions it calls safe.)
      expect(await published(ctx, agent)).toEqual({ phase: 'safe', safe: true, runningTools: [], rearmGoal: true })
      expect(await status(ctx)).toMatchObject({ registered: 1, safe: 1, draining: [], parking: 0 })

      // A settled park is not announced again: the stream goes quiet with it.
      const atSafe = watched.phases.length
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(watched.phases.length, 'a settled park kept announcing itself').toBe(atSafe)
    } finally {
      blocking.release()
      flush.release()
      await watched.stop()
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

      await pause(ctx, agent)
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

      await resume(ctx, agent)
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
      await pause(ctx, agent)
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
      await pause(ctx, agent)
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
      await pause(ctx, agent)
      await until(() => flush.calls() === 1)

      // Parked, and the checkpoint is still open: the durable promise is not
      // kept yet, so neither phase nor `safe` may say otherwise.
      expect(await published(ctx, agent)).toEqual({ phase: 'parking', safe: false, runningTools: [], rearmGoal: true })
      expect(await published(ctx, agent), 'a parked session disappeared from the snapshot').toBeDefined()

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
    if (held === undefined) throw new Error('pause: this case asked for held registry writes')
    try {
      // The press is a durable promise: it answers only after `draining` is on
      // the medium, and the move to `parking` is the write after that.
      const pressing = pause(ctx, agent)
      await held.untilRequested(1)
      // The action has not answered yet: the park is not durable and cannot be
      // called safe, even though this process already knows what it is doing.
      expect((await published(ctx, agent))?.safe).toBe(false)
      held.release(0)
      await pressing
      await held.untilRequested(2)

      // Standing still, with the write that would record `parking` still in
      // flight. The reply to the press is the last durable phase; a reader must
      // not be told the later one yet.
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
    if (held === undefined) throw new Error('pause: this case asked for held registry writes')
    const target = SessionId('park-vanished-target')
    // A session with a handle: the spec can take it away mid-press, which is
    // what closing a session the user just paused looks like to this plugin.
    const created = await ctx.agents.create({
      sessionId: target,
      agentOptions: { provider: 'fake', model: 'fake' },
    })
    try {
      const pressing = pause(ctx, created.agent).catch(() => {})
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
      expect(await status(ctx)).toMatchObject({
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
      await pause(ctx, agent)
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
      await pause(ctx, agent)
      expect((await published(ctx, agent))?.phase).toBe('draining')

      // Pressed again while the tool is still in flight: the pause is taken
      // back, and nothing about the session is left in a stopped state.
      await resume(ctx, agent)
      expect(await published(ctx, agent)).toBeUndefined()

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
      await pause(ctx, agent)
      await until(() => flush.calls() === 1)
      expect((await published(ctx, agent))?.phase).toBe('parking')

      await resume(ctx, agent)
      expect(await published(ctx, agent)).toBeUndefined()

      // The late completion of that flush must not resurrect the park's
      // published state.
      flush.release()
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(await published(ctx, agent)).toBeUndefined()
    } finally {
      flush.release()
      await ctx.fiber.dispose()
    }
  })
})

describe('the goal opt-out on a session\'s own record', () => {
  it('reports the record\'s opt-out and switches it through the session\'s own action', async () => {
    const loop = await mountGatedLoop('park-goal', [])
    const { ctx, agent } = loop
    liveSession(loop, agent)
    try {
      await pause(ctx, agent)
      await phaseBecomes(ctx, agent, 'safe')
      // The default is the product default: a goal session comes back running
      // its rounds unless its own record says otherwise.
      expect(await published(ctx, agent))
        .toEqual({ phase: 'safe', safe: true, runningTools: [], rearmGoal: true })

      // The switch is the session's own: it names no other session, which is
      // what makes it reachable on a session that stopped CLEANLY — the case
      // the decision list never shows, and the one a silent resume would
      // otherwise spend.
      const switched = await toggleGoal(ctx, agent)
      expect(switched.ok, switched.message).toBe(true)
      // The control shows the host's new answer, and that answer is the
      // record's: the same read that reports the phase reports the switch.
      expect(await published(ctx, agent)).toMatchObject({ rearmGoal: false })

      // A second press reads before it flips, so the button cannot drift from
      // the record it describes.
      await toggleGoal(ctx, agent)
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
      await pause(ctx, agent)
      // The park is still draining, and the record already exists: a user who
      // switches the goal off now must not have it silently reset by the
      // `parking` and `safe` writes that follow.
      expect((await published(ctx, agent))?.phase).toBe('draining')
      await toggleGoal(ctx, agent)
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
})
