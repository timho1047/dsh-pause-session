/**
 * Shared mounting for the assumption probes: a real agent loop (the harness's
 * own testkit) over the scripted fake provider, with no persistence and no
 * network.
 * @module dsh-safe-stop/test/assumptions/loop-harness
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { FakeProvider } from './fake-provider.ts'
import type { ScriptEntry } from './fake-provider.ts'

/** One mounted loop plus its fake provider, owned by the caller's context. */
export interface FakeLoop {
  readonly ctx: Context
  readonly provider: FakeProvider
  readonly agent: Agent
}

/** Mount the prerequisite services, the real AgentLoop, and one agent on the fake route. */
export async function mountFakeLoop(
  id: string,
  script: ScriptEntry[],
  options: { idleTimeoutMs?: number; agentOptions?: Partial<AgentOptions> } = {},
): Promise<FakeLoop> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  const provider = new FakeProvider(script, options.idleTimeoutMs)
  ctx.llm.registerAdapter(['fake'], provider)
  const agent = await harness.create(SessionId(id), {
    provider: 'fake',
    model: 'fake',
    ...options.agentOptions,
  })
  return { ctx, provider, agent }
}
