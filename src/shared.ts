/**
 * The identities both halves of dsh-safe-stop name, and the one status
 * encoding they share.
 *
 * The browser bundle may value-import only the shell's baseline module table,
 * so this module is the one place the client half and the host half agree on
 * the control's command names and on how the host's park state is spelled
 * without sharing a runtime edge: it imports nothing, and the host half
 * derives the branded identities from these strings.
 *
 * THE ENCODING IS A WORKAROUND WITH A REASON: a third-party plugin can publish
 * live state to the browser only through the command registry (no `ctx.remote`
 * namespace, no forwarded event — both are compiled into the harness's own API
 * assembly). A command descriptor's only free-form field is its `description`,
 * so the park state travels as a prefix plus `;`-separated fields on that
 * field. The sentence stays human-readable on purpose: the same text is what
 * the slash-command menu shows.
 * @module dsh-safe-stop/shared
 */

/** Command that pauses the receiving session before its next model request. */
export const PAUSE_COMMAND = 'safe-stop'

/** Command that resumes the receiving session; registered only while that session is paused. */
export const RESUME_COMMAND = 'safe-resume'

/** Command that resumes every parked session the registry remembers. */
export const RESUME_ALL_COMMAND = 'safe-resume-all'

/** Command that registers and parks every running session tree in one action. */
export const STOP_ALL_COMMAND = 'safe-stop-all'

/** Command that reports the whole-app park state; registered globally, always. */
export const STATE_ALL_COMMAND = 'safe-state-all'

/** Command that reports the receiving session's park state; registered only while it is paused. */
export const STATUS_COMMAND = 'safe-state'

/** Command that reports every session that did not stop cleanly. */
export const TRIAGE_COMMAND = 'safe-triage'

/** Command that resumes one session from the decision list exactly as the clean path would. */
export const TRIAGE_CONTINUE_COMMAND = 'safe-triage-continue'

/** Command that resumes one session from the decision list with the unknown-outcome note. */
export const TRIAGE_NOTE_COMMAND = 'safe-triage-note'

/** Command that opens one session from the decision list without spending a request. */
export const TRIAGE_REVIEW_COMMAND = 'safe-triage-review'

/** Command that leaves one session from the decision list exactly as it is. */
export const TRIAGE_LEAVE_COMMAND = 'safe-triage-leave'

/** Stable definition id of the pause command, matched by identity rather than by copy. */
export const PAUSE_DEFINITION_ID = 'dsh-safe-stop/pause'

/** Stable definition id of the resume command: the host's own "this session is paused" fact. */
export const RESUME_DEFINITION_ID = 'dsh-safe-stop/resume'

/** Stable definition id of the global resume command, matched by identity rather than by copy. */
export const RESUME_ALL_DEFINITION_ID = 'dsh-safe-stop/resume-all'

/** Stable definition id of the whole-app pause command. */
export const STOP_ALL_DEFINITION_ID = 'dsh-safe-stop/stop-all'

/** Stable definition id of the whole-app status read. */
export const STATE_ALL_DEFINITION_ID = 'dsh-safe-stop/state-all'

/** Stable definition id of the status read, matched by identity rather than by copy. */
export const STATUS_DEFINITION_ID = 'dsh-safe-stop/status'

/** Stable definition id of the decision-list read. */
export const TRIAGE_DEFINITION_ID = 'dsh-safe-stop/triage'

/** Stable definition id of the decision-list "continue" verb. */
export const TRIAGE_CONTINUE_DEFINITION_ID = 'dsh-safe-stop/triage-continue'

/** Stable definition id of the decision-list "continue with the unknown-outcome note" verb. */
export const TRIAGE_NOTE_DEFINITION_ID = 'dsh-safe-stop/triage-note'

/** Stable definition id of the decision-list "open without activating" verb. */
export const TRIAGE_REVIEW_DEFINITION_ID = 'dsh-safe-stop/triage-review'

