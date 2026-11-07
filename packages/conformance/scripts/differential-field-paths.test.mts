/**
 * Field names that are paths, against real Vega. A field is written as a path: `a.b` (nested), `a\.b` (one key with a dot),
 * `a[0]`, `a["b.c"]`, `["a b"]`, `0` (a numeric key). Everywhere a spec names a field the engine must read the same value
 * Vega reads: a facet's `groupby` (and its aggregate), the `field` of an encode entry, a scale's domain, a mark's sort, and
 * every transform that takes a field.
 *
 * Two generated sweeps over one pool of paths (see KEYS, NUMS): the datasets of a transform pipeline, strictly (values, key
 * order, row order), and the picture of a spec that names the path in a facet, an encode entry, a scale or a sort. A case
 * where Vega logs an error must make the engine log one too.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'
import { compileChart, datasetsOfScene, evaluateChart, renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { enc } from './differential-util.mts'
import { makeRng, scaled, type Rng } from './differential-gen.mts'

type Spec = Record<string, unknown>

// ---------------------------------------------------------------------------
// the two sides
// ---------------------------------------------------------------------------

type ViewLike = { runAsync(): Promise<void>; toSVG(): Promise<string>; data(n: string): unknown[]; finalize(): void }

async function onVega(spec: Spec, dataset?: string): Promise<{ svg: string; rows?: unknown[]; errors: string[] }> {
  const errors: string[] = []
  const logger = {
    level() { return 2 },
    error: (...a: unknown[]) => { errors.push(a.map(String).join(' ')); return logger },
    warn: () => logger, info: () => logger, debug: () => logger,
  }
  const View = (vega as unknown as { View: new (rt: unknown, o: unknown) => ViewLike }).View
  const view = new View(vega.parse(structuredClone(spec) as never), { renderer: 'none', logger })
  try {
    await view.runAsync()
    return { svg: await view.toSVG(), rows: dataset ? view.data(dataset) : undefined, errors }
  } finally {
    view.finalize()
  }
}

function onAster(spec: Spec, dataset?: string): { svg: string; rows?: unknown[]; errors: unknown[] } {
  const errors: unknown[] = []
  const logger = { error: (...a: unknown[]) => { errors.push(a[0]) }, warn: () => {} }
  const input = { logger } as never
  const svg = renderSpec(structuredClone(spec) as never, input)
  let rows: unknown[] | undefined
  if (dataset) rows = datasetsOfScene(evaluateChart(compileChart(structuredClone(spec) as never), { logger } as never)).get(dataset) as unknown[]
  return { svg, rows, errors }
}

// ---------------------------------------------------------------------------
// the paths, and a row that holds a value at each
// ---------------------------------------------------------------------------

/** Paths to a category (text) and where the row keeps it. */
const KEYS = [
  'k', 'o.k', 'o["k"]', "o['k']", 'd\\.k', '["d.k"]', 'dd\\.ee.f', 'arr[0]', 'arr.0', 'x\\[y\\]', '["x[y]"]', '0', '[0]', 'o.deep.k', 'm.0.k',
] as const
/** Paths to a number. */
const NUMS = ['n', 'o.n', '["n"]', 'arr[1]', 'arr.1', 'q\\.n', 'o.deep.n', 'm[1].n', 'o\\.n'] as const
/** A path to a text or number that exists in no row (reads undefined, never throws). */
const ABSENT = ['o.zz', 'zz', 'o["zz"]', 'arr[5]', 'k\\.k'] as const
/** Paths to an array. */
const ARRS = ['items', 'o.items', 'o["items"]', 'm'] as const

const CATS = ['a', 'b', 'c', 'd']

