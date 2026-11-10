/**
 * One explicit regression per known defect class of the incremental core (layer
 * identity, stale scales, domain census, multi-dataset domains, transform state, group
 * reuse, the session cache key, rejected evaluations, compiled-chart immutability,
 * aggregate order, derived-signal caches). Each repro states the original scenario and
 * compares the incremental result with a fresh `evaluateChart(compileChart(spec))`; the
 * property/fuzz oracle (incremental-oracle.test.ts) covers the general shape.
 */
import { describe, it, expect } from 'vitest'
import './addon-transforms.js'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { createChartSession } from './session.js'
import { AsterLimitError } from './limits.js'
import { renderSceneToSvg } from './index.js'
import type { SceneRoot, SceneGroup, SceneItem } from './types.js'

const BASE = { $schema: 'https://vega.github.io/schema/vega/v6.json', width: 100, height: 100, autosize: 'none', padding: 0 } as const
const fresh = (spec: unknown, input: Record<string, unknown>): SceneRoot => evaluateChart(compileChart(spec as never), input as never)
const groups = (s: SceneRoot): SceneGroup[] => s.items.filter((g) => g.role === 'mark' || g.role === 'scope')
const marktypes = (s: SceneRoot): string[] => groups(s).map((g) => String(g.marktype))
const xs = (g: SceneGroup): unknown[] => (g.items as SceneItem[]).map((it) => it.x)
const scaleDomain = (s: SceneRoot, name: string): unknown => (s as unknown as { __scales: Array<{ name: string; domain: unknown }> }).__scales.find((x) => x.name === name)?.domain

const lin = (name: string, domain: unknown, extra: Record<string, unknown> = {}) => ({ name, type: 'linear', domain, range: 'width', ...extra })
const sym = (dataset: string, scale = 'x', field = 'v', extra: Record<string, unknown> = {}) => ({
  type: 'symbol', from: { data: dataset }, encode: { update: { x: { scale, field }, y: { value: 5 }, size: { value: 20 } } }, ...extra,
})

describe('layered marks over one dataset keep their own identity', () => {
  // A fixed domain keeps the scale unchanged by the update, which is exactly
  // when whole-item reuse engages (and when mark matching used to go wrong).
  const spec = {
    ...BASE,
    data: [{ name: 't', values: [] }],
    scales: [lin('x', [0, 10])],
    marks: [
      sym('t'),
      { type: 'text', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { value: 20 }, text: { field: 'v' } } } },
    ],
  }
  it('a session update keeps the symbol layer AND the text layer', () => {
    const s = createChartSession()
    s.evaluate(spec as never, { data: { t: [{ v: 1 }, { v: 2 }, { v: 3 }] } })
    const b = [{ v: 1 }, { v: 2 }, { v: 4 }]
    const inc = s.evaluate(spec as never, { data: { t: b } })
    expect(marktypes(inc)).toEqual(['symbol', 'text'])
    expect(renderSceneToSvg(inc)).toBe(renderSceneToSvg(fresh(spec, { data: { t: b } })))
  })
  it('two unnamed marks of one type over one dataset do not collapse onto the first', () => {
    const mk = (y: number, size: number) => sym('t', 'x', 'v', { encode: { update: { x: { scale: 'x', field: 'v' }, y: { value: y }, size: { value: size } } } })
    const two = { ...spec, marks: [mk(5, 10), mk(50, 99)] }
    const chart = compileChart(two as never)
    evaluateChart(chart, { data: { t: [{ v: 1 }, { v: 2 }] } })
    const next = [{ v: 1 }, { v: 2.5 }]
    const inc = evaluateChart(chart, { data: { t: next }, dataChanges: { t: [1] } })
    expect(groups(inc).map((g) => (g.items as SceneItem[])[0]!.y)).toEqual([5, 50])
    expect(renderSceneToSvg(inc)).toBe(renderSceneToSvg(fresh(two, { data: { t: next } })))
  })
})

describe('stale scales never leave unchanged items at old positions', () => {
  it('values [10,0,5,8], row 0 -> 3', () => {
    const spec = { ...BASE, data: [{ name: 't', values: [] }], scales: [lin('x', { data: 't', field: 'v' })], marks: [sym('t')] }
    const s = createChartSession()
    s.evaluate(spec as never, { data: { t: [10, 0, 5, 8].map((v) => ({ v })) } })
    const next = [3, 0, 5, 8].map((v) => ({ v }))
    const inc = s.evaluate(spec as never, { data: { t: next } })
    expect(xs(groups(inc)[0]!)).toEqual(xs(groups(fresh(spec, { data: { t: next } }))[0]!))
    expect(xs(groups(inc)[0]!)).toEqual([37.5, 0, 62.5, 100])
  })
})

