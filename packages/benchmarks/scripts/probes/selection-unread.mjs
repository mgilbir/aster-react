// The controls of the selection probes: a point and a brush selection, evaluated while a param no mark reads changes. Median ms and items kept by identity.
// Usage: node packages/benchmarks/scripts/probes/selection-unread.mjs <worktree>
import { treeRoot } from './tree-root.mjs'
const R = treeRoot()
const { compile } = await import(R + '/packages/vl/dist/index.js')
const { createChartSession } = await import(R + '/packages/core/dist/addon-dom.js')
const N = 5000
const rows = Array.from({ length: N }, (_, i) => ({ x: i % 500, y: (i * 37) % 400, c: 'k' + (i % 5) }))
const base = (params, color) => compile({ width: 500, height: 300, data: { name: 'src' }, params: [...params, { name: 'u', value: 0 }],
  mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' }, color } })
const specs = {
  brush: base([{ name: 'brush', select: 'interval' }], { condition: { param: 'brush', value: 'red' }, value: 'grey' }),
  point: base([{ name: 'pick', select: { type: 'point', on: 'click' } }], { condition: { param: 'pick', value: 'red' }, value: 'grey' }),
}
const marks = (sc) => { const o = []; const w = (n) => { for (const g of n.items ?? []) { if (g.role === 'mark' && g.marktype === 'symbol') o.push(g); w(g) } }; w(sc); return o }
const med = (t) => (t.sort((a, b) => a - b), t[Math.floor(t.length / 2)].toFixed(2))
for (const [name, spec] of Object.entries(specs)) {
  const s = createChartSession(); let cur = rows
  let prev = s.evaluate(spec, { data: { src: cur }, signals: { u: 0 } })
  const t = []; let kept = 0
  for (let k = 1; k <= 30; k++) {
    const t0 = performance.now(); const sc = s.evaluate(spec, { data: { src: cur }, signals: { u: k } }); t.push(performance.now() - t0)
    const a = marks(prev)[0], b = marks(sc)[0]; if (a && b && a.items[0] === b.items[0] && a === b) kept++
    prev = sc
  }
  // case 3: append one row while the unrelated signal changes
  const t3 = []
  for (let k = 1; k <= 30; k++) {
    const next = [...cur, { x: k, y: k, c: 'k0' }]
    const t0 = performance.now(); prev = s.evaluate(spec, { data: { src: next }, signals: { u: 100 + k } }); t3.push(performance.now() - t0)
    cur = next
  }
  console.log(`${name}: unrelated signal ${med(t)} ms (mark kept ${kept}/30)   append + unrelated signal ${med(t3)} ms`)
}
