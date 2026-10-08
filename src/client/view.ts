/**
 * The control's phase → view mapping.
 *
 * Kept a pure function of the published reading so the rendering decision — what
 * the button says, whether it accepts a press, and which state label is visible
 * — is asserted without a browser renderer. The label is a KEY, not copy: the
 * visible sentence is localized, and the host's own tool names join it as data.
 * @module dsh-safe-stop/client/view
 */

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