function rowOf(r: Rng, i: number): Record<string, unknown> {
  const cat = (): string => r.pick(CATS)
  const num = (): number => r.between(1, 40) + (r.chance(0.3) ? 0.5 : 0)
  // a tree: the parent of row i is an earlier row (row 0 is the root), written under several paths
  const pid = i === 0 ? null : r.int(i)
  return {
    id: i,
    pid, o2: { pid }, 'p.id': pid,
    k: cat(), n: num(),
    o: { k: cat(), n: num(), 'o.n': num(), items: [num(), num()], deep: { k: cat(), n: num() }, id: i, pid },
    'i.id': i,
    'd.k': cat(), 'dd.ee': { f: cat() }, 'q.n': num(),
    arr: [cat(), num(), pid],
    'x[y]': cat(),
    0: cat(),
    m: [{ k: cat(), n: num() }, { k: cat(), n: num() }],
    items: [num(), num(), num()],
    t: '2020-0' + r.between(1, 9) + '-1' + r.between(0, 9),
  }
}

// ---------------------------------------------------------------------------
// the transform sweep
// ---------------------------------------------------------------------------

type Pick = { pick: <T>(items: readonly T[]) => T; keys: (n: number) => string[]; key: () => string; num: () => string; arr: () => string; any: () => string }

/** `n` different paths (a group-by that names one field twice is a different question). */
function distinct(r: Rng, n: number): string[] {
  const out: string[] = []
  while (out.length < n) {
    const k = r.chance(0.05) ? r.pick(ABSENT) : r.pick(KEYS)
    if (!out.includes(k)) out.push(k)
  }
  return out
}

