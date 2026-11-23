/**
 * Executes the built `dist` of the three published packages on the Node that runs this file, with no test framework and no jsdom:
 * core renders a Vega spec to SVG, vl compiles a Vega-Lite spec, react server-renders <Chart> (Vega and Vega-Lite) and <SvgChart>.
 * scripts/dist-node-smoke.test.mjs runs it as a child process; the `unit (node 20)` CI job selects that test, which is what makes
 * "the packages support Node 20" (the `engines` field of each) a tested claim rather than a statement.
 *
 * Usage: node scripts/lib/dist-node-smoke.mjs     (needs `pnpm build`)
 * Prints one line `ok node <version>` and exits 0; any broken import or assertion exits non-zero.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const load = (pkg, file) => import(pathToFileURL(join(root, 'packages', pkg, 'dist', file)).href)
const reactRequire = createRequire(join(root, 'packages', 'react', 'package.json'))

const core = await load('core', 'index.js')
const vl = await load('vl', 'index.js')
const react = await load('react', 'index.js')
const lite = await load('react', 'lite.js')
await load('react', 'vl.js') // the opt-in Vega-Lite add-on registers the compiler
const { renderToString } = await import(pathToFileURL(reactRequire.resolve('react-dom/server')).href)
const { createElement } = await import(pathToFileURL(reactRequire.resolve('react')).href)

const rows = [{ c: 'a', v: 3 }, { c: 'b', v: 5 }, { c: 'c', v: 2 }]
const vega = {
  width: 200, height: 120,
  data: [{ name: 't', values: rows }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width', padding: 0.1 },
    { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height', nice: true, zero: true },
  ],
  marks: [{
    type: 'rect', from: { data: 't' },
    encode: { enter: { x: { scale: 'x', field: 'c' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 }, fill: { value: 'tomato' } } },
  }],
}
const vegaLite = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 200, height: 120, data: { values: rows }, mark: 'bar',
  encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } },
}

const svg = core.renderSpec(vega)
assert.ok(svg.startsWith('<svg') && svg.includes('tomato') && svg.includes('mark-rect'), 'core renderSpec renders the Vega spec')
assert.ok(Array.isArray(vl.compile(vegaLite).marks), 'vl compiles the Vega-Lite spec')
for (const [what, el] of [
  ['<Chart> with Vega', createElement(react.Chart, { spec: vega, width: 200, height: 120, a11y: false })],
  ['<Chart> with Vega-Lite', createElement(react.Chart, { spec: vegaLite, width: 200, height: 120, a11y: false })],
  ['<SvgChart> with Vega', createElement(lite.SvgChart, { spec: vega, width: 200, height: 120, a11y: false })],
]) {
  const html = renderToString(el)
  assert.ok(html.includes('<svg') && /<(rect|path)\b/.test(html), `${what} server-renders marks: ${html.slice(0, 200)}`)
}
console.log(`ok node ${process.versions.node}`)
