import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
 * The pill reads the native status stream through `./global.ts`. With no
 * answer, or with no session to address an action through, it renders nothing
 * rather than a state it would have to invent. The decision list is
 * deliberately NOT part of that first read; the panel asks for its own rows
 * when it opens.
 * @module dsh-pause-session/client/pill
 */
import { useEffect, useRef, useState } from 'react';
import { addressingSession } from './global.js';
import { globalPauseView, showsPauseControl, triageActionsFor, triageView, TRIAGE_GOAL_VIEW } from './view.js';
import { draggedOffset, loadPillOffset, savePillOffset } from './pill-position.js';
import { CaveatIcon, ChevronIcon, PauseIcon, ResumeIcon } from './icons.js';
import styles from './button.module.css';
/** One listed session's row, with the four decisions. */
function TriageSessionRow(props) {
    const { row, decide, t } = props;
    return (_jsxs("li", { className: styles.dspPillRow, children: [_jsxs("div", { className: styles.dspPillRowHead, children: [_jsx("span", { className: styles.dspPillRowId, children: row.sessionId }), _jsx("span", { className: styles.dspPillRowPhase, children: t(row.phaseKey) })] }), _jsxs("div", { className: styles.dspPillRowFacts, children: [row.readable
                        ? (_jsxs(_Fragment, { children: [_jsxs("span", { children: [t('triage.stopped'), ": ", row.stopped ?? '-'] }), _jsx("span", { children: row.unknownTools.length === 0
                                        ? t('triage.toolsNone')
                                        : `${t('triage.tools')}: ${row.unknownTools.join(', ')}` })] }))
                        : _jsx("span", { children: t('triage.stoppedUnknown') }), row.readable && !row.wakeable ? _jsx("span", { children: t('triage.noWake') }) : null] }), _jsxs("div", { className: styles.dspPillRowActions, children: [triageActionsFor(row).map(action => (_jsx("button", { type: "button", className: styles.dspPillAction, "aria-label": t(action.ariaKey), onClick: () => { decide(row.sessionId, action.action); }, children: t(action.labelKey) }, action.action))), _jsx("button", { type: "button", className: styles.dspPillAction, "aria-label": t(TRIAGE_GOAL_VIEW.ariaKey), "aria-pressed": row.rearmGoal, onClick: () => { decide(row.sessionId, TRIAGE_GOAL_VIEW.action); }, children: t(TRIAGE_GOAL_VIEW.labelKey) })] })] }));
}
/**
 * The whole-app control: what the host says about the whole park, the one
 * press that parks or releases all of it, and the decision list for whatever
 * did not stop cleanly.
 * @param props - session-header runtime, host operations, and localized copy.
 * @returns the control and its panel, or nothing while the host has not answered.
 */