/** Transform templates: each gets a way to draw paths and returns the transforms of the pipeline. */
const TEMPLATES: Array<[string, (p: Pick) => Spec[]]> = [
  ['aggregate by a path', (p) => [{ type: 'aggregate', groupby: [p.key()], fields: [p.num(), p.num()], ops: ['sum', 'mean'] }]],
  ['aggregate by a path, named', (p) => [{ type: 'aggregate', groupby: [p.key()], fields: [p.num()], ops: ['max'], as: ['mx'] }]],
  ['aggregate by several paths', (p) => [{ type: 'aggregate', groupby: [p.key(), p.key()], fields: [p.num()], ops: ['count'] }]],
  ['aggregate keeping a count only', (p) => [{ type: 'aggregate', groupby: [p.key()] }]],
  ['aggregate over a path with values', (p) => [{ type: 'aggregate', groupby: [p.key()], fields: [p.num(), p.num()], ops: ['values', 'median'] }]],
  ['joinaggregate', (p) => [{ type: 'joinaggregate', groupby: [p.key()], fields: [p.num()], ops: ['mean'], as: ['avg'] }]],
  ['joinaggregate without names', (p) => [{ type: 'joinaggregate', groupby: [p.key()], fields: [p.num()], ops: ['sum'] }]],
  ['window', (p) => [{ type: 'window', sort: { field: p.num() }, groupby: [p.key()], ops: ['row_number', 'sum'], fields: [null, p.num()] }]],
  ['window without names', (p) => [{ type: 'window', sort: { field: p.num(), order: 'descending' }, groupby: [p.key()], ops: ['rank', 'mean'], fields: [null, p.num()], frame: [-1, 1] }]],
  ['stack', (p) => [{ type: 'stack', field: p.num(), groupby: [p.key()], sort: { field: p.key() } }]],
  ['stack normalized', (p) => [{ type: 'stack', field: p.num(), groupby: [p.key()], offset: 'normalize', sort: { field: [p.key(), p.num()], order: ['ascending', 'descending'] } }]],
  ['bin', (p) => [{ type: 'bin', field: p.num(), extent: [0, 50], maxbins: 5 }]],
  ['collect sorted', (p) => [{ type: 'collect', sort: { field: [p.key(), p.num()], order: ['descending', 'ascending'] } }]],
  ['fold', (p) => [{ type: 'fold', fields: [p.num(), p.num()] }]],
  ['fold with names', (p) => [{ type: 'fold', fields: [p.num(), p.num()], as: ['name', 'val'] }]],
  ['flatten', (p) => [{ type: 'flatten', fields: [p.arr()] }]],
  ['flatten with names', (p) => [{ type: 'flatten', fields: [p.arr()], as: ['elem'] }]],
  ['impute', (p) => [{ type: 'impute', field: p.num(), key: p.key(), groupby: [p.key()], method: 'value', value: 0 }]],
  ['impute by the mean', (p) => [{ type: 'impute', field: p.num(), key: p.key(), method: 'mean' }]],
  ['pivot', (p) => [{ type: 'pivot', field: p.key(), value: p.num(), groupby: [p.key()] }]],
  ['project', (p) => [{ type: 'project', fields: [p.key(), p.num()] }]],
  ['project with names', (p) => [{ type: 'project', fields: [p.key(), p.num()], as: ['a', 'b'] }]],
  ['quantile', (p) => [{ type: 'quantile', field: p.num(), probs: [0.25, 0.5] }]],
  ['quantile by a path', (p) => [{ type: 'quantile', field: p.num(), groupby: [p.key()], probs: [0.5] }]],
  ['regression', (p) => [{ type: 'regression', x: p.num(), y: p.num(), method: 'linear' }]],
  ['regression by a path', (p) => [{ type: 'regression', x: p.num(), y: p.num(), groupby: [p.key()], method: 'poly', order: 2 }]],
  ['loess', (p) => [{ type: 'loess', x: p.num(), y: p.num(), groupby: [p.key()] }]],
  ['kde', (p) => [{ type: 'kde', field: p.num(), groupby: [p.key()], steps: 5 }]],
  ['density', (p) => [{ type: 'density', extent: [0, 50], distribution: { function: 'kde', field: p.num(), from: 'src' }, steps: 5 }]],
  ['pie', (p) => [{ type: 'pie', field: p.num() }]],
  ['pie sorted', (p) => [{ type: 'pie', field: p.num(), sort: true }]],
  ['countpattern', (p) => [{ type: 'countpattern', field: p.key(), pattern: '[a-d]' }]],
  ['dotbin', (p) => [{ type: 'dotbin', field: p.num(), step: 3 }]],
  ['timeunit', (p) => [{ type: 'timeunit', field: 't', units: ['year', 'month'] }]],
  ['geojson', (p) => [{ type: 'geojson', fields: [p.num(), p.num()] }]],
  ['voronoi', (p) => [{ type: 'voronoi', x: p.num(), y: p.num(), size: [50, 50] }]],
  ['cross filter chain', (p) => [{ type: 'aggregate', groupby: [p.key()], fields: [p.num()], ops: ['sum'], as: ['s'] }, { type: 'collect', sort: { field: 's' } }]],
  ['lookup of a path', (p) => [{ type: 'lookup', from: 'lk', key: 'id', fields: [p.num()], values: ['label'], as: ['lab'], default: 'none' }]],
  ['lookup by a path in the other data', (p) => [{ type: 'lookup', from: 'lk', key: 'who', fields: [p.key()], values: ['label'], default: 'none' }]],
  ['lookup keyed by a path in the other data', (p) => [{ type: 'lookup', from: 'lk', key: p.pick(['id', 'o.id', 'i\\.id', 'arr[0]', '["i.id"]']), fields: [p.num()], values: ['label'], default: 'none' }]],
  ['lookup of several paths', (p) => [{ type: 'lookup', from: 'lk', key: 'id', fields: [p.num()], values: ['label', p.pick(['o.id', 'i\\.id', 'arr[0]'])], as: ['lab', 'other'] }]],
  ['stratify, treemap and a path', (p) => [{ type: 'stratify', key: 'id', parentKey: p.pick(['pid', 'o.pid', 'p\\.id', 'arr[2]', '["p.id"]', 'o2.pid']) }, { type: 'treemap', field: p.num(), size: [100, 50] }]],
  ['stratify and pack', (p) => [{ type: 'stratify', key: p.pick(['id', 'o.id', 'i\\.id']), parentKey: 'pid' }, { type: 'pack', field: p.num(), size: [100, 50] }]],
  ['stratify and partition', (p) => [{ type: 'stratify', key: 'id', parentKey: 'pid' }, { type: 'partition', field: p.num(), size: [100, 50], sort: { field: 'value' } }]],
  ['stratify and a tree', (p) => [{ type: 'stratify', key: 'id', parentKey: 'pid' }, { type: 'tree', field: p.num(), method: 'tidy', size: [100, 50] }]],
  ['label-free crossfilter', (p) => [{ type: 'crossfilter', fields: [p.num(), p.num()], query: [[0, 20], [5, 30]] }]],
  ['sample-free filter and formula', (p) => [{ type: 'filter', expr: 'datum.n > 0' }, { type: 'formula', expr: `datum["n"] * 2`, as: 'twice' }]],
]

function rowsAreEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(enc(a)) === JSON.stringify(enc(b))
}

/** Every string a value holds, keys excluded (the paths a case drew). */
function stringsIn(v: unknown, into: Set<string>): void {
  if (typeof v === 'string') into.add(v)
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, into)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsIn(x, into)
}

const nameOfCase = (name: string, t: unknown): string => `${name}: ${JSON.stringify(t)}`

describe('transforms read field paths as vega does', () => {
  it(`${scaled(600)} generated pipelines hold the vega datasets`, { timeout: 600_000 }, async () => {
    const r = makeRng(2024)
    const bad: string[] = []
    let compared = 0
    let refused = 0
    const used = new Set<string>()
    for (let c = 0; c < scaled(600); c++) {
      const [name, build] = r.pick(TEMPLATES)
      const rows = Array.from({ length: r.between(3, 9) }, (_, i) => rowOf(r, i))
      const p: Pick = {
        key: () => (r.chance(0.07) ? r.pick(ABSENT) : r.pick(KEYS)),
        num: () => (r.chance(0.07) ? r.pick(ABSENT) : r.pick(NUMS)),
        arr: () => r.pick(ARRS),
        any: () => r.pick([...KEYS, ...NUMS]),
        keys: (n) => distinct(r, n),
        pick: (items) => r.pick(items),
      }
      const transform = build(p)
      const lk = rows.map((row, i) => ({ id: i, o: { id: i }, 'i.id': i, arr: [i], who: (row as { k: string }).k, label: 'L' + i }))
      const spec: Spec = {
        data: [
          { name: 'lk', values: lk },
          { name: 'src', values: rows },
          { name: 'out', source: 'src', transform },
        ],
      }
      const label = nameOfCase(name, transform)
      stringsIn(transform, used)
      const want = await onVega(spec, 'out')
      let got: ReturnType<typeof onAster>
      try {
        got = onAster(spec, 'out')
      } catch (e) {
        if (want.errors.length) { refused++; continue }
        bad.push(`${label}: aster threw ${(e as Error).message}`)
        continue
      }
      if (want.errors.length) {
        refused++
        if (!got.errors.length) bad.push(`${label}: vega logged "${want.errors[0]}" and aster logged nothing`)
        continue
      }
      compared++
      if (got.errors.length) bad.push(`${label}: aster logged ${String(got.errors[0])}`)
      else if (!rowsAreEqual(got.rows, want.rows)) bad.push(`${label}: rows differ\n  aster ${JSON.stringify(enc(got.rows)).slice(0, 300)}\n  vega  ${JSON.stringify(enc(want.rows)).slice(0, 300)}`)
    }
    expect(bad.slice(0, 5)).toEqual([])
    // not vacuous: most cases ran to a result on both sides, and every path style was drawn
    expect(compared).toBeGreaterThan(scaled(600) * 0.6)
    expect(refused).toBeLessThan(scaled(600) * 0.4)
    for (const k of [...KEYS, ...NUMS]) expect(used.has(k)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// the spec sweep: facets, encode entries, scales, sorts
// ---------------------------------------------------------------------------

const frame = (marks: unknown[], extra: Spec = {}, rows: unknown[] = []): Spec => ({
  width: 200, height: 100, padding: 5, autosize: 'pad',
  data: [{ name: 't', values: rows }],
  marks,
  ...extra,
})

/** The marks that print what a facet cell holds, so a wrong partition or datum shows in the picture. */
const cellMarks = (more: Record<string, unknown> = {}): unknown[] => [{
  type: 'text',
  from: { data: 'f' },
  encode: { update: { x: { value: 2 }, y: { signal: '4 + 3 * datum.id' }, text: { signal: 'datum.id + "|" + (parent ? parent.count : "-")' }, ...more } },
}]

const group = (facet: Spec, extra: Record<string, unknown> = {}): Spec => ({
  type: 'group',
  from: { facet: { name: 'f', data: 't', ...facet } },
  encode: { update: { width: { value: 40 }, height: { value: 20 }, fill: { value: '#eee' } } },
  marks: cellMarks(),
  ...extra,
})

const SPEC_TEMPLATES: Array<[string, (p: Pick, r: Rng) => Spec]> = [
  ['facet groupby a path', (p) => frame([group({ groupby: p.key() })])],
  ['facet groupby a list of paths', (p) => frame([group({ groupby: [p.key()] })])],
  ['facet groupby two paths', (p) => frame([group({ groupby: p.keys(2) })])],
  ['facet groupby two paths, crossed', (p) => frame([group({ groupby: p.keys(2), aggregate: { cross: true } })])],
  ['facet groupby three paths', (p) => frame([group({ groupby: p.keys(3) })])],
  ['facet aggregate over a path', (p) => frame([group({ groupby: [p.key()], aggregate: { fields: [p.num()], ops: ['sum'], as: ['total'] } }, { encode: { update: { width: { signal: 'datum.total' }, height: { value: 10 }, fill: { value: 'teal' } } } })])],
  ['facet aggregate with default names', (p) => frame([group({ groupby: [p.key()], aggregate: { fields: [p.num()], ops: ['max'] } })])],
  ['facet with a sorted group', (p) => frame([group({ groupby: [p.key()], aggregate: { fields: [p.num()], ops: ['sum'], as: ['s'] } }, { sort: { field: 'datum.s', order: 'descending' } })])],
  ['pre-faceted data from a path', (p) => frame([{
    type: 'group',
    from: { facet: { name: 'f', data: 't', field: p.arr() } },
    encode: { update: { width: { value: 40 }, height: { value: 20 }, fill: { value: '#eee' } } },
    marks: [{ type: 'rect', from: { data: 'f' }, encode: { update: { width: { field: { parent: 'id' }, mult: 3 }, height: { value: 4 }, y: { signal: 'datum.data' } } } }],
  }])],
  ['rect height from a path', (p) => frame([{ type: 'rect', from: { data: 't' }, encode: { update: { x: { field: 'id', mult: 12 }, width: { value: 8 }, y: { value: 90 }, height: { field: p.num(), mult: 2, offset: { field: p.num() } } } } }])],
  ['rect, a scaled path', (p) => frame([{ type: 'rect', from: { data: 't' }, encode: { update: { x: { field: 'id', mult: 12 }, width: { value: 8 }, y: { scale: 'y', field: p.num() }, y2: { scale: 'y', value: 0 } } } }], {
    scales: [{ name: 'y', type: 'linear', range: 'height', zero: true, domain: { data: 't', field: p.num() } }],
  })],
  ['a band scale on a path', (p) => frame([{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: p.key() }, width: { scale: 'x', band: 1 }, y: { value: 5 }, height: { field: p.num() } } } }], {
    scales: [{ name: 'x', type: 'band', range: 'width', domain: { data: 't', field: p.key(), sort: true } }],
  })],
  ['a point scale sorted by a path', (p) => frame([{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: p.key() }, y: { value: 20 } } } }], {
    scales: [{ name: 'x', type: 'point', range: 'width', domain: { data: 't', field: p.key(), sort: { op: 'sum', field: p.num() } } }],
  })],
  ['a scale over several fields', (p) => frame([{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: p.num() }, y: { scale: 'y', field: p.num() } } } }], {
    scales: [
      { name: 'x', type: 'linear', range: 'width', domain: { data: 't', fields: [p.num(), p.num()] } },
      { name: 'y', type: 'linear', range: 'height', domain: { fields: [{ data: 't', field: p.num() }, { data: 't', field: p.num() }] } },
    ],
  })],
  ['indata over a path', (p) => frame([{ type: 'text', from: { data: 't' }, encode: { update: { x: { field: 'id', mult: 12 }, y: { value: 20 }, text: { signal: `indata("t", ${JSON.stringify(p.key())}, datum.k) ? "in" : "out"` } } } }])],
  ['indata of a value over a path', (p) => frame([{ type: 'text', from: { data: 'u' }, encode: { update: { x: { field: 'id', mult: 12 }, y: { value: 20 }, text: { signal: `indata("t", ${JSON.stringify(p.key())}, ${JSON.stringify(p.pick(CATS))}) ? "in" : "out"` } } } }])],
  ['pluck over a path', (p) => frame([{ type: 'text', encode: { update: { x: { value: 5 }, y: { value: 20 }, text: { signal: `join(pluck(data("t"), ${JSON.stringify(p.key())}), ",")` } } } }])],
  ['pluck of numbers over a path', (p) => frame([{ type: 'text', encode: { update: { x: { value: 5 }, y: { value: 20 }, text: { signal: `join(pluck(data("t"), ${JSON.stringify(p.num())}), ",")` } } } }])],
  ['a mark sorted by a path', (p) => frame([{ type: 'rect', from: { data: 't' }, sort: { field: ((n: string) => (n.startsWith('[') ? 'datum' : 'datum.') + n)(p.num()), order: 'descending' }, encode: { update: { x: { field: 'id', mult: 12 }, width: { value: 8 }, y: { value: 5 }, height: { field: 'id', mult: 5 } } } }])],
  ['an ordinal color scale on a path', (p) => frame([{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'id', mult: 12 }, y: { value: 20 }, fill: { scale: 'c', field: p.key() } } } }], {
    scales: [{ name: 'c', type: 'ordinal', range: 'category', domain: { data: 't', field: p.key() } }],
  })],
]

