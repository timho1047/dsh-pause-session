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
