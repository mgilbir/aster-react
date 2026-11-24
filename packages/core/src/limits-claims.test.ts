// @vitest-environment node
/**
 * The claims of docs/LIMITS.md that no other suite attacks (C340, C107). limits-sites.test.ts runs every spec-sized site under every
 * limits form; limits-clock.test.ts the clock inside every pass; limits-attacks.test.ts the allocators and the caps. What is left
 * is here: the `items` ceilings of the colour schemes, contour levels and drawn axis ticks, the spec-size ceiling under every shape
 * of `limits`, "maxDepth can only lower it", the recursive `maxMarks`, the exact `maxSvgLength`, and the regex caps with their
 * defaults. The ones that would exhaust the process on a regression run in a child (attack.testkit.ts); the exact boundaries run
 * here.
 */
import { describe, expect, it } from 'vitest'
import { attack, expectLimit, expectReturned } from './attack.testkit.js'
import { checkSpecLimits, renderSpec, type SpecLimits, type VgSpec } from './index.js'
import './addon-load.js'
import './addon-transforms.js'

const T = 40_000
const CEILING = /built-in ceiling that applies even without limits; raise it with limits\.maxItems/

describe('the items ceiling, with no limits and with limits that do not name items', () => {
  // (a budget that bounds the rows names the sequence that makes the axis's values first: the axis site is run without maxRows)
  const FORMS = ['undefined', '{}', '{ maxRows: 1000 }', '{ maxStringLength: 100000, regex: "refuse" }']
  const SITES: Array<[name: string, spec: string, message: RegExp, forms?: string[]]> = [
    ['contour levels 5e7', `{ width: 100, height: 100, data: [{ name: 't', values: [{ x: 1, y: 1 }, { x: 5, y: 5 }, { x: 3, y: 9 }], transform: [{ type: 'contour', x: 'x', y: 'y', size: [100, 100], count: 5e7 }] }] }`, /contour levels 50000000 > 100000/],
    ['isocontour levels 5e7', `{ width: 100, height: 100, data: [{ name: 't', values: [{ x: 1, y: 1 }, { x: 5, y: 5 }], transform: [{ type: 'kde2d', x: 'x', y: 'y', size: [100, 100] }, { type: 'isocontour', field: 'grid', levels: 5e7 }] }] }`, /isocontour levels 50000000 > 100000/],
    ['a colour scheme of 5e7 classes', `{ width: 100, height: 100, scales: [{ name: 'c', type: 'quantize', domain: [0, 1], range: { scheme: 'blues', count: 5e7 } }], legends: [{ fill: 'c' }] }`, /colour scheme count 50000000 > 100000/],
    // an axis given its ticks (`values`) is not bounded by the tick count: the ticks it draws are
    ['axis ticks drawn (values 150 000)', `{ width: 100, height: 100, scales: [{ name: 'x', type: 'linear', domain: [0, 1e6], range: 'width' }], axes: [{ scale: 'x', orient: 'bottom', values: { signal: 'sequence(0, 150000)' } }] }`, /axis ticks 150000 > 100000/, ['undefined', '{}', '{ maxStringLength: 100000, regex: "refuse" }']],
  ]
  for (const [name, spec, message, own] of SITES) {
    const forms = own ?? FORMS
    it(`${name}: refused before it is made, under every form`, async () => {
      const r = await attack(`
        const out = []
        for (const limits of [${forms.join(', ')}]) {
          const c0 = process.cpuUsage()
          try { core.renderSpec(${spec}, { limits }); out.push({ limits, threw: null }) } catch (e) { out.push({ limits, threw: e.name + ': ' + e.message }) }
          out[out.length - 1].cpuMs = (c => (c.user + c.system) / 1000)(process.cpuUsage(c0))
        }
        return out`)
      expectReturned(r)
      const out = r.value as Array<{ limits: unknown; threw: string | null; cpuMs: number }>
      expect(out).toHaveLength(forms.length)
      for (const o of out) {
        expect(o.threw, JSON.stringify(o)).toMatch(/^AsterLimitError: /)
        expect(o.threw, JSON.stringify(o)).toMatch(message)
        expect(o.threw, JSON.stringify(o)).toMatch(CEILING)
        expect(o.cpuMs, JSON.stringify(o)).toBeLessThan(2000)
      }
    }, T)
  }
  it('limits.maxItems replaces the ceiling at the same site: it is the budget that refuses', async () => {
    const r = await attack(`
      core.renderSpec({ width: 100, height: 100, scales: [{ name: 'x', type: 'linear', domain: [0, 1e6], range: 'width' }], axes: [{ scale: 'x', orient: 'bottom', values: { signal: 'sequence(0, 150000)' } }] }, { limits: { maxItems: 1000 } })`)
    expectLimit(r, /maxItems 150000 > 1000 \(axis ticks\)/, 500)
  }, T)
})