describe('the domain census shrinks', () => {
  const spec = { ...BASE, data: [{ name: 't', values: [] }], scales: [lin('x', { data: 't', field: 'v' }, { zero: false })], marks: [sym('t')] }
  it('both rows holding the minimum move up, in two successive updates', () => {
    const chart = compileChart(spec as never)
    const base = [0, 0, 6, 10].map((v) => ({ v }))
    evaluateChart(chart, { data: { t: base } })
    // First update: one of the two minimum holders moves (the min survives)...
    const mid = [5, 0, 6, 10].map((v) => ({ v }))
    evaluateChart(chart, { data: { t: mid }, dataChanges: { t: [0] } })
    // ...second update: the LAST holder moves, so the minimum itself moves.
    const next = [5, 5, 6, 10].map((v) => ({ v }))
    const inc = evaluateChart(chart, { data: { t: next }, dataChanges: { t: [1] } })
    expect(scaleDomain(inc, 'x')).toEqual(scaleDomain(fresh(spec, { data: { t: next } }), 'x'))
    expect(scaleDomain(inc, 'x')).toEqual([5, 10])
  })
  it('removing the only row holding the maximum shrinks the domain (length pulse)', () => {
    const s = createChartSession()
    s.evaluate(spec as never, { data: { t: [0, 5, 10].map((v) => ({ v })) } })
    const next = [0, 5].map((v) => ({ v }))
    const inc = s.evaluate(spec as never, { data: { t: next } })
    expect(xs(groups(inc)[0]!)).toEqual([0, 100])
    expect(scaleDomain(inc, 'x')).toEqual([0, 5])
  })
})

describe('discrete domain census', () => {
  it('a value whose first occurrence is later moves the domain order', () => {
    const spec = { ...BASE, data: [{ name: 't', values: [] }], scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'g' }, range: 'width' }], marks: [sym('t', 'x', 'g')] }
    const chart = compileChart(spec as never)
    const rows = ['A', 'A', 'B', 'C'].map((g) => ({ g }))
    evaluateChart(chart, { data: { t: rows } })
    const next = ['A', 'C', 'B', 'C'].map((g) => ({ g }))
    const inc = evaluateChart(chart, { data: { t: next }, dataChanges: { t: [1] } })
    expect(scaleDomain(inc, 'x')).toEqual(['A', 'C', 'B'])
    expect(renderSceneToSvg(inc)).toBe(renderSceneToSvg(fresh(spec, { data: { t: next } })))
  })
})

describe('multi-dataset domains are re-resolved every evaluation', () => {
  const spec = {
    ...BASE,
    data: [{ name: 'a', values: [] }, { name: 'b', values: [] }],
    scales: [lin('x', { fields: [{ data: 'a', field: 'v' }, { data: 'b', field: 'v' }] })],
    marks: [sym('a'), sym('b')],
  }
  it('data moving from 0..10 to 0..100 moves the domain', () => {
    const chart = compileChart(spec as never)
    evaluateChart(chart, { data: { a: [{ v: 0 }, { v: 10 }], b: [{ v: 5 }] } })
    const next = { a: [{ v: 0 }, { v: 100 }], b: [{ v: 50 }] }
    const second = evaluateChart(chart, { data: next })
    expect(scaleDomain(second, 'x')).toEqual([0, 100])
    const third = evaluateChart(chart, { data: next, dataChanges: { a: [1] } })
    expect(renderSceneToSvg(third)).toBe(renderSceneToSvg(fresh(spec, { data: next })))
  })
  it('does not rewrite the compiled IR', () => {
    const chart = compileChart(spec as never)
    const before = JSON.stringify(chart.scales)
    evaluateChart(chart, { data: { a: [{ v: 0 }, { v: 10 }], b: [{ v: 5 }] } })
    expect(JSON.stringify(chart.scales)).toBe(before)
  })
})

