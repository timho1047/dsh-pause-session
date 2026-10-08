/**
 * Browser half of dsh-safe-stop.
 *
 * Registers one control into the session header's title-adjacent action group
 * (`conversation.session.header.actions`). The slot is session-scoped and its
 * props carry `sessionId`, so every open session renders its own control and
 * switching sessions follows automatically.
 *
 * The control is host-authoritative: it reads the session's pause state from
 * the host's command registry and drives pause/resume through the host's
 * session commands (`./control.ts` documents why the command registry is the
 * only live channel a third-party plugin can use). It stays inert wherever
 * that round-trip is unavailable rather than rendering a control that cannot
 * tell the truth.
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
// Type-only: pulls the renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { SafeStopControl } from './control.js'
import type { SafeStopState } from './control.js'
import { safeStopView } from './view.js'
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

/** 16px stroke icon (currentColor): the two bars of a pause. */
function PauseIcon() {
  return (
    <svg
      aria-hidden="true"
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 5v14" />
      <path d="M15 5v14" />
    </svg>
  )
}

/** 16px stroke icon (currentColor): the triangle of a resume. */
function ResumeIcon() {
  return (
    <svg
      aria-hidden="true"
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 4.5v15l12-7.5z" />
    </svg>
  )
}

/** Browser state and operations injected into the Session-header contribution. */
export interface SafeStopInjected {
  hooks: { safeStop: ObservableSnapshot<SafeStopState> }
  /** Read the host's state for one session (the control calls this once per mount). */
  refresh: (sessionId: SessionId) => void
  /** Press the control for one session. */
  toggle: (sessionId: SessionId) => void
}

/** Full props of the Session-header safe-stop control. */
export type SafeStopButtonProps = PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<SafeStopInjected>
  & PropsLocale<'safe-stop'>

/**
 * The session's safe-stop control: pause the session before its next model
 * request, or resume it, with the host's own state on screen.
 * @param props - session runtime, host operations, and localized copy.
 * @returns the header action.
 */
export function SafeStopButton(props: SafeStopButtonProps): ReactNode {
  const { sessionId, refresh, toggle, t } = props
  const reading = props.useSafeStop(state => state.bySession[String(sessionId)])
  const view = safeStopView(reading)
  // Read once per mounted control: the host is the source of truth, and the
  // forwarded registry change keeps it current afterwards.
  useEffect(() => { refresh(sessionId) }, [refresh, sessionId])
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
 * Client plugin body: register the locale dictionaries, own the control
 * controller, follow the host's registry changes, and contribute the control
 * into the session header's title-adjacent action group.
 * @param ctx - client context carrying slots, locale, and the Remote face.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'safe-stop: dictionaries')
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort(new Error('safe-stop: client unloaded')) }, 'safe-stop: lifetime')
  const control = new SafeStopControl(ctx.remote.commands, lifetime.signal)
  // The host publishes no push channel of its own, so the forwarded command
  // registry change is what makes this control live: re-read after every one.
  ctx.effect(
    () => ctx.remote.$on('commands/change', () => { control.refreshAll() }),
    'safe-stop: host command registry changes',
  )
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
        }),
      },
      SafeStopButton,
    ),
  )
}
