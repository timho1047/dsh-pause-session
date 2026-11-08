/**
 * The identities both halves of dsh-pause-session name, the phase vocabulary
 * they share, and the one spelling a host log line gives a caught value.
 *
 * The browser bundle may value-import only the shell's baseline module table,
 * so this module imports nothing. The native Remote payloads are the live
 * vocabulary; there is no command encoding or slash-command surface here.
 * @module dsh-pause-session/shared
 */

/**
 * One log line's text for a caught value.
 * @param error - the caught value.
 * @returns the error's message, or the value's own spelling.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The four park outcomes, listed in the order a park walks them — and the one
 * vocabulary the live status, the durable registry, and the published words all
 * derive from, so they cannot drift apart:
 *
 * - `draining`: paused, and the session is still working — a tool is running, or
 *   a turn is between steps.
 * - `parking`: standing still at the park point; the session-level flush has
 *   not resolved yet.
 * - `safe`: parked and flushed, so it is safe to walk away. The only clean one.
 * - `flush-failed`: parked, but the flush failed — the durable promise is not
 *   kept, and it must never be read as clean.
 */
export const PARK_PHASES = ['draining', 'parking', 'safe', 'flush-failed'] as const

/** One park outcome. */
export type ParkPhase = (typeof PARK_PHASES)[number]

/**
 * How far along a phase is, worst first. The direction is not the order a park
 * walks: it orders how much of the promise each outcome keeps, which is what a
 * fold over several sessions has to compare. `safe` keeps all of it, `draining`
 * and `parking` are on their way, `flush-failed` has stopped trying — a park
 * that failed its flush is further from clean than one that is still working at
 * it, so it must never be the outcome a report rounds down to.
 */
const PHASE_SEVERITY: Record<ParkPhase, number> = {
  safe: 0,
  draining: 1,
  parking: 2,
  'flush-failed': 3,
}

/**
 * Fold several records into the one verdict that speaks for all of them: the
 * worst phase any of them reached, and whether every one of them is clean.
 *
 * This is how a session's control answers for its tree. "Safe to close" is a
 * promise about everything the press registered, so it may be said only when
 * every member reached the flushed park point; anything else is reported as the
 * least-clean state in the set, never rounded up to the session's own.
 * @param phases - the durable phases of the records being spoken for.
 * @returns the worst phase, and whether that verdict is the clean one.
 */
export function foldTreePhases(phases: Iterable<ParkPhase>): { phase: ParkPhase; safe: boolean } {
  let worst: ParkPhase = 'safe'
  for (const phase of phases) {
    if (PHASE_SEVERITY[phase] > PHASE_SEVERITY[worst]) worst = phase
  }
  return { phase: worst, safe: worst === 'safe' }
}

/** Everything the browser is told about one paused session. */
export interface ParkStatus {
  /**
   * The phase of everything that session's press registered — the session and
   * the subagent members under it, folded by {@link foldTreePhases}. A member
   * still draining or stalled holds this at its own phase, because the control
   * that owns the tree may not say "safe to close" while any member of it is
   * not.
   */
  readonly phase: ParkPhase
  /** Whether the host commits to "you can close the lid now". */
  readonly safe: boolean
  /** Tools in flight when the status was published; empty once parked. */
  readonly runningTools: readonly string[]
  /**
   * Whether the resume that takes this pause back may re-open the session's
   * goal — the durable record's own opt-out, which outlives this process. It is
   * absent when this host could not read the record that holds it; a browser
   * that is not told shows no switch rather than a state it would have to
   * guess, and a guess here would tell the user their money is safe when
   * nobody knows whether it is.
   */
  readonly rearmGoal?: boolean
}

/** One JSON snapshot: the whole-app verdict plus every live paused session. */
export interface PauseSnapshot {
  readonly global: GlobalStatus
  readonly sessions: Readonly<Record<string, ParkStatus>>
}

/** The whole-app answer to "can I close the lid?". */
export type GlobalVerdict = 'idle' | 'waiting' | 'safe'

/** A surface the whole-app report could not read at all. */
export type GlobalBlindSpot = 'trees' | 'jobs'

/**
 * Everything the whole-app control publishes about the park as a whole.
 *
 * The counts and the names are one answer, not two: a report that says
 * "3 registered, 1 safe" and then fails to say which two are missing is the
 * kind of silence this control exists to prevent. The verdict is the only
 * summary, and it is derived here so the host and the browser cannot disagree
 * about it.
 */
