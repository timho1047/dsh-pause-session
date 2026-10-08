/** `safe-stop` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'pause.aria': '暂停这个会话：下一条模型请求不再发出',
  'pause.tip': '暂停这个会话',
  'resume.aria': '恢复这个已暂停的会话',
  'resume.tip': '恢复这个会话',
  'state.paused': '已暂停',
  'checking.aria': '正在读取这个会话的暂停状态',
  'checking.tip': '正在读取暂停状态',
  'unavailable.aria': '暂停状态暂不可用',
  'unavailable.tip': '暂停状态暂不可用',
} satisfies Record<string, string>

/** The safe-stop namespace key union. */
export type SafeStopKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en: Record<SafeStopKey, string> = {
  'pause.aria': 'Pause this session: its next model request will not be sent',
  'pause.tip': 'Pause this session',
  'resume.aria': 'Resume this paused session',
  'resume.tip': 'Resume this session',
  'state.paused': 'Paused',
  'checking.aria': 'Reading this session’s pause state',
  'checking.tip': 'Reading pause state',
  'unavailable.aria': 'Pause state is unavailable',
  'unavailable.tip': 'Pause state is unavailable',
}
