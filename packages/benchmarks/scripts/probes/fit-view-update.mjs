// One-row updates on a 10k-point symbol chart: a fixed size (control), a measured container (fit), and a Vega-Lite
// `width/height: "container"` spec (fit). Usage: node packages/benchmarks/scripts/probes/fit-view-update.mjs <worktree> [rounds]
import { treeRoot } from './tree-root.mjs'
const W = treeRoot()
const ROUNDS = Number(process.argv[3] ?? 3)
const { createChartSession } = await import(W + '/packages/core/dist/addon-dom.js')
const { compile } = await import(W + '/packages/vl/dist/index.js')
const N = 10000
const rows = Array.from({ length: N }, (_, i) => ({ x: i, y: Math.sin(i / 50) * 100 + 200 }))
const spec = { width: 600, height: 300, padding: 5, data: [{ name: 't' }],
  scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' }, { name: 'y', type: 'linear', domain: { data: 't', field: 'y' }, range: 'height', nice: true }],
  axes: [{ orient: 'bottom', scale: 'x' }, { orient: 'left', scale: 'y' }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 4 } } } }] }
const vlOut = compile({ $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 'container', height: 'container',
  data: { name: 't' }, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } } })
const vlSpec = vlOut.spec ?? vlOut
const vlFixed = compile({ $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 600, height: 300,
  data: { name: 't' }, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } } })
function run(sp, size, ds) {
  const s = createChartSession()
  let cur = rows.slice()
  s.evaluate(sp, { data: { [ds]: cur }, ...size })
  const times = []
  let dims
  for (let k = 0; k < 40; k++) {
    const i = (k * 97) % N
    cur = cur.slice(); cur[i] = { x: i, y: 150 + (k % 7) } // inside the y domain: scales unchanged
    const t0 = performance.now()
    const scene = s.evaluate(sp, { data: { [ds]: cur }, dataChanges: { [ds]: [i] }, ...size })
    times.push(performance.now() - t0)
    if (k === 0) dims = `${scene.width}x${scene.height}`
  }
  times.sort((a, b) => a - b)
  return `median ${times[20].toFixed(2)} ms  p90 ${times[36].toFixed(2)} ms  (${dims})`
}
const vlData = (vlSpec.data ?? []).find((d) => d.name === 't') ? 't' : (vlSpec.data?.[0]?.name)
for (let r = 0; r < ROUNDS; r++) {
  console.log('fixed   ', run(spec, { width: 600, height: 300 }, 't'))
  console.log('measured', run(spec, { measuredSize: { width: 600, height: 300 } }, 't'))
  console.log('vl-fixed', run(vlFixed, {}, 't'))
  console.log('vl-cont ', run(vlSpec, { containerSize: { width: 600, height: 300 } }, vlData))
}
