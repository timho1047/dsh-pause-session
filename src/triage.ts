/**
 * The morning decision list: every session that did not stop cleanly, the facts
 * its own log carries about where it stopped, and the listed verbs the user can
 * take on it.
 *
 * A session gets here by NOT being on the clean path. A record whose phase is
 * `safe` is woken silently by `./resume.ts` and never appears here; the other
 * three phases describe work nobody can vouch for, and guessing on them would
 * spend the owner's money on a guess. This module is the other half of that
 * rule, not a second copy of it: the reading is taken from the session's own
 * stored log through a read handle that claims no ownership and writes nothing,
 * so asking what happened cannot itself change what happened.
 *
 * WHAT A ROW REPORTS. "Where it stopped" is the last event of the stored log
 * with the turn and step it belongs to. "Which tool was in flight" is the
 * `tool/call` events that no durable `tool/result` answers — a call event is
 * only written once the loop reached the dispatch, so an unanswered one is
 * exactly a tool the real world ran and the log never heard back from. The
 * harness turns each of those into a synthetic `TOOL_OUTCOME_UNKNOWN` error
 * result when it next reads the log; this module derives the same answer from
 * the stored events instead of writing it back. Nothing here is inferred from
 * the fact that the session is listed.
 *
 * WHAT THE ROW PROMISES. `wake` says the host can hand this session the request
 * it owes, and the wake that keeps that promise is `./resume.ts`'s. Both read
 * one rule from `./history.ts` over the same derivation the loop reads, so a
 * promise this list publishes is a promise that wake keeps. When the log cannot
 * be folded into that derivation, the promise is withheld and the reading is
 * reported; a withheld promise costs a user nothing, a broken one spends their
 * money.
 *
 * WHO MAY DECIDE. A decision names its target as command input, and the command
 * channel carries no origin of its own, so this list acts only on rows its most
 * recent read published to the calling session: the caller's own read is what
 * makes a target actionable. Anything else is refused, not looked up.
 *
 * TWO OF THE FIVE VERBS PUT THE SESSION BACK ON THE CLEAN PATH. Continue and
 * continue-with-the-note go through `ResumePath.decideUnclean`, which activates
 * the session, wakes it and drops the durable record before the gate opens.
 *
 * THE OTHER THREE TOUCH NOTHING. Leave writes nothing at all: the record stays,
 * the session stays held, and the row is still on tomorrow's list. Review
 * answers without activating anything or writing anything — opening a session
 * to read it is the user's own action in their session history, and starting an
 * agent on their behalf is precisely what they declined. Goal flips the row's
 * own re-arm opt-out: it is the user path for the one thing a resume can spend
 * without the user watching it, and it takes effect on whatever resume comes
 * next. All five carry the same binding — the row must be one this caller was
 * shown — because each changes, or declines to change, durable state of a
 * parked session.
 * @module dsh-safe-stop/triage
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: the optional `ctx.sessionPersistence` read seam and its handle.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { derivedHistory, owesReply, routeNamed } from './history.js'
import type { ParkRegistry, ParkedSession } from './registry.js'
import type { ResumePath } from './resume.js'
import { describeError } from './shared.js'
import type { TriageAction, TriageList, TriageRow, TriageTrace } from './shared.js'

/** The route a wake input has to be addressed to; see `./resume.ts`. */
type WakeOf = Parameters<ResumePath['resumeSession']>[1]

/** Result copy for a decision the list itself could not carry out. */
export const TRIAGE_FAILED_TEXT = 'safe-stop could not carry out that decision; the session is exactly as it was.'

/** Result copy for leaving one listed session alone. */
export const TRIAGE_LEFT_TEXT = 'safe-stop left this session paused; it is still on the list.'

/** Result copy for a decision aimed at a session that is not on the list. */
export const TRIAGE_NOT_LISTED_TEXT = 'safe-stop has no unfinished park recorded for this session.'

/**
 * Result copy for a decision aimed at a row the calling session was not shown.
 * The list is the only thing that legitimizes a target, so a target nobody read
 * is refused rather than acted on.
 */
export const TRIAGE_UNSHOWN_TEXT = 'safe-stop did not act: this Session has not been shown that row.'
  + ' Read the list first (/safe-triage).'

/**
 * Model-facing text that goes with a wake when the user chooses to continue
 * with a note.
 *
 * It is written the way the harness writes its own recovery text: the same two
 * facts the synthetic tool result states (the call's outcome was never recorded;
 * verify before retrying anything with side effects), in the same voice, with no
 * mention of the stop mechanism. The harness's own version lives in the tool
 * result for that call, which is why this one does not repeat the call's name —
 * it warns about the step as a whole, and the specific result sits directly
 * above it in the history.
 */