describe('one incremental transform engine, consistent with a full re-derive', () => {
  const run = (transform: unknown[], rows: Array<Record<string, unknown>>, steps: Array<{ rows: Array<Record<string, unknown>>; hint: Record<string, unknown> }>, field = 'v') => {
    const spec = {
      ...BASE,
      data: [{ name: 't', values: [], transform }],
      scales: [lin('x', [0, 100])],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field }, y: { value: 5 } } } }],
    }
    const chart = compileChart(spec as never)
    evaluateChart(chart, { data: { t: rows } })
    for (const step of steps) {
      const inc = evaluateChart(chart, { data: { t: step.rows }, ...step.hint })
      expect(renderSceneToSvg(inc)).toBe(renderSceneToSvg(fresh(spec, { data: { t: step.rows } })))
      expect(groups(inc)[0]!.items!.map((it) => (it as SceneItem).datum)).toEqual(groups(fresh(spec, { data: { t: step.rows } }))[0]!.items!.map((it) => (it as SceneItem).datum))
    }
  }
  const r = (...v: number[]) => v.map((n) => ({ v: n, g: n > 5 ? 'a' : 'b' }))

  it('filter: edit a row then append (state shared between same-length and length paths)', () => {
    run([{ type: 'filter', expr: 'datum.v > 5' }], r(1, 10, 20), [
      { rows: r(30, 10, 20), hint: { dataChanges: { t: [0] } } },
      { rows: r(30, 10, 20, 40), hint: { dataPulse: { t: { changed: [], appendOnly: true, baseLength: 3, added: [[3, 4]] } } } },
    ])
  })
  it('window with sort, grouped: a same-length edit that reorders rows inside a partition', () => {
    const win = [{ type: 'window', groupby: ['g'], sort: { field: 'v' }, ops: ['sum'], fields: ['v'], as: ['cs'] }]
    const rows = (...pairs: Array<[string, number]>) => pairs.map(([g, v]) => ({ g, v }))
    run(win, rows(['a', 3], ['b', 1], ['a', 1], ['b', 5]), [
      { rows: rows(['a', 0], ['b', 1], ['a', 1], ['b', 5]), hint: { dataChanges: { t: [0] } } },
      { rows: rows(['a', 0], ['b', 1], ['a', 1], ['b', 5], ['a', 2]), hint: { dataPulse: { t: { changed: [], appendOnly: true, baseLength: 4, added: [[4, 5]] } } } },
    ], 'cs')
  })
  it('identifier numbers rows by position, not 1 per derived row', () => {
    run([{ type: 'identifier', as: 'id' }], r(1, 10, 20), [
      { rows: r(1, 11, 20), hint: { dataChanges: { t: [1] } } },
      { rows: r(1, 11, 20, 4), hint: { dataPulse: { t: { changed: [], appendOnly: true, baseLength: 3, added: [[3, 4]] } } } },
    ], 'id')
  })
  it('bin with a data extent: stop-step clamp, non-finite values, extent growth', () => {
    const bin = [{ type: 'bin', field: 'v', maxbins: 4, as: ['b0', 'b1'] }]
    run(bin, r(0, 3, 5, 10), [
      { rows: [{ v: 0 }, { v: 3 }, { v: 5 }, { v: Infinity }], hint: { dataChanges: { t: [3] } } },
      { rows: [{ v: 0 }, { v: 3 }, { v: 5 }, { v: 7 }], hint: { dataChanges: { t: [3] } } },
      { rows: [{ v: 0 }, { v: 3 }, { v: null as unknown as number }, { v: 7 }], hint: { dataChanges: { t: [2] } } },
    ], 'b0')
  })
  it('fold, flatten and aggregate stay consistent across same-length and length updates', () => {
    run([{ type: 'fold', fields: ['v', 'w'], as: ['k', 'val'] }], [{ v: 1, w: 2 }, { v: 3, w: 4 }], [
      { rows: [{ v: 1, w: 9 }, { v: 3, w: 4 }], hint: { dataChanges: { t: [0] } } },
      { rows: [{ v: 1, w: 9 }, { v: 3, w: 4 }, { v: 5, w: 6 }], hint: { dataPulse: { t: { changed: [], appendOnly: true, baseLength: 2, added: [[2, 3]] } } } },
    ], 'val')
    run([{ type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] }], r(1, 10, 2, 20), [
      { rows: r(1, 10, 3, 20), hint: { dataChanges: { t: [2] } } },
      { rows: r(1, 10, 3, 20, 7), hint: { dataPulse: { t: { changed: [], appendOnly: true, baseLength: 4, added: [[4, 5]] } } } },
    ], 's')
  })
})

