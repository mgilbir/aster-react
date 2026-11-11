/**
 * Generated charts for the kept-steps differential (dataset-reuse.test.ts): specs that mix steps reading the size, steps reading
 * signals, steps that publish signals, ids, crossfilters and steps that draw, over datasets that read each other.
 */
import { compileChart } from './compiler.js'
import { datasetsOfScene } from './runtime.js'
import { evaluateChart } from './evaluate.js'
import { renderSceneToSvg } from './index.js'
import { contentKey } from './random-tape.js'
import type { SceneRoot, VgSpec } from './types.js'

export type Row = Record<string, unknown>

/** What an evaluation made, as text that tells `NaN`, `Infinity` and `undefined` apart: the datasets, the signals, the drawing. */
export function made(scene: SceneRoot): string {
  const datasets: Record<string, string> = {}
  for (const [name, rows] of datasetsOfScene(scene)) datasets[name] = contentKey(rows)
  const signals = (scene as unknown as { signalParams: Record<string, unknown> }).signalParams
  return JSON.stringify({ datasets, signals: contentKey(signals), svg: renderSceneToSvg(scene) })
}

export const rowsOf = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: i, g: i % 4, x: (i * 7) % 13, v: (i * 5) % 11 }))

export function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export const pick = <T,>(r: () => number, a: readonly T[]): T => a[Math.floor(r() * a.length)]!

export interface Gen { spec: VgSpec; draws: boolean; text: string }

/** The fields a pipeline's rows hold, so each generated step reads one that exists. */
interface Shape { numeric: string[]; any: string[] }

/**
 * A generated step: its transform, the fields it leaves, and the signals it publishes. `reads` names what it needs of the rows.
 */