describe('the spec-size ceiling holds under every shape of limits (C107)', () => {
  // `let o = {a: 1}; for (...) o = {p: o, q: o}`: 2^N paths, N objects. Cannot come from JSON.parse; code that builds specs, or a
  // structured clone across postMessage, can.
  const dag = (n: number) => `(() => { let o = { a: 1 }; for (let i = 0; i < ${n}; i++) o = { p: o, q: o }; return { width: 10, height: 10, marks: [], usermeta: o } })()`
  for (const [form, limits] of [['no limits', 'undefined'], ['limits {}', '{}'], ['maxRows', '{ maxRows: 10000 }'], ['maxItems and regex refuse', "{ maxItems: 50000, regex: 'refuse' }"], ['maxDepth', '{ maxDepth: 500 }']] as const) {
    it(`40 levels of shared objects under ${form} is refused as a spec size, not walked`, async () => {
      const r = await attack(`return core.renderSpec(${dag(40)}, { limits: ${limits} })`)
      expectLimit(r, /spec size > 5000000 objects/, 3000)
    }, T)
  }
  it('the pre-flight alone (checkSpecLimits) has the ceiling', async () => {
    const r = await attack(`return core.checkSpecLimits(${dag(40)}, {})`)
    expectLimit(r, /spec size > 5000000 objects/, 3000)
  }, T)
  it('a shared object below the ceiling is not refused: 20 levels (2^20 paths) pass', async () => {
    const r = await attack(`core.checkSpecLimits(${dag(20)}, {}); return core.renderSpec(${dag(20)}, { limits: {} }).length > 0`)
    expectReturned(r, true)
  }, T)
})

describe('maxDepth can only lower the built-in depth ceiling', () => {
  const nested = (n: number): VgSpec => {
    let o: Record<string, unknown> = { type: 'group' }
    const root = o
    for (let i = 0; i < n; i++) { const c = { type: 'group' }; o.marks = [c]; o = c }
    return { width: 10, height: 10, marks: [root] } as unknown as VgSpec
  }
  it('maxDepth 100000 over a spec 3000 deep is still refused at the ceiling (1000)', () => {
    expect(() => renderSpec(nested(3000), { limits: { maxDepth: 100000 } })).toThrow(/maxDepth \d+ > 1000$/)
  })
  it('a lower maxDepth refuses at its own number', () => {
    expect(() => renderSpec(nested(60), { limits: { maxDepth: 50 } })).toThrow(/maxDepth \d+ > 50$/)
    expect(() => renderSpec(nested(10), { limits: { maxDepth: 50 } })).not.toThrow()
  })
})

describe('maxMarks counts every mark definition, nested groups included', () => {
  const sym = { type: 'symbol', encode: { update: { x: { value: 1 }, y: { value: 1 } } } }
  // 5 definitions: two symbols and three groups' worth (symbol, group[symbol, group[symbol]])
  const spec = { width: 50, height: 50, marks: [sym, { type: 'group', marks: [sym, { type: 'group', marks: [sym] }] }] } as unknown as VgSpec
  it('5 definitions pass maxMarks 5 and are refused by maxMarks 4, with no budget that is not the one set', () => {
    expect(renderSpec(spec, { limits: { maxMarks: 5 } }).length).toBeGreaterThan(0)
    expect(() => renderSpec(spec, { limits: { maxMarks: 4 } })).toThrow(/maxMarks/)
  })
  it('the count follows the definitions, not the items: one symbol over 100 rows is one mark', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ i }))
    const one = { width: 50, height: 50, data: [{ name: 'd', values: rows }], marks: [{ type: 'symbol', from: { data: 'd' }, encode: { update: { x: { field: 'i' }, y: { value: 1 } } } }] } as unknown as VgSpec
    expect(renderSpec(one, { limits: { maxMarks: 1 } }).length).toBeGreaterThan(0)
  })
})

