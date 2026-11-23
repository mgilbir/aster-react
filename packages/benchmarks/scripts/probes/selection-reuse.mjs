// node packages/benchmarks/scripts/probes/selection-reuse.mjs <worktree> [case...]  -- measures cost and reuse by identity for the three cases of perf/selection-signal-reuse
import { treeRoot } from './tree-root.mjs'
const R = treeRoot()
const only = process.argv.slice(3)
const { compile } = await import(R + '/packages/vl/dist/index.js')
const { createChartSession } = await import(R + '/packages/core/dist/addon-dom.js')
const N = 5000
const rows = Array.from({ length: N }, (_, i) => ({ a: i, b: (i * 7919) % 1000, c: `k${i % 5}` }))
const marksOf = (sc) => { const out = new Map(); const w = (n) => { for (const g of n.items ?? []) { if (g.role === 'mark' && g.name) out.set(g.name, g); w(g) } }; w(sc); return out }
const scalesOf = (sc) => sc.__scaleMap
function diff(a, b) {
  const ma = marksOf(a), mb = marksOf(b)
  const marks = {}
  for (const [n, g] of mb) {
    const p = ma.get(n)
    const items = g.items ?? []
    const same = p ? items.filter((it, i) => it === p.items?.[i]).length : 0
    marks[n] = `${p === g ? 'G' : '-'}${same}/${items.length}`
  }
  const sa = scalesOf(a), sb = scalesOf(b)
  const scales = [...sb.keys()].filter((k) => sa.get(k) === sb.get(k)).sort().join(',')
  return { marks, scales: `[${scales}] of ${sb.size}` }
}
function scatter(params, cond, extra = {}) {
  return compile({ width: 400, height: 300, data: { name: 'src' }, params: [...params, { name: 'unused', value: 1 }], mark: 'point',
    encoding: { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' }, color: { condition: { ...cond, field: 'c', type: 'nominal' }, value: 'grey' }, ...extra } })
}
const sig = (spec, n) => spec.signals.find((s) => s.name === n)?.value
function run(name, spec, inputs, reps = 40) {
  if (only.length && !only.includes(name)) return
  const s = createChartSession()
  let prev = s.evaluate(spec, inputs(0))
  prev = s.evaluate(spec, inputs(1))
  const times = []
  let last
  for (let k = 2; k < reps + 2; k++) {
    const inp = inputs(k)
    const t0 = performance.now(); const sc = s.evaluate(spec, inp); times.push(performance.now() - t0)
    last = diff(prev, sc)
    prev = sc
  }
  times.sort((x, y) => x - y)
  console.log(`${name.padEnd(22)} median ${times[times.length >> 1].toFixed(2).padStart(6)} ms  p90 ${times[Math.floor(times.length * 0.9)].toFixed(2).padStart(6)}  scales kept ${last.scales}  marks ${JSON.stringify(last.marks)}`)
}

// 1. point selection (click): an unread signal changes; the store stays
const point = scatter([{ name: 'pick', select: { type: 'point', on: 'click' } }], { param: 'pick' })
const pickTuple = (i) => ({ unit: '', fields: [{ type: 'E', field: '_vgsid_' }], values: [i + 1] })
run('point:unread', point, (k) => ({ data: { src: rows, pick_store: [] }, signals: { unused: k } }))
run('point:unread+sel', point, (k) => ({ data: { src: rows, pick_store: [pickTuple(7)] }, signals: { unused: k } }))
// a click on another point: the store changes (a new array each time, as the event loop makes it)
run('point:click', point, (k) => ({ data: { src: rows, pick_store: [pickTuple(k % 50)] }, signals: { unused: 1 } }))
// 1b. hover (pointerover) point selection: the store holds the same tuple while the pointer stays (a new array, equal rows)
const hover = scatter([{ name: 'hover', select: { type: 'point', on: 'pointerover' } }], { param: 'hover', empty: false })
run('hover:same', hover, (k) => ({ data: { src: rows, hover_store: [pickTuple(9)] }, signals: { unused: k } }))
run('hover:move', hover, (k) => ({ data: { src: rows, hover_store: [pickTuple(k % 50)] }, signals: { unused: 1 } }))

// 2. interval brush highlighting by condition
const brush = scatter([{ name: 'brush', select: 'interval' }], { param: 'brush' })
const bf = sig(brush, 'brush_tuple_fields')
const brushTuple = (lo, hi) => ({ unit: '', fields: bf, values: [[lo, hi], [0, 500]] })
const bx = (lo, hi) => ({ brush_x: [lo * 400 / N, hi * 400 / N], brush_y: [0, 150], brush_a: [lo, hi], brush_b: [0, 500] })
run('brush:unread', brush, (k) => ({ data: { src: rows, brush_store: [brushTuple(1000, 2000)] }, signals: { unused: k, ...bx(1000, 2000) } }))
run('brush:drag', brush, (k) => ({ data: { src: rows, brush_store: [brushTuple(1000 + k * 10, 2000 + k * 10)] }, signals: { unused: 1, ...bx(1000 + k * 10, 2000 + k * 10) } }))

// 3. data appended while a signal changes (a stream with a signal moving: the session infers the pulse)
const plain = compile({ width: 400, height: 300, data: { name: 'src' }, params: [{ name: 'unused', value: 1 }, { name: 'sz', value: 30, bind: { input: 'range', min: 10, max: 100 } }], mark: { type: 'point', size: { expr: 'sz' } },
  encoding: { x: { field: 'a', type: 'quantitative', scale: { domain: [0, 2 * N] } }, y: { field: 'b', type: 'quantitative', scale: { domain: [0, 1000] } } } })
{
  let cur = rows.slice()
  const app = (k) => { if (k > 0) { cur = cur.concat([{ a: (k * 37) % N + 0.5, b: (k * 31) % 990 + 1, c: "k0" }]) } return cur }
  run('append:alone', plain, (k) => ({ data: { src: app(k) }, signals: { unused: 1, sz: 30 } }))
  cur = rows.slice()
  run('append+unread', plain, (k) => ({ data: { src: app(k) }, signals: { unused: k, sz: 30 } }))
  cur = rows.slice()
  run('append+read', plain, (k) => ({ data: { src: app(k) }, signals: { unused: 1, sz: 30 + (k % 2) } }))
  // the same through an explicit pulse (a ChartStream-like caller)
  cur = rows.slice()
  let len = N
  const pulseIn = (k, unused) => { const base = cur.length; const d = app(k); return k > 0 ? { data: { src: d }, dataPulse: { src: { appendOnly: true, baseLength: base } }, signals: { unused, sz: 30 } } : { data: { src: d }, signals: { unused, sz: 30 } } }
  run('append:pulse', plain, (k) => pulseIn(k, 1))
  cur = rows.slice()
  run('append:pulse+unread', plain, (k) => pulseIn(k, k))
  // a point-selection chart, rows appended while a hover moves (the store changes too)
  cur = rows.slice()
  run('append+hover', hover, (k) => ({ data: { src: app(k), hover_store: [pickTuple(k % 50)] }, signals: { unused: 1 } }))
  cur = rows.slice()
  run('append+unread(hover)', hover, (k) => ({ data: { src: app(k), hover_store: [pickTuple(9)] }, signals: { unused: k } }))
}
{
  let cur = rows.slice()
  const app = (k) => { if (k > 0) { cur = cur.concat([{ a: (k * 37) % N + 0.5, b: (k * 31) % 990 + 1, c: "k0" }]) } return cur }
  run('append-only(hover)', hover, (k) => ({ data: { src: app(k), hover_store: [pickTuple(9)] }, signals: { unused: 1 } }))
  cur = rows.slice()
  run('append-only(brush)', brush, (k) => ({ data: { src: app(k), brush_store: [brushTuple(1000, 2000)] }, signals: { unused: 1, ...bx(1000, 2000) } }))
}
// 3b. selection specs whose scales a data change can keep (no discrete data-driven scale: an append keeps x and y by their census)
{
  const enc = (p) => ({ x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' }, opacity: { condition: { param: p, value: 1 }, value: 0.3 } })
  const hov = compile({ width: 400, height: 300, data: { name: 'src' }, params: [{ name: 'hover', select: { type: 'point', on: 'pointerover' } }, { name: 'unused', value: 1 }], mark: 'point', encoding: enc('hover') })
  const br = compile({ width: 400, height: 300, data: { name: 'src' }, params: [{ name: 'brush', select: 'interval' }, { name: 'unused', value: 1 }], mark: 'point', encoding: enc('brush') })
  let cur = rows.slice()
  const app = (k) => { if (k > 0) { cur = cur.concat([{ a: (k * 37) % N + 0.5, b: (k * 31) % 990 + 1, c: 'k0' }]) } return cur }
  const edit = (k) => { if (k > 0) { cur = cur.slice(); const i = (k * 97) % N; cur[i] = { ...cur[i], b: (cur[i].b + 1) % 990 + 1 } } return cur }
  const hs = [pickTuple(9)]
  run('3b:hover append', hov, (k) => ({ data: { src: app(k), hover_store: hs.slice() }, signals: { unused: 1 } }))
  cur = rows.slice()
  run('3b:hover append+unread', hov, (k) => ({ data: { src: app(k), hover_store: hs.slice() }, signals: { unused: k } }))
  cur = rows.slice()
  run('3b:hover edit+unread', hov, (k) => ({ data: { src: edit(k), hover_store: hs.slice() }, signals: { unused: k } }))
  const bs = [brushTuple(1000, 2000)]
  cur = rows.slice()
  run('3b:brush append', br, (k) => ({ data: { src: app(k), brush_store: bs.slice() }, signals: { unused: 1, ...bx(1000, 2000) } }))
  cur = rows.slice()
  run('3b:brush append+unread', br, (k) => ({ data: { src: app(k), brush_store: bs.slice() }, signals: { unused: k, ...bx(1000, 2000) } }))
  cur = rows.slice()
  run('3b:brush edit+unread', br, (k) => ({ data: { src: edit(k), brush_store: bs.slice() }, signals: { unused: k, ...bx(1000, 2000) } }))
}
