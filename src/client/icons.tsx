/**
 * The two glyphs both safe-stop controls are drawn with, so the session-header
 * control and the whole-app pill cannot drift apart.
 * @module dsh-safe-stop/client/icons
 */

import type { ReactNode } from 'react'

/** 16px stroke icon (currentColor): the two bars of a pause. */
export function PauseIcon(): ReactNode {
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
export function ResumeIcon(): ReactNode {
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

/**
 * 14px stroke icon (currentColor): the mark that a report carries a caveat.
 * A glyph rather than copy, so the facts it stands for stay in the locale
 * dictionaries beside everything else the user reads.
 */
export function CaveatIcon(): ReactNode {
  return (
    <svg
      aria-hidden="true"
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.5v.5" />
    </svg>
  )
}

/** 14px stroke icon (currentColor): the chevron that opens the decision list. */
export function ChevronIcon(): ReactNode {
  return (
    <svg
      aria-hidden="true"
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 15l6-6 6 6" />
    </svg>
  )
}
