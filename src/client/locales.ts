/** `safe-stop` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'action.aria': '安全停止：把所有正在运行的会话停在安全点',
  'action.tip': '安全停止（尚未接线）',
} satisfies Record<string, string>

/** The safe-stop namespace key union. */
export type SafeStopKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en: Record<SafeStopKey, string> = {
  'action.aria': 'Safe stop: park every running session at a safe point',
  'action.tip': 'Safe stop (not wired yet)',
}
