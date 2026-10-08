// tests/park/park-crash-child.ts — hard-kill probe for the plugin's own park
// flow. A real agent loop runs over a scripted adapter, the plugin under test
// parks the session, the session-level flush lands, and then this process
// SIGKILLs itself without unwinding anything. The spec re-reads the stored log
// afterwards, so what it asserts is what actually reached the disk.
//
// Usage: node --experimental-transform-types tests/park/park-crash-child.ts <root> <sessionId>
//
// Two scripted responses are consumed on purpose: the first model response
// carries the follow-up the pending message triggers, and the request the loop
// builds for it is HELD at the gate — so that request never reaches the adapter
// and its input can only be in the log because the plugin flushed it.
//
// stdout carries one CRASH_READY line written synchronously, so the parent can
// tell "parked and flushed" from any earlier failure. The wait between looks is
// a real timer, not a microtask-resolving one: polling on `setTimeout(0)` keeps
// the loop's microtask queue busy enough to starve the disk writes the flush is
// waiting on.
//
// The transform-types flag is what lets this child import the spike's scripted
// provider (its constructor uses TypeScript parameter properties). The plugin
// itself is imported from the built entry (`lib/index.js`, built by the spec's
// beforeAll): its own sources use `.js` specifiers for relative imports, which
// Node's type stripping does not resolve.

import { writeSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { apply, inject, name } from 'dsh-safe-stop'
import { FakeProvider } from '../assumptions/fake-provider.ts'
import { textResponse } from '../assumptions/fake-provider.ts'

const [root, rawId] = process.argv.slice(2)
if (root === undefined || rawId === undefined) {
  console.error('usage: park-crash-child.ts <root> <sessionId>')
  process.exit(2)
}
const id = SessionId(rawId)

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
await ctx.plugin(CommandRuntime)
const harness = await mountAgentLoopTestHarness(ctx)
ctx.llm.registerAdapter(['fake'], new FakeProvider([textResponse('first answer'), textResponse('held answer')]))
const agent = await harness.create(id, { provider: 'fake', model: 'fake' })
await ctx.plugin({ name, inject, apply })

// Park the session, then hand it one more message: the loop opens a turn for
// it, builds the request, and stops at the gate with that input still pending.
const pause = await ctx.commands.execute(agent, '/safe-stop', [], new AbortController().signal)
if (pause?.result.kind !== 'success') throw new Error('child: pause did not succeed')
agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'pending while parked' }],
  source: { kind: 'user' },
}))

// Wait for the session to report safe, read the same way the browser does.
const statusDefinitionId = 'dsh-safe-stop/status'
const resumeDefinitionId = 'dsh-safe-stop/resume'
for (let attempt = 0; attempt < 4000; attempt++) {
  const listed = ctx.commands.list(agent)
  if (listed.some(descriptor => descriptor.definitionId === resumeDefinitionId)) {
    const status = await ctx.commands.execute(agent, '/safe-state', [], new AbortController().signal)
    const text = status?.result.kind === 'success' ? status.result.text : undefined
    if (text?.includes('safe to close') === true) {
      writeSync(1, `CRASH_READY ${text}\n`)
      process.kill(process.pid, 'SIGKILL')
    }
  }
  await new Promise(resolve => setTimeout(resolve, 10))
}
throw new Error('child: the session never reported safe to close')