describe('a group is reused only when everything it reads is unchanged', () => {
  const textGroup = (dataset: string) => ({ type: 'group', marks: [{ type: 'text', from: { data: dataset }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { value: 5 }, text: { field: 'v' } } } }] })
  it('a child mark reading top-level data sees an append', () => {
    const spec = { ...BASE, data: [{ name: 'table', values: [] }], scales: [lin('x', [0, 10])], marks: [textGroup('table')] }
    const s = createChartSession()
    s.evaluate(spec as never, { data: { table: [{ v: 1 }] } })
    const next = [{ v: 1 }, { v: 2 }]
    const inc = s.evaluate(spec as never, { data: { table: next } })
    expect(renderSceneToSvg(inc)).toBe(renderSceneToSvg(fresh(spec, { data: { table: next } })))
    expect(renderSceneToSvg(inc)).toContain('>2<')
  })
  it('a signal change with changedDatasets naming an unrelated dataset', () => {
    const spec = {
      ...BASE, signals: [{ name: 's', value: 1 }],
      data: [{ name: 'other', values: [{ v: 1 }] }, { name: 't', values: [{ v: 1 }] }],
      scales: [lin('x', [0, 100])],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { signal: 's' }, y: { value: 5 } } } }],
    }
    const chart = compileChart(spec as never)
    evaluateChart(chart, { signals: { s: 1 } })
    const inc = evaluateChart(chart, { signals: { s: 42 }, changedDatasets: ['other'] })
    expect(xs(groups(inc)[0]!)).toEqual([42])
  })
  it('a width change with changedDatasets', () => {
    const spec = { ...BASE, data: [{ name: 't', values: [{ v: 1 }] }, { name: 'o', values: [{ v: 1 }] }], scales: [lin('x', [0, 1])], marks: [sym('t')] }
    const chart = compileChart(spec as never)
    evaluateChart(chart, { width: 100 })
    const inc = evaluateChart(chart, { width: 400, changedDatasets: ['o'] })
    expect(xs(groups(inc)[0]!)).toEqual([400])
  })
  it('a mark over an unchanged dataset follows a scale whose domain changed', () => {
    const spec = {
      ...BASE,
      data: [{ name: 't', values: [] }, { name: 'u', values: [{ w: 5 }] }],
      scales: [lin('x', { data: 't', field: 'v' }, { zero: false })],
      marks: [sym('t'), sym('u', 'x', 'w')],
    }
    const chart = compileChart(spec as never)
    evaluateChart(chart, { data: { t: [{ v: 0 }, { v: 10 }], u: [{ w: 5 }] } })
    const next = [{ v: 0 }, { v: 20 }]
    const inc = evaluateChart(chart, { data: { t: next, u: [{ w: 5 }] }, dataChanges: { t: [1] } })
    expect(xs(groups(inc)[1]!)).toEqual([25])
  })
  it('a mark depending on a lookup source sees that source change', () => {
    const spec = {
      ...BASE,
      data: [{ name: 'u', values: [] }, { name: 'd', values: [], transform: [{ type: 'lookup', from: 'u', key: 'k', fields: ['k'], values: ['w'], as: ['w'] }] }],
      scales: [lin('x', [0, 100])],
      marks: [{ type: 'symbol', from: { data: 'd' }, encode: { update: { x: { field: 'w' }, y: { value: 5 } } } }],
    }
    const chart = compileChart(spec as never)
    evaluateChart(chart, { data: { u: [{ k: 'a', w: 10 }], d: [{ k: 'a' }] } })
    const inc = evaluateChart(chart, { data: { u: [{ k: 'a', w: 60 }], d: [{ k: 'a' }] }, changedDatasets: ['u'] })
    expect(xs(groups(inc)[0]!)).toEqual([60])
  })
})

describe('signal and data change together', () => {
  it('an encode reading a signal is re-encoded for unchanged rows when the signal changes alongside a data edit', () => {
    const spec = {
      ...BASE, signals: [{ name: 's', value: 1 }],
      data: [{ name: 't', values: [] }], scales: [lin('x', [0, 100])],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { signal: 's * 10' }, y: { value: 5 } } } }],
    }
    const chart = compileChart(spec as never)
    const rows = [{ v: 1 }, { v: 2 }]
    evaluateChart(chart, { data: { t: rows }, signals: { s: 1 } })
    const next = [{ v: 1 }, { v: 3 }]
    const inc = evaluateChart(chart, { data: { t: next }, signals: { s: 4 }, dataChanges: { t: [1] } })
    expect(xs(groups(inc)[0]!)).toEqual([40, 40])
  })
})

describe('the session no-op cache key is complete and typed', () => {
  const spec = { ...BASE, data: [{ name: 't', format: { type: 'json' }, values: '[{"v":1},{"v":2}]' }], scales: [lin('x', [0, 10])], marks: [sym('t')] }
  it('replacing an inline JSON string invalidates the cache', () => {
    const s = createChartSession()
    const a = s.evaluate(spec as never, {})
    const next = { ...spec, data: [{ name: 't', format: { type: 'json' }, values: '[{"v":7},{"v":8},{"v":9}]' }] }
    const b = s.evaluate(next as never, {})
    expect(b).not.toBe(a)
    expect(groups(b)[0]!.items).toHaveLength(3)
  })
  it('change() keeps every key in step: evaluate(w=100) -> change(w=400) -> evaluate(w=100)', () => {
    const sp = { ...BASE, data: [{ name: 't', values: [{ v: 1 }] }], scales: [lin('x', [0, 1])], marks: [sym('t')] }
    const s = createChartSession()
    const first = s.evaluate(sp as never, { width: 100 })
    expect(xs(groups(first)[0]!)).toEqual([100])
    const changed = s.change({ width: 400 })!
    expect(xs(groups(changed)[0]!)).toEqual([400])
    const again = s.evaluate(sp as never, { width: 100 })
    expect(xs(groups(again)[0]!)).toEqual([100])
  })
  it('signal 1 and "1" are different keys', () => {
    const sp = { ...BASE, signals: [{ name: 's', value: 0 }], data: [{ name: 't', values: [{ v: 1 }] }], marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { signal: 'isString(s) ? 20 : 10' }, y: { value: 5 } } } }] }
    const s = createChartSession()
    const a = s.evaluate(sp as never, { signals: { s: 1 } })
    const b = s.evaluate(sp as never, { signals: { s: '1' } })
    expect(xs(groups(a)[0]!)).toEqual([10])
    expect(xs(groups(b)[0]!)).toEqual([20])
  })
  it('an explicit changedDatasets bypasses the cache', () => {
    const rows = [{ v: 1 }]
    const sp = { ...BASE, data: [{ name: 't', values: rows }], scales: [lin('x', [0, 10])], marks: [sym('t')] }
    const s = createChartSession()
    const a = s.evaluate(sp as never, {})
    rows[0] = { v: 5 }
    const b = s.evaluate(sp as never, { changedDatasets: ['t'] })
    expect(b).not.toBe(a)
    expect(xs(groups(b)[0]!)).toEqual([50])
  })
  it('limits are part of the key', () => {
    const sp = { ...BASE, data: [{ name: 't', values: [{ v: 1 }, { v: 2 }, { v: 3 }] }], scales: [lin('x', [0, 10])], marks: [sym('t')] }
    const s = createChartSession()
    s.evaluate(sp as never, {})
    expect(() => s.evaluate(sp as never, { limits: { maxItems: 1 } })).toThrow(AsterLimitError)
  })
})

