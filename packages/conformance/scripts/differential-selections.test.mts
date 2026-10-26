/**
 * LIVE differential for the Vega-Lite selection expression functions (vega-selections 6.1.4, which the
 * pinned vega 6.3.1 registers): `vlSelectionTest`, `vlSelectionIdTest`, `vlSelectionResolve`,
 * `vlSelectionTuples`, and the `modify` dataflow semantics on named datasets.
 *
 * Each case runs the SAME store tuples and the SAME probes through a real vega `View` (the functions as
 * vega-functions wires them: the `:store` dataset parameter, the `index:unit` operator, the dataset's own
 * `collect` transform) and through Aster's evaluation of the same spec, in one process on one engine, and
 * compares what both return (exactly: NaN, -0, Dates and Sets are told apart) and what each leaves in the
 * store (upstream coerces Dates in tuple values to numbers while testing; so must we). Nothing is recorded.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart } from '../../core/src/compiler.ts'
import { evaluateChart } from '../../core/src/runtime.ts'
import { enc, quietLogger } from './differential-util.mts'

type Row = Record<string, unknown>

/** `enc`, plus Sets, and without function-valued keys (vega caches `getter` on each field definition). */
function image(v: unknown): unknown {
  if (v instanceof Set) return { $: 'set', values: [...v].map(image) }
  if (Array.isArray(v)) return v.map(image)
  if (v instanceof Date) return enc(v)
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) {
      const x = (v as Row)[k]
      if (typeof x !== 'function') o[k] = image(x)
    }
    return o
  }
  return enc(v)
}

const STORE = 's_store'

/** The results of both sides, probe by probe, leaving out the probes vega threw on. */
function comparable(want: Run, got: Run): { want: unknown[]; got: unknown[] } {
  const keep = (r: Run): unknown[] => r.results.map((x, i) => (want.threw[i] ? '(threw)' : x))
  return { want: keep(want), got: keep(got) }
}

interface Run {
  /** the value each probe expression gives, probe by probe */
  results: unknown[]
  /** probes the expression threw on: vega logs the error and keeps the previous value, so only vega's side says */
  threw: boolean[]
  /** the store's tuples afterwards (vega: `view.data`; Aster: the rows it was handed) */
  store: unknown
  errors: number
}

/** Real vega: the store dataset as vega-lite declares it, and one signal `r` evaluating `expr` for the signal `d`. */
async function vegaRun(rows: Row[], sorted: boolean, expr: string, probes: unknown[]): Promise<Run> {
  const errors: unknown[][] = []
  const q = quietLogger(errors)
  const spec = {
    data: [{ name: STORE, ...(sorted ? { transform: [{ type: 'collect', sort: { field: '_vgsid_' } }] } : {}) }],
    signals: [{ name: 'd', value: {} }, { name: 'r', update: expr }],
  }
  const view = new vega.View(vega.parse(spec as vega.Spec), { renderer: 'none', logger: q as never })
  view.logger(q as never)
  view.insert(STORE, rows)
  await view.runAsync()
  const results: unknown[] = []
  const threw: boolean[] = []
  errors.length = 0
  for (const p of probes) {
    const before = errors.length
    view.signal('d', structuredClone(p))
    await view.runAsync()
    threw.push(errors.length > before)
    results.push(image(view.signal('r')))
  }
  return { results, threw, store: image(view.data(STORE)), errors: errors.length }
}

function asterRun(rows: Row[], sorted: boolean, expr: string, probes: unknown[]): Run {
  const spec = {
    data: [{ name: STORE, ...(sorted ? { transform: [{ type: 'collect', sort: { field: '_vgsid_' } }] } : {}) }],
    signals: [{ name: 'd', value: {} }, { name: 'r', update: expr }],
  }
  const compiled = compileChart(spec as never)
  const errors: unknown[][] = []
  const logger = quietLogger(errors) as never
  const results: unknown[] = []
  for (const p of probes) {
    const scene = evaluateChart(compiled, { data: { [STORE]: rows }, signals: { d: structuredClone(p) }, logger })
    results.push(image((scene as unknown as { signalParams: Row }).signalParams.r))
  }
  return { results, threw: results.map(() => false), store: image(rows), errors: errors.length }
}

// ---- stores ------------------------------------------------------------------------------------------------

const F = (field: string, type = 'E'): Row => ({ field, type })
const T = (unit: string, fields: Row[], values: unknown[]): Row => ({ unit, fields, values })
const ID = (unit: string, id: number): Row => ({ unit, _vgsid_: id })

