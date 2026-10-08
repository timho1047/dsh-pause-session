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

/** Command that reports the receiving session's park state; registered only while it is paused. */
export const STATUS_COMMAND = 'safe-state'

/** Stable definition id of the pause command, matched by identity rather than by copy. */
export const PAUSE_DEFINITION_ID = 'dsh-safe-stop/pause'

/** Stable definition id of the resume command: the host's own "this session is paused" fact. */
export const RESUME_DEFINITION_ID = 'dsh-safe-stop/resume'

/** Stable definition id of the global resume command, matched by identity rather than by copy. */
export const RESUME_ALL_DEFINITION_ID = 'dsh-safe-stop/resume-all'

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
