/**
 * The wire seam: what the route in use would actually put in front of the
 * model. The loop always builds the wake message into its request; whether the
 * model sees it is decided below the loop, by the route's own conversion. This
 * module runs that conversion — the shipped DeepSeek serializer, the one the
 * spike used to locate the empty message's disappearance — over a request the
 * loop built, so a spec can assert the payload rather than the intent.
 * @module dsh-pause-session/test/resume/wire
 */

import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { serialize } from '@deepseek-ai/dsh-llm-deepseek/src/serialize.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ParkedRequest } from './home.ts'

/** Connection options the serializer needs; defaults, exactly as the spike used. */
const connection = resolveAdapterOptions({})

/** One message as it reaches the provider. */
export interface WireMessage {
  readonly role: string
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}

/**
 * Serialize one request the way the DeepSeek route does.
 * @param request - a request the loop built, live or as a parked child dumped it.
 * @returns the request body's messages, in provider order.
 */
export function wireMessages(request: GenerateOptions | ParkedRequest): WireMessage[] {
  const options = request as Parameters<typeof serialize>[0]
  const history = request.messages as Parameters<typeof serialize>[2]
  return serialize(options, connection, history, new Map(), () => undefined).messages as WireMessage[]
}

/** The model-visible text of one wire message, joined. */
export function wireText(message: WireMessage): string {
  return message.content.map(block => block.text ?? '').join('')
}
