// tests/registry/restart-child.ts — one process of the restart proof: it runs
// the real stack, parks a session, lets the plugin flush it, and then either
// SIGKILLs itself or exits cleanly. Whatever it leaves behind is the whole
// input to the parent's fresh process, which must re-apply the pause from the
// registry alone.
//
// Usage: node --experimental-transform-types tests/registry/restart-child.ts \
//          <storageRoot> <sessionRoot> <sessionId> <kill|exit>
//
// stdout carries one RESTART_READY line written synchronously once the session
// reports "safe to close" — i.e. once the parked state is durable on both
// media — so the parent can tell that state from any earlier failure. The wait
// between looks is a real timer, not a microtask-resolving one: polling on
// `setTimeout(0)` keeps the loop's microtask queue busy enough to starve the
// disk writes the flush is waiting on.
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
import { FakeProvider, textResponse } from '../assumptions/fake-provider.ts'
import { mountParkStorage } from './storage.ts'

const [registryRoot, sessionRoot, rawId, mode] = process.argv.slice(2)
if (registryRoot === undefined || sessionRoot === undefined || rawId === undefined) {
  console.error('usage: restart-child.ts <storageRoot> <sessionRoot> <sessionId> <kill|exit>')
  process.exit(2)
}
const id = SessionId(rawId)

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' })
await ctx.plugin(CommandRuntime)
// The registry lives under its own root, beside the session logs rather than in
// them: the parent asserts the pause outlives the process without being part of
// any session's history.
await mountParkStorage(ctx, registryRoot)
const harness = await mountAgentLoopTestHarness(ctx)
ctx.llm.registerAdapter(['fake'], new FakeProvider([textResponse('first answer'), textResponse('held answer')]))
const agent = await harness.create(id, { provider: 'fake', model: 'fake' })
await ctx.plugin({ name, inject, apply })

// Park the session, then hand it one more message: the loop opens a turn for
// it, builds the request, and stops at the gate with that input still pending.
const pause = await ctx.commands.execute(agent, '/safe-stop', [], new AbortController().signal)
if (pause?.result.kind !== 'success') {
  throw new Error(`child: pause did not succeed: ${JSON.stringify(pause?.result)}`)
}
agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'delivered while parked' }],
  source: { kind: 'schedule' },
}))

// Wait for the session to report safe, read the same way the browser does: the
// resume definition is the pause, and the status command answers with the phase
// as of the read.
const resumeDefinitionId = 'dsh-safe-stop/resume'
for (let attempt = 0; attempt < 4000; attempt++) {
  const listed = ctx.commands.list(agent)
  if (listed.some(descriptor => descriptor.definitionId === resumeDefinitionId)) {
    const status = await ctx.commands.execute(agent, '/safe-state', [], new AbortController().signal)
    const text = status?.result.kind === 'success' ? status.result.text : undefined
    if (text?.includes('safe to close') === true) {
      writeSync(1, `RESTART_READY ${text}\n`)
      if (mode === 'kill') process.kill(process.pid, 'SIGKILL')
      await ctx.fiber.dispose()
      writeSync(1, 'RESTART_CLEAN_EXIT\n')
      process.exit(0)
    }
  }
  await new Promise(resolve => setTimeout(resolve, 10))
}
throw new Error('child: the session never reported safe to close')