describe('specs read field paths as vega does', () => {
  it(`${scaled(400)} generated specs render the vega picture`, { timeout: 600_000 }, async () => {
    const r = makeRng(7)
    const bad: string[] = []
    let compared = 0
    let logged = 0
    const used = new Set<string>()
    for (let c = 0; c < scaled(400); c++) {
      const [name, build] = r.pick(SPEC_TEMPLATES)
      const p: Pick = {
        key: () => (r.chance(0.05) ? r.pick(ABSENT) : r.pick(KEYS)),
        num: () => (r.chance(0.05) ? r.pick(ABSENT) : r.pick(NUMS)),
        arr: () => r.pick(ARRS),
        any: () => r.pick([...KEYS, ...NUMS]),
        keys: (n) => distinct(r, n),
        pick: (items) => r.pick(items),
      }
      const rows = Array.from({ length: r.between(3, 8) }, (_, i) => rowOf(r, i))
      const spec = build(p, r)
      ;(spec.data as Array<Spec>)[0]!.values = rows
      ;(spec.data as Array<Spec>).push({ name: 'u', values: rows.slice(0, 4) })
      stringsIn(spec.marks, used)
      stringsIn(spec.scales, used)
      const label = `${name}: ${JSON.stringify(spec.marks)} ${JSON.stringify(spec.scales ?? [])}`.slice(0, 600)
      let want: Awaited<ReturnType<typeof onVega>>
      try { want = await onVega(spec) } catch (e) { throw new Error(`${label}: ${(e as Error).message}`) }
      let got: ReturnType<typeof onAster>
      try {
        got = onAster(spec)
      } catch (e) {
        bad.push(`${label}: aster threw ${(e as Error).message}`)
        continue
      }
      compared++
      if (want.errors.length) {
        logged++
        if (!got.errors.length) bad.push(`${label}: vega logged "${want.errors[0]}" and aster logged nothing`)
        continue
      }
      if (got.errors.length) { bad.push(`${label}: aster logged ${String(got.errors[0])}`); continue }
      const d = diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg))
      if (d.length) bad.push(`${label}: ${d.slice(0, 2).join(' | ')}`)
    }
    expect(bad.slice(0, 5)).toEqual([])
    expect(compared).toBeGreaterThan(scaled(400) * 0.9)
    expect(logged).toBeLessThan(scaled(400) * 0.3)
    for (const k of [...KEYS, ...NUMS]) expect(used.has(k)).toBe(true)
  })
})

