/**
 * The whole-app control: one pill in the frame-wide overlay layer that answers
 * "can I close the lid?", presses the park or the release, and — when something
 * did not stop cleanly — opens the morning decision list.
 *
 * The layer is the only root-scoped, additive seat the shell declares for a
 * frame-wide surface of its own, and it is exactly what this is — a status
 * pill outside every column, above every panel, click-through except for its
 * own entries. The per-session control stays in the session header where the
 * session it acts on is.
 *
 * The pill reads the host through the command channel only (`./global.ts`):
 * with no answer, or with no session to ask through, it renders nothing rather
 * than a state it would have to invent. The decision list is deliberately NOT
 * part of that first read — it costs two more command calls, and a user who
 * never opens it pays nothing; the panel asks for its own rows when it opens.
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
import type { TriageAction } from '../shared.js'
import { addressingSession } from './global.js'
import type { GlobalStopState } from './global.js'
import { globalStopView, triageView, TRIAGE_ACTION_VIEWS } from './view.js'
import type { TriageRowView } from './view.js'
import { CaveatIcon, ChevronIcon, PauseIcon, ResumeIcon } from './icons.js'
import styles from './button.module.css'

/** Browser state and operations injected into the whole-app pill. */
export interface SafeStopPillInjected {
  hooks: { safeStopGlobal: ObservableSnapshot<GlobalStopState> }
  /** Read the host's whole-app state through one session. */
  refresh: (sessionId: SessionId) => void
  /** Press the pill for one session. */
  toggle: (sessionId: SessionId) => void
  /** Show or hide the decision list; opening it also reads its rows. */
  setPanel: (open: boolean) => void
  /** Take one of the four decisions on one listed session. */
  decide: (sessionId: string, action: TriageAction) => void
}

/** Full props of the frame-wide safe-stop pill. */
export type SafeStopPillProps = PropsRuntime<'shell.overlay'>
  & InjectFace<SafeStopPillInjected>
  & PropsLocale<'safe-stop'>

/** One listed session's row, with the four decisions. */
function TriageSessionRow(props: {
  readonly row: TriageRowView
  readonly decide: (sessionId: string, action: TriageAction) => void
  readonly t: SafeStopPillProps['t']
}): ReactNode {
  const { row, decide, t } = props
  return (
    <li className={styles.dsssPillRow}>
      <div className={styles.dsssPillRowHead}>
        <span className={styles.dsssPillRowId}>{row.sessionId}</span>
        <span className={styles.dsssPillRowPhase}>{t(row.phaseKey)}</span>
      </div>
      <div className={styles.dsssPillRowFacts}>
        {row.readable
          ? (
            <>
              <span>{t('triage.stopped')}: {row.stopped ?? '-'}</span>
              <span>
                {row.unknownTools.length === 0
                  ? t('triage.toolsNone')
                  : `${t('triage.tools')}: ${row.unknownTools.join(', ')}`}
              </span>
            </>
          )
          : <span>{t('triage.stoppedUnknown')}</span>}
        {row.readable && !row.wakeable ? <span>{t('triage.noWake')}</span> : null}
      </div>
      <div className={styles.dsssPillRowActions}>
        {TRIAGE_ACTION_VIEWS.map(action => (
          <button
            key={action.action}
            type="button"
            className={styles.dsssPillAction}
            aria-label={t(action.ariaKey)}
            onClick={() => { decide(row.sessionId, action.action) }}
          >
            {t(action.labelKey)}
          </button>
        ))}
      </div>
    </li>
  )
}

/**
 * The frame-wide control: what the host says about the whole park, the one
 * press that parks or releases all of it, and the decision list for whatever
 * did not stop cleanly.
 * @param props - shell runtime, host operations, and localized copy.
 * @returns the pill and its panel, or nothing while the host has not answered.
 */
export function SafeStopPill(props: SafeStopPillProps): ReactNode {
  const { refresh, toggle, setPanel, decide, t, useSessions } = props
  const reading = props.useSafeStopGlobal(state => state.global)
  const triage = props.useSafeStopGlobal(state => state.triage)
  const open = props.useSafeStopGlobal(state => state.panelOpen)
  // The command channel is session-addressed: one user session is the address
  // every whole-app read and press goes through.
  const address = useSessions(addressingSession)
  const view = globalStopView(reading)
  const list = triageView(triage)
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
      {!open
        ? null
        : (
          <div className={styles.dsssPillPanel} role="dialog" aria-label={t('triage.title')}>
            <div className={styles.dsssPillPanelHead}>
              <span className={styles.dsssPillText}>{t('triage.title')}</span>
              <button
                type="button"
                className={styles.dsssPillAction}
                aria-label={t('triage.refresh.aria')}
                onClick={() => { setPanel(true) }}
              >
                {t('triage.refresh.aria')}
              </button>
            </div>
            {!list.visible
              ? <p className={styles.dsssPillPanelNote}>{t('triage.reading')}</p>
              : list.rows.length === 0
                ? <p className={styles.dsssPillPanelNote}>{t('triage.empty')}</p>
                : (
                  <ul className={styles.dsssPillRows}>
                    {list.rows.map(row => (
                      <TriageSessionRow key={row.sessionId} row={row} decide={decide} t={t} />
                    ))}
                  </ul>
                )}
          </div>
        )}
      {view.unclean === 0
        ? null
        : (
          <button
            type="button"
            className={styles.dsssPillTriage}
            aria-label={t('triage.open.aria')}
            aria-expanded={open}
            title={`${String(view.unclean)} ${t('all.triage')}`}
            onClick={() => { setPanel(!open) }}
          >
            <ChevronIcon />
            <span className={styles.dsssPillDetail}>{view.unclean}</span>
          </button>
        )}
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
