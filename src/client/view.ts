/**
 * The control's phase → view mapping.
 *
 * Kept a pure function of the published phase so the rendering decision — what
 * the button says, whether it accepts a press, and whether the visible "paused"
 * label is shown — is asserted without a browser renderer.
 * @module dsh-safe-stop/client/view
 */

import type { SafeStopPhase } from './control.js'
import type { SafeStopKey } from './locales.js'

/** What one phase renders as. */
export interface SafeStopView {
  /** Whether the host reported this session paused. */
  readonly paused: boolean
  /** Whether the control accepts a press; an unknown or failed reading does not. */
  readonly enabled: boolean
  /** Accessible name of the button. */
  readonly ariaKey: SafeStopKey
  /** Hover copy, shown only when no visible state label replaces it. */
  readonly tipKey: SafeStopKey
  /** Whether the visible "paused" label is rendered beside the button. */
  readonly stateLabel: boolean
}

/**
 * Map one phase to its view.
 * @param phase - the host-reported phase, or `undefined` before the first answer.
 * @returns the view for that phase.
 */
export function safeStopView(phase: SafeStopPhase | undefined): SafeStopView {
  switch (phase) {
    case 'paused':
      return { paused: true, enabled: true, ariaKey: 'resume.aria', tipKey: 'resume.tip', stateLabel: true }
    case 'active':
      return { paused: false, enabled: true, ariaKey: 'pause.aria', tipKey: 'pause.tip', stateLabel: false }
    case 'unavailable':
      return {
        paused: false,
        enabled: false,
        ariaKey: 'unavailable.aria',
        tipKey: 'unavailable.tip',
        stateLabel: false,
      }
    case undefined:
      return { paused: false, enabled: false, ariaKey: 'checking.aria', tipKey: 'checking.tip', stateLabel: false }
  }
}
