// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { compileChart, evaluateChart, getChartInfo, renderSpec } from './index.js'
import './addon-transforms.js'
import { createChartSession } from './session.js'
import { createChartStream } from './stream.js'
import { makesRegex } from './expr-check.js'
import { parseExpression } from './expr-parser.js'
import type { VgSpec } from './types.js'

const REFUSE = { regex: 'refuse' } as const
const ROWS = [{ a: 'aab', n: 1 }, { a: 'ba', n: 2 }]

/** A spec whose dataset `t` has `transforms`, drawn as text. */
const withTransforms = (transforms: unknown[], extra: Record<string, unknown> = {}): VgSpec => ({
  width: 60, height: 40, autosize: 'none',
  data: [{ name: 't', values: ROWS, transform: transforms }],
  marks: [{ type: 'text', from: { data: 't' }, encode: { update: { y: { field: 'n' }, text: { signal: "'' + datum.a" } } } }],
  ...extra,
}) as never
const formula = (expr: string): VgSpec => withTransforms([{ type: 'formula', expr, as: 'r' }])

/** It is refused with the option (a limit error, nothing drawn) and draws without it (the spec itself is fine). */
function expectRefusedOnlyWithOption(spec: VgSpec, what: string): void {
  expect(() => renderSpec(spec), `${what} draws without the option`).not.toThrow()
  expect(() => renderSpec(spec, { limits: {} }), `${what} draws under limits without the option`).not.toThrow()
  let err: unknown
  try { renderSpec(spec, { limits: REFUSE }) } catch (e) { err = e }
  expect(err, what).toBeInstanceOf(Error)
  expect((err as { code?: string }).code, what).toBe('ASTER_LIMIT')
  expect((err as Error).message, what).toContain("regular expressions are disabled (limits.regex: 'refuse')")
}

