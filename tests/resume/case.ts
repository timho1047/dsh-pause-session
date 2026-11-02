/**
 * The facts both sides of the resume proof have to agree on: what the parked
 * session was waiting for, and what the goal it was carrying asks for. Kept out
 * of the child module on purpose — importing that module runs it.
 * @module dsh-pause/test/resume/case
 */

/** The input the parked session left unanswered; the parent asserts the model got it. */
export const PENDING_INPUT = 'answer the question I asked before you stopped'

/** The goal the parked session was carrying. */
export const GOAL_OBJECTIVE = 'finish the overnight report'

/** How the child leaves the parked session behind. */
export type ParkMode = 'clean' | 'goal' | 'goal-draining' | 'tool-result' | 'draining' | 'parking' | 'flush-failed'
