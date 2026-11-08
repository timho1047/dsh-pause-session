/**
 * Browser half of dsh-pause-session.
 *
 * Registers two controls: one in the session header's title-adjacent action
 * group (`conversation.session.header.actions`), which pauses or resumes the
 * session it sits on, and one in the header's right-aligned utilities row
 * (`conversation.session.header.utilities`), which answers for the whole app.
 * Both seats are session-scoped and their props carry `sessionId`, so every
 * open session header renders its own pair and switching sessions follows
 * automatically; the whole-app control speaks for every session from the
 * header of the one on screen.
 *
 * The whole-app control sits inside the conversation column rather than in the
 * frame-wide overlay layer: it is read while looking at one conversation, and
 * a sidebar or drawer that covers that area covers the control with it.
 *
 * Both controls are host-authoritative. On a browser Host they read the
 * native `pauseSession` stream, which keeps status reads out of the Session
 * log. The same path serves Web and Desktop.
 * User actions and status both use the generated native Remote namespace;
 * no slash command is involved. Each control stays inert wherever no
 * round-trip is available rather than rendering a state it cannot support. The
 * header control also reads the whole-app answer the whole-app control
 * publishes, so a park that holds nothing does not cost a host round-trip per
 * header.
 * @module dsh-pause-session/client
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the api-remotes Client face and its forwarded-event key set.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap merge (header.actions, header.utilities).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { PauseControl } from './control.js'
import type { PauseState } from './control.js'
import { PauseGlobalControl } from './global.js'
import { remoteTransport } from './remote.js'
import pauseRemote from 'dsh-pause-session/remote'
import type {} from 'dsh-pause-session/remote'
import { GoalIcon, PauseIcon, ResumeIcon } from './icons.js'
import { PausePill } from './pill.js'
import type { PausePillInjected } from './pill.js'
import { pauseView, showsPauseControl } from './view.js'
import { en, zh, type PauseKey } from './locales.js'
import styles from './button.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The pause control's copy. */
    'pause': PauseKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'pause'

/** Required services: the slot registry, the locale registry, and the host round-trip. */
export const inject = ['slots', 'locale', 'remote']

/** Browser state and operations injected into the Session-header contribution. */
export interface PauseInjected {
  hooks: { pause: ObservableSnapshot<PauseState> }
  /** Read the host's state for one session (the control calls this once per mount). */
  refresh: (sessionId: SessionId) => void
  /** Press the control for one session. */
  toggle: (sessionId: SessionId) => void
  /** Flip one session's own goal opt-out. */
  toggleGoal: (sessionId: SessionId) => void
}

/** Full props of the Session-header pause control. */
export type PauseButtonProps = PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<PauseInjected>
  & PropsLocale<'pause'>

/**
 * The session's pause control: pause the session and its subagents before
 * their next model request, or resume them, with the host's own state on screen.
 * Once the host reports the park's goal opt-out, a second switch sits beside it
 * — the only place a session that stopped CLEANLY can be told not to re-open its
 * goal on the next resume, because the decision list shows only the sessions
 * that did not stop cleanly.
 *
 * A subagent session renders nothing: its work is its parent's, the parent's
 * control already covers it, and a button here would offer to pause "a session"
 * from inside a child.
 * @param props - session runtime, host operations, and localized copy.
 * @returns the header action, or nothing on a subagent session.
 */
export function PauseButton(props: PauseButtonProps): ReactNode {
  const { sessionId, refresh, toggle, toggleGoal, t, useSession } = props
  const reading = props.usePause(state => state.bySession[String(sessionId)])
  const running = useSession(snapshot => snapshot.running) ?? false
  const view = pauseView(reading, running)
  const visible = showsPauseControl(useSession(snapshot => snapshot.subagent))
  // Read once per mounted control: the host is the source of truth, and the
  // forwarded registry change keeps it current afterwards.
  useEffect(() => { refresh(sessionId) }, [refresh, sessionId])
  if (!visible) return null
  return (
    <span className={styles.dsp}>
      <button
        type="button"
        className={styles.dspBtn}
        aria-label={t(view.ariaKey)}
        aria-pressed={view.paused}
        disabled={!view.enabled}
        onClick={() => { toggle(sessionId) }}
      >
        {view.paused ? <ResumeIcon /> : <PauseIcon />}
      </button>
      {/* No host answer, no switch: the state has to come from the record, and
          a switch sitting in the default state would claim its own answer. */}
      {view.rearmGoal === undefined
        ? null
        : (
          <button
            type="button"
            className={styles.dspGoal}
            aria-label={t('goal.aria')}
            aria-pressed={view.rearmGoal}
            title={t(view.rearmGoal ? 'goal.on.tip' : 'goal.off.tip')}
            onClick={() => { toggleGoal(sessionId) }}
          >
            <GoalIcon />
          </button>
        )}
      {view.labelKey === undefined
        ? null
        : (
          <span className={styles.dspState}>
            {t(view.labelKey)}
            {view.runningTools.length === 0 ? null : `: ${view.runningTools.join(', ')}`}
          </span>
        )}
    </span>
  )
}

/**
 * Client plugin body: register the locale dictionaries, own both controllers,
 * follow the host's registry changes, and contribute the per-session control
 * and the whole-app control into the session header.
 * @param ctx - client context carrying slots, locale, and the Remote face.
 */

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'pause: dictionaries')
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort(new Error('pause: client unloaded')) }, 'pause: lifetime')

  // The generated contribution is the only transport. It is mounted before
  // the namespace consumer below; that consumer uses a child inject because a
  // Remote namespace does not exist until its contribution is mounted.
  if (typeof ctx.remote.$mount === 'function') {
    ctx.effect(async () => {
      const dispose = await ctx.remote.$mount(pauseRemote)
      return dispose
    }, 'pause: remote transport')
  }

  ctx.inject(['remote.pauseSession'], (remoteCtx) => {
    const remote = remoteCtx.remote.pauseSession
    const transport = remoteTransport(remote, lifetime.signal)
    const globalControl = new PauseGlobalControl(transport, lifetime.signal)
    const control = new PauseControl(transport, lifetime.signal)
    // The native stream is the change feed: every fresh snapshot applies to
    // both controls directly, with no re-read timer.
    remoteCtx.effect(
      () => transport.source.onSnapshot((snapshot) => {
        control.apply(snapshot)
        globalControl.apply(snapshot)
      }),
      'pause: native status stream',
    )
    remoteCtx.slots.inject('conversation.session.header.actions', () =>
      remoteCtx.slots.register(
        {
          name: 'conversation.session.header.actions',
          id: NS,
          order: 40,
          locale: NS,
          inject: (): PauseInjected => ({
            hooks: { pause: control.store },
            refresh: (sessionId) => { void control.refresh(sessionId) },
            toggle: (sessionId) => { void control.toggle(sessionId) },
            toggleGoal: (sessionId) => { void control.toggleGoal(sessionId) },
          }),
        },
        PauseButton,
      ),
    )
    remoteCtx.slots.inject('conversation.session.header.utilities', () =>
      remoteCtx.slots.register(
        {
          name: 'conversation.session.header.utilities',
          id: 'pause-all',
          order: 60,
          locale: NS,
          inject: (): PausePillInjected => ({
            hooks: { pauseGlobal: globalControl.store },
            refresh: (sessionId) => { void globalControl.refresh(sessionId) },
            toggle: (sessionId) => { void globalControl.toggle(sessionId) },
            setPanel: (open) => { globalControl.setPanel(open) },
            decide: (sessionId, action) => { void globalControl.decide(sessionId, action) },
          }),
        },
        PausePill,
      ),
    )
  })
}
