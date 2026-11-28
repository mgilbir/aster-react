// the point-selection and brush cases in a view that fits its container (`width: "container"`, measuredSize, as <Chart> does)
// Usage: node packages/benchmarks/scripts/probes/selection-fit.mjs <worktree>
import { treeRoot } from './tree-root.mjs'
const R = treeRoot()
const { compile } = await import(R + '/packages/vl/dist/index.js')
const { createChartSession } = await import(R + '/packages/core/dist/addon-dom.js')
const N = 5000
const rows = Array.from({ length: N }, (_, i) => ({ a: i, b: (i * 7919) % 1000, c: `k${i % 5}` }))
const marksOf = (sc) => { const out = new Map(); const w = (n) => { for (const g of n.items ?? []) { if (g.role === 'mark' && g.name) out.set(g.name, g); w(g) } }; w(sc); return out }
function diff(a, b) {
  const ma = marksOf(a), mb = marksOf(b); const marks = {}
  for (const [n, g] of mb) { const p = ma.get(n); marks[n] = `${p === g ? 'G' : '-'}${p ? g.items.filter((it, i) => it === p.items?.[i]).length : 0}/${g.items.length}` }
  const sa = a.__scaleMap, sb = b.__scaleMap
  return { marks, scales: `[${[...sb.keys()].filter((k) => sa.get(k) === sb.get(k)).sort()}] of ${sb.size}` }
}
function run(name, spec, inputs, reps = 30) {
  const s = createChartSession(); let prev = s.evaluate(spec, inputs(0)); prev = s.evaluate(spec, inputs(1)); const times = []; let last
  for (let k = 2; k < reps + 2; k++) { const t0 = performance.now(); const sc = s.evaluate(spec, inputs(k)); times.push(performance.now() - t0); last = diff(prev, sc); prev = sc }
  times.sort((x, y) => x - y)
  console.log(`${name.padEnd(24)} median ${times[times.length >> 1].toFixed(2).padStart(6)} ms  scales kept ${last.scales}  marks ${JSON.stringify(last.marks)}`)
}
const enc = (p) => ({ x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' }, opacity: { condition: { param: p, value: 1 }, value: 0.3 } })
const hov = compile({ width: 'container', height: 300, data: { name: 'src' }, params: [{ name: 'hover', select: { type: 'point', on: 'pointerover' } }, { name: 'unused', value: 1 }], mark: 'point', encoding: enc('hover') })
const br = compile({ width: 'container', height: 300, data: { name: 'src' }, params: [{ name: 'brush', select: 'interval' }, { name: 'unused', value: 1 }], mark: 'point', encoding: enc('brush') })
const size = { measuredSize: { width: 640, height: 300 } }
const tup = (i) => ({ unit: '', fields: [{ type: 'E', field: '_vgsid_' }], values: [i + 1] })
const bf = br.signals.find((s) => s.name === 'brush_tuple_fields').value
const bt = [{ unit: '', fields: bf, values: [[1000, 2000], [0, 500]] }]
run('fit hover:unread', hov, (k) => ({ data: { src: rows, hover_store: [tup(9)] }, signals: { unused: k }, ...size }))
run('fit hover:move', hov, (k) => ({ data: { src: rows, hover_store: [tup(k % 50)] }, signals: { unused: 1 }, ...size }))
run('fit brush:unread', br, (k) => ({ data: { src: rows, brush_store: bt.slice() }, signals: { unused: k }, ...size }))
let cur = rows.slice()
const app = (k) => { if (k > 0) cur = cur.concat([{ a: (k * 37) % N + 0.5, b: (k * 31) % 990 + 1, c: 'k0' }]); return cur }
run('fit hover:append+unread', hov, (k) => ({ data: { src: app(k), hover_store: [tup(9)] }, signals: { unused: k }, ...size }))
cur = rows.slice()
run('fit brush:append+unread', br, (k) => ({ data: { src: app(k), brush_store: bt.slice() }, signals: { unused: k }, ...size }))
