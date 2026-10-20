/**
 * Transform option matrix (R13.3).
 *
 * The schema sweeps cover marks/scales/guides; this gate covers the data
 * transform surface, including option combinations that a corpus chart rarely
 * sets (bin tuning, every window op/frame, stack offsets/sorts,
 * joinaggregate keys, impute methods/keyvals, fold/flatten/pivot/lookup and the
 * generating transforms). Each case is rendered through real Vega and the
 * engine, canonicalized and diffed.
 */
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { renderWithVega } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

type Spec = Record<string, unknown>
const rows = [
  { c: 'a', g: 'x', v: 1, w: 4, t: '2024-01-01' },
  { c: 'a', g: 'y', v: 2, w: 3, t: '2024-02-01' },
  { c: 'b', g: 'x', v: 3, w: 2, t: '2024-03-01' },
  { c: 'b', g: 'y', v: 4, w: 1, t: '2024-04-01' },
  { c: 'c', g: 'x', v: 5, w: 0, t: '2024-05-01' },
]

function base(data: Spec[]): Spec {
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 240, height: 140, padding: 5, autosize: 'none', background: 'white',
    data,
    scales: [
      { name: 'x', type: 'linear', domain: [0, 120], range: 'width' },
      { name: 'y', type: 'linear', domain: [0, 8], range: 'height' },
      { name: 'xb', type: 'band', domain: { data: 't', field: 'c' }, range: 'width', padding: 0.1 },
    ],
    axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left' }],
  }
}

function symbol(spec: Spec, x: unknown, y: unknown): Spec {
  return { ...spec, marks: [{ type: 'symbol', from: { data: 'data_0' }, encode: { update: { x, y, size: { value: 40 }, fill: { value: 'steelblue' } } } }] }
}
function bars(spec: Spec, x: unknown, y: unknown, y2: unknown = { value: 0 }): Spec {
  return { ...spec, marks: [{ type: 'rect', from: { data: 'data_0' }, encode: { update: { x, width: { value: 8 }, y, y2, fill: { value: 'steelblue' } } } }] }
}
function tx(transform: Spec[]): Spec[] {
  return [{ name: 't', values: rows }, { name: 'data_0', source: 't', transform }]
}
function xv(field: string): unknown { return { scale: 'x', field } }
function yv(field: string): unknown { return { scale: 'y', field } }

const cases: Array<{ name: string; spec: Spec }> = []
const add = (name: string, spec: Spec): void => { cases.push({ name, spec }) }

// bin option matrix
for (const [name, opt] of Object.entries({
  maxbins: { maxbins: 5 }, step: { step: 2 }, base: { maxbins: 6, base: 10 }, divide: { maxbins: 8, divide: [5, 2] },
  minstep: { maxbins: 4, minstep: 3 }, nice: { maxbins: 5, nice: false }, anchor: { maxbins: 5, anchor: 1.5 },
  extent: { extent: [0, 10], maxbins: 5 }, interval: { maxbins: 5, interval: true },
})) {
  const t = { type: 'bin', field: 'v', extent: [0, 6], as: ['b0', 'b1'], ...opt }
  add(`bin-${name}`, bars(base(tx([t])), xv('b0'), yv('b1')))
}

// aggregate ops
for (const op of ['count', 'valid', 'missing', 'distinct', 'sum', 'mean', 'average', 'median', 'q1', 'q3', 'min', 'max', 'product', 'variance', 'stdev', 'stderr', 'values']) {
  const t = { type: 'aggregate', groupby: ['c'], fields: [null, 'v'], ops: ['count', op], as: ['n', 'a'] }
  add(`aggregate-${op}`, symbol(base(tx([t])), xv('n'), yv('a')))
}

// window ops / frames / params
for (const op of ['row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value', 'last_value', 'nth_value', 'prev_value', 'next_value', 'sum', 'mean', 'min', 'max']) {
  const t = { type: 'window', groupby: ['c'], sort: { field: 'v', order: 'ascending' }, ops: [op], fields: [op === 'row_number' || op === 'rank' || op === 'dense_rank' || op === 'percent_rank' || op === 'cume_dist' || op === 'ntile' ? null : 'v'], as: ['a'], params: op === 'ntile' ? [2] : op === 'nth_value' ? [2] : undefined }
  add(`window-${op}`, symbol(base(tx([t])), xv('v'), yv('a')))
}
for (const [name, extra] of Object.entries({
  frame: { frame: [-1, 0] }, peers: { frame: [null, 0], ignorePeers: true }, desc: { sort: { field: 'v', order: 'descending' } },
})) {
  add(`window-${name}`, symbol(base(tx([{ type: 'window', groupby: ['c'], sort: { field: 'v' }, ops: ['sum'], fields: ['v'], as: ['a'], ...extra }])), xv('v'), yv('a')))
}

