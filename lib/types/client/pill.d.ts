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
 * The pill reads the host through the JSON status route on Web, with the
 * command channel as its fallback (`./global.ts`). With no answer, or with no
 * session to address an action through, it renders nothing rather than a state
 * it would have to invent. The decision list is deliberately NOT part of that
 * first read — it costs more host round-trips, and a user who never opens it
 * pays nothing; the panel asks for its own rows when it opens.
 * @module dsh-pause-session/client/pill
 */
import type { ReactNode } from 'react';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { TriageAction } from '../shared.js';
import type { GlobalPauseState } from './global.js';
/** Browser state and operations injected into the whole-app pill. */
export interface PausePillInjected {
    hooks: {
        pauseGlobal: ObservableSnapshot<GlobalPauseState>;
    };
    /** Hand the control the session the shell is on; it reads there until it has an answer. */
    refresh: (sessionId: SessionId) => void;
    /** Press the pill for one session. */
    toggle: (sessionId: SessionId) => void;
    /** Show or hide the decision list; opening it also reads its rows. */
    setPanel: (open: boolean) => void;
    /** Take one of the four decisions on one listed session. */
    decide: (sessionId: string, action: TriageAction) => void;
}
/** Full props of the whole-app pause control. */
export type PausePillProps = PropsRuntime<'conversation.session.header.utilities'> & InjectFace<PausePillInjected> & PropsLocale<'pause'>;
/**
 * The whole-app control: what the host says about the whole park, the one
 * press that parks or releases all of it, and the decision list for whatever
 * did not stop cleanly.
 * @param props - session-header runtime, host operations, and localized copy.
 * @returns the control and its panel, or nothing while the host has not answered.
 */
export declare function PausePill(props: PausePillProps): ReactNode;
