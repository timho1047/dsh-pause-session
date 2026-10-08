/**
 * Scripted fake provider that drives a real agent loop without a network.
 *
 * The harness keeps its equivalent (`packages/core/agent-loop/tests/mock-adapter.ts`)
 * behind an exports map that publishes only `.` and `./invariant`, so the
 * scripted-adapter pattern is copied here instead of imported.
 * @module dsh-safe-stop/test/assumptions/fake-provider
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'

/** What one scripted call streams: chunks, a per-request computation of them, or a stall. */
export type ScriptEntry = StreamChunk[] | ((options: GenerateOptions) => StreamChunk[]) | 'hang'

/** Terminal chunks for a plain text answer. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Request shape this fixture records. */
export type RecordedRequest = GenerateOptions

/**
 * A provider whose every call plays the next script entry.
 *
 * `stream()` records the request the moment the adapter is reached, before the
 * returned generator is pulled, so "the adapter was never reached" and "the
 * adapter was reached but nothing was pulled from it" stay distinguishable.
 */
export class FakeProvider extends LlmAdapter {
  /** Requests that reached the adapter. */
  readonly requests: RecordedRequest[] = []
  /** Generator bodies actually pulled. */
  pulls = 0

  constructor(
    private readonly script: ScriptEntry[],
    /** Arms the harness's real idle watchdog around each outstanding pull, as both shipped adapters do. */
    private readonly idleTimeoutMs?: number,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    return this.generate(options)
  }

  private async * generate(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.pulls += 1
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('FakeProvider: script exhausted')
    const watchdog = this.idleTimeoutMs === undefined
      ? undefined
      : idleWatchdog(options.signal, this.idleTimeoutMs, 'FAKE_STREAM_IDLE')
    try {
      const iterator = this.chunks(entry, options, watchdog?.signal ?? options.signal)[Symbol.asyncIterator]()
      for (;;) {
        const next = watchdog === undefined ? await iterator.next() : await watchdog.next(iterator)
        if (next.done === true) return
        yield next.value
      }
    } catch (error: unknown) {
      if (watchdog !== undefined && timeoutOf(watchdog.signal, 'FAKE_STREAM_IDLE') !== undefined) {
        throw new LlmError('FakeProvider stream idle timeout', 'TIMEOUT', { cause: error })
      }
      throw error
    } finally {
      watchdog?.[Symbol.dispose]()
    }
  }

  private async * chunks(
    entry: ScriptEntry,
    options: GenerateOptions,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'))
          return
        }
        signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) {
      signal.throwIfAborted()
      yield chunk
    }
  }
}
