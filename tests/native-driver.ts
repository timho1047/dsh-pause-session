/**
 * The test driver for the plugin's native Remote surface.
 *
 * Tests speak the same channel the browser does: button actions through
 * `pauseSession.act`, live state through `pauseSession.snapshot`, and the
 * morning decision list through `triage`/`decide`. There is no slash-command
 * registry underneath and no descriptor identity to match; the snapshot and
 * the action answers are the whole observable contract.
 * @module dsh-pause-session/test/native-driver
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  GlobalStatusWire, PauseActionResultWire, PauseRemote, PauseSnapshotWire, TriageRowWire,
} from '../src/remote.ts'
import type { ParkStatus, TriageAction } from '../src/shared.ts'

/** A session as a test has it: the live agent, its branded id, or its plain id. */
export type PauseActor = Agent | SessionId | string

/** The button actions the native namespace exposes. */
export type PauseAction = 'pause' | 'resume' | 'pause-all' | 'resume-all' | 'goal'

/** The old test-side names for those actions, kept so a spec reads like the UI it drives. */
export type PauseVerb = 'pause' | 'pause-resume' | 'pause-all' | 'pause-resume-all' | 'pause-goal'

/** Old test verb to native action. */
const ACTION_OF: Record<PauseVerb, PauseAction> = {
  pause: 'pause',
  'pause-resume': 'resume',
  'pause-all': 'pause-all',
  'pause-resume-all': 'resume-all',
  'pause-goal': 'goal',
}

/**
 * Read the mounted native service.
 * @param ctx - a context the plugin is mounted on.
 * @returns the `pauseSession` service.
 * @throws when the plugin is not mounted, rather than letting a test silently
 * read an undefined transport.
 */
export function pauseRemote(ctx: Context): PauseRemote {
  const remote = ctx.get('pauseSession') as PauseRemote | undefined
  if (remote === undefined) throw new Error('pause: ctx.pauseSession is not mounted')
  return remote
}

/**
 * Normalise a session handle to the id the wire carries.
 * @param actor - the session as the test names it.
 * @returns the branded session id.
 */
export function sessionOf(actor: PauseActor): SessionId {
  return typeof actor === 'string' ? SessionId(actor) : actor.id
}

/**
 * Press one native action.
 * @param ctx - the context holding the plugin.
 * @param action - the button action.
 * @param actor - the session the action is addressed through.
 * @param options - an optional decision target and cancellation signal.
 * @returns the user-facing outcome.
 */
export async function act(
  ctx: Context,
  action: PauseAction,
  actor: PauseActor,
  options: { target?: PauseActor; signal?: AbortSignal } = {},
): Promise<PauseActionResultWire> {
  const request = {
    action,
    sessionId: String(sessionOf(actor)),
    ...options.target === undefined ? {} : { target: String(sessionOf(options.target)) },
  }
  return await pauseRemote(ctx).act(request, options.signal)
}

/**
 * Press one action by its test-side verb.
 * @param ctx - the context holding the plugin.
 * @param actor - the session the action is addressed through.
 * @param verb - the verb the spec names.
 * @param signal - carrier cancellation.
 * @returns the user-facing outcome.
 */
export function press(
  ctx: Context,
  actor: PauseActor,
  verb: PauseVerb,
  signal?: AbortSignal,
): Promise<PauseActionResultWire> {
  return act(ctx, ACTION_OF[verb], actor, { signal })
}

/** Pause the actor's session tree. */
export function pause(ctx: Context, actor: PauseActor, signal?: AbortSignal): Promise<PauseActionResultWire> {
  return act(ctx, 'pause', actor, { signal })
}

/** Take the actor session's pause back. */
export function resume(ctx: Context, actor: PauseActor, signal?: AbortSignal): Promise<PauseActionResultWire> {
  return act(ctx, 'resume', actor, { signal })
}

/** Press every running session tree, addressed through `actor`. */
export function pauseAll(ctx: Context, actor: PauseActor, signal?: AbortSignal): Promise<PauseActionResultWire> {
  return act(ctx, 'pause-all', actor, { signal })
}

/** Resume every cleanly parked session, addressed through `actor`. */
export function resumeAll(ctx: Context, actor: PauseActor, signal?: AbortSignal): Promise<PauseActionResultWire> {
  return act(ctx, 'resume-all', actor, { signal })
}

/** Flip the actor session's own goal re-arm opt-out. */
export function toggleGoal(ctx: Context, actor: PauseActor, signal?: AbortSignal): Promise<PauseActionResultWire> {
  return act(ctx, 'goal', actor, { signal })
}

/**
 * Read one exact snapshot.
 * @param ctx - the context holding the plugin.
 * @param signal - cancellation for the snapshot's tree reads.
 * @returns the aggregate and every held session.
 */
export function snapshot(ctx: Context, signal?: AbortSignal): Promise<PauseSnapshotWire> {
  return pauseRemote(ctx).snapshot(signal)
}

/**
 * Read one session's status out of a native snapshot.
 * @param ctx - the context holding the plugin.
 * @param actor - the session to read.
 * @param signal - cancellation for the snapshot.
 * @returns the session's status, or `undefined` when nothing is held for it.
 */
export async function statusOf(
  ctx: Context,
  actor: PauseActor,
  signal?: AbortSignal,
): Promise<ParkStatus | undefined> {
  const wire = (await snapshot(ctx, signal)).sessions[String(sessionOf(actor))]
  if (wire === undefined) return undefined
  return {
    phase: wire.phase,
    safe: wire.phase === 'safe',
    runningTools: wire.runningTools,
    ...wire.rearmGoal === undefined ? {} : { rearmGoal: wire.rearmGoal },
  }
}

/**
 * Read the whole-app aggregate out of a native snapshot.
 * @param ctx - the context holding the plugin.
 * @param signal - cancellation for the snapshot.
 * @returns the aggregate.
 */
export async function aggregate(ctx: Context, signal?: AbortSignal): Promise<GlobalStatusWire> {
  return (await snapshot(ctx, signal)).global
}

/**
 * Read the morning decision list for one caller.
 * @param ctx - the context holding the plugin.
 * @param caller - the session whose list is read.
 * @param signal - cancellation for the log reads.
 * @returns the listed rows.
 */
export function triage(
  ctx: Context,
  caller: PauseActor,
  signal?: AbortSignal,
): Promise<readonly TriageRowWire[]> {
  return pauseRemote(ctx).triage({ caller: String(sessionOf(caller)) }, signal)
}

/**
 * Take one decision on one listed session.
 * @param ctx - the context holding the plugin.
 * @param caller - the session that read the list.
 * @param target - the listed session being decided.
 * @param decision - the decision to take.
 * @param signal - cancellation for the resume path.
 * @returns the user-facing outcome.
 */
export function decide(
  ctx: Context,
  caller: PauseActor,
  target: PauseActor,
  decision: TriageAction,
  signal?: AbortSignal,
): Promise<PauseActionResultWire> {
  return pauseRemote(ctx).decide({
    caller: String(sessionOf(caller)),
    target: String(sessionOf(target)),
    decision,
  }, signal)
}

/**
 * Turn an action answer into the test's failure channel.
 * @param answer - the native outcome.
 * @param what - the verb being reported, for the message.
 * @returns the same answer, when it succeeded.
 * @throws when the host refused the action.
 */
export function ensureOk(answer: PauseActionResultWire, what: string): PauseActionResultWire {
  if (!answer.ok) throw new Error(`pause: ${what} failed: ${answer.message}`)
  return answer
}
