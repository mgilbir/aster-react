// Vega-Lite charts with a discrete scale over data, driven through createChartSession as <Chart> drives them (a new array per
// update, the session diffs it), and through createChartStream for appends. Reports median ms per update, whether each discrete
// scale is the same object, and how many items of each mark are kept by identity.
// usage: node packages/benchmarks/scripts/probes/discrete-scale-appends.mjs <worktree> [N] [reps]
import { treeRoot } from './tree-root.mjs'
const R = treeRoot()
const N = +(process.argv[3] ?? 5000)
const REPS = +(process.argv[4] ?? 30)
const { compile } = await import(R + '/packages/vl/dist/index.js')
const { createChartSession } = await import(R + '/packages/core/dist/addon-dom.js')
const { createChartStream } = await import(R + '/packages/core/dist/index.js')

const CATS = 5
const row = (i, c = 'k' + (i % CATS)) => ({ t: i, x: (i * 13) % 1000, y: ((i * 37) % 400) + 10, c })
const rows0 = Array.from({ length: N }, (_, i) => row(i))

const specs = {
  scatter: compile({ width: 500, height: 300, data: { name: 'src' }, mark: 'point',
    encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } } }),
  bar: compile({ width: 500, height: 300, data: { name: 'src' }, mark: 'bar',
    encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'y', type: 'quantitative' } } }),
  stacked: compile({ width: 500, height: 300, data: { name: 'src' }, mark: 'bar',
    encoding: { x: { field: 't', type: 'ordinal', bin: false, timeUnit: undefined }, y: { field: 'y', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } } }),
  line: compile({ width: 500, height: 300, data: { name: 'src' }, mark: 'line',
    encoding: { x: { field: 't', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } } }),
}
// the stacked bar over N bars of one row each is unrealistic: stack N rows over 50 x bands instead
specs.stacked = compile({ width: 500, height: 300, data: { name: 'src' }, transform: [{ calculate: 'datum.t % 50', as: 'b' }], mark: 'bar',
  encoding: { x: { field: 'b', type: 'ordinal' }, y: { field: 'y', type: 'quantitative', aggregate: 'sum' }, color: { field: 'c', type: 'nominal' } } })

const marks = (sc) => { const o = []; const w = (n) => { for (const g of n.items ?? []) { if (g.role === 'mark' && g.marktype !== 'group') o.push(g); w(g) } }; w(sc); return o }
const discreteScales = (spec) => spec.scales.filter((s) => ['ordinal', 'band', 'point'].includes(s.type)).map((s) => s.name)
const med = (t) => { const s = [...t].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

// each change: from the current rows and the step k, the next rows
const changes = {
  'append existing': (cur, k) => [...cur, row(N + k)],
  'append new cat': (cur, k) => [...cur, row(N + k, 'new' + k)],
  'remove one': (cur, k) => { const i = 7 + k * 11; return [...cur.slice(0, i), ...cur.slice(i + 1)] },
  'edit value': (cur, k) => { const i = 3 + k * 17; const n = cur.slice(); n[i] = { ...n[i], y: n[i].y + 1 }; return n },
  'edit category': (cur, k) => { const i = 100 + k * 17; const n = cur.slice(); n[i] = { ...n[i], c: n[i].c === 'k1' ? 'k2' : 'k1' }; return n },
}

const ONLY = process.env.ONLY
for (const [name, spec] of Object.entries(specs)) {
  if (ONLY === 'stream') break
  const scs = discreteScales(spec)
  for (const [what, next] of Object.entries(changes)) {
    const s = createChartSession()
    let cur = rows0
    let prev = s.evaluate(spec, { data: { src: cur } })
    const t = []; let scaleKept = 0; let kept = 0; let total = 0
    for (let k = 0; k < REPS; k++) {
      const n = next(cur, k)
      const t0 = performance.now(); const sc = s.evaluate(spec, { data: { src: n } }); t.push(performance.now() - t0)
      if (k === REPS - 1) {
        scaleKept = scs.filter((x) => prev.__scaleMap.get(x) === sc.__scaleMap.get(x)).length
        const ma = marks(prev), mb = marks(sc)
        const was = new Set(ma.flatMap((g) => g.items))
        for (let m = 0; m < mb.length; m++) { total += mb[m].items.length; kept += mb[m].items.filter((it) => was.has(it)).length }
      }
      prev = sc; cur = n
    }
    console.log(`${name.padEnd(8)} ${what.padEnd(16)} ${med(t).toFixed(2).padStart(7)} ms  scales kept ${scaleKept}/${scs.length} (${scs.join(',')})  items kept ${kept}/${total}`)
  }
}

// createChartStream appends (one row of an existing category), as <ChartStream> pushes them
for (const [name, spec] of Object.entries(specs)) {
  const src = spec.data.find((d) => d.name === 'src')
  const st = createChartStream(spec, { capacity: 8 })
  st.push({ data: { src: rows0 } }); let prev = st.flush().scene
  const t = []; let scaleKept = 0; let kept = 0; let total = 0
  const scs = discreteScales(spec)
  for (let k = 0; k < REPS * 4; k++) {
    const a = performance.now(); st.push({ append: { src: [row(N + k)] } }); const sc = st.flush().scene; t.push(performance.now() - a)
    if (k === REPS * 4 - 1) {
      scaleKept = scs.filter((x) => prev.__scaleMap.get(x) === sc.__scaleMap.get(x)).length
      const ma = marks(prev), mb = marks(sc)
      for (let m = 0; m < mb.length; m++) { total += mb[m].items.length; kept += mb[m].items.filter((it, i) => it === ma[m]?.items[i]).length }
    }
    prev = sc
  }
  void src
  console.log(`${name.padEnd(8)} stream append    ${med(t.slice(10)).toFixed(2).padStart(7)} ms  scales kept ${scaleKept}/${scs.length}  items kept ${kept}/${total}`)
}