export interface GlobalStatus {
  /** `idle` with nothing registered, `safe` only when every registered session is. */
  readonly verdict: GlobalVerdict
  /** Sessions this park owns — the durable list plus anything pressed since. */
  readonly registered: number
  /** How many of them reached the flushed park point. */
  readonly safe: number
  /**
   * The session this park belongs to — the first registered one this host can
   * hold, whatever phase it reached, so a client can address its reads at the
   * park instead of at whatever session the user happens to be looking at. A
   * park whose every record is unreadable here names the first of those: the
   * name is a fact about the park, and an address that cannot answer is the
   * client's fallback to take.
   *
   * The buckets below name a session only while it has something left to do,
   * and the clean case — every registered session `safe`, which is the ordinary
   * one — leaves all of them empty: without this field a park that finished
   * cleanly names no session at all. `undefined` when the park holds nothing,
   * and absent from a reading written before this field existed; a client must
   * not treat either absence as an address.
   */
  readonly parkedAt?: string
  /**
   * Registered sessions still working: a tool is in flight or a turn is between
   * steps. Their park point is announced by the marker commands the park
   * registers, so a reader has nothing to watch here.
   */
  readonly draining: readonly string[]
  /**
   * How many registered sessions stand at the park point with their flush still
   * pending — the host's `parking` phase. Nothing announces a flush resolving,
   * so this is the one state a reader can only learn by asking again. A count
   * rather than names: it says how long to keep watching, not which transcript
   * a row belongs in, which is what `draining` is for.
   */
  readonly parking: number
  /**
   * Registered sessions that will not reach the park point in this process: a
   * flush that failed, a pause adopted from an earlier process, a press whose
   * registry write failed, or a record whose session this host cannot read and
   * therefore did not hold. Named, never folded into the count and forgotten.
   */
  readonly stalled: readonly string[]
  /** Registered sessions whose tree contains a route a restart cannot resume. */
  readonly unresumable: readonly string[]
  /** Registered sessions whose subagent tree could not be read — unknown, not clean. */
  readonly unreadTrees: readonly string[]
  /** Live background jobs owned by the registered trees; nothing here can stop them. */
  readonly jobs: readonly string[]
  /** Whole surfaces the report could not read, so their emptiness is not a fact. */
  readonly blind: readonly GlobalBlindSpot[]
}

/** How one decision-list row was read out of the session's own stored log. */
export type TriageReading = 'read' | 'unreadable'

/**
 * What one stored log says about a tool call whose outcome was never recorded.
 *
 * The call event itself is durable; the harness turns every such call into a
 * synthetic `TOOL_OUTCOME_UNKNOWN` error result when it next reads the log, and
 * this is that same derivation taken without writing anything back. The marker
 * itself is never in the stored log of a session still on the list: the resume
 * that appends it is also the resume that drops the record putting it here.
 */
export interface TriageTrace {
  /** The tool's own name, from the call event the model produced. */
  readonly tool: string
  /** The provider-issued id pairing the call with the result that never arrived. */
  readonly callId: string
}

/**
 * One session that did not stop cleanly, as the decision list presents it.
 *
 * Every field is read from the session's own log or from the durable park
 * record; nothing here is derived from the fact that the session is merely
 * listed. `reading` is the honesty field: a log this host could not read says
 * `unreadable` and carries no facts, rather than an empty row that would read
 * as "no traces".
 */
export interface TriageRow {
  /** The parked session. */
  readonly sessionId: string
  /** The durable park outcome; never `safe`, which is the clean path's business. */
  readonly phase: Exclude<ParkPhase, 'safe'>
  /** When that outcome was last written. */
  readonly updatedAt: number
  /** Whether the facts below came from the log. */
  readonly reading: TriageReading
  /** What the stored log's last event was, with the step it belongs to when it has one. */
  readonly lastEvent?: string
  /** The turn and step that last event belongs to. */
  readonly turn?: number
  readonly step?: number
  /** Tools whose call event is durable and whose result is not — the unknown outcomes. */
  readonly traces: readonly TriageTrace[]
  /** Whether the stored log ends owing the model an answer. */
  readonly owed: boolean
  /**
   * Whether resuming this session may re-open its goal. Re-arming is what makes
   * a resumed goal spend its owner's rounds, so it is a per-session choice the
   * row shows and the list can flip.
   */
  readonly rearmGoal: boolean
  /**
   * Whether the host could hand this session its owed request at all: a log it
   * could not read, or one whose last request recorded no route, cannot be
   * woken — which is a fact about the entry, not a refusal of the user's choice.
   */
  readonly wakeable: boolean
}

/** The decision list: what did not stop cleanly, and each row's facts. */
export interface TriageList {
  /** Every listed session, in registry order. */
  readonly rows: readonly TriageRow[]
}

/**
 * The decisions the list offers for one row. The first four carry the row out;
 * `goal` changes what the next resume may spend without touching the park
 * itself.
 */
export const TRIAGE_ACTIONS = ['continue', 'note', 'review', 'leave', 'goal'] as const

/** One decision the list offers. */
export type TriageAction = (typeof TRIAGE_ACTIONS)[number]