describe('a rejected evaluation commits nothing', () => {
  it('evaluate(A) -> evaluate(B, maxItems) throws -> evaluate(A) returns A', () => {
    const mk = (n: number) => ({ ...BASE, data: [{ name: 't', values: Array.from({ length: n }, (_, i) => ({ v: i })) }], scales: [lin('x', [0, 10])], marks: [sym('t')] })
    const A = mk(3)
    const B = mk(8)
    const s = createChartSession()
    const a = s.evaluate(A as never, {})
    expect(() => s.evaluate(B as never, { limits: { maxItems: 5 } })).toThrow(AsterLimitError)
    const again = s.evaluate(A as never, {})
    expect(groups(again)[0]!.items).toHaveLength(3)
    expect(again).toBe(a)
    // and the engine's incremental state is still sound for the next real update
    const next = mk(4)
    const inc = s.evaluate(next as never, {})
    expect(renderSceneToSvg(inc)).toBe(renderSceneToSvg(fresh(next, {})))
  })
  it('a mid-evaluation throw leaves the previous scene intact and later pulses sound', () => {
    // The formula throws on the appended row (no `obj`) AFTER it already
    // re-derived the changed row 0: the in-place fast path had half-updated its
    // cache when it died. The failure is a LIMIT violation inside the expression: a
    // plain TypeError is logged and recovered like vega's and does not throw,
    // while a limit refusal never is.
    const spec = {
      ...BASE,
      data: [{ name: 't', values: [], transform: [{ type: 'formula', expr: 'datum.obj ? datum.obj.deep : length(sequence(0, 1e9))', as: 'f' }] }],
      // The domain reads the derived field, so a stale cached row 0 (99) shows.
      scales: [lin('x', { data: 't', field: 'f' }, { zero: false })],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'f' }, y: { value: 5 } } } }],
    }
    const row = (deep: number) => ({ obj: { deep } })
    const chart = compileChart(spec as never)
    const a = evaluateChart(chart, { data: { t: [row(10), row(20)] } })
    const svgA = renderSceneToSvg(a)
    const bad = [row(99), row(20), { obj: undefined }]
    expect(() => evaluateChart(chart, { data: { t: bad }, limits: { maxRows: 1000 }, dataPulse: { t: { changed: [0], appendOnly: true, baseLength: 2, added: [[2, 3]] } } })).toThrow()
    expect(renderSceneToSvg(a)).toBe(svgA)
    // The next update is relative to the last SUCCESSFUL evaluation (row 0 is
    // back to 10): the half-updated cache must not leak 99 into the result.
    const next = [row(10), row(20), row(30)]
    const inc = evaluateChart(chart, { data: { t: next }, dataPulse: { t: { changed: [], appendOnly: true, baseLength: 2, added: [[2, 3]] } } })
    expect(renderSceneToSvg(inc)).toBe(renderSceneToSvg(fresh(spec, { data: { t: next } })))
    expect(xs(groups(inc)[0]!)).toEqual([0, 50, 100])
  })
})

describe('evaluateChart does not write the compiled chart', () => {
  it('an event-only signal is not promoted to a static update', () => {
    const spec = {
      ...BASE, signals: [{ name: 'count', on: [{ events: 'click', update: '(count||0)+1' }] }],
      data: [{ name: 't', values: [{ v: 1 }] }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { signal: 'count || 0' }, y: { value: 5 } } } }],
    }
    const chart = compileChart(spec as never)
    const seen = [0, 1, 2].map(() => xs(groups(evaluateChart(chart, {}))[0]!)[0])
    expect(seen).toEqual([0, 0, 0])
  })
  it('evaluation leaves the IR byte-identical (signals, scale domains, ranges)', () => {
    const spec = {
      ...BASE, signals: [{ name: 'a', value: 1 }, { name: 'b', update: 'a + 1' }, { name: 'rng', update: '[0, width]' }],
      data: [{ name: 't', values: [{ v: 1 }, { v: 2 }] }, { name: 'u', values: [{ v: 3 }] }],
      scales: [lin('x', { fields: [{ data: 't', field: 'v' }, { data: 'u', field: 'v' }] }, { range: 'category' })],
      marks: [sym('t')],
    }
    const chart = compileChart(spec as never)
    const before = JSON.stringify(chart)
    evaluateChart(chart, {})
    evaluateChart(chart, { signals: { a: 5 } })
    expect(JSON.stringify(chart)).toBe(before)
  })
})

