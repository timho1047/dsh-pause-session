/**
 * The whole-app control: one pill in the conversation header's utilities row
 * that answers "can I close the lid?", presses the park or the release, and —
 * when something did not stop cleanly — opens the morning decision list.
 *
 * The header's right-aligned utilities row is inside the conversation column,
 * which is where this control belongs: it answers for every session tree, but
 * it is read while looking at one, and a surface inside the layout is covered
 * by whatever covers that column — a sidebar or a drawer — instead of floating
 * above the whole frame. The decision list hangs from the control into the
 * conversation area below.
 *
 * The pill reads the host through the command channel only (`./global.ts`):
 * with no answer, or with no session to ask through, it renders nothing rather
 * than a state it would have to invent. The decision list is deliberately NOT
 * part of that first read — it costs two more command calls, and a user who
 * never opens it pays nothing; the panel asks for its own rows when it opens.
 * @module dsh-pause-session/client/pill
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (header.utilities).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ui-session GlobalStandardProps merge (useSessions).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { TriageAction } from '../shared.js'
import { addressingSession } from './global.js'
import type { GlobalPauseState } from './global.js'
import { globalPauseView, showsPauseControl, triageView, TRIAGE_ACTION_VIEWS, TRIAGE_GOAL_VIEW } from './view.js'
import type { TriageRowView } from './view.js'
import { CaveatIcon, ChevronIcon, PauseIcon, ResumeIcon } from './icons.js'
import styles from './button.module.css'

/** Browser state and operations injected into the whole-app pill. */
export interface PausePillInjected {
  hooks: { pauseGlobal: ObservableSnapshot<GlobalPauseState> }
  /** Hand the control the session the shell is on; it reads there until it has an answer. */
  refresh: (sessionId: SessionId) => void
  /** Press the pill for one session. */
  toggle: (sessionId: SessionId) => void
  /** Show or hide the decision list; opening it also reads its rows. */
  setPanel: (open: boolean) => void
  /** Take one of the four decisions on one listed session. */
  decide: (sessionId: string, action: TriageAction) => void
}

/** Full props of the whole-app pause control. */
export type PausePillProps = PropsRuntime<'conversation.session.header.utilities'>
  & InjectFace<PausePillInjected>
  & PropsLocale<'pause'>

/** One listed session's row, with the four decisions. */
function TriageSessionRow(props: {
  readonly row: TriageRowView
  readonly decide: (sessionId: string, action: TriageAction) => void
  readonly t: PausePillProps['t']
}): ReactNode {
  const { row, decide, t } = props
  return (
    <li className={styles.dspPillRow}>
      <div className={styles.dspPillRowHead}>
        <span className={styles.dspPillRowId}>{row.sessionId}</span>
        <span className={styles.dspPillRowPhase}>{t(row.phaseKey)}</span>
      </div>
      <div className={styles.dspPillRowFacts}>
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
      <div className={styles.dspPillRowActions}>
        {TRIAGE_ACTION_VIEWS.map(action => (
          <button
            key={action.action}
            type="button"
            className={styles.dspPillAction}
            aria-label={t(action.ariaKey)}
            onClick={() => { decide(row.sessionId, action.action) }}
          >
            {t(action.labelKey)}
          </button>
        ))}
        {/* A switch, not a decision: it says what the next resume of this
            session may spend, and the host's own reading is its state. */}
        <button
          type="button"
          className={styles.dspPillAction}
          aria-label={t(TRIAGE_GOAL_VIEW.ariaKey)}
          aria-pressed={row.rearmGoal}
          onClick={() => { decide(row.sessionId, TRIAGE_GOAL_VIEW.action) }}
        >
          {t(TRIAGE_GOAL_VIEW.labelKey)}
        </button>
      </div>
    </li>
  )
}

/**
 * The whole-app control: what the host says about the whole park, the one
 * press that parks or releases all of it, and the decision list for whatever
 * did not stop cleanly.
 * @param props - session-header runtime, host operations, and localized copy.
 * @returns the control and its panel, or nothing while the host has not answered.
 */
export function PausePill(props: PausePillProps): ReactNode {
  const { refresh, toggle, setPanel, decide, t, useSessions, useSession } = props
  const reading = props.usePauseGlobal(state => state.global)
  const triage = props.usePauseGlobal(state => state.triage)
  const open = props.usePauseGlobal(state => state.panelOpen)
  // The command channel is session-addressed: one user session is the address
  // every whole-app press goes through, and the one the control's very first
  // read goes through.
  const address = useSessions(addressingSession)
  const view = globalPauseView(reading)
  const list = triageView(triage)
  // A subagent's own header gets nothing, exactly like the per-session control:
  // its work is its parent's, and the parent's header already speaks for the
  // whole tree. The mount read below waits for the same gate, so a header that
  // renders nothing spends no host round-trip either.
  const visible = showsPauseControl(useSession(snapshot => snapshot.subagent))
  // Hand the control the session the shell is on. It reads there once, when it
  // has no answer yet; afterwards the address follows the view while the reads
  // follow the park (see `./global.ts`).
  useEffect(() => {
    if (visible && address !== undefined) refresh(address)
  }, [refresh, address, visible])
  if (!visible || !view.visible || address === undefined) return null
  const tip = view.caveats
    .map(caveat => caveat.names.length === 0
      ? t(caveat.key)
      : `${t(caveat.key)} (${caveat.names.join(', ')})`)
    .join('\n')
  return (
    <span className={styles.dspPill}>
      {!open
        ? null
        : (
          <div className={styles.dspPillPanel} role="dialog" aria-label={t('triage.title')}>
            <div className={styles.dspPillPanelHead}>
              <span className={styles.dspPillText}>{t('triage.title')}</span>
              <button
                type="button"
                className={styles.dspPillAction}
                aria-label={t('triage.refresh.aria')}
                onClick={() => { setPanel(true) }}
              >
                {t('triage.refresh.aria')}
              </button>
            </div>
            {!list.visible
              ? <p className={styles.dspPillPanelNote}>{t('triage.reading')}</p>
              : list.rows.length === 0
                ? <p className={styles.dspPillPanelNote}>{t('triage.empty')}</p>
                : (
                  <ul className={styles.dspPillRows}>
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
            className={styles.dspPillTriage}
            aria-label={t('triage.open.aria')}
            aria-expanded={open}
            title={`${String(view.unclean)} ${t('all.triage')}`}
            onClick={() => { setPanel(!open) }}
          >
            <ChevronIcon />
            <span className={styles.dspPillDetail}>{view.unclean}</span>
          </button>
        )}
      <button
        type="button"
        className={view.labelKey === undefined && view.detail.length === 0
          ? `${styles.dspPillBtn} ${styles.dspPillIcon}`
          : styles.dspPillBtn}
        aria-label={t(view.ariaKey)}
        aria-pressed={view.action === 'resume-all'}
        disabled={!view.enabled}
        {...tip.length === 0 ? {} : { title: tip }}
        onClick={() => { toggle(address) }}
      >
        {view.action === 'resume-all' ? <ResumeIcon /> : <PauseIcon />}
        {view.labelKey === undefined ? null : <span className={styles.dspPillText}>{t(view.labelKey)}</span>}
        {view.detail.length === 0 ? null : <span className={styles.dspPillDetail}>{view.detail}</span>}
        {view.caveats.length === 0 ? null : <span className={styles.dspPillWarn}><CaveatIcon /></span>}
      </button>
    </span>
  )
}
