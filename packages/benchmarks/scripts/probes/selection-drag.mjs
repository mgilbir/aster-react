// A brush drag and a hover sweep through <Chart> in headless Chromium, on a Vega-Lite scatter of N points.
// node packages/benchmarks/scripts/probes/selection-drag.mjs <worktree> <brush|hover|pick-hover> [N] -- per pointer move: the time from the move to the second frame after it
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { treeRoot } from './tree-root.mjs'
import { launchBrowser } from '../../../../scripts/lib/launch-browser.mjs'
const WT = treeRoot()
const kind = process.argv[3] ?? 'brush'
const N = +(process.argv[4] ?? 5000)
const req = createRequire(join(WT, 'packages/react/package.json'))
const eb = await import(req.resolve('esbuild')); const build = eb.build ?? eb.default.build
const pw = await import(req.resolve('playwright')); const chromium = pw.chromium ?? pw.default.chromium
const { compile } = await import(join(WT, 'packages/vl/dist/index.js'))
const entry = `
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Chart } from ${JSON.stringify(join(WT, 'packages/react/src/index.ts'))}
window.__mount = (spec) => {
  const host = document.getElementById('root')
  const container = document.createElement('div')
  container.id = 'chart-host'
  container.style.cssText = 'position:relative;width:640px;height:400px'
  host.replaceChildren(container)
  window.__root = createRoot(container)
  flushSync(() => window.__root.render(React.createElement(Chart, { spec })))
}`
const bundle = await build({ stdin: { contents: entry, resolveDir: join(WT, 'packages/react/scripts'), loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error' })
const rows = Array.from({ length: N }, (_, i) => ({ a: (i * 7919) % 1000, b: (i * 104729) % 997, c: `k${i % 5}` }))
const param = kind === 'brush' ? { name: 'sel', select: 'interval' } : { name: 'sel', select: { type: 'point', on: 'pointerover', nearest: kind === 'nearest' } }
const spec = compile({ width: 560, height: 320, data: { values: rows }, params: [param], mark: 'point',
  encoding: { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' }, color: { condition: { param: 'sel', field: 'c', type: 'nominal', empty: kind === 'brush' }, value: 'grey' } } })
const browser = await launchBrowser(chromium)
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } })
  page.on('pageerror', (e) => console.log('page error', e.message))
  await page.setContent('<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.evaluate((sp) => window.__mount(sp), spec)
  await page.waitForSelector('svg .mark-symbol')
  const box = await page.locator('#chart-host svg').boundingBox()
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now())))))
  const lat = []
  const x0 = box.x + 120, y0 = box.y + 80
  if (kind === 'brush') { await page.mouse.move(x0, y0); await page.mouse.down() }
  await frames()
  for (let k = 0; k < 60; k++) {
    const t0 = await page.evaluate(() => performance.now())
    await page.mouse.move(x0 + 20 + k * 5, y0 + 10 + k * 3)
    const t1 = await frames()
    if (k >= 10) lat.push(t1 - t0)
  }
  if (kind === 'brush') await page.mouse.up()
  lat.sort((a, b) => a - b)
  const changed = await page.evaluate(() => document.querySelectorAll('svg .mark-symbol path').length)
  console.log(`${kind.padEnd(8)} N=${N}  move->2 frames median ${lat[lat.length >> 1].toFixed(1)} ms  p90 ${lat[Math.floor(lat.length * 0.9)].toFixed(1)} ms  (${changed} symbol paths)`)
} finally { await browser.close() }
