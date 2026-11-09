/**
 * What a `transition` costs per frame, in a real browser.
 *
 * For each scene (a symbol scatter and a rect grid, at each size) the page evaluates two scenes of the same chart in which
 * every item moves and changes colour, draws the first, then: plans the transition once (`createSceneTransition`) and draws
 * 30 frames from `requestAnimationFrame` (`at(t)` + `patchSceneDom`, what `<Chart transition>` does per frame). It prints the
 * planning time, the script time of a frame, the interval between frames (what the browser managed, style, layout and paint
 * included) and, for scale, the time of one non-animated patch of the same change.
 *
 * Run: pnpm --filter @aster-charts/benchmarks run bench:transition [--sizes=1000,10000] [--runs=3]   (after `pnpm build`)
 */
import { build } from 'esbuild'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { ensureBuilt } from '../src/ensure-built.ts'
import { cli } from '../../../scripts/lib/cli.mjs'

cli({ url: import.meta.url, flags: { sizes: 'eq', runs: 'eq' } })

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const argv = process.argv.slice(2)
const arg = (name, dflt) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt
const SIZES = arg('sizes', '1000,10000').split(',').map(Number).filter((n) => n > 0)
const RUNS = Math.max(1, Number(arg('runs', '3')))
ensureBuilt()

const CORE = join(ROOT, 'packages/core/dist')
const entry = `
import { createChartSession, patchSceneDom, renderSceneToDomElement } from ${JSON.stringify(join(CORE, 'addon-dom.js'))}
import { createSceneTransition } from ${JSON.stringify(join(CORE, 'transition.js'))}
const colour = { name: 'c', type: 'linear', domain: [0, 1], range: ['#ff0000', '#0000ff'] }
const specs = {
  symbol: { width: 800, height: 500, padding: 0, autosize: 'none', data: [{ name: 't' }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 1], range: 'height' }, colour],
    axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left' }],
    marks: [{ type: 'symbol', from: { data: 't' }, key: 'k', encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 30 }, fill: { scale: 'c', field: 'x' } } } }] },
  rect: { width: 800, height: 500, padding: 0, autosize: 'none', data: [{ name: 't' }], scales: [colour],
    marks: [{ type: 'rect', from: { data: 't' }, key: 'k', encode: { update: { x: { field: 'cx' }, y: { field: 'cy' }, width: { value: 7 }, height: { value: 4 }, fill: { scale: 'c', field: 'x' } } } }] },
}
let seed = 1
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
window.run = (n, kind) => new Promise((resolve) => {
  const rows = () => Array.from({ length: n }, (_, i) => ({ k: i, x: rnd(), y: rnd(), cx: (i % 100) * 8, cy: Math.floor(i / 100) * 5 }))
  const s = createChartSession()
  const A = s.evaluate(specs[kind], { data: { t: rows() } })
  const B = s.evaluate(specs[kind], { data: { t: rows() } })
  document.body.replaceChildren()
  const svg = renderSceneToDomElement(A)
  document.body.append(svg)
  const once0 = performance.now()
  patchSceneDom(svg, B)
  const once = performance.now() - once0
  patchSceneDom(svg, A)
  const p0 = performance.now()
  const tr = createSceneTransition(A, B, { easing: 'linear' })
  const plan = performance.now() - p0
  const js = []
  const intervals = []
  let last = null
  let i = 0
  const tick = (ts) => {
    if (last !== null) intervals.push(ts - last)
    last = ts
    const a = performance.now()
    patchSceneDom(svg, tr.at(i / 30))
    js.push(performance.now() - a)
    if (++i <= 30) requestAnimationFrame(tick)
    else { patchSceneDom(svg, B); resolve({ once, plan, js, intervals }) }
  }
  requestAnimationFrame(tick)
})
`
const bundle = await build({ stdin: { contents: entry, resolveDir: ROOT, loader: 'js' }, bundle: true, write: false, format: 'iife', platform: 'browser', minify: true, logLevel: 'error' })
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const ms = (x) => `${x.toFixed(1)} ms`
const browser = await chromium.launch()
try {
  for (const kind of ['symbol', 'rect']) {
    for (const n of SIZES) {
      const runs = []
      for (let r = 0; r < RUNS; r++) {
        const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
        await page.setContent('<!doctype html><html><body style="margin:0"></body></html>')
        await page.addScriptTag({ content: bundle.outputFiles[0].text })
        runs.push(await page.evaluate(([size, k]) => window.run(size, k), [n, kind]))
        await page.close()
      }
      console.log(`${kind} x ${n}`)
      for (const x of runs) {
        console.log(`  plan ${ms(x.plan)}, script per frame ${ms(median(x.js))} (max ${ms(Math.max(...x.js))}), frame interval ${ms(median(x.intervals))}, one non-animated patch ${ms(x.once)}`)
      }
    }
  }
} finally {
  await browser.close()
}
