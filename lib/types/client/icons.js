import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** 16px stroke icon (currentColor): the two bars of a pause. */
export function PauseIcon() {
    return (_jsxs("svg", { "aria-hidden": "true", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", children: [_jsx("path", { d: "M9 5v14" }), _jsx("path", { d: "M15 5v14" })] }));
}
/** 16px stroke icon (currentColor): the triangle of a resume. */
export function ResumeIcon() {
    return (_jsx("svg", { "aria-hidden": "true", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", children: _jsx("path", { d: "M7 4.5v15l12-7.5z" }) }));
}
/**
 * 16px stroke icon (currentColor): the rings of a target, for the goal switch
 * on the session header. Drawn at 16px like the pause and resume glyphs it sits
 * beside rather than the 14px marks the two reports use.
 */
export function GoalIcon() {
    return (_jsxs("svg", { "aria-hidden": "true", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", children: [_jsx("circle", { cx: "12", cy: "12", r: "8" }), _jsx("circle", { cx: "12", cy: "12", r: "3" })] }));
}
/**
 * 14px stroke icon (currentColor): the mark that a report carries a caveat.
 * A glyph rather than copy, so the facts it stands for stay in the locale
 * dictionaries beside everything else the user reads.
 */
export function CaveatIcon() {
    return (_jsxs("svg", { "aria-hidden": "true", width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", children: [_jsx("circle", { cx: "12", cy: "12", r: "9" }), _jsx("path", { d: "M12 7.5v5.5" }), _jsx("path", { d: "M12 16.5v.5" })] }));
}
/** 14px stroke icon (currentColor): the chevron that opens the decision list. */
export function ChevronIcon() {
    return (_jsx("svg", { "aria-hidden": "true", width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", children: _jsx("path", { d: "M6 15l6-6 6 6" }) }));
}
//# sourceMappingURL=icons.js.map