/**
 * Differential-update benchmark: the reactive-dataflow core (#5).
 *
 * Compares the per-datum differential path (`evaluateChart` with a `dataChanges`
 * changeset — only changed rows re-derive, unchanged scene items are reused and
 * their DOM subtrees skipped) against a full re-encode (no changeset), across the
 * row-wise, group-aggregate, and affected-scale cases.
 *
 * Pure computation (scene eval), no DOM. Run: pnpm bench:differential
 * [--points=50000] [--reps=5] [--changed=1]
 */
import { performance } from 'node:perf_hooks'
import { ensureBuilt } from './ensure-built.js'
import { summarize, table, fmt, type Summary } from './stats.js'

interface Case {
  name: string
  spec: Record<string, unknown>
  changed: number[]
  next: (p: number) => Record<string, unknown[]>
}

function time(fn: () => void): number {
  const t0 = performance.now()
  fn()
  return performance.now() - t0
}

async function main(): Promise<void> {
  ensureBuilt()
  const argv = process.argv.slice(2)
  const arg = (n: string, d: string): string => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d
  const points = Number(arg('points', '50000'))
  const reps = Number(arg('reps', '5'))
  const changedPct = Number(arg('changed', '1'))
  const warmup = 2

  const { compileChart, evaluateChart } = await import('@aster/core')
  const { patchSceneDom, renderSceneToDomElement } = await import('@aster/core/dom')
  const { setupJsdom } = await import('./jsdom-env.js')
  setupJsdom()

  const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i % 100, y: i % 100 }))
  const few = (n: number): number[] => {
    const k = Math.max(1, Math.floor((n * changedPct) / 100))
    return Array.from({ length: k }, (_, i) => (i * 997) % n)
  }

  const cases: Case[] = [
    {
      name: 'row-wise (formula)',
      spec: {
        $schema: 'https://vega.github.io/schema/vega/v6.json', width: 600, height: 400, autosize: 'none',
        data: [{ name: 't', values: pts(points), transform: [{ type: 'formula', expr: 'datum.x * 2', as: 'x2' }] }],
        scales: [{ name: 'x', type: 'linear', domain: [0, 200], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 100], range: 'height' }],
        marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x2' }, y: { scale: 'y', field: 'y' }, size: { value: 40 } } } }],
      } as never,
      changed: few(points),
      next: (p) => ({ t: pts(p).map((r, i) => (r.x % 2 === 0 ? { x: r.x + 1, y: r.y } : r)) }),
    },
    {
      name: 'aggregate (1000 groups)',
      spec: {
        $schema: 'https://vega.github.io/schema/vega/v6.json', width: 600, height: 400, autosize: 'none',
        data: [{ name: 't', values: pts(points).map((_, i) => ({ g: 'g' + (i % 1000), v: i % 50 })), transform: [{ type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] }] }],
        scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'g' }, range: 'width', paddingOuter: 0.1, paddingInner: 0.2 }, { name: 'y', type: 'linear', domain: { data: 't', field: 's' }, range: 'height', zero: true, nice: true }],
        marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'g' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 's' }, y2: { scale: 'y', value: 0 } } } }],
      } as never,
      changed: few(points),
      next: (p) => ({ t: pts(p).map((r, i) => (i % 997 === 0 ? { g: 'g' + (i % 1000), v: r.y + 1 } : { g: 'g' + (i % 1000), v: i % 50 })) }),
    },
    {
      name: 'fixed-scale symbol',
      spec: {
        $schema: 'https://vega.github.io/schema/vega/v6.json', width: 600, height: 400, autosize: 'none',
        data: [{ name: 't', values: pts(points) }],
        scales: [{ name: 'x', type: 'linear', domain: [0, 100], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 100], range: 'height' }],
        marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 40 } } } }],
      } as never,
      changed: few(points),
      next: (p) => ({ t: pts(p).map((r, i) => (i % 997 === 0 ? { x: r.x, y: (r.y + 1) % 100 } : r)) }),
    },
  ]

  const data: string[][] = []
  const domData: string[][] = []
  for (const c of cases) {
    const chart = compileChart(c.spec)
    const initial = c.next(points)
    // warmup + set up the persistent scene (the differential path needs prev items)
    for (let w = 0; w < warmup; w++) { evaluateChart(chart, { data: initial }); evaluateChart(chart, { data: initial, dataChanges: { t: c.changed } }) }
    const diffData = c.next(points)
    const diff: number[] = []
    const full: number[] = []
    for (let r = 0; r < reps; r++) {
      full.push(time(() => evaluateChart(chart, { data: diffData })))
      diff.push(time(() => evaluateChart(chart, { data: diffData, dataChanges: { t: c.changed } })))
    }
    const d = summarize(diff)
    const f = summarize(full)
    data.push([c.name, String(points), fmt(f.median), fmt(d.median), (f.median / d.median).toFixed(1) + 'x'])

    // DOM-patch measurement: the incremental DOM patcher skips unchanged
    // subtrees, so a stable update only descends into the changed items. Use a
    // smaller chart (jsdom patching is O(n) and slow at 50k nodes).
    const domPts = Math.min(points, 4000)
    const domChanged = few(domPts)
    const host = document.createElement('div')
    document.body.appendChild(host)
    // Mount via patchSceneDom (like <Chart incremental>), so the patch cache
    // (LAST) is populated — the DOM-subtree skip only engages from the second
    // patch onward.
    const mountHost = document.createElement('div')
    mountHost.innerHTML = '<svg></svg>'
    const svg = mountHost.firstElementChild as Element
    const mountScene = evaluateChart(compileChart(c.spec), { data: c.next(domPts) })
    patchSceneDom(svg, mountScene)
    host.appendChild(svg)
    const patchFull: number[] = []
    const patchDiff: number[] = []
    const chart2 = compileChart(c.spec)
    const domData2 = c.next(domPts)
    for (let r = 0; r < Math.min(reps, 3); r++) {
      patchFull.push(time(() => patchSceneDom(svg, evaluateChart(chart2, { data: domData2 }))))
      patchDiff.push(time(() => patchSceneDom(svg, evaluateChart(chart2, { data: domData2, dataChanges: { t: domChanged } }))))
    }
    const pd = summarize(patchDiff)
    const pf = summarize(patchFull)
    domData.push([c.name, String(domPts), fmt(pf.median), fmt(pd.median), (pf.median / pd.median).toFixed(1) + 'x'])
    host.remove()
  }

  console.log(table('differential scene eval (changed-set vs full re-encode)', ['case', 'points', 'full (ms)', 'diff (ms)', 'speedup'], data))
  console.log(table('differential DOM patch (scene eval + patchSceneDom)', ['case', 'points', 'full (ms)', 'diff (ms)', 'speedup'], domData))
}

main().catch((e) => { console.error(e); process.exit(1) })
