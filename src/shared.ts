/**
 * The identities both halves of dsh-safe-stop name, the status encodings they
 * share, and the one spelling a host log line gives a caught value.
 *
 * The browser bundle may value-import only the shell's baseline module table,
 * so this module imports nothing: the client half reads command names and the
 * decode functions from it directly, and the host half derives the branded
 * identities from the same strings.
 *
 * A third-party plugin's only live channel to the browser is the command
 * registry — it can add neither a `ctx.remote` namespace nor a forwarded event,
 * both of which are compiled into the harness's own API assembly. A command
 * descriptor's only free-form field is its `description`, and a command
 * result's only free-form field is its `text`, so the park state travels as a
 * prefix plus `;`-separated fields on one of those. The text stays
 * human-readable: the same words are what the slash-command menu shows.
 *
 * Every value inside a field is escaped, so a decoded name is the exact name
 * that was encoded. Session ids, tool names, and call ids are the host's own
 * data and may contain the `;`, `,`, `/`, or newline a field is separated by; a
 * folded spelling would decode as a different name — a different row, looked up
 * again.
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
 * One list field's text when the list is empty. A value that would itself spell
 * this marker is escaped by {@link escapeField}, so an empty list and a list
 * holding the marker stay different texts.
 */
const EMPTY_FIELD = '-'

/**
 * One field or item value, ready to sit inside an encoded text: every separator
 * (`;`, `,`, `/`, newline) and the escape character itself are escaped, and a
 * value that would spell {@link EMPTY_FIELD} is escaped so it is not read as an
 * empty list.
 * @param text - the value to encode, as the host holds it.
 * @returns the value as it appears inside an encoded field.
 */
function escapeField(text: string): string {
  const escaped = text.replace(/[\\;,\n/]/g, character => character === '\n' ? '\\n' : `\\${character}`)
  return escaped.startsWith(EMPTY_FIELD) ? `\\${escaped}` : escaped
}

/**
 * One value previously written by {@link escapeField}.
 * @param text - the encoded value, escapes included.
 * @returns the value the host holds.
 */
function unescapeField(text: string): string {
  return text.replace(/\\(.)/g, (_escape, character: string) => character === 'n' ? '\n' : character)
}

/**
 * Split one encoded text on the separators that are not escaped, keeping each
 * escape beside the character it protects so {@link unescapeField} can read it.
 * @param text - an encoded text, without its prefix.
 * @param separator - the single character to split on.
 * @returns the parts, in order; always at least one.
 */
function splitFields(text: string, separator: string): string[] {
  const parts: string[] = []
  let part = ''
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at] ?? ''
    if (character === '\\') {
      part += character + (text[at + 1] ?? '')
      at += 1
      continue
    }
    if (character === separator) {
      parts.push(part)
      part = ''
      continue
    }
    part += character
  }
  parts.push(part)
  return parts
}

/**
 * One field of an encoded text, by its key.
 * @param fields - the separated fields of one encoded text.
 * @param key - the field's key, without its `:`.
 * @returns the field's value with its escapes still in place, or `undefined`
 * when the text does not carry that field.
 */
function fieldOf(fields: readonly string[], key: string): string | undefined {
  const prefix = `${key}:`
  const at = fields.findIndex(field => field.trim().startsWith(prefix))
  return at < 0 ? undefined : fields[at]?.trim().slice(prefix.length).trim()
}

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
  return status.runningTools.length === 0
    ? head
    : `${head}; tools: ${status.runningTools.map(escapeField).join(', ')}`
}

/**
 * Decode a status previously written by {@link encodeParkStatus}.
 * @param text - a command descriptor's description.
 * @returns the status, or `undefined` when this text carries none — a foreign
 * command, or a reading taken before the host published anything.
 */