export function PausePill(props) {
    const { refresh, toggle, setPanel, decide, t, useSessions, useSession } = props;
    const reading = props.usePauseGlobal(state => state.global);
    const triage = props.usePauseGlobal(state => state.triage);
    const open = props.usePauseGlobal(state => state.panelOpen);
    const error = props.usePauseGlobal(state => state.error);
    const sessions = props.usePauseGlobal(state => state.sessions);
    const [offset, setOffset] = useState(() => loadPillOffset());
    const drag = useRef(undefined);
    const suppressClick = useRef(false);
    // Actions address one user session; the status stream is process-wide.
    const address = useSessions(addressingSession);
    const view = globalPauseView(reading, sessions);
    const list = triageView(triage);
    // A subagent's own header gets nothing, exactly like the per-session control:
    // its work is its parent's, and the parent's header already speaks for the
    // whole tree. The mount read below waits for the same gate, so a header that
    // renders nothing spends no host round-trip either.
    const visible = showsPauseControl(useSession(snapshot => snapshot.subagent));
    // Hand the control the session the shell is on. It reads there once, when it
    // has no answer yet; afterwards the address follows the view while the reads
    // follow the park (see `./global.ts`).
    useEffect(() => {
        if (visible && address !== undefined)
            refresh(address);
    }, [refresh, address, visible]);
    if (!visible || !view.visible || address === undefined)
        return null;
    const onPointerDown = (event) => {
        if (event.button !== 0)
            return;
        drag.current = { startX: event.clientX, startY: event.clientY, base: offset, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event) => {
        const current = drag.current;
        if (current === undefined)
            return;
        const dx = event.clientX - current.startX;
        const dy = event.clientY - current.startY;
        if (!current.moved) {
            const next = draggedOffset(current.base, dx, dy);
            if (next === undefined)
                return;
            current.moved = true;
            event.preventDefault();
            current.last = next;
            setOffset(next);
            return;
        }
        event.preventDefault();
        current.last = draggedOffset(current.base, dx, dy, 0);
        if (current.last !== undefined)
            setOffset(current.last);
    };
    const onPointerUp = (event) => {
        const current = drag.current;
        drag.current = undefined;
        if (current === undefined)
            return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (!current.moved)
            return;
        suppressClick.current = true;
        savePillOffset(current.last ?? current.base);
    };
    const resetPosition = () => {
        setOffset({ x: 0, y: 0 });
        savePillOffset({ x: 0, y: 0 });
    };
    const tip = view.caveats
        .map(caveat => caveat.names.length === 0
        ? t(caveat.key)
        : `${t(caveat.key)} (${caveat.names.join(', ')})`)
        .join('\n');
    return (_jsxs("span", { className: styles.dspPill, style: { transform: `translate(${String(offset.x)}px, ${String(offset.y)}px)` }, title: t('all.drag'), onPointerDown: onPointerDown, onPointerMove: onPointerMove, onPointerUp: onPointerUp, onPointerCancel: onPointerUp, onClickCapture: (event) => {
            if (!suppressClick.current)
                return;
            suppressClick.current = false;
            event.preventDefault();
            event.stopPropagation();
        }, children: [!open
                ? null
                : (_jsxs("div", { className: styles.dspPillPanel, role: "dialog", "aria-label": t('triage.title'), children: [_jsxs("div", { className: styles.dspPillPanelHead, children: [_jsx("span", { className: styles.dspPillText, children: t('triage.title') }), _jsx("button", { type: "button", className: styles.dspPillAction, "aria-label": t('triage.refresh.aria'), onClick: () => { setPanel(true); }, children: t('triage.refresh.aria') }), offset.x === 0 && offset.y === 0
                                    ? null
                                    : (_jsx("button", { type: "button", className: styles.dspPillAction, "aria-label": t('all.reset.aria'), onClick: resetPosition, children: t('all.reset') }))] }), !list.visible
                            ? _jsx("p", { className: styles.dspPillPanelNote, children: t('triage.reading') })
                            : list.unavailable
                                ? _jsx("p", { className: styles.dspPillPanelNote, children: t('triage.unavailable') })
                                : list.rows.length === 0
                                    ? _jsx("p", { className: styles.dspPillPanelNote, children: t('triage.empty') })
                                    : (_jsx("ul", { className: styles.dspPillRows, children: list.rows.map(row => (_jsx(TriageSessionRow, { row: row, decide: decide, t: t }, row.sessionId))) }))] })), view.unclean === 0
                ? null
                : (_jsxs("button", { type: "button", className: styles.dspPillTriage, "aria-label": t('triage.open.aria'), "aria-expanded": open, title: `${String(view.unclean)} ${t('all.triage')}`, onClick: () => { setPanel(!open); }, children: [_jsx(ChevronIcon, {}), _jsx("span", { className: styles.dspPillDetail, children: view.unclean })] })), _jsxs("button", { type: "button", className: view.labelKey === undefined && view.detail.length === 0
                    ? `${styles.dspPillBtn} ${styles.dspPillIcon}`
                    : styles.dspPillBtn, "aria-label": t(view.ariaKey), "aria-pressed": view.action === 'resume-all' || view.action === 'cancel-all', disabled: !view.enabled, ...tip.length === 0 ? {} : { title: tip }, onClick: () => { toggle(address); }, children: [view.action === 'resume-all' || view.action === 'cancel-all' ? _jsx(ResumeIcon, {}) : _jsx(PauseIcon, {}), view.labelKey === undefined ? null : _jsx("span", { className: styles.dspPillText, children: t(view.labelKey) }), view.detail.length === 0 ? null : _jsx("span", { className: styles.dspPillDetail, children: view.detail }), view.caveats.length === 0 ? null : _jsx("span", { className: styles.dspPillWarn, children: _jsx(CaveatIcon, {}) })] })] }));
}
//# sourceMappingURL=pill.js.map