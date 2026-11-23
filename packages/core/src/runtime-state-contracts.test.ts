/**
 * The runtime's state contracts that are not the shape of a spec but of what a caller hands it (audit lane a05):
 *
 * - C232 / C500: a change hint that cannot be what it says is refused with a TypeError naming the dataset, before anything runs,
 *   and leaves the chart's state as it was (the next evaluation equals a fresh one);
 * - C265 / C114 / C540: signal values are compared by content whatever their size (an in-place change of a large host value is
 *   seen; an equal large derived value is not a change), and `valueKey` / `valuesEqual` agree;
 * - C280: a function re-registered with another body is a new context for every reused result;
 * - C281 (DECISIONS Q17): `maxGeneratedRows` meters the rows an evaluation's transforms produce in it;
 * - C111 / C395: a text measurer that throws is reported and its fallback not kept; a provider set again finds its widths.
 */
import { describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { createChartSession } from './session.js'
import { registerExpressionFunction } from './expression.js'
import { valueKey, valuesEqual } from './fingerprint.js'
import { renderSceneToSvg } from './index.js'
import type { RuntimeInput, SceneRoot, VgSpec } from './types.js'

type Rnd = () => number
function mulberry32(seed: number): Rnd {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T,>(r: Rnd, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
const quiet = { error() {}, warn() {}, info() {}, debug() {} }
const texts = (scene: SceneRoot): string[] => {
  const out: string[] = []
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return
    const t = (n as { text?: unknown }).text
    if (t !== undefined && (n as { items?: unknown }).items === undefined) out.push(String(t))
    for (const c of ((n as { items?: unknown[] }).items ?? [])) walk(c)
  }
  walk(scene)
  return out
}

const HINT_SPEC = {
  width: 100, height: 50,
  data: [{ name: 't' }, { name: 'd', source: 't', transform: [{ type: 'formula', as: 'w', expr: 'datum.v * 2' }] }],
  marks: [{ type: 'text', from: { data: 'd' }, encode: { update: { text: { signal: "datum.k + ':' + datum.w" } } } }],
} as unknown as VgSpec

describe('a change hint that cannot be what it says is refused (C232, C500)', () => {
  const rows = (r: Rnd, n: number): Array<Record<string, unknown>> => Array.from({ length: n }, (_, i) => ({ k: `k${i}`, v: Math.floor(r() * 9) }))
  const BAD: ReadonlyArray<readonly [string, (r: Rnd, n: number) => Partial<RuntimeInput>, RegExp]> = [
    ['an unknown name in changedDatasets', (r) => ({ changedDatasets: [pick(r, ['nope', 'constructor', '__proto__', 'T'])] }), /changedDatasets names dataset ".*", which is no dataset/],
    ['an unknown name in dataChanges', () => ({ dataChanges: { nope: [0] } }), /dataChanges names dataset "nope", which is no dataset/],
    ['a dataChanges for a derived dataset', () => ({ dataChanges: { d: [0] } }), /derived from other datasets/],
    ['a dataPulse for a derived dataset', () => ({ dataPulse: { d: { changed: [0] } } }), /derived from other datasets/],
    ['a fractional or NaN index', (r, n) => ({ dataChanges: { t: [0, pick(r, [0.5, n - 0.5, Number.NaN, Infinity, -0.25])] } }), /is not a row index/],
    ['an index given as text', () => ({ dataChanges: { t: ['1' as unknown as number] } }), /"1" in its list is not a row index/],
    ['a change list that is null', () => ({ dataChanges: { t: null as unknown as number[] } }), /is not a list of row indices/],
    ['a pulse whose changed is null', () => ({ dataPulse: { t: { changed: null as unknown as number[] } } }), /`changed` is not a list of row indices/],
    ['a pulse that says nothing', () => ({ dataPulse: { t: {} } }), /says nothing/],
  ]
  for (const [what, hint, message] of BAD) {
    for (const target of ['chart', 'session'] as const) {
      it(`${what} (${target}): a TypeError naming the dataset, and the evaluation after it equals a fresh one`, () => {
        for (let seed = 1; seed <= 12; seed++) {
          const r = mulberry32(seed)
          const n = 2 + Math.floor(r() * 6)
          let t = rows(r, n)
          const chart = compileChart(structuredClone(HINT_SPEC))
          const session = createChartSession()
          const run = (input: RuntimeInput): SceneRoot => (target === 'chart' ? evaluateChart(chart, input) : session.evaluate(HINT_SPEC, input))
          run({ data: { t }, logger: quiet })
          t = t.map((row, i) => (i === 0 ? { ...row, v: 99 } : row))
          let thrown: unknown
          try { run({ data: { t }, logger: quiet, ...hint(r, n) }) } catch (e) { thrown = e }
          expect(thrown).toBeInstanceOf(TypeError)
          expect(String((thrown as Error).message)).toMatch(/^\[aster\] /)
          expect(String((thrown as Error).message)).toMatch(message)
          const next = run({ data: { t: t.slice() }, logger: quiet })
          expect(renderSceneToSvg(next)).toBe(renderSceneToSvg(evaluateChart(compileChart(structuredClone(HINT_SPEC)), { data: { t }, logger: quiet })))
        }
      })
    }
  }

  it('an index past the rows is no row and is left alone; an empty hint says nothing changed', () => {
    const chart = compileChart(structuredClone(HINT_SPEC))
    const t = [{ k: 'a', v: 1 }, { k: 'b', v: 2 }]
    evaluateChart(chart, { data: { t }, logger: quiet })
    expect(texts(evaluateChart(chart, { data: { t }, dataChanges: { t: [5, -1] }, logger: quiet }))).toEqual(['a:2', 'b:4'])
    expect(texts(evaluateChart(chart, { data: { t }, changedDatasets: [], logger: quiet }))).toEqual(['a:2', 'b:4'])
  })
})

describe('signal values are compared by content whatever their size (C265, C114, C540)', () => {
  const spec = (expr: string): VgSpec => ({ width: 100, height: 50, signals: [{ name: 'big' }], data: [{ name: 'u' }], marks: [{ type: 'text', encode: { update: { text: { signal: expr } } } }] }) as unknown as VgSpec
  const VALUES: ReadonlyArray<readonly [string, (n: number) => unknown, (v: never, n: number) => void, string | ((n: number) => string)]> = [
    ['an array of numbers', (n) => Array.from({ length: n }, (_, i) => i), (v: number[], n) => { v[n - 1] = 999 }, 'big[length(big) - 1]'],
    ['an array of rows', (n) => Array.from({ length: n }, (_, i) => ({ i })), (v: Array<{ i: number }>, n) => { v[n - 1]!.i = 999 }, 'big[length(big) - 1].i'],
    ['a Float64Array', (n) => new Float64Array(n), (v: Float64Array, n) => { v[n - 1] = 999 }, 'big[length(big) - 1]'],
    ['a deep object', (n) => { let o: Record<string, unknown> = { leaf: 1 }; for (let d = 0; d < n % 12 + 1; d++) o = { a: o }; return o }, (v: Record<string, unknown>) => { let o = v; while (o.a) o = o.a as Record<string, unknown>; o.leaf = 999 }, (n) => `big${'.a'.repeat(n % 12 + 1)}.leaf`],
  ]
  for (const [what, make, mutate, expr] of VALUES) {
    it(`${what} the host changes in place is a change, at every size (chart and session)`, () => {
      for (const n of [1, 100, 512, 513, 2000]) {
        const s = spec(typeof expr === 'string' ? expr : expr(n))
        const chart = compileChart(structuredClone(s))
        const session = createChartSession()
        const big = make(n)
        evaluateChart(chart, { signals: { big }, data: { u: [] }, logger: quiet })
        session.evaluate(s, { signals: { big }, data: { u: [] }, logger: quiet })
        mutate(big as never, n)
        const want = texts(evaluateChart(compileChart(structuredClone(s)), { signals: { big }, logger: quiet }))
        expect(texts(evaluateChart(chart, { signals: { big }, data: { u: [{ v: 1 }] }, changedDatasets: ['u'], logger: quiet }))).toEqual(want)
        expect(texts(session.evaluate(s, { signals: { big }, data: { u: [] }, logger: quiet }))).toEqual(want)
      }
    })
  }

  it('an equal large derived signal is no change: one edited row re-encodes one row (C114)', () => {
    let calls = 0
    const dispose = registerExpressionFunction('a05count', (x: unknown) => { calls++; return x })
    try {
      for (const n of [100, 511, 513, 5000]) {
        const s = {
          width: 100, height: 50,
          signals: [{ name: 'seq', update: `sequence(0, ${n} + length(data('u')))` }],
          data: [{ name: 'u', values: [] }, { name: 't', transform: [{ type: 'formula', expr: 'a05count(datum.v)', as: 'w' }] }],
          marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { signal: 'a05count(datum.w)' } } } }, { type: 'text', encode: { update: { text: { signal: 'length(seq)' } } } }],
        } as unknown as VgSpec
        const t = Array.from({ length: 50 }, (_, i) => ({ v: i }))
        const session = createChartSession()
        session.evaluate(s, { data: { t }, logger: quiet })
        const t2 = t.slice()
        t2[3] = { v: 99 }
        calls = 0
        session.evaluate(s, { data: { t: t2 }, logger: quiet })
        expect(calls).toBe(2)
      }
    } finally { dispose() }
  })

  it('valueKey and valuesEqual agree (generated values, copies, edits)', () => {
    const r = mulberry32(5)
    const gen = (depth: number): unknown => {
      const k = Math.floor(r() * (depth > 8 ? 6 : 11))
      switch (k) {
        case 0: return Math.floor(r() * 4) - 1
        case 1: return pick(r, ['', 'a', '1'])
        case 2: return pick(r, [true, false, null, undefined, Number.NaN, -0, 0])
        case 3: return new Date(pick(r, [0, 1, Number.NaN]))
        case 4: return pick(r, [Symbol.for('s'), Symbol('s'), Symbol('s')])
        case 5: return 1n
        // (a long array only at the top, of short values: the walk is past the text budget without the value being huge)
        case 6: case 7: return depth === 0 && r() < 0.15 ? Array.from({ length: 700 }, () => gen(9)) : Array.from({ length: Math.floor(r() * 4) }, () => gen(depth + 1))
        case 8: return Object.fromEntries(Array.from({ length: Math.floor(r() * 4) }, (_, i) => [`f${i}`, gen(depth + 1)]))
        case 9: return new Set([gen(depth + 1)])
        default: return new Float64Array(Math.floor(r() * (depth === 0 && r() < 0.2 ? 600 : 3)))
      }
    }
    for (let i = 0; i < 3000; i++) {
      const a = gen(0)
      const b = r() < 0.5 ? a : r() < 0.5 ? structuredCloneSafe(a) : gen(0)
      expect(valuesEqual(a, b)).toBe(Object.is(a, b) || valueKey(a) === valueKey(b))
    }
    // the cases the keys used to tell apart only by identity, or not at all
    expect(valuesEqual(new Date(Number.NaN), new Date(Number.NaN))).toBe(true)
    expect(valueKey(Symbol('s')) === valueKey(Symbol('s'))).toBe(false)
    const big = Array.from({ length: 600 }, (_, i) => i)
    expect(valueKey(big)).toBe(valueKey(big.slice()))
    expect(valueKey(big)).not.toBe(valueKey([...big.slice(0, 599), 0]))
  })
})

