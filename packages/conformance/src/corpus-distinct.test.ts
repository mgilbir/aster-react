import { describe, expect, it } from 'vitest'
import { canonicalHash, checkIdentical, checkNoItems, groupIdentical } from './corpus-distinct.js'
import { canonicalizeSvg } from './normalize.js'

const names = (...n: string[]): Set<string> => new Set(n)

describe('groupIdentical', () => {
  it('groups the entries that share a hash, sorted, and drops the singletons', () => {
    const h = new Map([['b', '1'], ['a', '1'], ['c', '2'], ['e', '3'], ['d', '3'], ['f', '3']])
    expect(groupIdentical(h)).toEqual([['a', 'b'], ['d', 'e', 'f']])
  })
})

describe('canonicalHash', () => {
  const svg = (w: number): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20"><rect x="1" y="1" width="5" height="5" fill="red"/></svg>`
  it('is equal for equal renders and differs when anything the gate compares differs', () => {
    expect(canonicalHash(canonicalizeSvg(svg(30)))).toBe(canonicalHash(canonicalizeSvg(svg(30))))
    expect(canonicalHash(canonicalizeSvg(svg(30)))).not.toBe(canonicalHash(canonicalizeSvg(svg(31))))
    expect(canonicalHash(canonicalizeSvg(svg(30)))).not.toBe(canonicalHash(canonicalizeSvg(svg(30).replace('red', 'blue'))))
  })
})

describe('checkIdentical', () => {
  const table = { groups: [{ specs: ['x', 'y'], why: 'known' }] }
  it('accepts the corpus as the table says', () => {
    expect(checkIdentical([['y', 'x']], table, names('x', 'y'))).toEqual([])
  })
  it('refuses a new render-identical pair', () => {
    const p = checkIdentical([['x', 'y'], ['p', 'q']], table, names('x', 'y', 'p', 'q'))
    expect(p).toHaveLength(1)
    expect(p[0]).toContain('p == q')
  })
  it('refuses a group that grew (a third member renders alike)', () => {
    const p = checkIdentical([['x', 'y', 'z']], table, names('x', 'y', 'z'))
    expect(p.some((m) => m.includes('x == y == z'))).toBe(true)
    expect(p.some((m) => m.includes('x == y') && m.includes('no longer render identically'))).toBe(true)
  })
  it('refuses a table entry that is fixed, so the table only ever shrinks', () => {
    const p = checkIdentical([], table, names('x', 'y'))
    expect(p).toHaveLength(1)
    expect(p[0]).toContain('no longer render identically')
  })
  it('refuses a table entry naming a spec that is gone', () => {
    const p = checkIdentical([], table, names('x'))
    expect(p[0]).toContain('y no longer exist')
  })
  it('refuses a group of one', () => {
    expect(checkIdentical([], { groups: [{ specs: ['x'], why: 'w' }] }, names('x')).join('\n')).toContain('needs two or more')
  })
})

describe('checkNoItems', () => {
  const table = { specs: [{ name: 'guides', why: 'a guide-only spec, by design' }] }
  it('accepts the entries the table lists', () => {
    expect(checkNoItems(['guides'], table, names('guides'))).toEqual([])
  })
  it('refuses an unlisted entry that draws nothing of its own', () => {
    expect(checkNoItems(['guides', 'hollow'], table, names('guides', 'hollow'))[0]).toContain('hollow draws no item')
  })
  it('refuses a listed entry that now draws, or is gone, or has no reason', () => {
    expect(checkNoItems([], table, names('guides'))[0]).toContain('now draws items')
    expect(checkNoItems([], table, names())[0]).toContain('not in the corpus')
    expect(checkNoItems(['g'], { specs: [{ name: 'g', why: '' }] }, names('g'))[0]).toContain('needs a reason')
  })
})
