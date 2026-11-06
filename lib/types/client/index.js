import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
 * User actions still run through the host's session commands (`./control.ts`
 * and `./global.ts` own both transports). Each control stays inert wherever no
 * round-trip is available rather than rendering a state it cannot support. The
 * header control also reads the whole-app answer the whole-app control
 * publishes, so a park that holds nothing does not cost a host round-trip per
 * header.
 * @module dsh-pause-session/client
 */
import { useEffect } from 'react';
import { PauseControl } from './control.js';
import { PauseGlobalControl } from './global.js';
import { openRemoteSource, remoteCommands } from './remote.js';
import pauseRemote from 'dsh-pause-session/remote';
import { GoalIcon, PauseIcon, ResumeIcon } from './icons.js';
import { PausePill } from './pill.js';
import { pauseView, showsPauseControl } from './view.js';
import { en, zh } from './locales.js';
import styles from './button.module.css';
/** Dictionary namespace owned by this plugin. */
const NS = 'pause';
/** Required services: the slot registry, the locale registry, and the host round-trip. */
export const inject = ['slots', 'locale', 'remote', 'remote.commands'];
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
export function PauseButton(props) {
    const { sessionId, refresh, toggle, toggleGoal, t, useSession } = props;
    const reading = props.usePause(state => state.bySession[String(sessionId)]);
    const view = pauseView(reading);
    const visible = showsPauseControl(useSession(snapshot => snapshot.subagent));
    // Read once per mounted control: the host is the source of truth, and the
    // forwarded registry change keeps it current afterwards.
    useEffect(() => { refresh(sessionId); }, [refresh, sessionId]);
    if (!visible)
        return null;
    return (_jsxs("span", { className: styles.dsp, children: [_jsx("button", { type: "button", className: styles.dspBtn, "aria-label": t(view.ariaKey), "aria-pressed": view.paused, disabled: !view.enabled, onClick: () => { toggle(sessionId); }, children: view.paused ? _jsx(ResumeIcon, {}) : _jsx(PauseIcon, {}) }), view.rearmGoal === undefined
                ? null
                : (_jsx("button", { type: "button", className: styles.dspGoal, "aria-label": t('goal.aria'), "aria-pressed": view.rearmGoal, title: t(view.rearmGoal ? 'goal.on.tip' : 'goal.off.tip'), onClick: () => { toggleGoal(sessionId); }, children: _jsx(GoalIcon, {}) })), view.labelKey === undefined
                ? null
                : (_jsxs("span", { className: styles.dspState, children: [t(view.labelKey), view.runningTools.length === 0 ? null : `: ${view.runningTools.join(', ')}`] }))] }));
}
/**
 * Client plugin body: register the locale dictionaries, own both controllers,
 * follow the host's registry changes, and contribute the per-session control
 * and the whole-app control into the session header.
 * @param ctx - client context carrying slots, locale, and the Remote face.
 */