/** A copy where structuredClone can make one (symbols stay the symbols: a copy of a value holding one is that value). */
function structuredCloneSafe(v: unknown): unknown {
  try { return structuredClone(v) } catch { return v }
}

describe('a function re-registered with another body is another context (C280)', () => {
  const marks: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['a mark keyed by the signals it names', { type: 'text', encode: { update: { text: { signal: 'a05fn()' } } } }],
    ['a mark that reads every signal', { type: 'text', encode: { update: { text: { signal: "a05fn() + (containerSize()[0] ? '' : '')" } } } }],
    ['a mark with a transform', { type: 'text', from: { data: 't' }, encode: { update: { text: { signal: 'a05fn()' } } }, transform: [{ type: 'collect' }] }],
  ]
  for (const [what, mark] of marks) {
    it(`${what}: evaluateChart and the session see the new body`, () => {
      const s = { width: 50, height: 20, data: [{ name: 't' }, { name: 'u' }], marks: [mark] } as unknown as VgSpec
      let dispose = registerExpressionFunction('a05fn', () => 'one')
      try {
        const chart = compileChart(structuredClone(s))
        const session = createChartSession()
        evaluateChart(chart, { data: { t: [{}], u: [] }, logger: quiet })
        session.evaluate(s, { data: { t: [{}], u: [] }, logger: quiet })
        dispose()
        dispose = registerExpressionFunction('a05fn', () => 'two')
        expect(texts(evaluateChart(chart, { data: { t: [{}], u: [{}] }, changedDatasets: ['u'], logger: quiet }))).toEqual(['two'])
        expect(texts(session.evaluate(s, { data: { t: [{}], u: [{}] }, logger: quiet }))).toEqual(['two'])
      } finally { dispose() }
    })
  }
})

