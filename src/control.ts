/**
 * The session control the browser half drives: one host round-trip, plus the
 * live state channel that accompanies it.
 *
 * A third-party plugin can add neither a `ctx.remote` namespace nor a forwarded
 * event: the Client's Remote namespaces and the forwarded-event allowlist are
 * compiled into the harness's own API assembly. The documented Client-callable
 * Host entry point is therefore a session command run through
 * `ctx.remote.commands.execute` (plugin-development `references/user-actions.md`),
 * and the one live channel such a plugin can publish through is the command
 * registry itself — `commands/change` is a forwarded event, and
 * `commands.list(sessionId)` is a Client-callable read.
 *
 * So the resume definition IS the paused marker: it is registered on a paused
 * session's own agent context and removed on resume. The browser half reads
 * "paused" from a fact the host commits, and never invents it. The pause verb
 * stays global, so pressing pause twice, or pressing it on a session whose
 * state the browser has not refreshed yet, is idempotent rather than an
 * admission miss.
 * @module dsh-safe-stop/control
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type {} from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PauseGate } from './gate.js'
import { PAUSE_COMMAND, PAUSE_DEFINITION_ID, RESUME_COMMAND, RESUME_DEFINITION_ID } from './shared.js'

/** Result copy for a session that just reached the pause point; the model never sees it. */
const PAUSED_TEXT = 'This session is paused. Its next model request will not be sent until you resume it.'

/** Result copy for a released session. */
const RESUMED_TEXT = 'This session resumed from where it paused.'

/**
 * Contribute the session control: the global pause verb and, for every paused
 * session that has a live agent, the resume marker.
 * @param ctx - host context carrying the command registry and the agent store.
 * @param gate - the pause gate this control drives and reflects.
 */
export function installSessionControl(ctx: Context, gate: PauseGate): void {
  /** Resume-marker fiber per paused session; disposing it removes the registration. */
  const markers = new Map<SessionId, Fiber>()

  const drop = (sessionId: SessionId): void => {
    const fiber = markers.get(sessionId)
    if (fiber === undefined) return
    markers.delete(sessionId)
    void Promise.resolve(fiber.dispose()).catch((error: unknown) => {
      ctx.logger.warn(`safe-stop: resume marker cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const install = (agent: Agent): void => {
    if (markers.has(agent.id)) return
    // The registry keys scoped definitions off the context a call is made
    // through, and Cordis refuses an undeclared service access, so the marker
    // goes through a `commands`-injected child of THIS agent's context: the
    // scope layer is that agent, two sessions never collide, and agent
    // disposal removes the marker on its own.
    const fiber = agent.ctx.inject(['commands'], (scope) => {
      scope.commands.register({
        definitionId: CommandDefinitionId(RESUME_DEFINITION_ID),
        name: RESUME_COMMAND,
        description: 'Resume this paused Session',
        handler: (invocation) => {
          gate.resume(invocation.agent.id)
          return { kind: 'success', text: RESUMED_TEXT }
        },
      })
    })
    markers.set(agent.id, fiber)
  }

  const sync = (sessionId: SessionId): void => {
    if (!gate.isPaused(sessionId)) {
      drop(sessionId)
      return
    }
    const agent = ctx.agents.get(sessionId)
    if (agent !== undefined) install(agent)
  }

  // One effect owns the whole surface: unloading removes the pause verb, the
  // change subscription, and every marker this plugin registered.
  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: CommandDefinitionId(PAUSE_DEFINITION_ID),
      name: PAUSE_COMMAND,
      description: 'Pause this Session before its next model request',
      handler: (invocation) => {
        gate.pause(invocation.agent.id)
        return { kind: 'success', text: PAUSED_TEXT }
      },
    })
    yield gate.onChange(sessionId => { sync(sessionId) })
    // An agent created after its session was paused still owes the browser the
    // marker: a session keeps its pause across an agent replacement.
    yield ctx.on('agent/created', ({ agent }) => {
      sync(agent.id)
      return undefined
    })
    // The agent's own teardown already removed the marker registration; forget
    // the stale handle so a replacement agent can register its own.
    yield ctx.on('agent/disposed', ({ agent }) => {
      drop(agent.id)
      return undefined
    })
    yield async () => {
      const pending = [...markers.values()].map(fiber => fiber.dispose())
      markers.clear()
      await Promise.all(pending)
    }
  }, 'safe-stop: session control')
}
