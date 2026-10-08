/**
 * The whole-app control: one pill in the frame-wide overlay layer that answers
 * "can I close the lid?" and presses the park or the release.
 *
 * The layer is the only root-scoped, additive seat the shell declares for a
 * frame-wide surface of its own, and it is exactly what this is — a status
 * pill outside every column, above every panel, click-through except for its
 * own entries. The per-session control stays in the session header where the
 * session it acts on is.
 *
 * The pill reads the host through the command channel only (`./global.ts`):
 * with no answer, or with no session to ask through, it renders nothing rather
 * than a state it would have to invent.
 * @module dsh-safe-stop/client/pill
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-layout SlotMap merge (the root-scoped shell.overlay).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the ui-session GlobalStandardProps merge (useSessions).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { addressingSession } from './global.js'
import type { GlobalStopState } from './global.js'
import { globalStopView } from './view.js'
import { CaveatIcon, PauseIcon, ResumeIcon } from './icons.js'
import styles from './button.module.css'

/** Browser state and operations injected into the whole-app pill. */
export interface SafeStopPillInjected {
  hooks: { safeStopGlobal: ObservableSnapshot<GlobalStopState> }
  /** Read the host's whole-app state through one session. */
  refresh: (sessionId: SessionId) => void
  /** Press the pill for one session. */
  toggle: (sessionId: SessionId) => void
}

/** Full props of the frame-wide safe-stop pill. */
export type SafeStopPillProps = PropsRuntime<'shell.overlay'>
  & InjectFace<SafeStopPillInjected>
  & PropsLocale<'safe-stop'>

/**
 * The frame-wide control: what the host says about the whole park, and the one
 * press that parks or releases all of it.
 * @param props - shell runtime, host operations, and localized copy.
 * @returns the pill, or nothing while the host has not answered.
 */
export function SafeStopPill(props: SafeStopPillProps): ReactNode {
  const { refresh, toggle, t, useSessions } = props
  const reading = props.useSafeStopGlobal(state => state.global)
  // The command channel is session-addressed: one user session is the address
  // every whole-app read and press goes through.
  const address = useSessions(addressingSession)
  const view = globalStopView(reading)
  // Read once per address: the host is the source of truth, and the forwarded
  // registry change keeps it current afterwards.
  useEffect(() => {
    if (address !== undefined) refresh(address)
  }, [refresh, address])
  if (!view.visible || address === undefined) return null
  const tip = view.caveats
    .map(caveat => caveat.names.length === 0
      ? t(caveat.key)
      : `${t(caveat.key)} (${caveat.names.join(', ')})`)
    .join('\n')
  return (
    <span className={styles.dsssPill}>
      <button
        type="button"
        className={view.labelKey === undefined && view.detail.length === 0
          ? `${styles.dsssPillBtn} ${styles.dsssPillIcon}`
          : styles.dsssPillBtn}
        aria-label={t(view.ariaKey)}
        aria-pressed={view.action === 'resume-all'}
        disabled={!view.enabled}
        {...tip.length === 0 ? {} : { title: tip }}
        onClick={() => { toggle(address) }}
      >
        {view.action === 'resume-all' ? <ResumeIcon /> : <PauseIcon />}
        {view.labelKey === undefined ? null : <span className={styles.dsssPillText}>{t(view.labelKey)}</span>}
        {view.detail.length === 0 ? null : <span className={styles.dsssPillDetail}>{view.detail}</span>}
        {view.caveats.length === 0 ? null : <span className={styles.dsssPillWarn}><CaveatIcon /></span>}
      </button>
    </span>
  )
}
