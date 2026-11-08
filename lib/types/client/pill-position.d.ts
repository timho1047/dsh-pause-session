/**
 * The global pill's remembered position, kept out of the React component so
 * the storage and drag threshold have a small, testable seam.
 * @module dsh-pause-session/client/pill-position
 */
/** The localStorage key for the pill offset. */
export declare const PILL_POSITION_KEY = "dsh.pause.pill.position";
/** One pill offset from its header seat. */
export interface PillOffset {
    readonly x: number;
    readonly y: number;
}
/** The storage methods the position uses; a subset so tests can fake them. */
export interface PillStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
/**
 * Read the persisted offset. A malformed value or unavailable storage is zero.
 * @param storage - storage override for tests.
 * @returns the saved offset or the origin.
 */
export declare function loadPillOffset(storage?: PillStorage): PillOffset;
/**
 * Persist the offset; zero removes the key.
 * @param offset - the position to remember.
 * @param storage - storage override for tests.
 */
export declare function savePillOffset(offset: PillOffset, storage?: PillStorage): void;
/**
 * Apply a pointer delta once it crosses the drag threshold.
 * @param base - the offset at pointer-down.
 * @param dx - horizontal delta.
 * @param dy - vertical delta.
 * @param threshold - movement below this remains a click.
 * @returns the new offset, or undefined while the gesture is still a click.
 */
export declare function draggedOffset(base: PillOffset, dx: number, dy: number, threshold?: number): PillOffset | undefined;
