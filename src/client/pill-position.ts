/**
 * The global pill's remembered position, kept out of the React component so
 * the storage and drag threshold have a small, testable seam.
 * @module dsh-pause-session/client/pill-position
 */

/** The localStorage key for the pill offset. */
export const PILL_POSITION_KEY = 'dsh.pause.pill.position'

/** One pill offset from its header seat. */
export interface PillOffset {
  readonly x: number
  readonly y: number
}

/** The storage methods the position uses; a subset so tests can fake them. */
export interface PillStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Resolve the browser storage, or undefined in a non-browser context. */
function storageOf(storage: PillStorage | undefined): PillStorage | undefined {
  if (storage !== undefined) return storage
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

/**
 * Read the persisted offset. A malformed value or unavailable storage is zero.
 * @param storage - storage override for tests.
 * @returns the saved offset or the origin.
 */
export function loadPillOffset(storage?: PillStorage): PillOffset {
  const target = storageOf(storage)
  if (target === undefined) return { x: 0, y: 0 }
  try {
    const raw = target.getItem(PILL_POSITION_KEY)
    if (raw === null) return { x: 0, y: 0 }
    const value = JSON.parse(raw) as Partial<PillOffset>
    return { x: typeof value.x === 'number' ? value.x : 0, y: typeof value.y === 'number' ? value.y : 0 }
  } catch {
    return { x: 0, y: 0 }
  }
}

/**
 * Persist the offset; zero removes the key.
 * @param offset - the position to remember.
 * @param storage - storage override for tests.
 */
export function savePillOffset(offset: PillOffset, storage?: PillStorage): void {
  const target = storageOf(storage)
  if (target === undefined) return
  try {
    if (offset.x === 0 && offset.y === 0) target.removeItem(PILL_POSITION_KEY)
    else target.setItem(PILL_POSITION_KEY, JSON.stringify(offset))
  } catch {
    // A private/storage-disabled profile keeps the position for this page only.
  }
}

/**
 * Apply a pointer delta once it crosses the drag threshold.
 * @param base - the offset at pointer-down.
 * @param dx - horizontal delta.
 * @param dy - vertical delta.
 * @param threshold - movement below this remains a click.
 * @returns the new offset, or undefined while the gesture is still a click.
 */
export function draggedOffset(base: PillOffset, dx: number, dy: number, threshold = 4): PillOffset | undefined {
  return Math.hypot(dx, dy) < threshold ? undefined : { x: base.x + dx, y: base.y + dy }
}