describe('aggregate order and previous scenes', () => {
  it('first-occurrence group order, incremental === full', () => {
    const spec = {
      ...BASE,
      data: [{ name: 't', values: [], transform: [{ type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] }] }],
      scales: [lin('x', [0, 100])],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 's' }, y: { value: 5 } } } }],
    }
    const chart = compileChart(spec as never)
    const row = (g: string, v: number) => ({ g, v })
    evaluateChart(chart, { data: { t: [row('A', 1), row('B', 2), row('A', 3)] } })
    // Row 0 moves from group A to a new group C while a row is appended: the
    // group order is first occurrence in the NEW rows (C, B, A, E), not the old
    // order with the new keys tacked on (A, B, C, E).
    const next = [row('C', 4), row('B', 2), row('A', 3), row('E', 5)]
    const inc = evaluateChart(chart, { data: { t: next }, dataPulse: { t: { changed: [0], appendOnly: true, baseLength: 3, added: [[3, 4]] } } })
    expect(xs(groups(inc)[0]!)).toEqual(xs(groups(fresh(spec, { data: { t: next } }))[0]!))
    expect(xs(groups(inc)[0]!)).toEqual([4, 2, 3, 5])
  })
  it('a returned scene never changes under the caller', () => {
    const spec = { ...BASE, data: [{ name: 't', values: [] }], scales: [lin('x', [0, 100])], marks: [sym('t')] }
    const chart = compileChart(spec as never)
    const a = evaluateChart(chart, { data: { t: [{ v: 1 }, { v: 2 }] } })
    const snap = JSON.stringify(a.items.map((g) => g.items?.map((i) => [i.x, i.y])))
    const gA = groups(a)[0]!
    const lenA = gA.items!.length
    evaluateChart(chart, { data: { t: [{ v: 1 }, { v: 2 }, { v: 3 }] }, dataPulse: { t: { changed: [], appendOnly: true, baseLength: 2, added: [[2, 3]] } } })
    evaluateChart(chart, { data: { t: [{ v: 9 }, { v: 2 }, { v: 3 }] }, dataChanges: { t: [0] } })
    expect(groups(a)[0]).toBe(gA)
    expect(gA.items).toHaveLength(lenA)
    expect(JSON.stringify(a.items.map((g) => g.items?.map((i) => [i.x, i.y])))).toBe(snap)
  })
})

describe('object-valued derived signals do not defeat the caches', () => {
  it('unchanged items keep their identity across an update when a derived signal is an array', () => {
    const spec = {
      ...BASE, signals: [{ name: 'rng', update: '[0, width]' }],
      data: [{ name: 't', values: [] }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: { signal: 'rng' } }],
      marks: [sym('t')],
    }
    const chart = compileChart(spec as never)
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }]
    const a = evaluateChart(chart, { data: { t: rows } })
    const next = rows.map((r, i) => (i === 1 ? { v: 9 } : r))
    const b = evaluateChart(chart, { data: { t: next }, dataChanges: { t: [1] } })
    const ia = groups(a)[0]!.items as SceneItem[]
    const ib = groups(b)[0]!.items as SceneItem[]
    expect(ib[0]).toBe(ia[0])
    expect(ib[2]).toBe(ia[2])
    expect(ib[1]).not.toBe(ia[1])
    expect(renderSceneToSvg(b)).toBe(renderSceneToSvg(fresh(spec, { data: { t: next } })))
  })
})

