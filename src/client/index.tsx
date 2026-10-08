/**
 * Browser half of dsh-safe-stop.
 *
 * Registers one icon button into the session header's title-adjacent action
 * group (`conversation.session.header.actions`). The slot is session-scoped
 * and standard props carry `sessionId`, so every open session renders its own
 * button and switching sessions follows automatically. The button does not
 * act yet: the pause path lands with the host gate.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (header.actions).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
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

/** Required services: the slot registry and the locale dictionary registry. */
export const inject = ['slots', 'locale']

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

/** The session's safe-stop control. Inert until the pause path exists. */
function SafeStopButton(props: PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'safe-stop'>) {
  const { t } = props
  return (
    <span className={styles.dsss}>
      <button type="button" className={styles.dsssBtn} aria-label={t('action.aria')}>
        <PauseIcon />
      </button>
      <span className={styles.dsssTip} aria-hidden="true">{t('action.tip')}</span>
    </span>
  )
}

/**
 * Client plugin body: register the locale dictionaries, then contribute the
 * control into the session header's title-adjacent action group. The
 * `slots.inject` wait covers the conversation package declaring the slot.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'safe-stop: dictionaries')
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      { name: 'conversation.session.header.actions', id: NS, order: 40, locale: NS },
      SafeStopButton,
    ),
  )
}