function genStep(r: () => number, shape: Shape, dataset: string, index: number, published: string[], filters: string[], dense: boolean): { t: Record<string, unknown>; shape: Shape; draws?: boolean; publishes?: string; crossfilter?: boolean } {
  const num = (): string => pick(r, shape.numeric)
  const out = (base: string): string => `${base}_${dataset}${index}`
  const kinds = ['formulaWidth', 'formulaSignal', 'formulaPure', 'filterSignal', 'binFixed', 'binSignal', 'binExtent', 'aggregate', 'collect', 'identifier', 'extent', 'window', 'project', 'stack', 'formulaRandom', 'sample', 'impute', 'crossfilter', 'resolvefilter', 'filterCount', 'formulaPool', 'formulaPool', 'binPool', 'formulaPositions', 'filterPositions', 'filterData']
  const kind = dense ? pick(r, ['formulaPool', 'binPool', 'formulaPool', 'binPool', 'formulaWidth', 'formulaSignal']) : pick(r, kinds)
  const keep = shape.any
  switch (kind) {
    case 'formulaWidth': { const as = out('fw'); return { t: { type: 'formula', as, expr: `datum.${num()} * width / 100` }, shape: { numeric: [...shape.numeric, as], any: [...keep, as] } } }
    case 'formulaSignal': { const as = out('fs'); return { t: { type: 'formula', as, expr: `datum.${num()} + ${pick(r, ['sigA', 'sigB', 'sigA * sigB'])}` }, shape: { numeric: [...shape.numeric, as], any: [...keep, as] } } }
    case 'formulaPure': { const as = out('fp'); return { t: { type: 'formula', as, expr: `abs(datum.${num()} - 3) + 1` }, shape: { numeric: [...shape.numeric, as], any: [...keep, as] } } }
    case 'filterSignal': return { t: { type: 'filter', expr: `datum.${num()} >= ${pick(r, ['thr', 'sigA - 2', '1'])}` }, shape }
    case 'binFixed': { const a = out('bf'); return { t: { type: 'bin', field: num(), extent: [0, 14], step: pick(r, [1, 2, 3]), as: [a, `${a}e`] }, shape: { numeric: [...shape.numeric, a, `${a}e`], any: [...keep, a, `${a}e`] } } }
    case 'binSignal': { const a = out('bs'); return { t: { type: 'bin', field: num(), extent: [0, 14], step: { signal: 'sigB' }, as: [a, `${a}e`] }, shape: { numeric: [...shape.numeric, a, `${a}e`], any: [...keep, a, `${a}e`] } } }
    case 'binExtent': {
      const a = out('be')
      const sig = published.length ? pick(r, published) : undefined
      return { t: { type: 'bin', field: num(), extent: sig ? { signal: sig } : [0, 14], maxbins: pick(r, [3, 5, 8]), signal: out('binfo'), as: [a, `${a}e`] }, shape: { numeric: [...shape.numeric, a, `${a}e`], any: [...keep, a, `${a}e`] }, publishes: out('binfo') }
    }
    case 'aggregate': { const s = out('ag'); return { t: { type: 'aggregate', groupby: [pick(r, shape.any)], fields: [num()], ops: [pick(r, ['sum', 'max', 'mean'])], as: [s] }, shape: { numeric: [s], any: [s] } } }
    case 'collect': return { t: { type: 'collect', sort: { field: num(), order: pick(r, ['ascending', 'descending']) } }, shape }
    case 'identifier': { const as = out('id'); return { t: { type: 'identifier', as }, shape: { numeric: [...shape.numeric, as], any: [...keep, as] } } }
    case 'extent': { const sig = out('ext'); return { t: { type: 'extent', field: num(), signal: sig }, shape, publishes: sig } }
    case 'window': { const as = out('wn'); return { t: { type: 'window', sort: { field: num() }, ops: ['row_number'], as: [as] }, shape: { numeric: [...shape.numeric, as], any: [...keep, as] } } }
    case 'project': { const f = num(); return { t: { type: 'project', fields: [f], as: [out('pj')] }, shape: { numeric: [out('pj')], any: [out('pj')] } } }
    case 'stack': { const as = out('st'); return { t: { type: 'stack', field: num(), groupby: [], as: [as, `${as}e`] }, shape: { numeric: [...shape.numeric, as, `${as}e`], any: [...keep, as, `${as}e`] } } }
    case 'formulaRandom': { const as = out('rn'); return { t: { type: 'formula', as, expr: pick(r, ['random()', 'sampleNormal(0, 1)']) }, shape: { numeric: [...shape.numeric, as], any: [...keep, as] }, draws: true } }
    case 'sample': return { t: { type: 'sample', size: pick(r, [5, 12]) }, shape, draws: true }
    case 'impute': { const f = num(); return { t: { type: 'impute', field: f, key: pick(r, shape.any), value: 0 }, shape } }
    // (a signal that reads a dataset resolves after it is built: the datasets build again under it)
    case 'filterCount': return { t: { type: 'filter', expr: `datum.${num()} >= (cnt > 20 ? 1 : 0)` }, shape }
    // (fields from a small pool, so steps read and write each other's: a chain of them is where running steps as one could go wrong)
    case 'formulaPool': { const as = pick(r, ['p', 'q', 'x']); return { t: { type: 'formula', as, expr: `datum.${pick(r, ['p', 'q', 'x', 'v'])} + ${pick(r, ['1', 'datum.q', 'sigA', 'datum.p * 2'])}` }, shape: { numeric: [...shape.numeric, as], any: [...keep, as] } } }
    case 'binPool': { const a = pick(r, ['p', 'q']); return { t: { type: 'bin', field: pick(r, ['p', 'q', 'x', 'v']), ...(r() < 0.5 ? { extent: [0, 14], step: pick(r, [1, 2]) } : { maxbins: pick(r, [4, 8]) }), as: [a, pick(r, ['q', 'x', 'p'])] }, shape: { numeric: [...shape.numeric, a], any: [...keep, a] } } }
    // (a signal in each position of an expression: both branches and the test of a conditional, a call argument at depth, an array or
    // object literal value, either side of a short-circuit, a computed member)
    case 'formulaPositions': {
      const as = out('fx'); const f = num()
      const expr = pick(r, [`datum.${f} > 3 ? sigA : 0`, `datum.${f} > 3 ? 0 : sigB`, `sigA > 3 ? datum.${f} : 1`, `abs(max(1, min(50, floor(sigA * datum.${f}))))`, `[1, sigB][1] + datum.${f}`, `({a: sigA}).a + datum.${f}`, `datum.${f} > 100 || sigB`, `sigA && datum.${f}`, `[datum.${f}, sigA, sigB][sigB % 3]`, `datum[sigA > 3 ? 'x' : 'v']`])
      return { t: { type: 'formula', as, expr }, shape: { numeric: [...shape.numeric, as], any: [...keep, as] } }
    }
    case 'filterPositions': return { t: { type: 'filter', expr: pick(r, [`datum.${num()} > (sigA > 3 ? thr : 0)`, `datum.${num()} >= (sigB > 1 ? 0 : thr)`, `[thr, sigA][sigB % 2] <= datum.${num()}`]) }, shape }
    // (a step that reads the rows of the first dataset by name: it is kept while they are equal)
    case 'filterData': {
      if (dataset === 't') return { t: { type: 'filter', expr: `datum.${num()} >= 0` }, shape }
      return { t: { type: 'filter', expr: pick(r, [`datum.${num()} * 4 >= length(data('t'))`, `indata('t', 'x', datum.${num()}) || datum.${num()} > 6`]) }, shape }
    }
    case 'crossfilter': { const sig = out('xf'); return { t: { type: 'crossfilter', signal: sig, fields: [num(), num()], query: [{ signal: 'rangeA' }, { signal: 'rangeB' }] }, shape, publishes: sig, crossfilter: true } }
    case 'resolvefilter': {
      if (!filters.length) return { t: { type: 'filter', expr: `datum.${num()} >= 0` }, shape }
      return { t: { type: 'resolvefilter', filter: { signal: pick(r, filters) }, ignore: pick(r, [0, 1, 2]) }, shape }
    }
    default: { const as = out('fl'); return { t: { type: 'formula', as, expr: `datum.${num()} * 2` }, shape: { numeric: [...shape.numeric, as], any: [...keep, as] } } }
  }
}

