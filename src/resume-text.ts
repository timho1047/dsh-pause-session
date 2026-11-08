/**
 * User-facing copy and result shapes for the clean resume and tree release.
 * @module dsh-pause-session/resume-text
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PauseAnswer } from './shared.js'

/** Route knowledge the clean resume path needs. */
export interface ResumeOptions {
  /** Provider routes whose request conversion drops an empty user message. */
  readonly silentWakeRoutes: readonly string[]
}

/**
 * The one wake content a route that keeps an empty user message is given.
 */
export const WAKE_MARKER = '[pause: resumed from a pause]'

/** How one resume asks the loop for the request it owes the session. */
export type WakeRequest =
  | { readonly kind: 'silent' }
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'none' }

/** Result copy for a resumed session; the model never sees it. */
export const RESUMED_TEXT = 'This session resumed from where it paused.'

/** Result copy for a registered session whose park did not finish cleanly. */
export const UNCLEAN_TEXT = 'pause did not resume this session: its pause did not finish cleanly,'
  + ' so it needs your decision.'

/** Result copy when nothing is parked under that session. */
export const NOT_PARKED_TEXT = 'pause has no pause recorded for this session.'

/** Result copy for a session that is parked but could not be loaded back. */
export const ACTIVATION_FAILED_TEXT = 'pause could not reopen this session, so it stayed paused.'

/** Result copy for a one-shot subagent route. */
export const UNRESUMABLE_TEXT = 'pause did not resume this session: it is a one-shot subagent route and cannot be resumed.'

/** Result copy for the review decision. */
export const REVIEW_TEXT = 'pause did not activate this session: it is still parked, and nothing was sent to a model.'
  + ' Open it from your session list when you want to read it.'

/** Copy for one goal opt-out change. */
export const REARM_GOAL_ON_TEXT = 'pause will re-open this session\'s goal when it resumes it.'
export const REARM_GOAL_OFF_TEXT = 'pause will leave this session\'s goal closed when it resumes it.'

/** Why one record did not produce a running session. */
export type ResumeRefusal = 'not-parked' | 'not-clean' | 'activation-failed' | 'unrecorded' | 'not-activated' | 'unresumable'

/** What one resume attempt did. */
export interface ResumeOutcome {
  readonly sessionId: SessionId
  readonly resumed: boolean
  readonly refusal?: ResumeRefusal
}

/** One resume attempt plus the answer the caller receives. */
export interface ResumeAttempt extends ResumeOutcome {
  readonly answer: PauseAnswer
}

/** What releasing one session's registered tree did. */
export interface ReleaseTreeOutcome {
  readonly members: number
  readonly resumed: number
  readonly refusals: readonly { readonly sessionId: SessionId; readonly refusal: ResumeRefusal }[]
  readonly answer: PauseAnswer
}

/**
 * How one tree-wide release answers the person who pressed it.
 * @param released - the sessions this release covered, in release order.
 * @returns one sentence about what came back and what did not.
 */
export function summarizeTreeRelease(released: readonly ResumeAttempt[]): string {
  const resumed = released.filter(attempt => attempt.resumed).length
  const head = resumed === 0
    ? 'pause resumed nothing from this tree'
    : resumed === 1
      ? 'pause resumed 1 session from where it stopped'
      : `pause resumed ${resumed} sessions from where they stopped`
  const refused = released.filter(attempt => !attempt.resumed)
  if (refused.length === 0) return `${head}.`
  const named = refused
    .filter(attempt => attempt.refusal === 'not-clean')
    .map(attempt => `"${String(attempt.sessionId)}"`)
  const rest = named.length === 0
    ? `${String(refused.length)} could not be resumed`
    : refused.length === named.length
      ? `${named.join(', ')} did not pause completely`
      : `${named.join(', ')} did not pause completely, and ${String(refused.length - named.length)} more could not be resumed`
  return `${head}; ${rest}.`
}