/** Stable definition id of the decision-list "leave it alone today" verb. */
export const TRIAGE_LEAVE_DEFINITION_ID = 'dsh-safe-stop/triage-leave'

/** First token of every encoded status, so a descriptor is never parsed by accident. */
export const STATUS_PREFIX = 'safe-stop: '

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

/** The one word each phase is published as, and the whole decoding vocabulary. */
const PHASE_WORD: Record<ParkPhase, string> = {
  draining: 'draining',
  parking: 'flushing',
  safe: 'safe to close',
  'flush-failed': 'could not flush',
}

/** Everything the browser is told about one paused session. */
export interface ParkStatus {
  readonly phase: ParkPhase
  /** Whether the host commits to "you can close the lid now". */
  readonly safe: boolean
  /** Tools in flight when the status was published; empty once parked. */
  readonly runningTools: readonly string[]
}

/**
 * Encode one status for a command descriptor.
 * @param status - the state to publish.
 * @returns the descriptor text, e.g. `safe-stop: draining; tools: edit, bash`.
 */
export function encodeParkStatus(status: ParkStatus): string {
  const head = `${STATUS_PREFIX}${PHASE_WORD[status.phase]}`
  return status.runningTools.length === 0 ? head : `${head}; tools: ${status.runningTools.join(', ')}`
}

/**
 * Decode a status previously written by {@link encodeParkStatus}.
 * @param text - a command descriptor's description.
 * @returns the status, or `undefined` when this text carries none — a foreign
 * command, or a reading taken before the host published anything.
 */
export function decodeParkStatus(text: string): ParkStatus | undefined {
  if (!text.startsWith(STATUS_PREFIX)) return undefined
  const [head = '', ...rest] = text.slice(STATUS_PREFIX.length).split(';')
  const word = head.trim()
  const phase = (Object.keys(PHASE_WORD) as ParkPhase[]).find(candidate => PHASE_WORD[candidate] === word)
  if (phase === undefined) return undefined
  const tools = rest
    .map(field => field.trim())
    .find(field => field.startsWith('tools:'))
    ?.slice('tools:'.length)
    .split(',')
    .map(name => name.trim())
    .filter(name => name.length > 0) ?? []
  return { phase, safe: phase === 'safe', runningTools: tools }
}

/**
 * First token of every encoded whole-app status. A different prefix from the
 * per-session status on purpose: one decoder must never read the other's text.
 */
export const GLOBAL_STATUS_PREFIX = 'safe-stop all: '

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
  /** Registered sessions still on their way to the park point. */
  readonly draining: readonly string[]
  /**
   * Registered sessions that will not reach the park point in this process: a
   * flush that failed, a pause adopted from an earlier process, or a press
   * whose registry write failed. Named, never folded into the count and
   * forgotten.
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

/** What an empty list field looks like, so a field is never silently absent. */
const NO_NAMES = '-'

/**
 * One name, stripped of the two characters the encoding separates fields and
 * items with. Session ids come from the host (`session-<uuid>` or a caller's
 * id), so this only ever guards the parse, never a human's reading of a name.
 */
function plainName(name: string): string {
  return name.replace(/[;,\n]/g, '_')
}

/** Encode one list field. */
function encodeNames(names: readonly string[]): string {
  return names.length === 0 ? NO_NAMES : names.map(plainName).join(', ')
}

/** Decode one list field. */
function decodeNames(field: string | undefined): string[] {
  const text = field?.trim()
  if (text === undefined || text.length === 0 || text === NO_NAMES) return []
  return text.split(',').map(name => name.trim()).filter(name => name.length > 0)
}

/**
 * Encode one whole-app status for a command result.
 * @param status - the state to publish.
 * @returns the result text, e.g.
 * `safe-stop all: waiting; registered: 3; safe: 1; draining: overnight; stalled: -; unresumable: -; unread-trees: -; jobs: bash-1; blind: -`.
 */