export function genSpec(seed: number): Gen {
  const r = mulberry32(seed)
  const published: string[] = []
  const filters: string[] = []
  let draws = false
  const base: Shape = { numeric: ['x', 'v'], any: ['x', 'v', 'g'] }
  const data: Array<Record<string, unknown>> = []
  const marks: unknown[] = []
  const names = ['t']
  const datasetCount = 1 + Math.floor(r() * 3)
  for (let d = 0; d < datasetCount; d++) {
    const name = d === 0 ? 't' : `d${d}`
    let shape = base
    if (d > 0) names.push(name)
    const transform: Array<Record<string, unknown>> = []
    // (some datasets are chains of the steps that write fields, which is where running steps as one has to be careful)
    const dense = r() < 0.35
    const steps = dense ? 2 + Math.floor(r() * 4) : 1 + Math.floor(r() * 5)
    for (let i = 0; i < steps; i++) {
      const s = genStep(r, shape, name, i, published, filters, dense)
      transform.push(s.t)
      shape = s.shape
      if (s.draws) draws = true
      if (s.crossfilter) filters.push(s.publishes!)
      else if (s.publishes) published.push(s.publishes)
    }
    // (a dataset after the first may be derived from an earlier one; it then reads that one's fields, so it starts from its own)
    const pickSource = (): string | string[] => d > 1 && r() < 0.25 ? names.slice(0, 2) : pick(r, names.slice(0, d))
    const source = d > 0 && r() < 0.5 ? pickSource() : undefined
    data.push({ name, ...(source ? { source } : {}), transform })
    if (source) { /* the fields it starts from are the source's, which the generator does not track: only the shared ones are read */ }
    marks.push({ type: 'symbol', from: { data: name }, encode: { update: { x: { field: shape.numeric[0] }, y: { field: shape.numeric[shape.numeric.length - 1] } } } })
  }
  // Group scopes with datasets of their own, derived from the datasets of the view (the shape of a cross-filtered histogram)
  for (let gi = 0, groups = r() < 0.5 ? 1 + Math.floor(r() * 2) : 0; gi < groups; gi++) {
    const gname = `g${gi}`
    let shape = base
    const transform: Array<Record<string, unknown>> = []
    for (let i = 0, n = 1 + Math.floor(r() * 3); i < n; i++) {
      const s = genStep(r, shape, gname, i, [], filters, r() < 0.3)
      transform.push(s.t)
      shape = s.shape
      if (s.draws) draws = true
    }
    marks.push({
      type: 'group', data: [{ name: gname, source: pick(r, names), transform }],
      marks: [{ type: 'symbol', from: { data: gname }, encode: { update: { x: { field: shape.numeric[0] }, y: { field: shape.numeric[shape.numeric.length - 1] } } } }],
    })
  }
  // A derived dataset starts from its source's fields, not the base ones: regenerate those so every step reads a field that exists.
  const spec = {
    width: 200, height: 100, autosize: 'none',
    signals: [
      { name: 'sigA', value: 3 }, { name: 'sigB', value: 2 }, { name: 'thr', value: 2 },
      { name: 'cnt', update: "length(data('t'))" }, { name: 'rangeA', update: '[sigA - 3, sigA + 4]' }, { name: 'rangeB', update: '[thr - 2, thr + 6]' },
      ...published.map((p, i) => ({ name: `sum${i}`, update: `isArray(${p}) ? ${p}[0] : 0` })),
    ],
    data, marks,
  } as unknown as VgSpec
  return { spec, draws, text: JSON.stringify(spec) }
}

/** A generated spec whose derived datasets are only kept when their sources hold the fields they read: others are dropped. */
export function usable(g: Gen, rows: Row[]): boolean {
  try { evaluateChart(compileChart(g.spec), { data: { t: rows }, random: mulberry32(1) }); return true } catch { return false }
}

