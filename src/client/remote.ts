/**
 * Client-side bridge from the generated `pauseSession` Remote namespace to the
 * existing control state machines.
 *
 * The controls were written against a command-shaped transport. The native
 * namespace is now the only transport: this adapter maps its unary actions and
 * stream snapshots into that shape, so no host slash command is involved.
 * @module dsh-pause-session/client/remote
 */

import type { CommandDescriptor, CommandExecution } from '@deepseek-ai/dsh-commands/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  PauseActionResultWire, PauseDecisionRequest, PauseSnapshotWire, TriageRowWire,
} from '../remote.js'
import {
  decodeGlobalStatus, decodeParkStatus, encodeGlobalStatus, encodeParkStatus, encodeTriageList,
  GOAL_DEFINITION_ID, PAUSE_ALL_COMMAND, RESUME_ALL_COMMAND, RESUME_DEFINITION_ID,
  STATE_ALL_COMMAND, STATUS_DEFINITION_ID, TRIAGE_COMMAND,
} from '../shared.js'
import type { GlobalBlindSpot, GlobalStatus, ParkStatus, TriageRow } from '../shared.js'
import type { PauseStatusSource } from './status.js'

/** The generated namespace shape this bridge needs. */
export interface RemotePauseNamespace {
  observe(signal?: AbortSignal): AsyncIterable<PauseSnapshotWire>
  act(request: {
    readonly action: 'pause' | 'resume' | 'pause-all' | 'resume-all' | 'goal'
    readonly sessionId: string
    readonly target?: string
  }, signal?: AbortSignal): Promise<{ readonly ok: boolean; readonly value?: PauseActionResultWire; readonly error?: { readonly code: string } }>
  triage(request: { readonly caller: string }, signal?: AbortSignal): Promise<{
    readonly ok: boolean
    readonly value?: readonly TriageRowWire[]
  }>
  decide(request: PauseDecisionRequest, signal?: AbortSignal): Promise<{
    readonly ok: boolean
    readonly value?: PauseActionResultWire
  }>
}

/** Convert one wire snapshot to the host-status vocabulary the controls already use. */
function snapshotOf(wire: PauseSnapshotWire): PauseSnapshotLike {
  return {
    global: {
      ...wire.global,
      parkedAt: wire.global.parkedAt as never,
      draining: wire.global.draining as never,
      stalled: wire.global.stalled as never,
      unresumable: wire.global.unresumable as never,
      unreadTrees: wire.global.unreadTrees as never,
      jobs: wire.global.jobs as never,
      blind: wire.global.blind as GlobalBlindSpot[],
    },
    sessions: Object.fromEntries(Object.entries(wire.sessions).map(([id, status]) => [id, status as ParkStatus])),
  }
}

/** The status shape shared by the controls, with branded ids erased at this boundary. */
export interface PauseSnapshotLike {
  readonly global: GlobalStatus
  readonly sessions: Readonly<Record<string, ParkStatus>>
}

/** A remote-backed status source with a change subscription. */
export interface RemoteStatusSource extends PauseStatusSource {
  onChange(listener: () => void): () => void
}

/**
 * Open the native status stream and expose its latest snapshot to both controls.
 * @param remote - the generated Remote namespace.
 * @param lifetime - client lifetime; aborting it releases the stream.
 * @returns the cached source and its change subscription.
 */
export function openRemoteSource(remote: RemotePauseNamespace, lifetime: AbortSignal): RemoteStatusSource {
  let latest: PauseSnapshotLike | undefined
  let failed = false
  let first: (() => void) | undefined
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of [...listeners]) listener() }
  const ready = new Promise<void>((resolve) => { first = resolve })

  void (async () => {
    try {
      for await (const snapshot of remote.observe(lifetime)) {
        latest = snapshotOf(snapshot)
        first?.()
        first = undefined
        notify()
      }
    } catch {
      failed = true
    } finally {
      first?.()
      first = undefined
    }
  })()

  return {
    onChange: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    read: async (signal) => {
      if (latest === undefined && !failed) {
        await new Promise<void>((resolve) => {
          const done = (): void => { signal?.removeEventListener('abort', done); resolve() }
          first = () => { first = undefined; done() }
          signal?.addEventListener('abort', done, { once: true })
          if (latest !== undefined || failed) done()
        })
      }
      signal?.throwIfAborted()
      return latest
    },
  }
}