export function encodeGlobalStatus(status: GlobalStatus): string {
  return `${GLOBAL_STATUS_PREFIX}${status.verdict}`
    + `; registered: ${status.registered}`
    + `; safe: ${status.safe}`
    + `; draining: ${encodeNames(status.draining)}`
    + `; stalled: ${encodeNames(status.stalled)}`
    + `; unresumable: ${encodeNames(status.unresumable)}`
    + `; unread-trees: ${encodeNames(status.unreadTrees)}`
    + `; jobs: ${encodeNames(status.jobs)}`
    + `; blind: ${encodeNames(status.blind)}`
}

/**
 * Decode a whole-app status previously written by {@link encodeGlobalStatus}.
 * @param text - a command result's text.
 * @returns the status, or `undefined` when this text carries none.
 */
export function decodeGlobalStatus(text: string): GlobalStatus | undefined {
  if (!text.startsWith(GLOBAL_STATUS_PREFIX)) return undefined
  const [head = '', ...fields] = text.slice(GLOBAL_STATUS_PREFIX.length).split(';')
  const verdict = head.trim()
  if (verdict !== 'idle' && verdict !== 'waiting' && verdict !== 'safe') return undefined
  const byKey = new Map<string, string>()
  for (const field of fields) {
    const at = field.indexOf(':')
    if (at < 0) continue
    byKey.set(field.slice(0, at).trim(), field.slice(at + 1).trim())
  }
  const count = (key: string): number => {
    const value = Number(byKey.get(key))
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  }
  return {
    verdict,
    registered: count('registered'),
    safe: count('safe'),
    draining: decodeNames(byKey.get('draining')),
    stalled: decodeNames(byKey.get('stalled')),
    unresumable: decodeNames(byKey.get('unresumable')),
    unreadTrees: decodeNames(byKey.get('unread-trees')),
    jobs: decodeNames(byKey.get('jobs')),
    blind: decodeNames(byKey.get('blind')).filter((spot): spot is GlobalBlindSpot => spot === 'trees' || spot === 'jobs'),
  }
}

/**
 * First token of every encoded decision list. Separate from the per-session and
 * whole-app status prefixes on purpose, for the same reason those two are
 * separate: one decoder must never read another's text.
 */
export const TRIAGE_PREFIX = 'safe-stop triage: '

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

/** The four decisions the list offers for one row. */
export const TRIAGE_ACTIONS = ['continue', 'note', 'review', 'leave'] as const

/** One decision the list offers. */
export type TriageAction = (typeof TRIAGE_ACTIONS)[number]

/** How one row is spelled in the published list; the wake field's state when the host can hand over the owed request. */
const WAKE_YES = 'yes'

/** Field text for an empty name list, so a field is never silently absent. */
const NONE = 'none'

/**
 * One field's text: a fact whose spelling may contain the two separators is
 * folded, because session ids and tool names are the host's data and the
 * encoding is the only thing that must survive being parsed.
 */
function plainField(text: string): string {
  return text.replace(/[;,\n]/g, '_')
}

/** One row's traces, as a list of `tool/callId` items. */
function encodeTraces(traces: readonly TriageTrace[]): string {
  if (traces.length === 0) return NONE
  return traces
    .map(trace => `${plainField(trace.tool)}/${plainField(trace.callId)}`)
    .join(', ')
}

/** Decode {@link encodeTraces}; an item without a tool name is not a trace. */
function decodeTraces(field: string | undefined): TriageTrace[] {
  const text = field?.trim()
  if (text === undefined || text.length === 0 || text === NONE) return []
  return text.split(',').flatMap((item) => {
    const entry = item.trim()
    const at = entry.indexOf('/')
    if (at <= 0) return []
    return [{ tool: entry.slice(0, at), callId: entry.slice(at + 1) }]
  })
}