describe('maxGeneratedRows meters the rows an evaluation produces (C281, DECISIONS Q17)', () => {
  it('a pulse is charged what it produced, a kept step nothing; maxRows still bounds what is kept', () => {
    const spec = {
      width: 100, height: 50, signals: [{ name: 's', value: 1 }],
      data: [{ name: 'src' }, { name: 't', source: 'src', transform: [{ type: 'flatten', fields: ['a'] }, { type: 'formula', as: 'w', expr: 'datum.a * s' }] }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'w' } } } }],
    } as unknown as VgSpec
    const row = (i: number) => ({ a: [i, i + 1, i + 2] })
    const session = createChartSession()
    let src = Array.from({ length: 3 }, (_, i) => row(i))
    const limits = { maxGeneratedRows: 10, maxRows: 40 }
    session.evaluate(spec, { data: { src }, limits, logger: quiet })
    for (let n = 4; n <= 13; n++) {
      src = [...src, row(n)]
      // (the flatten makes 3 rows of each row, 2 more than it was given: each append produces 2; a fresh evaluation of the n rows
      // produces 2n, refused past 10)
      expect(() => session.evaluate(spec, { data: { src }, limits, logger: quiet })).not.toThrow()
      const fresh = (): unknown => evaluateChart(compileChart(structuredClone(spec)), { data: { src }, limits, logger: quiet })
      if (2 * src.length > 10) expect(fresh).toThrow(/maxGeneratedRows 2[0-9] > 10|maxGeneratedRows 1[1-9] > 10/)
      else expect(fresh).not.toThrow()
    }
    // a signal the formula reads: the flatten is kept (it produced nothing in this evaluation), the formula maps 1:1
    expect(() => session.evaluate(spec, { data: { src }, signals: { s: 2 }, limits, logger: quiet })).not.toThrow()
    // what is kept is bounded by maxRows on every path
    src = [...src, row(14)]
    expect(() => session.evaluate(spec, { data: { src }, signals: { s: 2 }, limits: { maxGeneratedRows: 10, maxRows: 41 }, logger: quiet })).toThrow(/maxRows/)
  })
})