const D0 = new Date(Date.UTC(2020, 0, 1))
const D1 = new Date(Date.UTC(2021, 0, 1))
const D2 = new Date(Date.UTC(2022, 0, 1))

const FIELD_STORES: Array<{ name: string; rows: () => Row[] }> = [
  { name: 'empty', rows: () => [] },
  { name: 'point-enum', rows: () => [T('', [F('b')], ['x'])] },
  { name: 'point-multi-values', rows: () => [T('', [F('b')], ['x']), T('', [F('b')], ['y'])] },
  { name: 'point-two-fields', rows: () => [T('', [F('a'), F('b')], [1, 'x'])] },
  { name: 'point-two-fields-two-tuples', rows: () => [T('', [F('a'), F('b')], [1, 'x']), T('', [F('a'), F('b')], [2, 'y'])] },
  { name: 'interval-range', rows: () => [T('', [F('a', 'R')], [[1, 3]])] },
  { name: 'interval-range-reversed', rows: () => [T('', [F('a', 'R')], [[3, 1]])] },
  { name: 'interval-two-axes', rows: () => [T('', [F('a', 'R'), F('d', 'R')], [[1, 3], [0, 10]])] },
  { name: 'interval-enum-array', rows: () => [T('', [F('b')], [['x', 'z']])] },
  { name: 'interval-dates', rows: () => [T('', [F('c', 'R')], [[D0, D1]])] },
  { name: 'interval-dates-reversed', rows: () => [T('', [F('c', 'R')], [[D1, D0]])] },
  { name: 'enum-date', rows: () => [T('', [F('c')], [D1])] },
  { name: 'binned-range-right-exclusive', rows: () => [T('', [F('a', 'R-RE')], [[1, 3]])] },
  { name: 'range-exclusive', rows: () => [T('', [F('a', 'R-E')], [[1, 3]])] },
  { name: 'range-left-exclusive', rows: () => [T('', [F('a', 'R-LE')], [[1, 3]])] },
  { name: 'pred-lt', rows: () => [T('', [F('a', 'E-LT')], [2])] },
  { name: 'pred-lte', rows: () => [T('', [F('a', 'E-LTE')], [2])] },
  { name: 'pred-gt', rows: () => [T('', [F('a', 'E-GT')], [2])] },
  { name: 'pred-gte', rows: () => [T('', [F('a', 'E-GTE')], [2])] },
  { name: 'pred-valid', rows: () => [T('', [F('d', 'E-VALID')], [null])] },
  { name: 'pred-oneof', rows: () => [T('', [F('b', 'E-ONE')], [['x', 'y']])] },
  { name: 'nested-field', rows: () => [T('', [F('n.k')], [7])] },
  { name: 'two-units-point', rows: () => [T('u1', [F('b')], ['x']), T('u2', [F('b')], ['y'])] },
  { name: 'two-units-same-value', rows: () => [T('u1', [F('b')], ['x']), T('u2', [F('b')], ['x'])] },
  { name: 'two-units-two-tuples-each', rows: () => [T('u1', [F('b')], ['x']), T('u1', [F('b')], ['y']), T('u2', [F('a', 'R')], [[1, 3]]), T('u2', [F('a', 'R')], [[2, 4]])] },
  { name: 'three-units', rows: () => [T('u1', [F('b')], ['x']), T('u2', [F('b')], ['x']), T('u3', [F('a', 'R')], [[0, 9]])] },
  { name: 'unit-then-miss', rows: () => [T('u1', [F('b')], ['q']), T('u1', [F('b')], ['x']), T('u2', [F('a', 'R')], [[1, 3]])] },
]

const ID_STORES: Array<{ name: string; rows: () => Row[] }> = [
  { name: 'empty', rows: () => [] },
  { name: 'one-id', rows: () => [ID('', 2)] },
  { name: 'ids-unsorted', rows: () => [ID('', 5), ID('', 1), ID('', 3)] },
  { name: 'ids-two-units-disjoint', rows: () => [ID('u1', 1), ID('u1', 4), ID('u2', 2)] },
  { name: 'ids-two-units-shared', rows: () => [ID('u1', 1), ID('u2', 1), ID('u1', 2), ID('u2', 3)] },
  { name: 'ids-three-units-shared', rows: () => [ID('u1', 1), ID('u2', 1), ID('u3', 1), ID('u1', 2), ID('u2', 2)] },
  { name: 'ids-duplicates', rows: () => [ID('u1', 3), ID('u1', 3), ID('u2', 3)] },
]