/** One row's stop position, encoded as `<last event>` plus the step it belongs to. */
function encodeStop(row: TriageRow): string {
  if (row.lastEvent === undefined) return NONE
  const position = row.turn === undefined
    ? ''
    : `/turn ${String(row.turn)}${row.step === undefined ? '' : ` step ${String(row.step)}`}`
  return `${plainField(row.lastEvent)}${position}`
}

/**
 * Encode one decision list for a command result.
 * @param list - the rows to publish.
 * @returns the result text, e.g. `safe-stop triage: 1; row: overnight; phase: draining; stopped: tool/call/turn 1 step 1; tools: gated; wake: yes`.
 */
export function encodeTriageList(list: TriageList): string {
  const head = `${TRIAGE_PREFIX}${String(list.rows.length)}`
  return list.rows.reduce((text, row) => {
    const stopped = row.reading === 'unreadable' ? 'unreadable' : encodeStop(row)
    return `${text}; row: ${plainField(row.sessionId)}`
      + `; phase: ${row.phase}`
      + `; stopped: ${stopped}`
      + `; traces: ${row.reading === 'unreadable' ? NONE : encodeTraces(row.traces)}`
      + `; tools: ${row.reading === 'unreadable' || row.traces.length === 0 ? NONE : encodeNames(row.traces.map(trace => trace.tool))}`
      + `; owed: ${row.owed ? WAKE_YES : 'no'}`
      + `; wake: ${row.wakeable ? WAKE_YES : 'no'}`
  }, head)
}

/** Decode one field of an encoded row, or `undefined` when the row does not carry it. */
function fieldOf(fields: readonly string[], key: string): string | undefined {
  const prefix = `${key}:`
  const at = fields.findIndex(field => field.trim().startsWith(prefix))
  return at < 0 ? undefined : fields[at]?.trim().slice(prefix.length).trim()
}

/**
 * Decode a decision list previously written by {@link encodeTriageList}.
 * @param text - a command result's text.
 * @returns the list, or `undefined` when this text carries none.
 */
export function decodeTriageList(text: string): TriageList | undefined {
  if (!text.startsWith(TRIAGE_PREFIX)) return undefined
  const [head = '', ...rest] = text.slice(TRIAGE_PREFIX.length).split(';')
  if (!Number.isSafeInteger(Number(head.trim())) || Number(head.trim()) < 0) return undefined
  const rows: TriageRow[] = []
  let fields: string[] = []
  const flush = (): void => {
    if (fields.length === 0) return
    const sessionId = fieldOf(fields, 'row')
    const phase = fieldOf(fields, 'phase')
    if (sessionId === undefined || phase === undefined || phase === 'safe') return
    const stopped = fieldOf(fields, 'stopped')
    const reading: TriageReading = stopped === 'unreadable' ? 'unreadable' : 'read'
    // The event name may itself contain a slash (`tool/call`), so the name is
    // matched lazily and the `/turn` suffix is what ends it. An unreadable row
    // has no event to name, so it is not run through this at all.
    const position = reading === 'unreadable'
      ? null
      : /^(.*?)(?:\/turn (\d+)(?: step (\d+))?)?$/.exec(stopped ?? '')
    rows.push({
      sessionId,
      phase: phase as TriageRow['phase'],
      updatedAt: 0,
      reading,
      ...position === null
        ? {}
        : {
          lastEvent: position[1] ?? '',
          turn: Number(position[2]),
          ...position[3] === undefined ? {} : { step: Number(position[3]) },
        },
      traces: reading === 'unreadable' ? [] : decodeTraces(fieldOf(fields, 'traces')),
      owed: fieldOf(fields, 'owed') === WAKE_YES,
      wakeable: fieldOf(fields, 'wake') === WAKE_YES,
    })
    fields = []
  }
  for (const field of rest) {
    if (field.trim().startsWith('row:')) flush()
    fields.push(field)
  }
  flush()
  return { rows }
}
