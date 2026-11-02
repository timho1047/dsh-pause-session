/**
 * The message history a session's log derives to, and the one rule that reads
 * whether it still owes the model an answer.
 *
 * That question is asked twice and must have one answer: the clean wake asks it
 * before it hands a session an input (an input nobody owes an answer to would
 * open a turn of its own), and the decision list publishes it as the row's
 * `wake` field. A published promise that the wake then declines to keep is the
 * report lying, so both read the same derivation and the same rule.
 *
 * The derivation is the harness's own: the surface fold the loop reads its
 * history through, with the same message projections this process has
 * registered, and an interrupted tail closed exactly as the harness closes it
 * on the next read. `resume.ts` reads the live form of it
 * (`Session.deriveMessages()`); {@link derivedHistory} is the cold form over a
 * stored log, which is all the decision list may claim — it opens a log to read
 * it and never activates a session.
 * @module dsh-pause/history
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import {
  deriveEventMessage, foldSurface, foldRequestHeader, interruptedTurnClosers,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionMessageProjection } from '@deepseek-ai/dsh-session'

/**
 * Whether one derived history ends owing the model an answer: the last thing
 * said on the model-visible surface is not an assistant message.
 * @param messages - a derived history, in model-visible order.
 * @returns whether a model still owes that history a reply.
 */
export function owesReply(messages: readonly Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    // System and developer entries are request framing, not conversation.
    if (message === undefined || message.role === 'system' || message.role === 'developer') continue
    return message.role !== 'assistant'
  }
  return false
}

/**
 * The messages one stored log derives to, as the harness would read them on the
 * session's next activation: the open tail turn is closed with the harness's
 * own synthetic results first, then the log is folded into its surface.
 * @param events - the stored events, exactly as they are stored and in sequence order.
 * @param projections - this process's registered message projections.
 * @returns the derived history, in model-visible order.
 * @throws when the log cannot be folded — an event this build has no interpreter
 * for, or surface metadata that does not apply to this history.
 */
export function derivedHistory(
  events: readonly SessionEvent[],
  projections: readonly SessionMessageProjection[],
): Message[] {
  const stored = [...events, ...interruptedTurnClosers(events)]
  const fold = foldSurface(stored, projections)
  return fold.nodes.flatMap((seq) => {
    const event = stored[seq]
    if (event === undefined) return []
    const message = deriveEventMessage(event, fold.projectedMessages)
    return message === null ? [] : [message]
  })
}

/**
 * Whether one stored log names the route a wake would be addressed to. The wake
 * needs a provider and a model to build a request at all, and the request
 * header the session itself persisted is the only place that names them.
 * @param events - the stored events, in sequence order.
 * @returns whether the log's last request header carries both route fields.
 */
export function routeNamed(events: readonly SessionEvent[]): boolean {
  const config = foldRequestHeader(events)?.config
  return config !== undefined && config.provider.length > 0 && config.model.length > 0
}