describe("limits.regex: 'refuse'", () => {
  describe('the cases of the issue', () => {
    for (const expr of [
      "test('a+', datum.a)",
      "(test)('a+', datum.a)",
      "replace(datum.a, / a+/, '')",
      "split(datum.a, regexp(','))",
    ]) {
      it(expr, () => expectRefusedOnlyWithOption(formula(expr), expr))
    }
    it('_test (refused as an unknown function before any limit, with or without the option)', () => {
      expect(() => renderSpec(formula("_test('a+', datum.a)"))).toThrow(/Unrecognized function: _test/)
      expect(() => renderSpec(formula("_test('a+', datum.a)"), { limits: REFUSE })).toThrow()
    })
    it("replace(datum.a, 'a+', ''): a text pattern is literal and still draws", () => {
      const spec = formula("replace(datum.a, 'a+', '')")
      expect(renderSpec(spec, { limits: REFUSE })).toBe(renderSpec(spec))
    })
  })

  describe('every spelling of a regular expression in an expression', () => {
    for (const expr of [
      '/a/', '/ .*a/', '/a/gi', '(/a/)', "[/a/][0] ? 1 : 0", "{x: /a/}.x ? 1 : 0",
      "test(/a/, datum.a)", "test(regexp('a'), datum.a)", "regexp('a', 'g') ? 1 : 0", '((test))(/a/, datum.a)',
      "split(datum.a, /,/)", "replace(datum.a, regexp('a', 'g'), 'x')", "replace(datum.a, /a/g, 'x')",
      // never evaluated: refused all the same (for the spec, whatever the data)
      "datum.a === 'zz' ? test('a', datum.a) : 0", "false && test('a', datum.a)", "if(false, regexp('a'), 0)",
    ]) {
      it(expr, () => expectRefusedOnlyWithOption(formula(expr), expr))
    }
  })

  describe('every place of a spec an expression stands in', () => {
    const T = "test('a', 'a')"
    const base = (extra: Record<string, unknown>): VgSpec => ({ width: 60, height: 40, autosize: 'none', data: [{ name: 't', values: ROWS }], ...extra }) as never
    const textMark = (update: Record<string, unknown>, from = 't'): Record<string, unknown> => ({ type: 'text', from: { data: from }, encode: { update: { text: { value: 'x' }, ...update } } })
    const CASES: Array<[string, VgSpec]> = [
      ['a signal update', base({ signals: [{ name: 's', update: T }], marks: [textMark({})] })],
      ['a signal init', base({ signals: [{ name: 's', init: T }], marks: [textMark({})] })],
      ['a signal on-event handler', base({ signals: [{ name: 's', value: 0, on: [{ events: 'mousedown', update: T }] }], marks: [textMark({})] })],
      ['an event stream filter', base({ signals: [{ name: 's', value: 0, on: [{ events: `mousedown[${T}]`, update: '1' }] }], marks: [textMark({})] })],
      ['a filter transform', withTransforms([{ type: 'filter', expr: T }])],
      ['a mark encode signal', base({ marks: [textMark({ x: { signal: `${T} ? 1 : 2` } })] })],
      ['a mark encode test rule', base({ marks: [textMark({ fill: [{ test: T, value: 'red' }, { value: 'blue' }] })] })],
      ['a mark over a dataset with no rows', base({ data: [{ name: 'e', values: [] }], marks: [textMark({ x: { signal: `${T} ? 1 : 2` } }, 'e')] })],
      ['a scale domain signal', base({ scales: [{ name: 'x', type: 'linear', domain: { signal: `[0, ${T} ? 1 : 2]` }, range: 'width' }], marks: [textMark({})] })],
      ['a nested group mark', base({ marks: [{ type: 'group', marks: [textMark({ x: { signal: `${T} ? 1 : 2` } }, 't')] }] })],
      ['a data trigger', base({ signals: [{ name: 's', value: 0 }], data: [{ name: 't', values: ROWS, on: [{ trigger: T, remove: true }] }], marks: [textMark({})] })],
      ['countpattern pattern', withTransforms([{ type: 'countpattern', field: 'a', pattern: 'a+' }])],
      ['countpattern stopwords', withTransforms([{ type: 'countpattern', field: 'a', stopwords: 'b' }])],
      ['countpattern pattern from a signal', withTransforms([{ type: 'countpattern', field: 'a', pattern: { signal: 'p' } }], { signals: [{ name: 'p', value: 'a+' }] })],
    ]
    for (const [what, spec] of CASES) it(what, () => expectRefusedOnlyWithOption(spec, what))
  })

  describe('what stays allowed', () => {
    const ALLOWED: Array<[string, VgSpec]> = [
      ["split with a text separator", formula("split(datum.a, ',')")],
      ["replace with a text pattern", formula("replace(datum.a, 'a', 'x')")],
      ["indexof / substring", formula("indexof(datum.a, 'a') + length(substring(datum.a, 1))")],
      ['a division (not a regex literal)', formula('datum.n / 2 / 1')],
      ["text that reads like a pattern", formula("'/a/' + 'test(' + datum.a")],
      ['countpattern with the engine default', withTransforms([{ type: 'countpattern', field: 'a' }])],
      ["countpattern with an empty pattern (the default)", withTransforms([{ type: 'countpattern', field: 'a', pattern: '', stopwords: '' }])],
      ['number and time formats, colour parsing', formula("format(datum.n, ',.2f') + timeFormat(datetime(2024, 0, 1), '%Y') + rgb('steelblue').r")],
    ]
    for (const [what, spec] of ALLOWED) {
      it(what, () => expect(renderSpec(spec, { limits: REFUSE })).toBe(renderSpec(spec)))
    }
  })

  describe('every entry point refuses before anything runs', () => {
    const spec = formula("test('a', datum.a)")
    const limitError = (fn: () => unknown): void => {
      let err: unknown
      try { fn() } catch (e) { err = e }
      expect((err as { code?: string } | undefined)?.code).toBe('ASTER_LIMIT')
      expect((err as Error).message).toContain('limits.regex')
    }
    it('renderSpec, evaluateChart, getChartInfo', () => {
      limitError(() => renderSpec(spec, { limits: REFUSE }))
      limitError(() => evaluateChart(compileChart(spec), { limits: REFUSE }))
      limitError(() => getChartInfo(spec, { limits: REFUSE }))
    })
    it('a chart compiled with no limits, evaluated under them', () => {
      const chart = compileChart(spec)
      expect(() => evaluateChart(chart, {})).not.toThrow()
      limitError(() => evaluateChart(chart, { limits: REFUSE }))
    })
    it('a session: evaluate, and a change under the option after an evaluation without it', () => {
      limitError(() => createChartSession().evaluate(spec, { limits: REFUSE }))
      const s = createChartSession()
      expect(() => s.evaluate(spec, {})).not.toThrow()
      limitError(() => s.change({ limits: REFUSE }))
    })
    it('a stream: its options and a batch', () => {
      const a = createChartStream(spec, { limits: REFUSE })
      try { limitError(() => a.flush()) } finally { a.close() }
      const b = createChartStream(spec)
      try {
        expect(() => b.flush()).not.toThrow()
        b.push({ limits: REFUSE })
        limitError(() => b.flush())
      } finally { b.close() }
    })
    it('an invalid value is a host error, never read as permission', () => {
      expect(() => renderSpec(spec, { limits: { regex: 'refused' as never } })).toThrow(TypeError)
      expect(() => renderSpec(formula('1'), { limits: { regex: 'nope' as never } })).toThrow(TypeError)
      expect(() => renderSpec(spec, { limits: { regex: 'screen' } })).not.toThrow()
    })
    it('a refusal leaves nothing behind: the next charts draw', () => {
      expect(() => renderSpec(spec, { limits: REFUSE })).toThrow()
      expect(() => renderSpec(formula('1'))).not.toThrow()
      expect(() => renderSpec(formula('1'), { limits: REFUSE })).not.toThrow()
      expect(() => renderSpec(spec)).not.toThrow()
    })
  })

  describe('a regular expression that reaches the engine at run time is refused where it would run', () => {
    const fromData = withTransforms([{ type: 'formula', expr: "replace(datum.a, datum.re, '')", as: 'r' }])
    it('a RegExp object in host data', () => {
      const data = { t: [{ a: 'aab', n: 1, re: /a+/ }] }
      expect(() => renderSpec(fromData, { data })).not.toThrow()
      expect(() => renderSpec(fromData, { data, limits: REFUSE })).toThrow(/limits\.regex/)
    })
    it('a RegExp object as a signal value', () => {
      const spec = { ...formula("split(datum.a, sep)"), signals: [{ name: 'sep', value: ',' }] } as never
      expect(() => renderSpec(spec, { signals: { sep: /a/ } })).not.toThrow()
      expect(() => renderSpec(spec, { signals: { sep: /a/ }, limits: REFUSE })).toThrow(/limits\.regex/)
      // a text separator is fine
      expect(() => renderSpec(spec, { signals: { sep: 'a' }, limits: REFUSE })).not.toThrow()
    })
  })

  it('without the option nothing changes: the screen still refuses a backtracking shape, regexes run', () => {
    expect(() => renderSpec(formula("test('(a+)+$', datum.a)"), { limits: {} })).toThrow(/regexSafety: a repeated group/)
    expect(renderSpec(formula("test('a', datum.a) ? 'y' : 'n'"))).toContain('<text')
  })
})

describe('makesRegex', () => {
  const regex = (code: string): boolean => makesRegex(parseExpression(code))
  it('finds a literal or a call of test / regexp however it is written', () => {
    for (const c of ['/a/', "test('a', x)", "regexp('a')", "_test('a', x)", "_regexp('a')", "(test)('a', x)", "f(1, [g({k: /a/})])", "x ? 1 : test('a', x)"]) {
      expect(regex(c), c).toBe(true)
    }
  })
  it('finds none in expressions without one', () => {
    for (const c of ["replace(x, 'a', 'b')", "split(x, ',')", 'a / b / c', "'test(a)' + '/a/'", 'test', 'datum.test', "datum['regexp']", 'tested(1)', 'contest(1)']) {
      expect(regex(c), c).toBe(false)
    }
  })
})
