// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { field, pluck, pluckCacheSize, PLUCK_CACHE_MAX } from './util.js'

describe('pluck memoizes accessors in a bounded table', () => {
  it('stays at PLUCK_CACHE_MAX however many distinct names are read (it grew without bound before)', () => {
    for (let i = 0; i < PLUCK_CACHE_MAX * 20; i++) pluck({ ['name_' + i]: i }, 'name_' + i)
    expect(pluckCacheSize()).toBe(PLUCK_CACHE_MAX)
  })

  it('reads the same values as an unbounded table did, hit or miss, evicted names included', () => {
    const datum = { a: 1, b: 2, nested: { x: 3 }, 0: 'zero' }
    const first = [pluck(datum, 'a'), pluck(datum, 'nested.x'), pluck(datum, 'b'), pluck([datum, { a: 9 }], 'a')]
    for (let i = 0; i < PLUCK_CACHE_MAX + 10; i++) pluck({}, 'evict_' + i) // push every earlier name out
    const again = [pluck(datum, 'a'), pluck(datum, 'nested.x'), pluck(datum, 'b'), pluck([datum, { a: 9 }], 'a')]
    expect(again).toEqual(first)
    // and they are what a fresh (uncached) accessor reads
    const fresh = [field('a')(datum), field('nested.x')(datum), field('b')(datum), [datum, { a: 9 }].map(field('a'))]
    expect(first).toEqual(fresh)
  })

  it('keeps the recently used names: a name read again survives a flood of new ones', () => {
    pluck({ hot: 1 }, 'hot')
    for (let i = 0; i < PLUCK_CACHE_MAX - 2; i++) { pluck({}, 'cold_' + i); pluck({ hot: 1 }, 'hot') }
    expect(pluckCacheSize()).toBeLessThanOrEqual(PLUCK_CACHE_MAX)
  })
})