const DATUMS: Row[] = []
for (const a of [0, 1, 2, 3, 4, 'q', null]) {
  for (const b of ['x', 'y', 'z']) {
    DATUMS.push({ a, b, c: D1, d: 5, n: { k: 7 } })
  }
}
for (const c of [D0, D1, D2, new Date(Date.UTC(2020, 6, 1))]) DATUMS.push({ a: 2, b: 'x', c, d: 1, n: { k: 7 } })
for (const d of [null, NaN, undefined, 0, 10, 11, -1]) DATUMS.push({ a: 2, b: 'y', d, n: { k: 8 } })
DATUMS.push({}, { n: {} }, { a: 3, b: 'x', c: 1577836800000, d: 5, n: { k: 7 } })
const ID_DATUMS: Row[] = [-1, 0, 1, 2, 3, 4, 5, 6, NaN].map((_vgsid_) => ({ _vgsid_ }))
ID_DATUMS.push({}, { _vgsid_: null }, { _vgsid_: '3' })

const OPS = ['', ', "union"', ', "intersect"']

describe(`vlSelectionTest vs vega@${vega.version}`, () => {
  for (const store of FIELD_STORES) {
    for (const op of OPS) {
      it(`${store.name}${op}`, async () => {
        const expr = `vlSelectionTest("${STORE}", d${op})`
        const probes = DATUMS
        const want = await vegaRun(store.rows(), false, expr, probes)
        const got = asterRun(store.rows(), false, expr, probes)
        const c = comparable(want, got)
        expect(c.got).toEqual(c.want)
        expect(got.store).toEqual(want.store)
      })
    }
  }
  it('has real coverage: a probe set that is neither all-true nor all-false', async () => {
    const outcomes = new Set<string>()
    for (const store of FIELD_STORES) {
      const want = await vegaRun(store.rows(), false, `vlSelectionTest("${STORE}", d, "intersect")`, DATUMS)
      for (const r of want.results) outcomes.add(JSON.stringify(r))
    }
    expect(outcomes.has('true')).toBe(true)
    expect(outcomes.has('false')).toBe(true)
    expect(outcomes.has('0')).toBe(true)
  })
})

describe(`vlSelectionIdTest vs vega@${vega.version}`, () => {
  for (const store of ID_STORES) {
    for (const op of OPS) {
      it(`${store.name}${op}`, async () => {
        const expr = `vlSelectionIdTest("${STORE}", d${op})`
        const want = await vegaRun(store.rows(), true, expr, ID_DATUMS)
        const got = asterRun(store.rows(), true, expr, ID_DATUMS)
        expect(got.results).toEqual(want.results)
      })
    }
  }
})

describe(`vlSelectionResolve vs vega@${vega.version}`, () => {
  const ARGS = [
    '',
    ', "union"', ', "intersect"',
    ', "union", true', ', "intersect", true',
    ', "union", true, true', ', "intersect", true, true',
    ', "union", false', ', "intersect", false, true',
  ]
  for (const store of FIELD_STORES) {
    for (const args of ARGS) {
      it(`${store.name}${args}`, async () => {
        const expr = `vlSelectionResolve("${STORE}"${args})`
        const want = await vegaRun(store.rows(), false, expr, [null])
        const got = asterRun(store.rows(), false, expr, [null])
        const c = comparable(want, got)
        expect(c.got).toEqual(c.want)
        expect(got.store).toEqual(want.store)
      })
    }
  }
  for (const store of ID_STORES) {
    for (const args of ARGS) {
      it(`ids: ${store.name}${args}`, async () => {
        const expr = `vlSelectionResolve("${STORE}"${args})`
        const want = await vegaRun(store.rows(), true, expr, [null])
        const got = asterRun(store.rows(), true, expr, [null])
        expect(got.results).toEqual(want.results)
      })
    }
  }
  it('resolves after a test coerced the dates (order matters upstream)', async () => {
    const expr = `[vlSelectionTest("${STORE}", d), vlSelectionResolve("${STORE}", "union")]`
    const store = (): Row[] => [T('', [F('c', 'R')], [[D1, D0]])]
    const want = await vegaRun(store(), false, expr, DATUMS.slice(0, 4))
    const got = asterRun(store(), false, expr, DATUMS.slice(0, 4))
    expect(got.results).toEqual(want.results)
    expect(got.store).toEqual(want.store)
  })
})

