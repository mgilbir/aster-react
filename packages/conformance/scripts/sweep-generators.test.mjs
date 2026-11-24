/**
 * What the schema sweeps generate (audit C263, C332, C479, C619, C759): a property that is several kinds at once is swept as all of
 * them, a skip reason that is false is not a skip, a name collision never replaces a case, and the stack journey stacks.
 */
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import * as vl from 'vega-lite'
import { enumerableUnion, uniqueName, generate as generateVega } from '../src/sweeps/vega-schema.mjs'
import { generate as generateVL } from '../src/sweeps/vega-lite-schema.mjs'
import { generate as generateValues } from '../src/sweeps/values.mjs'

const require = createRequire(import.meta.url)

/** The directory run-sweep.ts builds: every package of vega's and vega-lite's stores, side by side. */
function nodeModules() {
  const dir = mkdtempSync(join(tmpdir(), 'aster-sweep-test-'))
  mkdirSync(join(dir, 'node_modules'))
  const seen = new Set()
  for (const store of [join(dirname(require.resolve('vega')), '..', '..'), join(dirname(require.resolve('vega-lite')), '..', '..')]) {
    for (const name of readdirSync(store)) {
      if (seen.has(name) || name.startsWith('.')) continue
      seen.add(name)
      try { symlinkSync(join(store, name), join(dir, 'node_modules', name), 'dir') } catch { /* linked */ }
    }
  }
  return join(dir, 'node_modules')
}
const ctx = () => ({ vega, vl, require, nodeModules: nodeModules() })

describe('values of a property that is several kinds (C263)', () => {
  const words = { enum: ['millisecond', 'year'] }
  it('is every enum word, both booleans and the numbers together', () => {
    expect(enumerableUnion([words, { type: 'number' }], [0, 8]).values).toEqual(['millisecond', 'year', 0, 8])
    expect(enumerableUnion([{ enum: ['parity', 'greedy'] }, { type: 'boolean' }], []).values).toEqual(['parity', 'greedy', true, false])
    expect(enumerableUnion([{ enum: ['a', null] }, { enum: ['b', 'a'] }], []).values).toEqual(['a', 'b'])
    expect(enumerableUnion([{ type: 'string' }], [1]).values).toEqual([])
  })

  const cases = { vega: generateVega(ctx()).cases, vl: generateVL(ctx()).cases }
  const values = (sweep, family, property) => new Set(cases[sweep].filter((c) => c.family === family && c.property === property).map((c) => c.name.split('-').slice(2).join('-')))
  it('the vega sweep offers tickCount as words and numbers, labelOverlap as words and booleans', () => {
    const tick = values('vega', 'axis', 'tickCount')
    expect([...tick].some((n) => /^(0|0\.5|8|-4)$/.test(n)), [...tick].join()).toBe(true)
    expect(tick.has('year')).toBe(true)
    const overlap = values('vega', 'axis', 'labelOverlap')
    expect(overlap.has('parity') && overlap.has('true') && overlap.has('false'), [...overlap].join()).toBe(true)
  })
  it('the vega-lite sweep offers stack words and booleans, tickCount numbers, every timeUnit word', () => {
    const names = (p) => new Set(cases.vl.filter((c) => c.property === p).map((c) => c.name))
    expect(names('stack').has('encoding-x-stack-true')).toBe(true)
    expect(names('stack').has('encoding-x-stack-center')).toBe(true)
    expect([...names('tickCount')].some((n) => n.endsWith('-tickCount-8'))).toBe(true)
    expect(names('timeUnit').size).toBeGreaterThan(1000)
  })

  it('a skip reason that is not true is not a skip: scale reverse and legend type are swept (C332)', () => {
    const swept = (sweep, p, fam) => cases[sweep].some((c) => c.property === p && c.family.startsWith(fam))
    expect(swept('vega', 'reverse', 'scale')).toBe(true)
    expect(cases.vega.some((c) => c.family === 'legend' && c.property === 'type' && c.name.endsWith('gradient'))).toBe(true)
    expect(cases.vega.some((c) => c.family === 'legend' && c.property === 'type' && c.name.endsWith('symbol'))).toBe(true)
  })

  it('no sweep names two cases alike (C479)', () => {
    for (const k of ['vega', 'vl']) expect(cases[k].length - new Set(cases[k].map((c) => c.name)).size, k).toBe(0)
  })
})

describe('a case name that collides gets the next free one (C479)', () => {
  it('four values that slug alike give four names', () => {
    const used = new Map()
    expect([1, 2, 3, 4].map(() => uniqueName(used, 'x'))).toEqual(['x', 'x-2', 'x-3', 'x-4'])
  })
  it('a base that is itself a numbered name cannot collide with it', () => {
    const used = new Map()
    expect(['x', 'x', 'x-2', 'x-2'].map((n) => uniqueName(used, n))).toEqual(['x', 'x-2', 'x-2-2', 'x-2-3'])
  })
})

describe('the value sweep stacks (C619)', () => {
  it('the stacked charts group two rows per stack, and one journey groups by the swept values', () => {
    const { cases } = generateValues()
    const stacked = cases.filter((c) => c.name.startsWith('linear-rect-stacked--'))
    expect(stacked.length).toBeGreaterThan(20)
    const spec = JSON.parse(stacked[0].specText ?? JSON.stringify(stacked[0].spec))
    const rows = spec.data[0].values
    expect(spec.data[0].transform[0].groupby).toEqual(['g'])
    expect(new Set(rows.map((r) => r.g)).size).toBeLessThan(rows.length)
    expect(cases.some((c) => c.name.startsWith('stacked-by-the-values--'))).toBe(true)
  })
})
