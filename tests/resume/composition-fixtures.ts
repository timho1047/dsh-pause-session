/**
 * Service faces and durable log events for the composition tests.
 *
 * The subject of these tests is the composition assembly itself, so only the
 * two optional services `restoreComposition` reads are replaced: the Session
 * projection read and the preset roster. Everything else in the fixtures is a
 * real Cordis Context or the real subagent descriptor format.
 * @module dsh-pause/test/resume/composition-fixtures
 */

import { vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { snapshotSubagentDescriptor, SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'

/** One fake observation's projection cut; `'none'` means the projection is unavailable. */
export type ProjectionFixture = 'none' | { readonly agentPreset?: string | null }

/** A fake Session observation with the fields `restoreComposition` reads. */
export function observationOf(options: {
  readonly events?: readonly SessionEvent[]
  readonly projection?: ProjectionFixture
} = {}): SessionObservation {
  const projection = options.projection ?? { agentPreset: null }
  return {
    source: 'prepared',
    inheritedEventCount: 0,
    events: options.events ?? [],
    projections: projection === 'none'
      ? undefined
      : { asOfSeq: -1, values: projection },
    [Symbol.dispose]: () => {},
  } as unknown as SessionObservation
}

/** One `agent-preset/selected` event. */
export function selectedEvent(seq: number, agentPreset: string): SessionEvent {
  return {
    type: 'agent-preset/selected',
    seq: SessionSeq(seq),
    time: seq + 1,
    data: { agentPreset },
  } as SessionEvent
}

/** One continuable child descriptor, with the route and overrides a resume reads back. */
export function continuableDescriptor(seq: number, fields: {
  readonly persona?: string
  readonly toolFilter?: ToolRestriction
  readonly agentProvider?: string
  readonly agentModel?: string
  readonly agentReasoningEffort?: ReturnType<typeof ReasoningEffortId>
} = {}): SessionEvent {
  return {
    type: 'subagent/descriptor',
    seq: SessionSeq(seq),
    time: seq + 1,
    data: snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: 'spawn',
      label: 'child work',
      ...fields,
    }),
  } as SessionEvent
}

/** One terminal one-shot child descriptor. */
export function oneShotDescriptor(seq: number): SessionEvent {
  return {
    type: 'subagent/descriptor',
    seq: SessionSeq(seq),
    time: seq + 1,
    data: {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'one-shot',
      provider: 'spawn',
      label: 'one-shot work',
    },
  } as SessionEvent
}

/** The preset roster and the calls `restoreComposition` makes into it. */
export function presetRoster() {
  const mounts: { readonly ctx: Context; readonly id: string }[] = []
  const joins: { readonly child: Context; readonly parent: Context }[] = []
  const resolve = vi.fn(async (id?: string) => ({ id: id ?? 'default' }))
  const mount = vi.fn(async (ctx: Context, id?: string) => {
    const resolved = id ?? 'default'
    mounts.push({ ctx, id: resolved })
    return { id: resolved }
  })
  const composeFrom = vi.fn((child: Context, parent: Context) => {
    joins.push({ child, parent })
    return 'parent'
  })
  return { resolve, mount, composeFrom, mounts, joins }
}

/** A parent Agent whose only used face is its context. */
export function parentAgent(ctx: Context): Agent {
  return { ctx } as unknown as Agent
}