export const UNKNOWN_OUTCOME_NOTE = 'A tool call from this step was interrupted: its call was recorded but no '
  + 'result was durably recorded, so its outcome is unknown. If it had side effects, verify the external state '
  + 'before doing anything else, and do not retry it blindly. Then continue with what I asked for.'

/** What one stored log says, or that this host could not read it. */
interface ColdRead {
  /** The events exactly as they are stored: no repair, no synthesis. */
  readonly events: readonly SessionEvent[]
}

/**
 * One registry entry this list owns: every park outcome but `safe`, which is
 * the silent path's business and never appears here.
 */
type ListedPark = Omit<ParkedSession, 'phase'> & { readonly phase: TriageRow['phase'] }

/**
 * Events that are not the session's own story: the bookkeeping of the pause
 * command the user pressed, and the pending-input splices the inbox writes.
 * They are real and durable, but "it stopped right after `/safe-stop` finished"
 * is not what "where did it stop" means.
 */
const BOOKKEEPING_EVENTS: ReadonlySet<string> = new Set(['command/run', 'command/done', 'agent/inbox/spliced'])

/** The turn and step an event belongs to, when it carries them. */
function positionOf(event: SessionEvent): { readonly turn?: number; readonly step?: number } {
  const data = event.data
  if (typeof data !== 'object' || data === null) return {}
  const turn = 'turn' in data && typeof data.turn === 'number' ? data.turn : undefined
  const step = 'step' in data && typeof data.step === 'number' ? data.step : undefined
  return { ...turn === undefined ? {} : { turn }, ...step === undefined ? {} : { step } }
}

/**
 * Read one session's stored log without taking ownership of it.
 * @param ctx - host context carrying the optional persistence service.
 * @param sessionId - the stored session to read.
 * @returns the events exactly as stored, or `undefined` when no read seam exists or it refused.
 */
async function coldRead(ctx: Context, sessionId: SessionId): Promise<ColdRead | undefined> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return undefined
  let handle
  try {
    handle = await persistence.open(sessionId, 'read')
  } catch (error: unknown) {
    ctx.logger.warn(`safe-stop: could not open the stored log of "${sessionId}": ${describeError(error)}`)
    return undefined
  }
  try {
    const stored = await handle.read(0, undefined)
    return { events: [...stored.events] }
  } catch (error: unknown) {
    ctx.logger.warn(`safe-stop: could not read the stored log of "${sessionId}": ${describeError(error)}`)
    return undefined
  } finally {
    await handle.close()
  }
}

/**
 * Every tool call the STORED events record and no stored result answers.
 *
 * Deliberately the stored prefix rather than the repaired view: what a row
 * reports is the state of the session's own log, and the harness's synthetic
 * unknown-outcome results are exactly what that log is missing. Taking the
 * repaired view here would subtract the very traces the row exists to show.
 */
function unansweredCalls(events: readonly SessionEvent[]): TriageTrace[] {
  const names = new Map<string, string>()
  const answered = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      names.set(String(event.data.callId), event.data.name)
      continue
    }
    if (event.type !== 'tool/result') continue
    answered.add(String(event.data.message.toolCallId))
  }
  return [...names].flatMap(([callId, tool]) => answered.has(callId) ? [] : [{ tool, callId }])
}

/**
 * One row's facts, as the session's own log reports them.
 * @param ctx - host context carrying the registered message projections.
 * @param entry - the durable park record this row is built from.
 * @param stored - the events exactly as they are stored.
 * @returns the row, ready to publish.
 */
function rowOf(
  ctx: Context,
  entry: ListedPark,
  stored: readonly SessionEvent[],
): TriageRow {
  const { sessionId, phase, updatedAt, rearmGoal } = entry
  // The stop position is the last event the log actually ends on, minus the
  // bookkeeping that only says how the pause itself was requested.
  const last = [...stored].reverse().find(event => !BOOKKEEPING_EVENTS.has(event.type))
  const traces = unansweredCalls(stored)
  // Whether an answer is owed is the wake's own question, read through the
  // wake's own rule over the history the harness would derive from this log. A
  // log this build cannot fold leaves the question unanswerable, and the promise
  // is withheld rather than guessed.
  let owed = false
  try {
    owed = owesReply(derivedHistory(stored, ctx.sessions.messageProjections))
  } catch (error: unknown) {
    ctx.logger.warn(`safe-stop: could not derive the history of "${sessionId}": ${describeError(error)}`)
  }
  return {
    sessionId: String(sessionId),
    phase,
    updatedAt,
    reading: 'read',
    ...last === undefined ? {} : { lastEvent: last.type, ...positionOf(last) },
    traces,
    owed,
    rearmGoal,
    // Two facts have to hold before this host can hand the session its owed
    // request: the log must name the route the wake would be addressed to, and
    // there must be an answer still owed for the wake to ask for.
    wakeable: owed && routeNamed(stored),
  }
}

