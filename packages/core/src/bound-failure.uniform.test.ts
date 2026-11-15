/**
 * A symbol or path mark whose judged channel no encode set defines (and no transform of the mark writes) holds one value on every item,
 * so vega's Bound outcome is decided by the first item: the others are not read. A mark whose channel is encoded is judged item by item.
 */
import { describe, expect, it } from 'vitest'
import { boundFailure } from './bound-failure.js'
import type { SceneItem } from './types.js'

function counted(n: number, shape: string | undefined): { items: SceneItem[]; reads: () => number } {
  let reads = 0
  const items = Array.from({ length: n }, () => {
    const it = {} as Record<string, unknown>
    Object.defineProperty(it, 'shape', { get: () => { reads++; return shape }, enumerable: true })
    return it as unknown as SceneItem
  })
  return { items, reads: () => reads }
}

describe('boundFailure', () => {
  it('reads one item of a mark whose channel is the same on every item', () => {
    const { items, reads } = counted(10_000, undefined)
    expect(boundFailure('symbol', items, undefined, false, true)).toBeUndefined()
    expect(reads()).toBe(1)
  })
  it('reads every item of a mark whose channel is encoded', () => {
    const { items, reads } = counted(10_000, 'circle')
    expect(boundFailure('symbol', items, undefined, false, false)).toBeUndefined()
    expect(reads()).toBe(10_000)
  })
  it('a uniform channel vega cannot measure fails at the first item, as judging every item does', () => {
    const { items } = counted(5, 'M0,0 L')
    const all = boundFailure('symbol', items, undefined, false, false)
    const one = boundFailure('symbol', items, undefined, false, true)
    expect(all?.from).toBe(0)
    expect(one?.from).toBe(0)
    expect(String(one?.error)).toBe(String(all?.error))
  })
})
