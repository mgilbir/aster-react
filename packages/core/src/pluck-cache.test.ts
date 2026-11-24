// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { field, memoField, pluck, pluckCacheSize, PLUCK_CACHE_MAX, recentlyUsed } from './util.js'

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

  it('keeps the recently used names: a name read again survives a flood of new ones, one not read again does not', () => {
    const hot = memoField('hot')
    const cold = memoField('cold')
    // three tables' worth of names, the hot one read again every few: a table that dropped the oldest entry first (a FIFO) would
    // let it go after PLUCK_CACHE_MAX names, and the accessor would be another object
    for (let i = 0; i < PLUCK_CACHE_MAX * 3; i++) {
      memoField('flood_' + i)
      if (i % 64 === 0) expect(memoField('hot'), `after ${i}`).toBe(hot)
    }
    expect(memoField('hot')).toBe(hot)
    expect(memoField('cold')).not.toBe(cold)
    expect(pluckCacheSize()).toBe(PLUCK_CACHE_MAX)
  })
})

describe('recentlyUsed keeps what it promises, against a model', () => {
  // The contract (util.ts): at most `max` entries; a hit costs no `make`; an entry used within the last max / 2 distinct keys is
  // never dropped. Random access sequences over a few key-space sizes, with the number of `make` calls a hit must not add.
  it.each([[8, 5], [8, 40], [64, 100], [64, 5000]])('max %i over %i keys', (max, keys) => {
    let seed = max * 7919 + keys
    const rand = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
    let made = 0
    const get = recentlyUsed(max, (k: number) => ({ k, made: ++made }))
    const madeFor = new Map<number, unknown>()
    /** The distinct keys, most recently read first. */
    const recent: number[] = []
    for (let step = 0; step < 4000; step++) {
      const key = rand() < 0.3 && recent.length ? recent[Math.floor(rand() * Math.min(recent.length, max / 2))]! : Math.floor(rand() * keys)
      const idx = recent.indexOf(key)
      // used within the last max / 2 distinct keys: fewer than that many others were read since
      const young = idx !== -1 && idx < max / 2
      const before = made
      const value = get(key)
      if (young) {
        expect(made, `step ${step}: ${key} was read within the last ${max / 2} distinct keys and was made again`).toBe(before)
        expect(value, `step ${step}`).toBe(madeFor.get(key))
      }
      madeFor.set(key, value)
      if (idx !== -1) recent.splice(idx, 1)
      recent.unshift(key)
      expect(get.size(), `step ${step}`).toBeLessThanOrEqual(max)
    }
    expect(get.size()).toBe(Math.min(max, new Set(madeFor.keys()).size))
  })
})
