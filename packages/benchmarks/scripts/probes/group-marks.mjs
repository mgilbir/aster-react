// group marks: a line per category, a faceted scatter, an hconcat, as <Chart> drives them (new arrays); median ms, items and group
// items kept by identity. usage: node packages/benchmarks/scripts/probes/group-marks.mjs <worktree> [N] [reps]
import { treeRoot } from './tree-root.mjs'
const R = treeRoot()
const N = +(process.argv[3] ?? 5000)
const REPS = +(process.argv[4] ?? 20)
const { compile } = await import(R + '/packages/vl/dist/index.js')
const { createChartSession } = await import(R + '/packages/core/dist/addon-dom.js')
const row = (i, c = 'k' + (i % 5)) => ({ t: i, x: (i * 13) % 1000, y: ((i * 37) % 400) + 10, c })
const rows0 = Array.from({ length: N }, (_, i) => row(i))
const enc = { x: { field: 'x', type: 'quantitative', scale: { domain: [0, 1000] } }, y: { field: 'y', type: 'quantitative', scale: { domain: [0, 420] } } }
const specs = {
  line: compile({ width: 500, height: 300, data: { name: 'src' }, mark: 'line', encoding: { x: { field: 't', type: 'quantitative', scale: { domain: [0, 2 * N] } }, y: enc.y, color: { field: 'c', type: 'nominal' } } }),
  facet: compile({ data: { name: 'src' }, facet: { column: { field: 'c', type: 'nominal' } }, spec: { width: 150, height: 150, mark: 'point', encoding: { ...enc, color: { field: 'c', type: 'nominal' } } } }),
  concat: compile({ data: { name: 'src' }, hconcat: [{ width: 250, height: 200, mark: 'point', encoding: { ...enc, color: { field: 'c', type: 'nominal' } } }, { width: 250, height: 200, mark: 'point', encoding: { x: enc.y, y: enc.x } }] }),
}
const changes = {
  'append existing': (cur, k) => [...cur, row(N + k)],
  'remove one': (cur, k) => { const i = 7 + k * 11; return [...cur.slice(0, i), ...cur.slice(i + 1)] },
  'edit value': (cur, k) => { const i = 3 + k * 17; const n = cur.slice(); n[i] = { ...n[i], y: n[i].y + 1 }; return n },
}
const leaves = (sc) => { const o = []; const w = (n) => { for (const g of n.items ?? []) { if (g.role === 'mark' && g.marktype !== 'group') o.push(g); else w(g) } }; w(sc); return o }
const groupItems = (sc) => { const o = []; const w = (n) => { for (const g of n.items ?? []) { if (g.marktype === 'group' && g.role !== 'mark' && g.items) { o.push(g); w(g) } } }; w(sc); return o }
const med = (t) => { const s = [...t].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
for (const [name, spec] of Object.entries(specs)) {
  for (const [what, next] of Object.entries(changes)) {
    const s = createChartSession(); let cur = rows0; let prev = s.evaluate(spec, { data: { src: cur } })
    const t = []; let line = ''
    for (let k = 0; k < REPS; k++) {
      const n = next(cur, k); const a = performance.now(); const sc = s.evaluate(spec, { data: { src: n } }); t.push(performance.now() - a)
      if (k === REPS - 1) {
        const was = new Set(leaves(prev).flatMap((g) => g.items)); const now = leaves(sc).flatMap((g) => g.items)
        const gw = new Set(groupItems(prev)); const gn = groupItems(sc)
        line = `items kept ${now.filter((x) => was.has(x)).length}/${now.length}  group items kept ${gn.filter((g) => gw.has(g)).length}/${gn.length}`
      }
      prev = sc; cur = n
    }
    console.log(`${name.padEnd(7)} ${what.padEnd(16)} ${med(t).toFixed(2).padStart(7)} ms  ${line}`)
  }
}
