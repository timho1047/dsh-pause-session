/**
 * The controls' phase → view mapping.
 *
 * Kept pure functions of the published reading so the rendering decision — what
 * the button says, whether it accepts a press, and which state label is visible
 * — is asserted without a browser renderer. Labels are KEYS, not copy: the
 * visible sentence is localized, and the host's own names join it as data.
 * @module dsh-safe-stop/client/view
 */

import type { GlobalReading } from './global.js'
import type { SafeStopReading } from './control.js'
import type { SafeStopKey } from './locales.js'

/** What one reading renders as. */
export interface SafeStopView {
  /** Whether the host reported this session paused. */
  readonly paused: boolean
  /** Whether the control accepts a press; an unknown or failed reading does not. */
  readonly enabled: boolean
  /** Accessible name of the button. */
  readonly ariaKey: SafeStopKey
  /** Label shown beside the button while the control has something to say. */
  readonly labelKey?: SafeStopKey
  /** Tools in flight, taken verbatim from the host; rendered only with `labelKey`. */
  readonly runningTools: readonly string[]
}

/**
 * Map one reading to its view.
 * @param reading - the host-reported reading, or `undefined` before the first answer.
 * @returns the view for that reading.
 */
export function safeStopView(reading: SafeStopReading | undefined): SafeStopView {
  switch (reading?.phase) {
    case 'active':
      return { paused: false, enabled: true, ariaKey: 'pause.aria', runningTools: [] }
    case 'draining':
      // Still working: pressing again is exactly how the user takes the pause
      // back, so the control stays live.
      return {
        paused: true,
        enabled: true,
        ariaKey: 'draining.aria',
        labelKey: 'state.draining',
        runningTools: reading.runningTools,
      }
    case 'parking':
      return { paused: true, enabled: true, ariaKey: 'parking.aria', labelKey: 'state.parking', runningTools: [] }
    case 'safe':
      return { paused: true, enabled: true, ariaKey: 'safe.aria', labelKey: 'state.safe', runningTools: [] }
    case 'flush-failed':
      return {
        paused: true,
        enabled: true,
        ariaKey: 'flushFailed.aria',
        labelKey: 'state.flushFailed',
        runningTools: [],
      }
    case 'unavailable':
      return { paused: false, enabled: false, ariaKey: 'unavailable.aria', runningTools: [] }
    case undefined:
      return { paused: false, enabled: false, ariaKey: 'checking.aria', runningTools: [] }
  }
}

/** One named fact from the whole-app report, with the copy key that introduces it. */
export interface GlobalCaveat {
  /** What this list of names is. */
  readonly key: SafeStopKey
  /** Host names, rendered verbatim. */
  readonly names: readonly string[]
}

/** Which verb a whole-app press runs. */
export type GlobalAction = 'stop-all' | 'resume-all' | 'none'

/** What the whole-app reading renders as. */
export interface GlobalStopView {
  /** Whether the control renders at all; a control with no host answer claims nothing. */
  readonly visible: boolean
  /** Whether the control accepts a press. */
  readonly enabled: boolean
  /** Accessible name of the button. */
  readonly ariaKey: SafeStopKey
  /**
   * Headline shown beside the button. Absent while there is nothing to report:
   * an untouched park renders the bare affordance, not a sentence about itself.
   */
  readonly labelKey?: SafeStopKey
  /** Verb the press runs. */
  readonly action: GlobalAction
  /** Host numbers, rendered verbatim beside the label. */
  readonly detail: string
  /** Named facts the user must not miss; rendered on the tooltip. */
  readonly caveats: readonly GlobalCaveat[]
}

/**
 * Map one whole-app reading to its view.
 * @param reading - the host-reported reading, or `undefined` before the first answer.
 * @returns the view for that reading.
 */
export function globalStopView(reading: GlobalReading | undefined): GlobalStopView {
  if (reading === undefined) {
    return { visible: false, enabled: false, ariaKey: 'all.checking.aria', action: 'none', detail: '', caveats: [] }
  }
  // A host that cannot answer gets no control: this plugin never renders a
  // button whose state it would have to invent.
  if (reading.kind === 'unavailable') {
    return { visible: false, enabled: false, ariaKey: 'unavailable.aria', action: 'none', detail: '', caveats: [] }
  }
  const { status } = reading
  const caveats: GlobalCaveat[] = []
  // A missing surface subsumes its per-session names: the absence itself is the
  // fact, and listing every session it blinds would say less.
  if (status.blind.includes('jobs')) caveats.push({ key: 'all.caveat.blindJobs', names: [] })
  else if (status.jobs.length > 0) caveats.push({ key: 'all.caveat.jobs', names: status.jobs })
  if (status.blind.includes('trees')) caveats.push({ key: 'all.caveat.blindTrees', names: [] })
  else if (status.unreadTrees.length > 0) caveats.push({ key: 'all.caveat.unread', names: status.unreadTrees })
  if (status.unresumable.length > 0) caveats.push({ key: 'all.caveat.unresumable', names: status.unresumable })
  const verdict = status.verdict
  // The stalled names belong on the headline when they are the whole story,
  // and in the caveats when sessions are also still finishing.
  if (verdict !== 'safe' && status.stalled.length > 0 && status.draining.length > 0) {
    caveats.push({ key: 'all.caveat.stalled', names: status.stalled })
  }
  const base = { visible: true, enabled: true, caveats } as const
  switch (verdict) {
    case 'idle':
      // Nothing parked: the pill is the affordance itself, so it carries no
      // sentence about a park that does not exist.
      return { ...base, ariaKey: 'all.stop.aria', action: 'stop-all', detail: '' }
    case 'safe':
      return {
        ...base,
        ariaKey: 'all.resume.aria',
        action: 'resume-all',
        labelKey: 'all.safe',
        detail: `${String(status.safe)}/${String(status.registered)}`,
      }
    case 'waiting':
      return status.draining.length > 0
        ? {
          ...base,
          ariaKey: 'all.resume.aria',
          action: 'resume-all',
          labelKey: 'all.finishing',
          detail: `${String(status.safe)}/${String(status.registered)}`,
        }
        : {
          ...base,
          ariaKey: 'all.resume.aria',
          action: 'resume-all',
          labelKey: 'all.unclean',
          detail: String(status.stalled.length),
        }
  }
}