describe(`vlSelectionTuples vs vega@${vega.version}`, () => {
  const ITEMS = [
    [{ datum: { a: 1, b: 'x', _vgsid_: 4, n: { k: 2 } } }, { datum: { a: 2, b: 'y', _vgsid_: 7, n: { k: 3 } } }],
    [],
    [{ datum: {} }],
    [{ datum: { a: new Date(5), b: null } }],
  ]
  const BASES = [
    { unit: '', fields: [F('a'), F('b', 'R')] },
    { unit: 'u', fields: [F('n.k')] },
    { unit: 'v' },
    { unit: 'w', fields: [] },
  ]
  for (const [bi, base] of BASES.entries()) {
    for (const [ii, items] of ITEMS.entries()) {
      it(`base ${bi}, items ${ii}`, async () => {
        const expr = `vlSelectionTuples(d.items, d.base)`
        const probe = { items, base }
        const want = await vegaRun([], false, expr, [probe])
        const got = asterRun([], false, expr, [probe])
        expect(got.results).toEqual(want.results)
      })
    }
  }
  for (const [name, probe] of Object.entries({
    'items not an array': { items: 3, base: { unit: '' } },
    'base not an object': { items: [], base: 3 },
    'base null': { items: [], base: null },
  })) {
    it(`refuses: ${name}`, async () => {
      const expr = `vlSelectionTuples(d.items, d.base)`
      const want = await vegaRun([], false, expr, [probe])
      const got = asterRun([], false, expr, [probe])
      expect(got.results).toEqual(want.results)
      expect(want.errors).toBeGreaterThan(0)
    })
  }
})

describe(`pan / zoom / clampRange / inrange vs vega@${vega.version}`, () => {
  const DOMAINS = [[0, 10], [10, 0], [1, 100], [-5, 5], [0.5, 2], [-100, -1], [3, 3], [0, 1, 2, 10]]
  const NUMS = [-2, -1, -0.25, 0, 0.1, 0.5, 1, 1.001, 2, 16]
  const probes = (extra: Record<string, unknown[]>): unknown[] => {
    const out: unknown[] = []
    for (const domain of DOMAINS) for (const a of NUMS) {
      if (!Object.keys(extra).length) out.push({ domain, a })
      else for (const e of Object.values(extra)[0]!) out.push({ domain, a, b: 4, e })
    }
    return out
  }
  const cases: Array<[string, string, unknown[]]> = [
    ['panLinear', 'panLinear(d.domain, d.a)', probes({})],
    ['panLog', 'panLog(d.domain, d.a)', probes({})],
    ['panPow', 'panPow(d.domain, d.a, d.e)', probes({ e: [0.5, 1, 2] })],
    ['panSymlog', 'panSymlog(d.domain, d.a, d.e)', probes({ e: [0.5, 1, 10] })],
    ['zoomLinear', 'zoomLinear(d.domain, d.b, d.a)', probes({ e: [0] })],
    ['zoomLinear without anchor', 'zoomLinear(d.domain, null, d.a)', probes({})],
    ['zoomLog', 'zoomLog(d.domain, d.b, d.a)', probes({ e: [0] })],
    ['zoomPow', 'zoomPow(d.domain, d.b, d.a, d.e)', probes({ e: [0.5, 1, 2] })],
    ['zoomSymlog', 'zoomSymlog(d.domain, d.b, d.a, d.e)', probes({ e: [0.5, 1, 10] })],
    ['clampRange', 'clampRange(d.domain, 0, d.b + 3)', probes({ e: [0] })],
    ['clampRange reversed', 'clampRange([d.a, d.domain[0]], -1, 5)', probes({})],
    ['inrange', 'inrange(d.a, d.domain)', probes({})],
    ['inrange exclusive', 'inrange(d.a, d.domain, false, false)', probes({})],
    ['inrange left only', 'inrange(d.a, d.domain, true, false)', probes({})],
    ['inrange right only', 'inrange(d.a, d.domain, false, true)', probes({})],
    ['isTuple of a datum', 'isTuple(d)', [{ domain: [0], a: 1 }]],
    ['isTuple of nothing', 'isTuple(null)', [{}]],
  ]
  for (const [name, expr, ps] of cases) {
    it(name, async () => {
      const want = await vegaRun([], false, expr, ps)
      const got = asterRun([], false, expr, ps)
      const c = comparable(want, got)
      expect(c.got).toEqual(c.want)
    })
  }
})