describe('lazily materialised superseded scenes', () => {
  const spec = { ...BASE, data: [{ name: 't', values: [] }], scales: [lin('x', [0, 100])], marks: [sym('t')] }
  const ap = (base: number) => ({ t: { changed: [] as number[], appendOnly: true, baseLength: base, added: [[base, base + 1]] as Array<[number, number]> } })
  const rowsN = (n: number, bump = -1) => Array.from({ length: n }, (_, i) => ({ v: i === bump ? 77 : i }))

  it('a chain of superseded scenes reads correctly in any order, including never-read-until-later', () => {
    const chart = compileChart(spec as never)
    const scenes: SceneRoot[] = [evaluateChart(chart, { data: { t: rowsN(3) } })]
    const snaps = [xs(groups(scenes[0]!)[0]!)]
    for (let n = 3; n < 9; n++) {
      // alternate appends and same-length edits
      const next = n % 2 ? rowsN(n + 1) : rowsN(n, 1)
      const input = n % 2
        ? { data: { t: next }, dataPulse: ap(n) }
        : { data: { t: next }, dataChanges: { t: [1] } }
      // an edit step keeps the length: the previous length is n
      const sc = evaluateChart(chart, input.dataChanges ? { data: { t: rowsN(n + 0, 1) }, dataChanges: { t: [1] } } : input)
      scenes.push(sc)
      snaps.push(xs(groups(sc)[0]!))
    }
    // read newest first, then a middle one, then oldest, then everything again
    const order = [scenes.length - 1, 3, 0, 5, 1, 2, 4, 6].filter((i) => i < scenes.length)
    for (const i of order) expect(xs(groups(scenes[i]!)[0]!), `scene ${i}`).toEqual(snaps[i])
    for (let i = 0; i < scenes.length; i++) expect(xs(groups(scenes[i]!)[0]!), `scene ${i} again`).toEqual(snaps[i])
  })

  it('an unreferenced old scene is collectable and a newer scene never keeps it alive', async () => {
    const { setFlagsFromString } = await import('node:v8')
    const vm = await import('node:vm')
    setFlagsFromString('--expose-gc')
    const gc = vm.runInNewContext('gc') as () => void
    const chart = compileChart(spec as never)
    const refs: Array<WeakRef<object>> = []
    let newest!: SceneRoot
    ;(() => {
      let s = evaluateChart(chart, { data: { t: rowsN(50) } })
      refs.push(new WeakRef(s), new WeakRef(groups(s)[0]!))
      for (let n = 50; n < 60; n++) {
        s = evaluateChart(chart, { data: { t: rowsN(n + 1) }, dataPulse: ap(n) })
        refs.push(new WeakRef(s), new WeakRef(groups(s)[0]!))
      }
      newest = s
    })()
    for (let i = 0; i < 20; i++) { gc(); await new Promise((r) => setTimeout(r, 5)) }
    const alive = refs.slice(0, -2).filter((r) => r.deref() !== undefined).length
    expect(alive).toBe(0)
    expect(groups(newest)[0]!.items).toHaveLength(60)
  })
})

describe('gradient paints keep their <defs> through an incremental evaluation', () => {
  // A gradient object on an item is defined once in the scene's defs. Defs are collected while items are encoded, so an item
  // that is not re-encoded (a reused mark, an unchanged row) must still bring its definition: the SVG references it by id.
  const grad = (color: string) => ({ gradient: 'linear', stops: [{ offset: 0, color: 'white' }, { offset: 1, color }] })
  const gradientIds = (scene: SceneRoot): string[] => (scene.defs ?? []).map((d) => d.id)
  const svgDefs = (scene: SceneRoot): string => renderSceneToSvg(scene).match(/<defs>[\s\S]*<\/defs>/)?.[0] ?? ''

  it('a mark over unchanged data keeps its gradient when another mark is re-encoded', () => {
    const spec = {
      ...BASE,
      data: [{ name: 't', values: [{ x: 0 }, { x: 1 }, { x: 2 }] }],
      marks: [
        { type: 'rect', from: { data: 't' }, encode: { update: { x: { signal: '10 * datum.x' }, width: { value: 5 }, height: { value: 5 }, fill: { value: grad('red') } } } },
        { type: 'rect', encode: { update: { x: { value: 50 }, y: { value: 50 }, width: { value: 20 }, height: { value: 20 }, fill: { value: grad('blue') } } } },
      ],
    }
    const rows = [{ x: 0 }, { x: 1 }, { x: 2 }]
    const next = [{ x: 0 }, { x: 5 }, { x: 2 }]
    const chart = compileChart(spec as never)
    evaluateChart(chart, { data: { t: rows } })
    const inc = evaluateChart(chart, { data: { t: next }, dataChanges: { t: [1] } })
    const full = fresh(spec, { data: { t: next } })
    expect(gradientIds(inc)).toEqual(gradientIds(full))
    expect(gradientIds(full)).toHaveLength(2)
    expect(svgDefs(inc)).toBe(svgDefs(full))
  })

  it('rows that are not re-encoded keep their gradients, and a gradient nothing uses any more is dropped', () => {
    const spec = {
      ...BASE,
      data: [{ name: 't', values: [] }],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { signal: '10 * datum.x' }, width: { value: 5 }, height: { value: 5 }, fill: { signal: "datum.c === 'a' ? {gradient: 'linear', stops: [{offset: 0, color: 'white'}, {offset: 1, color: 'red'}]} : datum.c === 'b' ? {gradient: 'linear', stops: [{offset: 0, color: 'white'}, {offset: 1, color: 'blue'}]} : 'green'" } } } }],
    }
    const rows = [{ x: 0, c: 'a' }, { x: 1, c: 'b' }, { x: 2, c: 'b' }]
    const chart = compileChart(spec as never)
    evaluateChart(chart, { data: { t: rows } })
    // row 0 (the only red gradient) is re-encoded as a plain colour; row 1 (a blue one) is untouched
    const next = [{ x: 0, c: 'z' }, { x: 1, c: 'b' }, { x: 2, c: 'b' }]
    const inc = evaluateChart(chart, { data: { t: next }, dataChanges: { t: [0] } })
    const full = fresh(spec, { data: { t: next } })
    expect(gradientIds(full)).toHaveLength(1)
    expect(gradientIds(inc)).toEqual(gradientIds(full))
    expect(svgDefs(inc)).toBe(svgDefs(full))
    // and the other way: the plain row takes the red gradient back
    const back = [{ x: 0, c: 'a' }, { x: 1, c: 'b' }, { x: 2, c: 'b' }]
    const inc2 = evaluateChart(chart, { data: { t: back }, dataChanges: { t: [0] } })
    const full2 = fresh(spec, { data: { t: back } })
    expect(gradientIds(inc2)).toEqual(gradientIds(full2))
    expect(svgDefs(inc2)).toBe(svgDefs(full2))
  })
})

