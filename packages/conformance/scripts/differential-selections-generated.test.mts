/**
 * LIVE generated differential for the Vega-Lite selection functions (vega-selections 6.1.4): random selection stores
 * (several units, one or two fields per tuple, every tuple type: enumerated, ranges with each kind of open end,
 * comparison predicates, valid, one-of; numbers, strings, Dates, reversed ranges, nulls) and random probe data go
 * through a real vega View and through Aster's evaluation of the same expressions. Results AND the tuples left in the
 * store afterwards (upstream rewrites Dates in tuple values as it tests) must be equal. `differential-selections`
 * pins hand-written stores; this one finds the combinations nobody wrote down.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart } from '../../core/src/compiler.ts'
import { evaluateChart } from '../../core/src/runtime.ts'
import { enc, quietLogger } from './differential-util.mts'
import { seeded } from './upstream.mts'

type Row = Record<string, unknown>
const STORE = 's_store'

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

interface Outcome { results: unknown[]; threw: boolean[]; store: unknown }

async function vegaRun(rows: Row[], sorted: boolean, expr: string, probes: unknown[]): Promise<Outcome> {
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
  const store = image(view.data(STORE))
  view.finalize()
  return { results, threw, store }
}

function asterRun(rows: Row[], sorted: boolean, expr: string, probes: unknown[]): Outcome {
  const spec = {
    data: [{ name: STORE, ...(sorted ? { transform: [{ type: 'collect', sort: { field: '_vgsid_' } }] } : {}) }],
    signals: [{ name: 'd', value: {} }, { name: 'r', update: expr }],
  }
  const compiled = compileChart(spec as never)
  const logger = quietLogger([]) as never
  // vega evaluates the signal once with its initial value (an empty datum) before any probe, and that run can rewrite tuples too
  evaluateChart(compiled, { data: { [STORE]: rows }, signals: { d: {} }, logger })
  const results = probes.map((p) => image((evaluateChart(compiled, { data: { [STORE]: rows }, signals: { d: structuredClone(p) }, logger }) as unknown as { signalParams: Row }).signalParams.r))
  return { results, threw: results.map(() => false), store: image(rows) }
}

const TYPES = ['E', 'E', 'E', 'R', 'R', 'R-E', 'R-LE', 'R-RE', 'E-LT', 'E-LTE', 'E-GT', 'E-GTE', 'E-VALID', 'E-ONE']
const FIELDS = ['a', 'b', 'c', 'd', 'n.k']
const D = [0, 1.6e12, 1.7e12, 1.8e12].map((t) => new Date(t))

type Gen = ReturnType<typeof seeded>

function scalar(r: Gen, field: string): unknown {
  if (field === 'b') return r.pick(['x', 'y', 'z', 'q'])
  if (field === 'c') return r.pick([...D, 1.6e12, 1.7e12])
  return r.pick([0, 1, 2, 3, 4, 2.5, -1, null, NaN])
}

function tuple(r: Gen, unit: string, enumArrays: boolean): Row {
  const n = 1 + r.int(2)
  const fields: Row[] = []
  const values: unknown[] = []
  for (let i = 0; i < n; i++) {
    const field = r.pick(FIELDS)
    const type = r.pick(enumArrays ? TYPES : TYPES.filter((t) => t !== 'E-ONE'))
    fields.push({ field, type })
    if (type.startsWith('R')) values.push([scalar(r, field), scalar(r, field)])
    else if (type === 'E-ONE') values.push([scalar(r, field), scalar(r, field)])
    else if (type === 'E' && enumArrays && r.int(3) === 0) values.push([scalar(r, field), scalar(r, field), scalar(r, field)])
    else values.push(scalar(r, field))
  }
  return { unit, fields, values }
}

/**
 * A random store. Without `enumArrays` no tuple enumerates an array of values (`E` with a list, `E-ONE`): upstream's
 * `vlSelectionResolve` hands the first such tuple's own array out as its accumulator and grows it in place when it merges
 * another tuple of the same field into it, so its result and the store depend on that accident; Aster resolves into fresh
 * arrays and does not reproduce it, so resolve is compared on stores where it cannot arise.
 */
function store(seed: number, enumArrays: boolean): Row[] {
  const r = seeded(seed)
  const units = r.pick([[''], ['', 'u1'], ['u1', 'u2'], ['u1', 'u2', 'u3']])
  return Array.from({ length: r.int(7) }, () => tuple(r, r.pick(units), enumArrays))
}

function probes(seed: number): Row[] {
  const r = seeded(seed)
  return Array.from({ length: 12 }, () => {
    const datum: Row = { n: { k: scalar(r, 'a') } }
    for (const f of ['a', 'b', 'c', 'd']) if (r.int(10)) datum[f] = scalar(r, f)
    return datum
  })
}

const OPS = ['', ', "union"', ', "intersect"']
const RESOLVE = ['', ', "union"', ', "intersect"', ', "union", true', ', "intersect", true', ', "union", true, true', ', "intersect", true, true']

describe('vlSelectionTest / vlSelectionResolve vs vega-selections (generated)', () => {
  it('agree on random field stores, results and store contents', async () => {
    let trues = 0
    let falses = 0
    let compared = 0
    for (let seed = 1; seed <= 400; seed++) {
      const r = seeded(seed * 7919)
      const test = `vlSelectionTest("${STORE}", d${r.pick(OPS)})`
      const resolve = `vlSelectionResolve("${STORE}"${r.pick(RESOLVE)})`
      for (const [expr, ps] of [[test, probes(seed)], [resolve, [null]], [`[${test}, ${resolve}]`, probes(seed + 1)]] as Array<[string, Row[]]>) {
        const enumArrays = expr === test
        const want = await vegaRun(store(seed, enumArrays), false, expr, ps)
        const got = asterRun(store(seed, enumArrays), false, expr, ps)
        const mask = (o: Outcome): unknown[] => o.results.map((x, i) => (want.threw[i] ? '(threw)' : x))
        expect({ results: mask(got), store: got.store }, `seed ${seed}: ${expr}`).toEqual({ results: mask(want), store: want.store })
        for (const x of want.results) {
          compared++
          if (x === true) trues++
          if (x === false) falses++
        }
      }
    }
    expect(compared).toBeGreaterThan(5000)
    expect(trues).toBeGreaterThan(100)
    expect(falses).toBeGreaterThan(100)
  })

  it('agree on random id stores', async () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = seeded(seed * 104729)
      const rows: Row[] = Array.from({ length: r.int(9) }, () => ({ unit: r.pick(['u1', 'u2', 'u3']), _vgsid_: r.int(6) }))
      const ps = [0, 1, 2, 3, 4, 5, 6, -1, NaN, null].map((_vgsid_) => ({ _vgsid_ }))
      const test = `vlSelectionIdTest("${STORE}", d${r.pick(OPS)})`
      const resolve = `vlSelectionResolve("${STORE}"${r.pick(RESOLVE)})`
      for (const [expr, p] of [[test, ps], [resolve, [null]]] as Array<[string, Row[]]>) {
        const want = await vegaRun(structuredClone(rows), true, expr, p)
        const got = asterRun(structuredClone(rows), true, expr, p)
        expect(got.results, `seed ${seed}: ${expr} ${JSON.stringify(rows)}`).toEqual(want.results)
      }
    }
  })
})
