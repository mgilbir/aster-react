// A Vega-Lite `time` animation over 3,000 points through createChartSession().evaluate with only the clock advanced per tick: median ms per
// tick and how many items of the first mark are kept by identity. Usage: node packages/benchmarks/scripts/probes/time-tick.mjs <worktree>
import { treeRoot } from './tree-root.mjs'
const R = treeRoot()
const { compile } = await import(R + '/packages/vl/dist/index.js')
const { createChartSession } = await import(R + '/packages/core/dist/addon-dom.js')
const rows = [1990, 1991, 1992].flatMap((year) => Array.from({ length: 1000 }, (_, i) => ({ year, x: i, y: (i * 7 + year) % 100 })))
const spec = compile({ width: 400, height: 200, data: { name: 'src', values: rows },
  params: [{ name: 'anim', select: { type: 'point', on: 'timer', fields: ['year'] } }],
  transform: [{ filter: { param: 'anim' } }], mark: 'point',
  encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' }, time: { field: 'year', type: 'ordinal' } } })
const s = createChartSession()
const marks = (sc) => { const out = []; const w = (n) => { for (const g of n.items ?? []) { if (g.role === 'mark') out.push(g); w(g) } }; w(sc); return out }
const store = spec.data.find((d) => /_store$/.test(d.name))?.name
console.log('store dataset:', store, 'signals with clock:', spec.signals.filter((x) => /clock|anim_value/.test(x.name)).map((x) => x.name).join(','))
const sigs = (clock) => ({ anim_clock: clock })
const a = s.evaluate(spec, { signals: sigs(10) })
const t0 = performance.now(); const b = s.evaluate(spec, { signals: sigs(26) }); const dt = performance.now() - t0
const ma = marks(a), mb = marks(b)
console.log('root same:', a === b, ' marks:', ma.length, ' same mark groups:', ma.filter((g, i) => g === mb[i]).length, ' same items arrays:', ma.filter((g, i) => g.items === mb[i]?.items).length, ' items in marks:', mb.map((g) => g.items.length).join('/'), ' eval ms', dt.toFixed(2))
const sameItems = (x, y) => x.items.filter((it, i) => it === y.items[i]).length
let prev = b, times = []
for (let k = 0; k < 30; k++) {
  const t = performance.now(); const c = s.evaluate(spec, { signals: sigs(30 + k * 16) }); times.push(performance.now() - t)
  if (k === 29) console.log('tick 30: same items', sameItems(marks(prev)[0], marks(c)[0]), 'of', marks(c)[0].items.length)
  prev = c
}
times.sort((x, y) => x - y); console.log('warm tick eval median', times[15].toFixed(2), 'ms, p90', times[27].toFixed(2))
// control: the same spec at fixed signals, data unchanged: what an evaluation with nothing new costs
const t1 = performance.now(); const d = s.evaluate(spec, { signals: sigs(30 + 29 * 16) }); console.log('identical inputs again:', (performance.now() - t1).toFixed(2), 'ms, same root', d === prev)
