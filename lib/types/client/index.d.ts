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
 * same-origin JSON status route, which keeps background reads out of the
 * Session log; a carrier without that route falls back to the command channel.
 * User actions and status both use the generated native Remote namespace;
 * no slash command is involved. Each control stays inert wherever no
 * round-trip is available rather than rendering a state it cannot support. The
 * header control also reads the whole-app answer the whole-app control
 * publishes, so a park that holds nothing does not cost a host round-trip per
 * header.
 * @module dsh-pause-session/client
 */
import type { ReactNode } from 'react';
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { PauseState } from './control.js';
import { type PauseKey } from './locales.js';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** The pause control's copy. */
        'pause': PauseKey;
    }
}
/** Required services: the slot registry, the locale registry, and the host round-trip. */
export declare const inject: string[];
/** Browser state and operations injected into the Session-header contribution. */
export interface PauseInjected {
    hooks: {
        pause: ObservableSnapshot<PauseState>;
    };
    /** Read the host's state for one session (the control calls this once per mount). */
    refresh: (sessionId: SessionId) => void;
    /** Press the control for one session. */
    toggle: (sessionId: SessionId) => void;
    /** Flip one session's own goal opt-out. */
    toggleGoal: (sessionId: SessionId) => void;
}
/** Full props of the Session-header pause control. */
export type PauseButtonProps = PropsRuntime<'conversation.session.header.actions'> & InjectFace<PauseInjected> & PropsLocale<'pause'>;
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
export declare function PauseButton(props: PauseButtonProps): ReactNode;
/**
 * Client plugin body: register the locale dictionaries, own both controllers,
 * follow the host's registry changes, and contribute the per-session control
 * and the whole-app control into the session header.
 * @param ctx - client context carrying slots, locale, and the Remote face.
 */
export declare function apply(ctx: ClientContext): void;
