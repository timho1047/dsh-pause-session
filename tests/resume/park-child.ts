// tests/resume/park-child.ts — one process of the resume proof: it runs the
// real stack, parks a session the way the plugin's own pause flow does, and
// SIGKILLs itself without unwinding. Whatever is left on disk is the whole
// input to the parent, which mounts the plugin in a fresh context and resumes
// from it.
//
// Usage: node --experimental-transform-types tests/resume/park-child.ts \
//          <storageRoot> <sessionRoot> <sessionId> <mode> <route>
//
// Modes, each ending in the durable park outcome the parent needs:
//   clean        paused at the gate with an input the model still owes an
//                answer to; the request the loop built is what the parent's
//                resumed request is compared against on the wire.
//   goal         a live goal, one ordinary turn finished, then parked with
//                nothing pending.
//   tool-result  paused with a tool in flight, which then finished, so the
//                request standing at the gate is the one that answers the tool
//                results — the park point the whole gate exists for.
//   draining     paused while a tool is in flight, so the park never finished.
//   parking      paused and standing still, with the session-level flush still
//                open, so the durable promise is not kept either.
//   flush-failed paused, but the session-level flush failed.
//
// stdout carries one RESUME_READY line written synchronously, with the parked
// session's phase and — for `clean` — the request that was standing at the
// gate, so the parent can compare the wire payload it produces after resuming.
// The wait between looks is a real timer, not a microtask-resolving one:
// polling on `setTimeout(0)` keeps the loop's microtask queue busy enough to
// starve the disk writes the flush is waiting on.
//
// The plugin comes from the BUILT entry (`lib/index.js`, built by the spec's
// beforeAll): its own sources use `.js` specifiers for relative imports, which
// Node's type stripping does not resolve. The transform-types flag is what lets
// this child import the spike's scripted provider.

import { writeSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { apply, inject, name } from 'dsh-safe-stop'
import { FakeProvider, textResponse } from '../assumptions/fake-provider.ts'
import { mountParkStorage } from '../registry/storage.ts'
import { GOAL_OBJECTIVE, PENDING_INPUT } from './case.ts'
import type { ParkMode } from './case.ts'

const [registryRoot, sessionRoot, rawId, rawMode, route = 'deepseek-official'] = process.argv.slice(2)
if (registryRoot === undefined || sessionRoot === undefined || rawId === undefined || rawMode === undefined) {
  console.error('usage: park-child.ts <storageRoot> <sessionRoot> <sessionId> <mode> <route>')
  process.exit(2)
}
const id = SessionId(rawId)
const mode = rawMode as ParkMode

/** One assistant response carrying a single tool call. */
function toolCallResponse(callId: string, toolName: string, args: object): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(callId), name: toolName, arguments: JSON.stringify(args) } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' })
await ctx.plugin(CommandRuntime)
await mountParkStorage(ctx, registryRoot)
// Mounted before the agent exists: the goal projection has to be registered
// while the session that will carry the goal is still being created.
if (mode === 'goal') await ctx.plugin(GoalService)
const harness = await mountAgentLoopTestHarness(ctx)

const provider = new FakeProvider(mode === 'draining' || mode === 'tool-result'
  ? [toolCallResponse('call-1', 'gated', { id: '1' }), textResponse('after the tool'), textResponse('woken answer')]
  : [textResponse('first answer'), textResponse('held answer'), textResponse('woken answer')])
ctx.llm.registerAdapter([route], provider)
const agent = await harness.create(id, { provider: route, model: 'model' })

// Upstream of the gate: the request is recorded when the loop builds it, not
// when the gate releases it, which is what makes the parked request readable.
const seen: GenerateOptions[] = []
ctx.on('llm/stream', (request, next) => {
  seen.push(request)
  return next()
})