/** The command-shaped transport the existing controls consume. */
export interface RemoteCommandTransport {
  list(sessionId: SessionId): Promise<{ readonly ok: boolean; readonly value?: readonly CommandDescriptor[] }>
  execute(
    sessionId: SessionId,
    line: string,
    attachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<{ readonly ok: boolean; readonly value?: CommandExecution }>
}

/** Build the internal command-shaped adapter over the Remote namespace. */
export function remoteCommands(remote: RemotePauseNamespace, source: RemoteStatusSource): RemoteCommandTransport {
  // The adapter reads the shared snapshot through a small unary-free path: the
  // stream is started by openRemoteSource; the control's source remains the
  // authority for state. Command calls below are actions, never status reads.
  const result = (ok: boolean, text?: string): CommandExecution => ({
    commandId: 'native' as never,
    result: ok ? { kind: 'success', ...text === undefined ? {} : { text } } : { kind: 'error', text: text ?? 'pause action failed' },
  })
  const run = async (request: Parameters<RemotePauseNamespace['act']>[0], signal: AbortSignal): Promise<CommandExecution> => {
    const answer = await remote.act(request, signal)
    if (!answer.ok) return result(false, answer.error?.code ?? 'pause action failed')
    return result(answer.value?.ok ?? true, answer.value?.message)
  }
  const execute = async (sessionId: SessionId, line: string, _attachments: readonly unknown[], signal: AbortSignal): Promise<{ ok: boolean; value?: CommandExecution }> => {
    const [name = '', ...rest] = line.replace(/^\//u, '').split(' ')
    const target = rest.join(' ').trim()
    try {
      switch (name) {
        case 'pause':
          return { ok: true, value: await run({ action: 'pause', sessionId: String(sessionId) }, signal) }
        case 'pause-resume':
          return { ok: true, value: await run({ action: 'resume', sessionId: String(sessionId) }, signal) }
        case 'pause-all':
          return { ok: true, value: await run({ action: 'pause-all', sessionId: String(sessionId) }, signal) }
        case 'pause-resume-all':
          return { ok: true, value: await run({ action: 'resume-all', sessionId: String(sessionId) }, signal) }
        case 'pause-goal':
          return { ok: true, value: await run({ action: 'goal', sessionId: String(sessionId) }, signal) }
        case 'pause-triage': {
          const answer = await remote.triage({ caller: String(sessionId) }, signal)
          if (!answer.ok) return { ok: false }
          return { ok: true, value: result(true, encodeTriageList({ rows: (answer.value ?? []).map(wireRow) })) }
        }
        case 'pause-state': {
          const latest = await source.read(signal)
          if (latest === undefined) return { ok: false }
          const status = latest.sessions[String(sessionId)]
          return { ok: true, value: result(true, status === undefined ? '' : encodeParkStatus(status)) }
        }
        case 'pause-state-all': {
          const latest = await source.read(signal)
          if (latest === undefined) return { ok: false }
          return { ok: true, value: result(true, encodeGlobalStatus(latest.global)) }
        }
        case 'pause-triage-continue':
        case 'pause-triage-note':
        case 'pause-triage-review':
        case 'pause-triage-leave':
        case 'pause-triage-goal': {
          const decision = name.slice('pause-triage-'.length) as PauseDecisionRequest['decision']
          const answer = await remote.decide({ caller: String(sessionId), target, decision }, signal)
          if (!answer.ok) return { ok: false }
          return { ok: true, value: result(answer.value?.ok ?? true, answer.value?.message) }
        }
        default:
          return { ok: false }
      }
    } catch {
      return { ok: false }
    }
  }
  return {
    list: async (sessionId) => {
      // The source owns state; the marker list is only a fallback for code that
      // still asks. It is derived from the latest snapshot without a command.
      const latest = await source.read()
      if (latest === undefined) return { ok: false }
      const paused = latest.sessions[String(sessionId)] !== undefined
      if (!paused) return { ok: true, value: [] }
      return {
        ok: true,
        value: [
          { definitionId: RESUME_DEFINITION_ID as never, name: 'pause-resume', description: 'Resume this paused session' },
          { definitionId: STATUS_DEFINITION_ID as never, name: 'pause-state', description: 'Report this session\'s pause state' },
          { definitionId: GOAL_DEFINITION_ID as never, name: 'pause-goal', description: 'Toggle goal re-arm' },
        ],
      }
    },
    execute,
  }
}

/** Map one wire row to the list's structured row. */
function wireRow(row: TriageRowWire): TriageRow {
  return {
    sessionId: row.sessionId,
    phase: row.phase,
    updatedAt: row.updatedAt,
    reading: row.reading,
    ...row.lastEvent === undefined ? {} : { lastEvent: row.lastEvent },
    ...row.turn === undefined ? {} : { turn: row.turn },
    ...row.step === undefined ? {} : { step: row.step },
    traces: row.traces.map(trace => ({ tool: trace.tool, callId: trace.callId ?? '' })),
    owed: row.owed,
    wakeable: row.wakeable,
    rearmGoal: row.rearmGoal,
  }
}