export function decodeParkStatus(text: string): ParkStatus | undefined {
  if (!text.startsWith(STATUS_PREFIX)) return undefined
  const [head = '', ...rest] = splitFields(text.slice(STATUS_PREFIX.length), ';')
  const word = head.trim()
  const phase = (Object.keys(PHASE_WORD) as ParkPhase[]).find(candidate => PHASE_WORD[candidate] === word)
  if (phase === undefined) return undefined
  return { phase, safe: phase === 'safe', runningTools: decodeNames(fieldOf(rest, 'tools')) }
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

/** Encode one list field. */
function encodeNames(names: readonly string[]): string {
  return names.length === 0 ? EMPTY_FIELD : names.map(escapeField).join(', ')
}

/** Decode one list field. */
function decodeNames(field: string | undefined): string[] {
  const text = field?.trim()
  if (text === undefined || text.length === 0 || text === EMPTY_FIELD) return []
  return splitFields(text, ',')
    .map(name => unescapeField(name.trim()))
    .filter(name => name.length > 0)
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
  const [head = '', ...fields] = splitFields(text.slice(GLOBAL_STATUS_PREFIX.length), ';')
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

/** One row's traces, as a list of `tool/callId` items. */
function encodeTraces(traces: readonly TriageTrace[]): string {
  if (traces.length === 0) return EMPTY_FIELD
  return traces
    .map(trace => `${escapeField(trace.tool)}/${escapeField(trace.callId)}`)
    .join(', ')
}

/** Decode {@link encodeTraces}; an item without a tool name is not a trace. */
function decodeTraces(field: string | undefined): TriageTrace[] {
  const text = field?.trim()
  if (text === undefined || text.length === 0 || text === EMPTY_FIELD) return []
  return splitFields(text, ',').flatMap((item) => {
    // Only the separator between the two halves is unescaped, so the split is
    // exact even for a tool name or a call id that carries a slash itself.
    const [tool = '', callId = ''] = splitFields(item.trim(), '/')
    if (tool.length === 0) return []
    return [{ tool: unescapeField(tool), callId: unescapeField(callId) }]
  })
}

/** One row's stop position, encoded as `<last event>` plus the step it belongs to. */
function encodeStop(row: TriageRow): string {
  if (row.lastEvent === undefined) return EMPTY_FIELD
  const position = row.turn === undefined
    ? ''
    : `/turn ${String(row.turn)}${row.step === undefined ? '' : ` step ${String(row.step)}`}`
  return `${escapeField(row.lastEvent)}${position}`
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
    return `${text}; row: ${escapeField(row.sessionId)}`
      + `; phase: ${row.phase}`
      + `; stopped: ${stopped}`
      + `; traces: ${row.reading === 'unreadable' ? EMPTY_FIELD : encodeTraces(row.traces)}`
      + `; tools: ${row.reading === 'unreadable' || row.traces.length === 0 ? EMPTY_FIELD : encodeNames(row.traces.map(trace => trace.tool))}`
      + `; owed: ${row.owed ? WAKE_YES : 'no'}`
      + `; wake: ${row.wakeable ? WAKE_YES : 'no'}`
  }, head)
}

/**
 * Decode a decision list previously written by {@link encodeTriageList}.
 * @param text - a command result's text.
 * @returns the list, or `undefined` when this text carries none.
 */
export function decodeTriageList(text: string): TriageList | undefined {
  if (!text.startsWith(TRIAGE_PREFIX)) return undefined
  const [head = '', ...rest] = splitFields(text.slice(TRIAGE_PREFIX.length), ';')
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
    // An encoded event name has every slash escaped, so the `/turn` suffix is
    // the field's only raw slash and the lazy match ends exactly there. A row
    // the host could not read has no event to name, and a row whose log ends on
    // no event at all carries the empty marker instead.
    const position = reading === 'unreadable' || stopped === undefined || stopped === EMPTY_FIELD
      ? null
      : /^(.*?)(?:\/turn (\d+)(?: step (\d+))?)?$/.exec(stopped)
    rows.push({
      sessionId: unescapeField(sessionId),
      phase: phase as TriageRow['phase'],
      updatedAt: 0,
      reading,
      ...position === null
        ? {}
        : {
          lastEvent: unescapeField(position[1] ?? ''),
          ...position[2] === undefined ? {} : { turn: Number(position[2]) },
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
