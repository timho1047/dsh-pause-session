/**
 * Browser half of dsh-safe-stop.
 *
 * Registers two controls: one in the session header's title-adjacent action
 * group (`conversation.session.header.actions`), which pauses or resumes the
 * session it sits on, and one in the frame-wide overlay layer
 * (`shell.overlay`), which answers for the whole app. The header slot is
 * session-scoped and its props carry `sessionId`, so every open session renders
 * its own control and switching sessions follows automatically; the overlay
 * entry is root-scoped, which is what lets one control speak for every session.
 *
 * Both controls are host-authoritative: they read state from the host's command
 * registry and drive it through the host's session commands (`./control.ts` and
 * `./global.ts` document why the command registry is the only live channel a
 * third-party plugin can use). Each stays inert wherever that round-trip is
 * unavailable rather than rendering a control that cannot tell the truth. The
 * header control also reads the whole-app answer the pill publishes, so a park
 * that holds nothing does not cost a host round-trip per header.
 * @module dsh-safe-stop/client
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the api-remotes Client face and its forwarded-event key set.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap merge (header.actions).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ui-layout SlotMap merge (the root-scoped shell.overlay).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { SafeStopControl } from './control.js'
import type { SafeStopState } from './control.js'
import { SafeStopGlobalControl } from './global.js'
import { GoalIcon, PauseIcon, ResumeIcon } from './icons.js'
import { SafeStopPill } from './pill.js'
import type { SafeStopPillInjected } from './pill.js'
import { safeStopView, showsPauseControl } from './view.js'
import { en, zh, type SafeStopKey } from './locales.js'
import styles from './button.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The safe-stop control's copy. */
    'safe-stop': SafeStopKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'safe-stop'

/** Required services: the slot registry, the locale registry, and the host round-trip. */
export const inject = ['slots', 'locale', 'remote', 'remote.commands']

/** Browser state and operations injected into the Session-header contribution. */
export interface SafeStopInjected {
  hooks: { safeStop: ObservableSnapshot<SafeStopState> }
  /** Read the host's state for one session (the control calls this once per mount). */
  refresh: (sessionId: SessionId) => void
  /** Press the control for one session. */
  toggle: (sessionId: SessionId) => void
  /** Flip one session's own goal opt-out. */
  toggleGoal: (sessionId: SessionId) => void
}

/** Full props of the Session-header safe-stop control. */
export type SafeStopButtonProps = PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<SafeStopInjected>
  & PropsLocale<'safe-stop'>

/**
 * The session's safe-stop control: pause the session and its subagents before
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
export function SafeStopButton(props: SafeStopButtonProps): ReactNode {
  const { sessionId, refresh, toggle, toggleGoal, t, useSession } = props
  const reading = props.useSafeStop(state => state.bySession[String(sessionId)])
  const view = safeStopView(reading)
  const visible = showsPauseControl(useSession(snapshot => snapshot.subagent))
  // Read once per mounted control: the host is the source of truth, and the
  // forwarded registry change keeps it current afterwards.
  useEffect(() => { refresh(sessionId) }, [refresh, sessionId])
  if (!visible) return null
  return (
    <span className={styles.dsss}>
      <button
        type="button"
        className={styles.dsssBtn}
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
            className={styles.dsssGoal}
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
          <span className={styles.dsssState}>
            {t(view.labelKey)}
            {view.runningTools.length === 0 ? null : `: ${view.runningTools.join(', ')}`}
          </span>
        )}
    </span>
  )
}

/**
 * Client plugin body: register the locale dictionaries, own both controllers,
 * follow the host's registry changes, and contribute the session-header control
 * and the frame-wide pill.
 * @param ctx - client context carrying slots, locale, and the Remote face.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'safe-stop: dictionaries')
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort(new Error('safe-stop: client unloaded')) }, 'safe-stop: lifetime')
  const globalControl = new SafeStopGlobalControl(ctx.remote.commands, lifetime.signal)
  const control = new SafeStopControl(
    ctx.remote.commands,
    lifetime.signal,
    undefined,
    undefined,
    () => globalControl.store.getSnapshot().global,
  )
  // A header answered from the whole-app "nothing is registered" is read for
  // real the moment that stops holding: the session it stood in for may be the
  // one the park just took.
  ctx.effect(
    () => globalControl.store.subscribe(() => { control.reconsider() }),
    'safe-stop: the whole-app answer serves the session headers',
  )
  // The host publishes no push channel of its own, so the forwarded command
  // registry change is what makes these controls live: every one of them is a
  // transition worth looking at.
  //
  // The host announces a registration and an unregistration per command, so
  // parking N sessions arrives as several events per session; a burst of reads
  // per event would be several reads of the same state. One tick's worth of
  // changes is one trigger, and a trigger that lands while a burst is already
  // running is absorbed by it: every read that burst still owes happens after
  // the change.
  let scheduled = false
  const reread = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      control.refreshAll()
      globalControl.refreshAll()
    })
  }
  ctx.effect(
    () => ctx.remote.$on('commands/change', reread),
    'safe-stop: host command registry changes',
  )
  // A page that is not on screen is not being read: the controls stop their
  // re-read timers while it is hidden and continue them when it comes back.
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const onVisibility = (): void => {
      control.watchVisibility()
      globalControl.watchVisibility()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { document.removeEventListener('visibilitychange', onVisibility) }
  }, 'safe-stop: page visibility')
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: NS,
        order: 40,
        locale: NS,
        inject: (): SafeStopInjected => ({
          hooks: { safeStop: control.store },
          refresh: (sessionId) => { void control.refresh(sessionId) },
          toggle: (sessionId) => { void control.toggle(sessionId) },
          toggleGoal: (sessionId) => { void control.toggleGoal(sessionId) },
        }),
      },
      SafeStopButton,
    ),
  )
  // The whole-app control goes in the frame-wide overlay layer: it belongs to
  // no session, and that layer is the shell's own additive seat for a
  // frame-wide surface (a status pill is one of the things it names).
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'safe-stop-all',
        order: 60,
        locale: NS,
        inject: (): SafeStopPillInjected => ({
          hooks: { safeStopGlobal: globalControl.store },
          refresh: (sessionId) => { void globalControl.refresh(sessionId) },
          toggle: (sessionId) => { void globalControl.toggle(sessionId) },
          setPanel: (open) => { globalControl.setPanel(open) },
          decide: (sessionId, action) => { void globalControl.decide(sessionId, action) },
        }),
      },
      SafeStopPill,
    ),
  )
}