describe('a pulse past a step that publishes a signal a later step reads', () => {
  // (Vega-Lite's `{extent: 'y', param: 'yext'}` then `{calculate: '(datum.y - yext[0]) / (yext[1] - yext[0])'}`)
  const spec = {
    width: 100, height: 60, padding: 0, autosize: 'none',
    data: [
      { name: 't' },
      { name: 'd', source: 't', transform: [{ type: 'extent', field: 'y', signal: 'yext' }, { type: 'formula', as: 'n', expr: '(datum.y - yext[0]) / (yext[1] - yext[0])' }] },
    ],
    scales: [{ name: 'y', type: 'linear', domain: { data: 'd', field: 'n' }, range: 'height' }],
    marks: [{ type: 'symbol', name: 'pts', from: { data: 'd' }, encode: { update: { x: { field: 'y' }, y: { scale: 'y', field: 'n' } } } }],
  } as never
  const rows = [2, 4, 3, 6, 5, 8, 7, 9].map((y) => ({ y }))
  const items = (s: SceneRoot): SceneItem[] => ((s.items[0] as SceneGroup).items ?? []) as SceneItem[]

  it('rows past a moved extent are made again; past an unmoved one only the changed rows are', () => {
    for (const [what, next, movesExtent] of [
      ['the row of the minimum removed', rows.slice(1), true],
      ['the row of the maximum removed', rows.slice(0, -1), true],
      ['a middle row removed', rows.filter((_, i) => i !== 3), false],
      ['a row appended past the maximum', [...rows, { y: 12 }], true],
    ] as const) {
      const session = createChartSession()
      const before = session.evaluate(spec, { data: { t: rows } })
      const input = { data: { t: next as Array<{ y: number }> } }
      const after = session.evaluate(spec, input)
      expect(renderSceneToSvg(after), what).toBe(renderSceneToSvg(evaluateChart(compileChart(spec), input)))
      const was = new Set(items(before))
      const kept = items(after).filter((it) => was.has(it)).length
      if (movesExtent) expect(kept, what).toBe(0)
      else expect(kept, what).toBe(items(after).length)
    }
  })
})

describe('marks bound to a force layout\'s links', () => {
  it('a node appended or removed moves every node, and the links drawn between them, as a fresh evaluation does', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ name: `n${i}`, weight: 3 + (i % 4) }))
    const links = Array.from({ length: 10 }, (_, i) => ({ source: i, target: (i * 5 + 2) % 12 }))
    const spec = {
      width: 200, height: 120, padding: 0, autosize: 'none',
      data: [{ name: 'node-data' }, { name: 'link-data', values: links }],
      marks: [
        { name: 'nodes', type: 'symbol', from: { data: 'node-data' }, encode: { update: { size: { signal: '6 * datum.weight' } } },
          transform: [{ type: 'force', iterations: 60, static: true, forces: [{ force: 'center', x: 100, y: 60 }, { force: 'nbody', strength: -20 }, { force: 'link', links: 'link-data', distance: 25 }], signal: 'force' }] },
        { name: 'edges', type: 'path', from: { data: 'link-data' }, encode: { update: { stroke: { value: '#bbb' } } },
          transform: [{ type: 'linkpath', shape: 'line', sourceX: 'datum.source.x', sourceY: 'datum.source.y', targetX: 'datum.target.x', targetY: 'datum.target.y', require: { signal: 'force' } }] },
      ],
    } as never
    const session = createChartSession()
    session.evaluate(spec, { data: { 'node-data': nodes } })
    for (const next of [[...nodes, { ...nodes[3]! }], nodes.slice(0, 11).concat([{ ...nodes[11]!, weight: 9 }]), nodes]) {
      const input = { data: { 'node-data': next } }
      expect(renderSceneToSvg(session.evaluate(spec, input))).toBe(renderSceneToSvg(evaluateChart(compileChart(spec), input)))
    }
  })
})