describe('a text measurer that throws (C111) and a provider set again (C395)', () => {
  const spec = {
    width: 100, height: 60,
    data: [{ name: 't' }],
    scales: [{ name: 'y', type: 'band', domain: { data: 't', field: 'k' }, range: 'height' }],
    axes: [{ orient: 'left', scale: 'y' }],
    marks: [],
  } as unknown as VgSpec
  it('the failure is logged once, the fallback is not kept, and the evaluation after it equals a fresh one', () => {
    let failing = false
    let calls = 0
    const provider = { measure: (text: string) => { calls++; if (failing) throw new Error('measurer down'); return text.length * 9 } }
    const session = createChartSession()
    const errors: unknown[] = []
    const logger = { ...quiet, error: (e: unknown) => { errors.push(e) } }
    for (let step = 0; step < 6; step++) {
      failing = step % 3 === 1
      const t = [{ k: `label-${step}` }, { k: `other-${step % 2}` }]
      const scene = session.evaluate(spec, { data: { t }, textMetrics: provider, logger })
      if (failing) expect(errors.splice(0)).toHaveLength(1)
      else {
        expect(errors.splice(0)).toEqual([])
        const fresh = evaluateChart(compileChart(structuredClone(spec)), { data: { t }, textMetrics: provider, logger: quiet })
        expect(renderSceneToSvg(scene)).toBe(renderSceneToSvg(fresh))
      }
    }
    // (the same provider set again finds the widths it measured: the same labels are not measured again)
    failing = false
    const t = [{ k: 'again' }]
    session.evaluate(spec, { data: { t }, textMetrics: provider, logger })
    const before = calls
    evaluateChart(compileChart(structuredClone(spec)), { data: { t: [{ k: 'again' }] }, textMetrics: provider, logger: quiet })
    expect(calls).toBe(before)
  })
})