/** What mounting the decision list hands back. */
export interface TriageListService {
  /**
   * Read the list for one calling session, and record the rows it was shown.
   * @param caller - the session the read was addressed to.
   * @returns every session that did not stop cleanly, with the facts its own log carries.
   */
  read(caller: SessionId): Promise<TriageList>
  /**
   * Carry out one decision on one listed session, for the caller that read it.
   * @param caller - the session the decision was addressed to.
   * @param sessionId - the listed session to act on.
   * @param action - which of the listed decisions was taken.
   * @returns the outcome for whoever asked.
   */
  decide(caller: SessionId, sessionId: SessionId, action: TriageAction): Promise<CommandResult>
}

/**
 * Mount the decision list over the durable registry and the clean resume path.
 *
 * The list is the registry's own complement: it asks for every record whose
 * phase is not `safe`, so a session that cleaned up is off the list by the same
 * fact that puts it on the silent path, and nothing has to be reconciled.
 * @param ctx - host context carrying the optional persistence service.
 * @param registry - the durable list of park outcomes.
 * @param resumePath - the path all three resuming decisions go through.
 * @returns the list read and the decision verbs.
 */
export function mountTriageList(ctx: Context, registry: ParkRegistry, resumePath: ResumePath): TriageListService {
  /**
   * The rows each calling session was last shown by its own read. A decision
   * names its target as command input, and the command channel carries no
   * origin of its own, so this is what ties a target to the list the user read:
   * only a row this caller has been shown is acted on.
   */
  const shown = new Map<SessionId, ReadonlySet<string>>()

  const readable = async (entry: ListedPark): Promise<TriageRow> => {
    const read = await coldRead(ctx, entry.sessionId)
    // A log this host could not read says so. An empty row would claim the
    // session left no traces, which is precisely the verdict nobody has.
    if (read === undefined) {
      return {
        sessionId: String(entry.sessionId),
        phase: entry.phase,
        updatedAt: entry.updatedAt,
        reading: 'unreadable',
        traces: [],
        owed: false,
        wakeable: false,
        rearmGoal: entry.rearmGoal,
      }
    }
    return rowOf(ctx, entry, read.events)
  }

  /**
   * One decision, as the resume path's own verbs plus the two local verbs that
   * change nothing but the record. Review is the list's own "do not run it"
   * answer: it activates nothing and writes nothing, so the park is exactly as
   * it was. The goal toggle is the user path for the one thing a resume can
   * spend unasked.
   */
  const decide = async (caller: SessionId, sessionId: SessionId, action: TriageAction): Promise<CommandResult> => {
    if (!(shown.get(caller)?.has(String(sessionId)) ?? false)) return { kind: 'error', text: TRIAGE_UNSHOWN_TEXT }
    const record = registry.get(sessionId)
    // `safe` is not a decision this list owns: that session belongs to the
    // silent path, and acting here would be a second resume.
    if (record === undefined || record.phase === 'safe') {
      return { kind: 'error', text: TRIAGE_NOT_LISTED_TEXT }
    }
    if (action === 'leave') return { kind: 'success', text: TRIAGE_LEFT_TEXT }
    if (action === 'goal') return await resumePath.setRearmGoal(sessionId, !record.rearmGoal)
    // Review is its own kind of decision, not a wake-less resume: it leaves the
    // park exactly as it was, so the row is still there for tomorrow and
    // nothing has been continued — or even activated — on the user's behalf.
    if (action === 'review') return (await resumePath.decideUnclean(sessionId, { kind: 'none' }, 'review')).answer
    const wake: WakeOf = action === 'continue' ? { kind: 'silent' } : { kind: 'message', text: UNKNOWN_OUTCOME_NOTE }
    return (await resumePath.decideUnclean(sessionId, wake, 'release')).answer
  }

  return {
    read: async (caller) => {
      const rows = await Promise.all(registry.list()
        .flatMap(entry => entry.phase === 'safe' ? [] : [readable({ ...entry, phase: entry.phase })]))
      shown.set(caller, new Set(rows.map(row => row.sessionId)))
      return { rows }
    },
    decide,
  }
}