describe('the facet of the reported crash', () => {
  it('groupby a nested path renders as vega does', async () => {
    const spec = {
      data: [{ name: 't', values: [{ o: { k: 'a' }, v: 1 }, { o: { k: 'b' }, v: 2 }] }],
      marks: [{ type: 'group', from: { facet: { name: 'f', data: 't', groupby: 'o.k' } }, marks: [{ type: 'rect', from: { data: 'f' }, encode: { enter: { width: { value: 5 }, height: { field: 'v' } } } }] }],
    } as Spec
    const want = await onVega(spec)
    expect(want.errors).toEqual([])
    expect(diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(onAster(spec).svg))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// the format of a dataset: `parse` names properties, `property` is a path
// ---------------------------------------------------------------------------

describe('data formats read field paths as vega does', () => {
  it('parse names properties and property is a path, as in vega', async () => {
    const r = makeRng(99)
    const bad: string[] = []
    const kinds: string[] = ['number', 'string', 'boolean', 'date']
    const wrappers: Array<[string, (rows: unknown[]) => unknown]> = [
      ['rows', (rows) => rows],
      ['w.rows', (rows) => ({ w: { rows } })],
      ['w\\.rows', (rows) => ({ 'w.rows': rows })],
      ['w["rows"]', (rows) => ({ w: { rows } })],
      ['list[1]', (rows) => ({ list: [[], rows] })],
      ['list.1', (rows) => ({ list: [[], rows] })],
    ]
    for (let c = 0; c < scaled(150); c++) {
      const rows = Array.from({ length: r.between(2, 5) }, (_, i) => rowOf(r, i))
      const [property, wrap] = r.pick(wrappers)
      const parse: Record<string, string> = {}
      for (let j = r.between(0, 3); j > 0; j--) parse[r.pick([...NUMS, ...KEYS, 'n', 't', 'id'])] = r.pick(kinds)
      const format: Spec = { type: 'json', ...(property === 'rows' ? {} : { property }), ...(r.chance(0.7) ? { parse } : {}) }
      const spec: Spec = { data: [{ name: 'out', values: wrap(rows), format }] }
      const label = JSON.stringify(format)
      const want = await onVega(spec, 'out')
      let got: ReturnType<typeof onAster>
      try { got = onAster(spec, 'out') } catch (e) {
        if (!want.errors.length) bad.push(`${label}: aster threw ${(e as Error).message}`)
        continue
      }
      if (want.errors.length) { if (!got.errors.length) bad.push(`${label}: vega logged "${want.errors[0]}", aster nothing`); continue }
      if (got.errors.length) bad.push(`${label}: aster logged ${String(got.errors[0])}`)
      else if (!rowsAreEqual(got.rows, want.rows)) bad.push(`${label}: rows differ`)
    }
    expect(bad.slice(0, 5)).toEqual([])
  })
})
