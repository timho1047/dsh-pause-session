/**
 * Wire adapter between the pause engine and the generated Remote namespace.
 *
 * The engine speaks in branded Session ids and CommandResult copy; the Remote
 * contract is plain JSON. Mapping lives here so neither side depends on the
 * other's types.
 * @module dsh-pause-session/remote-adapter
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionControl, PressTreeOutcome } from './control.js'
import type {
  GlobalStatusWire, PauseActionRequest, PauseActionResultWire, PauseDecisionRequest,
  PauseRemoteApi, PauseSnapshotWire, PauseTriageRequest, SessionStatusWire, TriageRowWire,
} from './remote.js'
import type { GlobalStatus, ParkStatus, TriageAction, TriageRow } from './shared.js'

/** Map the engine's aggregate status to the wire shape. */
function globalOf(status: GlobalStatus): GlobalStatusWire {
  return {
    verdict: status.verdict,
    registered: status.registered,
    safe: status.safe,
    ...status.parkedAt === undefined ? {} : { parkedAt: String(status.parkedAt) },
    draining: status.draining.map(String),
    parking: status.parking,
    stalled: status.stalled.map(String),
    unresumable: status.unresumable.map(String),
    unreadTrees: status.unreadTrees.map(String),
    jobs: status.jobs.map(String),
    blind: [...status.blind],
  }
}

/** Map one engine status to the wire shape. */
function sessionOf(status: ParkStatus): SessionStatusWire {
  return {
    phase: status.phase,
    runningTools: [...status.runningTools],
    ...status.rearmGoal === undefined ? {} : { rearmGoal: status.rearmGoal },
  }
}

/** Map one engine triage row to the wire shape. */
function triageRowOf(row: TriageRow): TriageRowWire {
  return {
    sessionId: row.sessionId,
    phase: row.phase,
    updatedAt: row.updatedAt,
    reading: row.reading,
    ...row.lastEvent === undefined ? {} : { lastEvent: row.lastEvent },
    ...row.turn === undefined ? {} : { turn: row.turn },
    ...row.step === undefined ? {} : { step: row.step },
    traces: row.traces.map(trace => ({
      tool: trace.tool,
      ...trace.callId === undefined ? {} : { callId: trace.callId },
    })),
    owed: row.owed,
    wakeable: row.wakeable,
    rearmGoal: row.rearmGoal,
  }
}

/** Map the engine's snapshot to the wire shape. */
export function snapshotOf(snapshot: { global: GlobalStatus; sessions: Readonly<Record<string, ParkStatus>> }): PauseSnapshotWire {
  return {
    global: globalOf(snapshot.global),
    sessions: Object.fromEntries(Object.entries(snapshot.sessions).map(([id, status]) => [id, sessionOf(status)])),
  }
}

/** Convert one CommandResult-like answer to the wire outcome. */
function outcomeOf(answer: { kind: 'success' | 'error'; text?: string }): PauseActionResultWire {
  return { ok: answer.kind === 'success', message: answer.text ?? (answer.kind === 'success' ? 'Done.' : 'Pause action failed.') }
}

/** Convert a press outcome to the wire outcome. */
function pressOutcomeOf(outcome: PressTreeOutcome): PauseActionResultWire {
  if (outcome.unrecorded.length > 0) {
    return { ok: false, message: 'pause could not record this session tree.' }
  }
  if (!outcome.rootRegistered) return { ok: false, message: 'pause did not register this session.' }
  return {
    ok: true,
    message: `Paused ${String(outcome.registered)} session${outcome.registered === 1 ? '' : 's'}.`
      + (outcome.unread ? ' The subagent tree could not be fully read.' : ''),
  }
}

/**
 * Build the Remote callbacks over the mounted pause control.
 * @param control - the engine's host control surface.
 * @returns the wire API.
 */
export function remoteApiOf(control: SessionControl): PauseRemoteApi {
  return {
    snapshot: async signal => snapshotOf(await control.readSnapshot(signal)),
    subscribe: listener => control.subscribe(listener),
    act: async (request: PauseActionRequest, signal) => {
      const sessionId = SessionId(request.sessionId)
      switch (request.action) {
        case 'pause':
          return pressOutcomeOf(await control.pressTree(sessionId, signal))
        case 'resume':
          return outcomeOf((await control.releaseTree(sessionId, signal)).answer)
        case 'pause-all':
          return outcomeOf(await control.pauseAll(signal))
        case 'resume-all':
          return outcomeOf(await control.resumeAll(signal))
        case 'goal':
          return outcomeOf(await control.toggleGoal(sessionId, signal))
      }
    },
    triage: async (request: PauseTriageRequest, signal) => {
      const list = await control.readTriage(SessionId(request.caller), signal)
      return list.rows.map(triageRowOf)
    },
    decide: async (request: PauseDecisionRequest, signal) => {
      const action = request.decision as TriageAction
      return outcomeOf(await control.decideTriage(
        SessionId(request.caller),
        SessionId(request.target),
        action,
        signal,
      ))
    },
  }
}
