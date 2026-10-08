/**
 * The identities both halves of dsh-safe-stop name.
 *
 * The browser bundle may value-import only the shell's baseline module table,
 * so this module is the one place the client half and the host half agree on
 * the control's command names without sharing a runtime edge: it imports
 * nothing, and the host half derives the branded identities from these strings.
 * @module dsh-safe-stop/shared
 */

/** Command that pauses the receiving session before its next model request. */
export const PAUSE_COMMAND = 'safe-stop'

/** Command that resumes the receiving session; registered only while that session is paused. */
export const RESUME_COMMAND = 'safe-resume'

/** Stable definition id of the pause command, matched by identity rather than by copy. */
export const PAUSE_DEFINITION_ID = 'dsh-safe-stop/pause'

/** Stable definition id of the resume command: the host's own "this session is paused" fact. */
export const RESUME_DEFINITION_ID = 'dsh-safe-stop/resume'
