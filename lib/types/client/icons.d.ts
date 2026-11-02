/**
 * The glyphs both pause controls are drawn with, so the session-header
 * control and the whole-app pill cannot drift apart.
 * @module dsh-pause-session/client/icons
 */
import type { ReactNode } from 'react';
/** 16px stroke icon (currentColor): the two bars of a pause. */
export declare function PauseIcon(): ReactNode;
/** 16px stroke icon (currentColor): the triangle of a resume. */
export declare function ResumeIcon(): ReactNode;
/**
 * 16px stroke icon (currentColor): the rings of a target, for the goal switch
 * on the session header. Drawn at 16px like the pause and resume glyphs it sits
 * beside rather than the 14px marks the two reports use.
 */
export declare function GoalIcon(): ReactNode;
/**
 * 14px stroke icon (currentColor): the mark that a report carries a caveat.
 * A glyph rather than copy, so the facts it stands for stay in the locale
 * dictionaries beside everything else the user reads.
 */
export declare function CaveatIcon(): ReactNode;
/** 14px stroke icon (currentColor): the chevron that opens the decision list. */
export declare function ChevronIcon(): ReactNode;