// stack offsets and sorts
for (const offset of ['zero', 'center', 'normalize']) {
  for (const sort of [undefined, { field: 'v', order: 'descending' }]) {
    const t = { type: 'stack', groupby: ['c'], field: 'v', as: ['s0', 's1'], offset, ...(sort ? { sort } : {}) }
    add(`stack-${offset}${sort ? '-sorted' : ''}`, bars(base(tx([t])), { scale: 'xb', field: 'c' }, yv('s1'), yv('s0')))
  }
}

// joinaggregate keys and impute options
add('joinaggregate-key', symbol(base(tx([{ type: 'joinaggregate', groupby: ['c'], fields: ['v'], ops: ['sum'], as: ['a'], key: 'g' }])), xv('v'), yv('a')))
for (const method of ['value', 'mean', 'median', 'max', 'min']) {
  const t = { type: 'impute', field: 'v', key: 'c', groupby: ['g'], method, ...(method === 'value' ? { value: 0 } : {}) }
  add(`impute-${method}`, symbol(base(tx([t])), xv('v'), yv('w')))
}
add('impute-keyvals', symbol(base(tx([{ type: 'impute', field: 'v', key: 'c', keyvals: ['a', 'b', 'c', 'd'], method: 'value', value: 0 }])), xv('v'), yv('w')))

// shaping transforms
add('fold', symbol(base(tx([{ type: 'fold', fields: ['v', 'w'], as: ['key', 'value'] }])), { scale: 'xb', field: 'key' }, yv('value')))
add('flatten', symbol(base(tx([{ type: 'formula', expr: '[datum.v, datum.w]', as: 'arr' }, { type: 'flatten', fields: ['arr'] }])), xv('v'), yv('w')))
add('pivot', bars(base(tx([{ type: 'pivot', field: 'c', value: 'v', groupby: ['g'] }])), { scale: 'xb', field: 'g' }, yv('a'), yv('b')))
add('lookup', symbol(base([
  { name: 't', values: rows },
  { name: 'keys', values: [{ c: 'a', label: 10 }, { c: 'b', label: 20 }, { c: 'c', label: 30 }] },
  { name: 'data_0', source: 't', transform: [{ type: 'lookup', from: 'keys', key: 'c', fields: ['c'], as: ['label'] }] },
]), xv('v'), yv('label')))
add('sequence', symbol(base(tx([{ type: 'sequence', start: 0, stop: 10, step: 2, as: 'v' }])), xv('v'), { value: 60 }))
add('identifier', symbol(base(tx([{ type: 'identifier', as: 'id' }])), xv('v'), yv('id')))
add('extent', symbol(base(tx([{ type: 'extent', field: 'v', signal: 'vext' }])), xv('v'), { signal: 'vext[0]' }))
add('timeunit', symbol(base(tx([{ type: 'timeunit', field: 't', units: ['year', 'month'], as: ['t0', 't1'] }])), xv('v'), yv('w')))
add('filter-formula', symbol(base(tx([{ type: 'formula', expr: 'datum.v * 2', as: 'd' }, { type: 'filter', expr: 'datum.d > 2' }])), xv('v'), yv('d')))

async function run(spec: Spec): Promise<{ pass: boolean; diffs: string[]; error?: string }> {
  try {
    const [oracleSvg, ours] = await Promise.all([renderWithVega(spec), Promise.resolve(renderSpec(spec as never))])
    const diffs = diffCanonical(canonicalizeSvg(oracleSvg), canonicalizeSvg(ours))
    return { pass: diffs.length === 0, diffs }
  } catch (e) {
    return { pass: false, diffs: [], error: e instanceof Error ? e.message : String(e) }
  }
}

const argv = process.argv.slice(2)
const filterIdx = argv.indexOf('--filter')
const filter = filterIdx >= 0 ? argv[filterIdx + 1]! : ''
let pass = 0
const fail: string[] = []
for (const c of cases) {
  if (filter && !c.name.includes(filter)) continue
  const r = await run(c.spec)
  if (r.pass) pass++
  else {
    fail.push(c.name)
    console.log(`FAIL  ${c.name}${r.error ? `  (${r.error})` : ''}`)
    for (const d of r.diffs.slice(0, 4)) console.log(`      ${d}`)
  }
}
const total = cases.filter((c) => !filter || c.name.includes(filter)).length
console.log(`\n[transforms] ${pass}/${total} transform cases match`)
if (fail.length) console.log(`[transforms] failing: ${fail.join(', ')}`)
process.exit(fail.length ? 1 : 0)