describe('maxSvgLength is exact', () => {
  const sym = { type: 'symbol', encode: { update: { x: { value: 1 }, y: { value: 1 } } } }
  const spec = { width: 50, height: 50, marks: [sym, { type: 'group', marks: [sym] }] } as unknown as VgSpec
  it('the SVG\'s own length passes, one less is refused', () => {
    const length = renderSpec(spec).length
    expect(renderSpec(spec, { limits: { maxSvgLength: length } }).length).toBe(length)
    expect(() => renderSpec(spec, { limits: { maxSvgLength: length - 1 } })).toThrow(/maxSvgLength/)
  })
})

describe('regular expressions: the default caps are exact', () => {
  const formula = (expr: string, rows: Array<Record<string, unknown>> = [{ a: 1 }]): VgSpec =>
    ({ data: [{ name: 't', values: rows, transform: [{ type: 'formula', as: 'n', expr }] }] }) as unknown as VgSpec
  const withString = (n: number) => [{ s: 'a'.repeat(n) }]
  const limits: SpecLimits = {}
  it('a pattern of 1024 characters runs and one of 1025 is refused, under limits {}', () => {
    // (a class of 1022 letters is one position to the screen: the cap is what is measured here. A plain run of 1024 letters is one
    // position each, and the screen's analysis of all the patterns of an evaluation, SCREEN_STEPS, is spent at about 600 of them)
    const cls = (n: number): string => `[${'a'.repeat(n - 2)}]`
    expect(() => renderSpec(formula(`test(regexp('${cls(1024)}'), 'a')`), { limits })).not.toThrow()
    expect(() => renderSpec(formula(`test(regexp('${cls(1025)}'), 'a')`), { limits })).toThrow(/pattern length 1025 > 1024/)
    expect(() => renderSpec(formula(`test(/${cls(1024)}/, 'a')`), { limits })).not.toThrow()
    expect(() => renderSpec(formula(`test(/${cls(1025)}/, 'a')`), { limits })).toThrow(/pattern length 1025 > 1024/)
    // and a run of letters under the analysis budget still runs
    expect(() => renderSpec(formula(`test(/${'a'.repeat(500)}/, 'a')`), { limits })).not.toThrow()
  })
  it('an input of 10 000 characters runs and one of 10 001 is refused, in test, replace, split and countpattern', () => {
    const calls: Array<[string, (n: number) => VgSpec]> = [
      ['test', (n) => formula('test(/b/, datum.s)', withString(n))],
      ['replace', (n) => formula("replace(datum.s, /b/, 'c')", withString(n))],
      ['split', (n) => formula('split(datum.s, /b/)', withString(n))],
      ['countpattern', (n) => ({ data: [{ name: 't', values: withString(n), transform: [{ type: 'countpattern', field: 's' }] }] }) as unknown as VgSpec],
    ]
    for (const [name, make] of calls) {
      expect(() => renderSpec(make(10_000), { limits }), name).not.toThrow()
      expect(() => renderSpec(make(10_001), { limits }), name).toThrow(/maxStringLength 10001 > 10000/)
    }
  })
  it('maxStringLength raises the input cap, and not the pattern cap', () => {
    expect(() => renderSpec(formula('test(/b/, datum.s)', withString(20_000)), { limits: { maxStringLength: 50_000 } })).not.toThrow()
    expect(() => renderSpec(formula("test(regexp(pad('a', 1025, 'a')), 'a')"), { limits: { maxStringLength: 50_000 } })).toThrow(/pattern length 1025 > 1024/)
  })
})

describe('checkSpecLimits is the same walk the render takes', () => {
  it('a spec without sharing is walked once and passes', () => {
    expect(() => checkSpecLimits({ width: 10, height: 10, marks: [] } as unknown as VgSpec, {})).not.toThrow()
  })
})