/** Test-double fallback: the old command path, kept only off real Cordis. */
function mountLegacy(ctx) {
    const lifetime = new AbortController();
    ctx.effect(() => () => { lifetime.abort(new Error('pause: client unloaded')); }, 'pause: lifetime');
    const globalControl = new PauseGlobalControl(ctx.remote.commands, lifetime.signal);
    const control = new PauseControl(ctx.remote.commands, lifetime.signal, undefined, undefined, () => globalControl.store.getSnapshot().global);
    ctx.effect(() => globalControl.store.subscribe(() => { control.reconsider(); }), 'pause: legacy aggregate');
    ctx.effect(() => ctx.remote.$on('commands/change', () => {
        control.refreshAll();
        globalControl.refreshAll();
    }), 'pause: legacy command changes');
    ctx.effect(() => {
        if (typeof document === 'undefined')
            return () => { };
        const onVisibility = () => {
            control.watchVisibility();
            globalControl.watchVisibility();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => { document.removeEventListener('visibilitychange', onVisibility); };
    }, 'pause: legacy visibility');
    ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions', id: NS, order: 40, locale: NS,
        inject: () => ({
            hooks: { pause: control.store },
            refresh: (sessionId) => { void control.refresh(sessionId); },
            toggle: (sessionId) => { void control.toggle(sessionId); },
            toggleGoal: (sessionId) => { void control.toggleGoal(sessionId); },
        }),
    }, PauseButton));
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities', id: 'pause-all', order: 60, locale: NS,
        inject: () => ({
            hooks: { pauseGlobal: globalControl.store },
            refresh: (sessionId) => { void globalControl.refresh(sessionId); },
            toggle: (sessionId) => { void globalControl.toggle(sessionId); },
            setPanel: (open) => { globalControl.setPanel(open); },
            decide: (sessionId, action) => { void globalControl.decide(sessionId, action); },
        }),
    }, PausePill));
}
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'pause: dictionaries');
    if (typeof ctx.inject !== 'function') {
        mountLegacy(ctx);
        return;
    }
    const lifetime = new AbortController();
    ctx.effect(() => () => { lifetime.abort(new Error('pause: client unloaded')); }, 'pause: lifetime');
    // The generated contribution is the only transport. It is mounted before
    // the namespace consumer below; that consumer uses a child inject because a
    // Remote namespace does not exist until its contribution is mounted.
    if (typeof ctx.remote.$mount === 'function') {
        ctx.effect(async () => {
            const dispose = await ctx.remote.$mount(pauseRemote);
            return dispose;
        }, 'pause: remote transport');
    }
    ctx.inject(['remote.pauseSession'], (remoteCtx) => {
        const remote = remoteCtx.remote.pauseSession;
        const source = openRemoteSource(remote, lifetime.signal);
        const commands = remoteCommands(remote, source);
        const globalControl = new PauseGlobalControl(commands, lifetime.signal, undefined, undefined, source);
        const control = new PauseControl(commands, lifetime.signal, undefined, undefined, () => globalControl.store.getSnapshot().global, source);
        // A header answered from the whole-app "nothing is registered" is read for
        // real the moment that stops holding.
        remoteCtx.effect(() => globalControl.store.subscribe(() => { control.reconsider(); }), 'pause: the whole-app answer serves the session headers');
        // The native stream is the change feed: every fresh snapshot wakes the
        // controls' own coalescing burst, which reads the cached snapshot.
        remoteCtx.effect(() => source.onChange(() => {
            control.refreshAll();
            globalControl.refreshAll();
        }), 'pause: native status stream');
        // A page that is not on screen is not being read: the controls stop their
        // re-read timers while it is hidden and continue them when it comes back.
        remoteCtx.effect(() => {
            if (typeof document === 'undefined')
                return () => { };
            const onVisibility = () => {
                control.watchVisibility();
                globalControl.watchVisibility();
            };
            document.addEventListener('visibilitychange', onVisibility);
            return () => { document.removeEventListener('visibilitychange', onVisibility); };
        }, 'pause: page visibility');
        remoteCtx.slots.inject('conversation.session.header.actions', () => remoteCtx.slots.register({
            name: 'conversation.session.header.actions',
            id: NS,
            order: 40,
            locale: NS,
            inject: () => ({
                hooks: { pause: control.store },
                refresh: (sessionId) => { void control.refresh(sessionId); },
                toggle: (sessionId) => { void control.toggle(sessionId); },
                toggleGoal: (sessionId) => { void control.toggleGoal(sessionId); },
            }),
        }, PauseButton));
        remoteCtx.slots.inject('conversation.session.header.utilities', () => remoteCtx.slots.register({
            name: 'conversation.session.header.utilities',
            id: 'pause-all',
            order: 60,
            locale: NS,
            inject: () => ({
                hooks: { pauseGlobal: globalControl.store },
                refresh: (sessionId) => { void globalControl.refresh(sessionId); },
                toggle: (sessionId) => { void globalControl.toggle(sessionId); },
                setPanel: (open) => { globalControl.setPanel(open); },
                decide: (sessionId, action) => { void globalControl.decide(sessionId, action); },
            }),
        }, PausePill));
    });
}
//# sourceMappingURL=index.js.map