let toolStarted = false
let releaseTool: () => void = () => {}
/** Set when the park's own session-level checkpoint is entered. */
let flushEntered = false
if (mode === 'draining' || mode === 'tool-result') {
  ctx.tools.register(defineContentToolFixture({
    name: 'gated',
    description: 'blocks until the child lets it finish',
    parameters: { id: { type: 'string', required: true } },
    async execute() {
      toolStarted = true
      await new Promise<void>((resolve) => { releaseTool = resolve })
      return [{ type: 'text', text: 'tool done' }]
    },
  }))
}
if (mode === 'flush-failed') {
  ctx.effect(() => ctx.on('session/flush', () => Promise.reject(new Error('disk full'))), 'child: failing flush')
}
if (mode === 'parking') {
  // A checkpoint that never resolves: the park reaches "standing still, flush
  // pending" and stays there until this process dies. The plugin records that
  // phase before it dispatches this checkpoint, so entering the peer is the
  // signal that the durable record says `parking`.
  ctx.effect(() => ctx.on('session/flush', () => {
    flushEntered = true
    return new Promise<void>(() => {})
  }), 'child: held flush')
}

await ctx.plugin({ name, inject, apply })

const signal = new AbortController().signal

/** Press the pause verb the way the browser half does. */
async function pause(): Promise<void> {
  const pressed = await ctx.commands.execute(agent, '/safe-stop', [], signal)
  if (pressed?.result.kind !== 'success') {
    throw new Error(`child: pause did not succeed: ${JSON.stringify(pressed?.result)}`)
  }
}

/** The park state the browser reads, as of this read. */
async function phase(): Promise<string | undefined> {
  const listed = ctx.commands.list(agent)
  if (!listed.some(descriptor => descriptor.definitionId === 'dsh-safe-stop/resume')) return undefined
  const status = await ctx.commands.execute(agent, '/safe-state', [], signal)
  return status?.result.kind === 'success' ? status.result.text : undefined
}

async function until(predicate: () => boolean, describe: string): Promise<void> {
  for (let attempt = 0; attempt < 4000; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`child: never saw ${describe}`)
}

async function untilPhase(wanted: string): Promise<void> {
  for (let attempt = 0; attempt < 4000; attempt++) {
    if ((await phase())?.includes(wanted) === true) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`child: the session never reported "${wanted}"`)
}

if (mode === 'clean') {
  // Pressed while idle, then handed the input: the park point is the request
  // the loop builds for that input, and the record's outcome is the park's.
  await pause()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: PENDING_INPUT }], source: { kind: 'user' } }))
  await until(() => seen.length === 1, 'the request standing at the gate')
  await untilPhase('safe to close')
} else if (mode === 'goal') {
  ctx.goals.create(agent, { objective: GOAL_OBJECTIVE })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start the work' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await pause()
  await untilPhase('safe to close')
} else if (mode === 'tool-result') {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the tool' }], source: { kind: 'user' } }))
  await until(() => toolStarted, 'the tool in flight')
  await pause()
  // The tool finishes only now, so the request the loop builds next is the one
  // the gate catches: the park point with the tool's results already in hand.
  releaseTool()
  await until(() => seen.length === 2, 'the request answering the tool results')
  await untilPhase('safe to close')
} else if (mode === 'draining') {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the tool' }], source: { kind: 'user' } }))
  await until(() => toolStarted, 'the tool in flight')
  await pause()
  await untilPhase('draining')
} else if (mode === 'parking') {
  await pause()
  await until(() => flushEntered, 'the park checkpoint to be dispatched')
} else {
  await pause()
  await untilPhase('could not flush')
}

// The park flush covered the session as it stood at the park point; this child
// dies without unwinding, so anything appended after that point is made
// durable here rather than left to the process that will never come back. The
// modes that are about a park that did NOT complete have nothing to make
// durable — one has a tool in flight, the other a flush that always fails.
if (mode === 'clean' || mode === 'goal' || mode === 'tool-result') await ctx.sessions.flush(agent.session)

const held = mode === 'tool-result' ? seen[1] : seen[0]
const request = held === undefined ? undefined : {
  provider: held.provider,
  model: held.model,
  system: held.system,
  messages: held.messages,
  tools: held.tools,
  sessionId: held.sessionId,
  purpose: held.purpose,
  reasoningEffort: held.reasoningEffort,
  maxTokens: held.maxTokens,
}
writeSync(1, `RESUME_READY ${JSON.stringify({ sessionId: rawId, mode, route, request })}\n`)
process.kill(process.pid, 'SIGKILL')
