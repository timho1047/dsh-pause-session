/** The pill's remembered position: storage, reset, and the drag threshold. */
import { describe, expect, it } from 'vitest'
import {
  draggedOffset, loadPillOffset, PILL_POSITION_KEY, savePillOffset,
} from '../src/client/pill-position.ts'
import type { PillStorage } from '../src/client/pill-position.ts'

/** An in-memory Storage double. */
function storageDouble(): PillStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

describe('pill position', () => {
  it('round-trips a saved offset and resets to the origin', () => {
    const storage = storageDouble()
    savePillOffset({ x: 12, y: -8 }, storage)
    expect(loadPillOffset(storage)).toEqual({ x: 12, y: -8 })
    expect(storage.values.has(PILL_POSITION_KEY)).toBe(true)

    savePillOffset({ x: 0, y: 0 }, storage)
    expect(loadPillOffset(storage)).toEqual({ x: 0, y: 0 })
    expect(storage.values.has(PILL_POSITION_KEY)).toBe(false)
  })

  it('ignores malformed or missing storage', () => {
    const storage = storageDouble()
    storage.values.set(PILL_POSITION_KEY, '{not json')
    expect(loadPillOffset(storage)).toEqual({ x: 0, y: 0 })
    expect(loadPillOffset()).toEqual({ x: 0, y: 0 })
  })

  it('keeps a small movement as a click until the threshold', () => {
    expect(draggedOffset({ x: 10, y: 10 }, 1, 2)).toBeUndefined()
    expect(draggedOffset({ x: 10, y: 10 }, 4, 0)).toEqual({ x: 14, y: 10 })
    expect(draggedOffset({ x: 10, y: 10 }, 0, -5)).toEqual({ x: 10, y: 5 })
  })
})
