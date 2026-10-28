#!/usr/bin/env node
/**
 * Tree-shaking correctness gate (audit: sideEffects).
 *
 * `sideEffects` in the package manifests lets a bundler drop every module whose exports an app never uses. That is
 * only safe if every module with an effect that matters (a registration, a hook install, a worker message handler)
 * is listed. This gate proves it per documented import pattern: for each one it BUNDLES a tiny app with esbuild,
 * production settings (minify, NODE_ENV=production, tree-shaking on), then EXECUTES the bundle in a fresh node
 * process (jsdom where the pattern needs a DOM) and asserts the behaviour. A pattern whose side effect was shaken
 * out fails here, not in a user's production build.
 *
 *   node scripts/check-bundle-shaking.mjs                  run every pattern against the manifests as they are
 *   node scripts/check-bundle-shaking.mjs --blanket-false  bite check: pretend EVERY aster module is side-effect
 *                                                          free (what `"sideEffects": false` would do); the gate
 *                                                          must then FAIL (scripts/bundle-shaking.test.mjs asserts it)
 *   node scripts/check-bundle-shaking.mjs --only react-vl,core-geo   run the named patterns only
 *   node scripts/check-bundle-shaking.mjs --bundler vite   second opinion: the same patterns through Vite/Rollup
 *                                                          (not a gate: Vite is only present as a vitest dependency;
 *                                                          it is resolved from the pnpm store and the run fails if absent)
 *
 * Needs `pnpm build` (it bundles the packages' dist, like a consumer does).
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TMP = join(ROOT, 'packages', 'react', '.tmp-shaking') // under packages/react so `react` and `react-dom` resolve
const CORPUS = join(ROOT, 'packages', 'conformance', 'corpus')
const argv = process.argv.slice(2)
const BLANKET_FALSE = argv.includes('--blanket-false')
const BUNDLER = argv.includes('--bundler') ? argv[argv.indexOf('--bundler') + 1] : 'esbuild'
const only = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null

for (const pkg of ['core', 'react', 'vl']) {
  if (!existsSync(join(ROOT, 'packages', pkg, 'dist', 'index.js'))) {
    console.error(`[bundle-shaking] packages/${pkg}/dist is missing: run \`pnpm build\` first`)
    process.exit(2)
  }
}

const corpus = (name) => JSON.parse(readFileSync(join(CORPUS, name), 'utf8'))
const BAR_VG = corpus('bar-bands.vg.json')
const BAR_VL = corpus('bar-basic.vl.json')
const GEO_VG = corpus('geo-vlout-mercator-translate.vg.json')
const TREEMAP_VG = corpus('treemap.vg.json')

const REGRESSION_VG = {
  width: 200, height: 100,
  data: [{
    name: 't',
    values: [{ x: 1, y: 2 }, { x: 2, y: 4.1 }, { x: 3, y: 5.9 }, { x: 4, y: 8.2 }, { x: 5, y: 9.8 }],
    transform: [{ type: 'regression', x: 'x', y: 'y', method: 'linear', as: ['rx', 'ry'] }],
  }],
  scales: [
    { name: 'sx', type: 'linear', domain: [1, 5], range: 'width' },
    { name: 'sy', type: 'linear', domain: [0, 10], range: 'height' },
  ],
  marks: [{ type: 'line', from: { data: 't' }, encode: { update: { x: { scale: 'sx', field: 'rx' }, y: { scale: 'sy', field: 'ry' }, stroke: { value: 'red' } } } }],
}
/** A spec with a signal handler, for `@aster/core/signals`. */
const SIGNAL_VG = {
  width: 100, height: 100,
  signals: [{ name: 'clicks', value: 0, on: [{ events: 'click', update: 'clicks + 1' }] }],
  data: [{ name: 'table', values: [{ k: 1 }] }],
  marks: [{ type: 'rect', from: { data: 'table' }, encode: { enter: { x: { value: 10 }, y: { value: 10 }, width: { value: 30 }, height: { value: 30 }, fill: { value: 'red' } } } }],
}
const lit = (v) => JSON.stringify(v)

/**
 * Each pattern: an app (its source), whether it needs jsdom, the assertions on the JSON it returns, and optionally
 * `modules(m)`: assertions on which dist modules the bundle read / contributed code from (esbuild metafile).
 * `app` is the body of `export default async function run(env) {...}`; `imports` are its import lines.
 */
const PATTERNS = [
  {
    name: 'core-renderSpec',
    why: "import { renderSpec } from '@aster/core': SVG with the guide captions installed; geo/transforms are NOT registered",
    imports: `import { renderSpec } from '@aster/core'`,
    body: `
      const svg = renderSpec(${lit(BAR_VG)})
      const err = (spec) => { try { renderSpec(spec); return null } catch (e) { return String(e.message) } }
      return { svg, geoErr: err(${lit(GEO_VG)}), treemapErr: err(${lit(TREEMAP_VG)}) }`,
    check: (r) => [
      [r.svg.startsWith('<svg') && /class="mark-rect/.test(r.svg), 'renders a bar chart'],
      [/aria-label="[XY]-axis/.test(r.svg), 'axis aria-label caption (guide-caption.js installed)'],
      [/load the addon/.test(r.geoErr ?? ''), 'a geo spec without the addon asks for the addon (it is not registered by accident)'],
      [/load the addon/.test(r.treemapErr ?? ''), 'a treemap spec without the addon asks for the addon'],
    ],
  },
  {
    name: 'core-geo',
    why: "import '@aster/core/geo': projections register",
    imports: `import { renderSpec } from '@aster/core'\nimport '@aster/core/geo'`,
    body: `return { svg: renderSpec(${lit(GEO_VG)}) }`,
    check: (r) => [[/<path [^>]*d="M/.test(r.svg), 'a projected geoshape renders path data']],
  },
  {
    name: 'core-geo-bare',
    why: "bare side-effect import + the spec through the compile/evaluate entry (no renderSpec import from the barrel)",
    imports: `import '@aster/core/geo'\nimport { createChartSession } from '@aster/core/dom'`,
    body: `const scene = createChartSession().evaluate(${lit(GEO_VG)}, {}); return { scene: JSON.stringify(scene, (k, v) => (k === 'runtime' || k === 'compiled' ? undefined : v)).length }`,
    check: (r) => [[r.scene > 500, 'the geo spec evaluates through the session']],
  },
  {
    name: 'core-geo-lazy',
    why: "await import('@aster/core/geo'): the lazy form registers too (code-split chunk)",
    split: true,
    imports: `import { renderSpec } from '@aster/core'`,
    body: `
      let before = null
      try { renderSpec(${lit(GEO_VG)}) } catch (e) { before = String(e.message) }
      await import('@aster/core/geo')
      return { before, svg: renderSpec(${lit(GEO_VG)}) }`,
    check: (r) => [
      [/load the addon/.test(r.before ?? ''), 'before the dynamic import the addon is missing'],
      [/<path [^>]*d="M/.test(r.svg), 'after it the projected geoshape renders'],
    ],
  },
  {
    name: 'core-transforms',
    why: "import '@aster/core/transforms': the rare-layout transforms register",
    imports: `import { renderSpec } from '@aster/core'\nimport '@aster/core/transforms'`,
    body: `return { treemap: renderSpec(${lit(TREEMAP_VG)}), regression: renderSpec(${lit(REGRESSION_VG)}) }`,
    check: (r) => [
      [(r.treemap.match(/fill="steelblue"/g) ?? []).length >= 5, 'treemap lays out one rect per node'],
      [/<path [^>]*stroke="red"/.test(r.regression), 'regression produces the fitted line'],
    ],
  },
  {
    name: 'core-load',
    why: "import { loadSpecData } from '@aster/core/load': a URL dataset loads (csv over http) and renders",
    imports: `import { renderSpec } from '@aster/core'\nimport { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster/core/load'`,
    body: `
      const spec = { width: 100, height: 50, data: [{ name: 't', url: env.url, format: { type: 'csv', parse: 'auto' } }],
        scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'a' }, range: 'width' }],
        marks: [{ type: 'symbol', from: { data: 't' }, encode: { enter: { x: { scale: 'x', field: 'a' }, y: { value: 10 } } } }] }
      const loaded = await loadSpecData(spec, TRUSTED_LOAD_OPTIONS)
      return { rows: loaded.data[0].values, svg: renderSpec(loaded) }`,
    check: (r) => [
      [Array.isArray(r.rows) && r.rows.length === 3 && r.rows[2].a === 7, 'three csv rows fetched and parsed'],
      [(r.svg.match(/<path /g) ?? []).length >= 3, 'one symbol per row'],
    ],
  },
  {
    name: 'core-load-bare',
    why: "import '@aster/core/load' for the side effect only: csv/tsv/topojson readers register for inline strings",
    imports: `import { renderSpec } from '@aster/core'\nimport '@aster/core/load'`,
    body: `
      const spec = (fmt, values) => ({ width: 100, height: 50, data: [{ name: 't', values, format: fmt }],
        scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'a' }, range: 'width' }],
        marks: [{ type: 'symbol', from: { data: 't' }, encode: { enter: { x: { scale: 'x', field: 'a' }, y: { value: 10 } } } }] })
      return { csv: renderSpec(spec({ type: 'csv', parse: 'auto' }, 'a,b\\n1,2\\n3,4\\n5,6')), tsv: renderSpec(spec({ type: 'tsv', parse: 'auto' }, 'a\\tb\\n1\\t2\\n3\\t4')) }`,
    check: (r) => [
      [(r.csv.match(/<path /g) ?? []).length >= 3, 'inline csv text parses (reader registered by the bare import)'],
      [(r.tsv.match(/<path /g) ?? []).length >= 2, 'inline tsv text parses'],
    ],
  },
  {
    name: 'core-dom',
    why: "import from '@aster/core/dom' only: patcher + session, guide captions installed by dom.ts' own import",
    dom: true,
    imports: `import { createChartSession, renderSceneToDomElement, patchSceneDom } from '@aster/core/dom'`,
    body: `
      const session = createChartSession()
      const scene = session.evaluate(${lit(BAR_VG)}, {})
      const svg = renderSceneToDomElement(scene)
      const html = svg.outerHTML
      patchSceneDom(svg, session.evaluate(${lit(BAR_VG)}, { width: 300 }))
      return { html, tag: svg.tagName, patched: svg.outerHTML }`,
    check: (r) => [
      [r.tag === 'svg' && /class="mark-rect/.test(r.html), 'a DOM tree is built'],
      [/aria-label="[XY]-axis/.test(r.html), 'axis aria-label caption (dom.ts imports guide-caption.js for its effect)'],
      [r.patched !== r.html, 'patchSceneDom updates the live tree'],
    ],
  },
  {
    name: 'core-canvas',
    why: "import { renderSceneToCanvas } from '@aster/core/canvas'",
    imports: `import { evaluateChart, compileChart } from '@aster/core'\nimport { renderSceneToCanvas } from '@aster/core/canvas'`,
    body: `
      const calls = {}
      const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => { calls[k] = (calls[k] ?? 0) + 1 }), set: (t, k, v) => { t[k] = v; return true } })
      renderSceneToCanvas(evaluateChart(compileChart(${lit(BAR_VG)}), {}), ctx, { dpr: 1 })
      return { calls }`,
    check: (r) => [[(r.calls.fill ?? 0) + (r.calls.fillRect ?? 0) >= 3, 'the bars are painted']],
  },
  {
    name: 'core-hit',
    why: "import { buildHitIndex } from '@aster/core/hit'",
    imports: `import { evaluateChart, compileChart } from '@aster/core'\nimport { buildHitIndex } from '@aster/core/hit'`,
    body: `
      const scene = evaluateChart(compileChart(${lit(BAR_VG)}), {})
      const index = buildHitIndex(scene)
      const kinds = new Set()
      for (let x = 0; x < scene.width; x += 4) for (let y = 0; y < scene.height; y += 4) { const t = index.queryMark(x, y); if (t) kinds.add(t.marktype) }
      return { kinds: [...kinds], size: index.size() }`,
    check: (r) => [[r.kinds.includes('rect') && r.size > 0, 'a pointer over a bar resolves to the rect mark']],
  },
  {
    name: 'core-signals',
    why: "import { bindSceneSignals } from '@aster/core/signals': a click updates a signal",
    dom: true,
    imports: `import { createChartSession, renderSceneToDomElement } from '@aster/core/dom'\nimport { bindSceneSignals } from '@aster/core/signals'`,
    body: `
      const session = createChartSession()
      const scene = session.evaluate(${lit(SIGNAL_VG)}, {})
      const svg = renderSceneToDomElement(scene)
      document.body.appendChild(svg)
      const seen = []
      const binding = bindSceneSignals(svg, scene, {}, { onSignal: (name, value) => seen.push([name, value]) })
      svg.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      binding.detach()
      return { seen }`,
    check: (r) => [[r.seen.some(([n, v]) => n === 'clicks' && v === 1), 'the click handler ran and wrote the signal']],
  },
  {
    name: 'core-expression-fn',
    why: 'registerExpressionFunction (a call, not an import effect) keeps working',
    imports: `import { renderSpec, registerExpressionFunction } from '@aster/core'`,
    body: `
      registerExpressionFunction('triple', (n) => n * 3)
      const svg = renderSpec({ width: 50, height: 50, data: [{ name: 't', values: [{ v: 1 }] }],
        marks: [{ type: 'rect', from: { data: 't' }, encode: { enter: { x: { value: 0 }, y: { value: 0 }, width: { signal: 'triple(7)' }, height: { value: 5 } } } }] })
      return { svg }`,
    check: (r) => [[/h21v5/.test(r.svg), 'the registered function is evaluated (7 * 3)']],
  },
  {
    name: 'core-stream',
    why: 'createChartStream from the barrel',
    imports: `import { createChartStream } from '@aster/core'`,
    body: `
      const spec = { width: 100, height: 50, data: [{ name: 't', values: [] }], scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }],
        marks: [{ type: 'rect', from: { data: 't' }, encode: { enter: { x: { scale: 'x', field: 'v' }, y: { value: 0 }, width: { value: 4 }, height: { value: 4 } } } }] }
      const stream = createChartStream(spec, {})
      stream.push({ append: { t: [{ v: 1 }, { v: 2 }] } })
      const flush = stream.flush()
      return { rows: flush ? flush.scene.width : -1, stats: stream.stats().flushes ?? stream.stats() }`,
    check: (r) => [[r.rows > 0, 'the stream appends and flushes a scene']],
  },
  {
    name: 'vl-compile',
    why: "import { compile } from '@aster/vl'",
    imports: `import { compile } from '@aster/vl'\nimport { renderSpec } from '@aster/core'`,
    body: `const vg = compile(${lit(BAR_VL)}); return { marks: vg.marks.length, svg: renderSpec(vg) }`,
    check: (r) => [[r.marks >= 1 && /class="mark-rect/.test(r.svg), 'a Vega-Lite spec compiles and renders']],
  },
  {
    name: 'react-chart',
    why: "import { Chart } from '@aster/react': server markup and a client mount",
    dom: true,
    imports: `import * as React from 'react'\nimport { renderToString } from 'react-dom/server'\nimport { flushSync } from 'react-dom'\nimport { createRoot } from 'react-dom/client'\nimport { Chart } from '@aster/react'`,
    body: `
      const el = React.createElement(Chart, { spec: ${lit(BAR_VG)}, width: 300, height: 200 })
      const html = renderToString(el)
      const host = document.createElement('div'); document.body.appendChild(host)
      flushSync(() => createRoot(host).render(el))
      return { html, client: host.innerHTML }`,
    check: (r) => [
      [/<svg/.test(r.html) && /class="mark-rect/.test(r.html), 'server render'],
      [/<svg/.test(r.client) && /class="mark-rect/.test(r.client), 'client mount'],
      [/aria-label="[XY]-axis/.test(r.html), 'axis caption'],
    ],
    modules: (m) => [[hasModule(m.contributing, 'core', 'canvas') && hasModule(m.contributing, 'core', 'hit') && hasModule(m.contributing, 'core', 'signals'), '<Chart> carries the canvas renderer, the hit index and the signal loop (the module check can see them)']],
  },
  {
    name: 'react-svgchart',
    why: "import { SvgChart } from '@aster/react/lite': renders and reports a missing event loop, and the bundle holds NO canvas, hit or signals code",
    dom: true,
    imports: `import * as React from 'react'\nimport { renderToString } from 'react-dom/server'\nimport { flushSync } from 'react-dom'\nimport { createRoot } from 'react-dom/client'\nimport { SvgChart } from '@aster/react/lite'`,
    body: `
      const el = React.createElement(SvgChart, { spec: ${lit(BAR_VG)}, width: 300, height: 200 })
      const html = renderToString(el)
      const host = document.createElement('div'); document.body.appendChild(host)
      flushSync(() => createRoot(host).render(el))
      const errors = []
      const host2 = document.createElement('div'); document.body.appendChild(host2)
      flushSync(() => createRoot(host2).render(React.createElement(SvgChart, { spec: ${lit(SIGNAL_VG)}, width: 100, height: 100, onError: (e) => errors.push(e.message) })))
      return { html, client: host.innerHTML, errors, streamSvg: host2.innerHTML }`,
    check: (r) => [
      [/<svg/.test(r.html) && /class="mark-rect/.test(r.html), 'server render'],
      [/<svg/.test(r.client) && /class="mark-rect/.test(r.client), 'client mount'],
      [/aria-label="[XY]-axis/.test(r.html), 'axis caption'],
      [r.errors.length === 1 && /event streams/.test(r.errors[0]) && /@aster\/react\/interaction/.test(r.errors[0]), 'an event-stream spec without `interaction` reports how to fix it'],
      [/<svg/.test(r.streamSvg), 'and still renders'],
    ],
    modules: (m) => [
      [!hasModule(m.parsed, 'core', 'canvas'), 'the canvas renderer (core/canvas.js) is not even read'],
      [!hasModule(m.parsed, 'core', 'hit'), 'the hit index (core/hit.js) is not even read'],
      [!hasModule(m.parsed, 'core', 'signals'), 'the signal event loop (core/signals.js) is not even read'],
      [!hasModule(m.parsed, 'react', 'canvas-capability') && !hasModule(m.parsed, 'react', 'interaction-capability'), 'neither capability module of @aster/react is read'],
      [hasModule(m.contributing, 'react', 'ChartCore') && hasModule(m.contributing, 'core', 'dom'), 'ChartCore and the DOM patcher are what it is made of'],
    ],
  },
  {
    name: 'react-svgchart-interaction',
    why: "import { SvgChart } from '@aster/react/lite' + { interaction } from '@aster/react/interaction': a click drives a signal; hit and signals are in the bundle, canvas is not",
    dom: true,
    imports: `import * as React from 'react'\nimport { flushSync } from 'react-dom'\nimport { createRoot } from 'react-dom/client'\nimport { SvgChart } from '@aster/react/lite'\nimport { interaction } from '@aster/react/interaction'`,
    body: `
      const ref = React.createRef()
      const errors = []
      const host = document.createElement('div'); document.body.appendChild(host)
      flushSync(() => createRoot(host).render(React.createElement(SvgChart, { ref, interaction, spec: ${lit(SIGNAL_VG)}, width: 100, height: 100, tooltip: true, onError: (e) => errors.push(e.message) })))
      const before = ref.current.getSignals().clicks
      flushSync(() => { host.querySelector('svg').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
      const rect = host.querySelector('.mark-rect path')
      rect.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 15, clientY: 15 }))
      await new Promise((r) => setTimeout(r, 30)) // a continuous event: React renders it on the next tick
      return { before: before ?? null, after: ref.current.getSignals().clicks, errors, stamped: host.querySelector('[data-datum]') !== null, tooltip: !!host.querySelector('[data-testid="chart-tooltip"]') }`,
    check: (r) => [
      [r.after === 1, 'the click ran the spec\'s signal.on handler (the event loop is bound)'],
      [r.errors.length === 0, 'no capability is reported missing'],
      [!r.stamped && r.tooltip, 'the markup carries no data-datum (it is vega\'s), and the tooltip resolves the hovered datum through the hit index'],
    ],
    modules: (m) => [
      [hasModule(m.contributing, 'core', 'hit') && hasModule(m.contributing, 'core', 'signals'), 'hit.js and signals.js contribute code'],
      [!hasModule(m.parsed, 'core', 'canvas') && !hasModule(m.parsed, 'react', 'canvas-capability'), 'the canvas renderer is not even read'],
    ],
  },
  {
    name: 'react-usechart',
    why: "import { useChart } from '@aster/react'",
    imports: `import * as React from 'react'\nimport { renderToString } from 'react-dom/server'\nimport { useChart } from '@aster/react'`,
    body: `
      function App() { const r = useChart(${lit(BAR_VG)}, { width: 300, height: 200 }); return React.createElement('div', { 'data-scene': r.scene ? 'yes' : 'none', dangerouslySetInnerHTML: { __html: r.svg ?? '' } }) }
      function Headless() { const r = useChart(${lit(BAR_VG)}, { serialize: false }); return React.createElement('i', { 'data-w': r.scene ? r.scene.width : 'none', 'data-svg': String(r.svg) }) }
      return { html: renderToString(React.createElement(App)), headless: renderToString(React.createElement(Headless)) }`,
    check: (r) => [
      [/data-scene="yes"/.test(r.html) && /class="mark-rect/.test(r.html), 'useChart returns the scene and the svg'],
      [/data-w="\d+"/.test(r.headless) && /data-svg="null"/.test(r.headless), 'headless useChart (serialize: false) returns a scene only'],
    ],
  },
  {
    name: 'react-autoload',
    why: "<Chart> with nothing imported: a plain spec imports no add-on; pie, a projection and csv text load theirs on demand, from chunks the entry does not contain, and render what the static path renders",
    split: true,
    dom: true,
    imports: `import * as React from 'react'\nimport { flushSync } from 'react-dom'\nimport { createRoot } from 'react-dom/client'\nimport { Chart } from '@aster/react'\nimport { renderSpec, geoRegistry, transformRegistry, dataFormatRegistry } from '@aster/core'`,
    body: `
      const registered = () => ({ geo: geoRegistry.buildProjection !== null, transforms: transformRegistry.size > 0, load: dataFormatRegistry.has('csv') })
      const mount = (spec) => {
        const host = document.createElement('div'); document.body.appendChild(host)
        flushSync(() => createRoot(host).render(React.createElement(React.Suspense, { fallback: React.createElement('i', { id: 'fb' }) }, React.createElement(Chart, { spec, width: 300, height: 200, a11y: false }))))
        return host
      }
      const svgOf = (host) => host.querySelector('svg')?.outerHTML ?? null
      const staticSvg = (spec) => { const h = document.createElement('div'); h.innerHTML = renderSpec(spec, { width: 300, height: 200 }); return h.firstElementChild.outerHTML }
      const settle = async (host) => { for (let i = 0; i < 400 && !host.querySelector('svg'); i++) await new Promise((r) => setTimeout(r, 10)) }
      const out = {}
      const plain = mount(${lit(BAR_VG)})
      out.plainSync = !!plain.querySelector('svg') && !plain.querySelector('#fb')
      out.afterPlain = registered()
      const pie = mount(${lit(corpus('t-pie.vg.json'))})
      out.pieFallback = !!pie.querySelector('#fb')
      await settle(pie)
      out.afterPie = registered()
      out.pieSame = svgOf(pie) === staticSvg(${lit(corpus('t-pie.vg.json'))})
      const geo = mount(${lit(GEO_VG)})
      out.geoFallback = !!geo.querySelector('#fb')
      await settle(geo)
      out.afterGeo = registered()
      out.geoSame = svgOf(geo) === staticSvg(${lit(GEO_VG)})
      const CSV = { width: 100, height: 40, padding: 0, data: [{ name: 't', values: 'k,v\\na,1\\nb,2', format: { type: 'csv', parse: { v: 'number' } } }],
        scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: 'width' }],
        marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { value: 10 } } } }] }
      const csv = mount(CSV)
      out.csvFallback = !!csv.querySelector('#fb')
      await settle(csv)
      out.afterCsv = registered()
      out.csvSame = svgOf(csv) === staticSvg(CSV)
      return out`,
    check: (r) => [
      [r.plainSync === true, 'a plain spec renders in the first commit, with no fallback'],
      [r.afterPlain.geo === false && r.afterPlain.transforms === false && r.afterPlain.load === false, 'and imports no add-on (nothing registered after it)'],
      [r.pieFallback === true && r.afterPie.transforms === true && r.afterPie.geo === false && r.afterPie.load === false, 'pie: the fallback shows, then only the transforms add-on is loaded'],
      [r.pieSame === true, 'pie renders what renderSpec renders'],
      [r.geoFallback === true && r.afterGeo.geo === true && r.afterGeo.load === false, 'a projection: the fallback shows, then the geo add-on is loaded (not load)'],
      [r.geoSame === true, 'the map renders what renderSpec renders'],
      [r.csvFallback === true && r.afterCsv.load === true, 'csv text: the fallback shows, then the load add-on is loaded'],
      [r.csvSame === true, 'the csv chart renders what renderSpec renders'],
    ],
    modules: (m) => {
      const geoOut = outputsWith(m, 'core', 'addon-geo')
      const trOut = outputsWith(m, 'core', 'transform-extra')
      const loadOut = outputsWith(m, 'core', 'addon-load')
      return [
        [geoOut.length === 1 && !geoOut[0].initial, 'the geo add-on is in a chunk of its own, loaded on demand (not by the entry)'],
        [trOut.length === 1 && !trOut[0].initial, 'the transforms add-on is in a chunk of its own, loaded on demand'],
        [loadOut.length === 1 && !loadOut[0].initial, 'the load add-on is in a chunk of its own, loaded on demand'],
        [new Set([geoOut[0]?.file, trOut[0]?.file, loadOut[0]?.file]).size === 3, 'and each in its own chunk, so a spec pays for the add-ons it needs only'],
      ]
    },
  },
  {
    name: 'react-autoload-static',
    why: "an app that imports an add-on itself: <Chart> renders at once, the add-on is in the entry once and no chunk of it is built twice",
    split: true,
    dom: true,
    imports: `import * as React from 'react'\nimport { flushSync } from 'react-dom'\nimport { createRoot } from 'react-dom/client'\nimport '@aster/core/geo'\nimport { Chart } from '@aster/react'\nimport { renderSpec } from '@aster/core'`,
    body: `
      const host = document.createElement('div'); document.body.appendChild(host)
      flushSync(() => createRoot(host).render(React.createElement(React.Suspense, { fallback: React.createElement('i', { id: 'fb' }) }, React.createElement(Chart, { spec: ${lit(GEO_VG)}, width: 300, height: 200, a11y: false }))))
      const h = document.createElement('div'); h.innerHTML = renderSpec(${lit(GEO_VG)}, { width: 300, height: 200 })
      return { sync: !!host.querySelector('svg') && !host.querySelector('#fb'), same: host.querySelector('svg')?.outerHTML === h.firstElementChild.outerHTML }`,
    check: (r) => [
      [r.sync === true, 'the map renders in the first commit (the add-on is found, nothing is imported)'],
      [r.same === true, 'and is what renderSpec renders'],
    ],
    modules: (m) => {
      const geoOut = outputsWith(m, 'core', 'addon-geo')
      return [
        [geoOut.length === 1 && geoOut[0].initial, 'the geo add-on is in one output, loaded up front with the entry (the dynamic import of it resolves to the same module)'],
        [outputsWith(m, 'core', 'addon-transforms').length + outputsWith(m, 'core', 'transform-extra').filter((o) => o.initial).length === 0, 'and the add-ons it did not import are not loaded up front'],
      ]
    },
  },
  {
    name: 'react-vl',
    why: "import '@aster/react/vl' registers the Vega-Lite compiler for <Chart> and useChart",
    imports: `import * as React from 'react'\nimport { renderToString } from 'react-dom/server'\nimport '@aster/react/vl'\nimport { Chart, useChart, hasVegaLiteCompiler } from '@aster/react'`,
    body: `
      function Hook() { const r = useChart(${lit(BAR_VL)}); return React.createElement('div', { dangerouslySetInnerHTML: { __html: r.svg ?? ('ERR ' + r.error) } }) }
      return { has: hasVegaLiteCompiler(), chart: renderToString(React.createElement(Chart, { spec: ${lit(BAR_VL)}, width: 200, height: 100 })), hook: renderToString(React.createElement(Hook)) }`,
    check: (r) => [
      [r.has === true, 'hasVegaLiteCompiler() is true'],
      [/class="mark-rect/.test(r.chart), '<Chart> renders a Vega-Lite spec'],
      [/class="mark-rect/.test(r.hook), 'useChart renders a Vega-Lite spec'],
    ],
  },
  {
    name: 'react-novl',
    why: 'without the vl import a Vega-Lite spec asks for it (the base entry carries no compiler)',
    imports: `import * as React from 'react'\nimport { renderToString } from 'react-dom/server'\nimport { Chart, hasVegaLiteCompiler } from '@aster/react'`,
    body: `
      let err = null
      try { renderToString(React.createElement(Chart, { spec: ${lit(BAR_VL)}, width: 200, height: 100 })) } catch (e) { err = String(e.message) }
      return { has: hasVegaLiteCompiler(), err }`,
    check: (r) => [[r.has === false && /@aster\/react\/vl/.test(r.err ?? ''), 'the error names the import to add']],
  },
  {
    name: 'react-ssr',
    why: "import { renderChartToStaticMarkup, hydrateChart } from '@aster/react/ssr'",
    dom: true,
    imports: `import { renderChartToStaticMarkup, hydrateChart } from '@aster/react/ssr'`,
    body: `
      const markup = renderChartToStaticMarkup(${lit(BAR_VG)}, { width: 300, height: 200 })
      const host = document.createElement('div'); host.innerHTML = markup; document.body.appendChild(host)
      const adopted = host.querySelector('svg')
      const h = hydrateChart(host, ${lit(BAR_VG)}, { width: 300, height: 200 })
      return { markup, reused: h.reused, same: h.svg === adopted }`,
    check: (r) => [
      [/<svg/.test(r.markup) && /aria-label="[XY]-axis/.test(r.markup), 'static markup'],
      [r.reused === true && r.same === true, 'hydrateChart adopts the server svg'],
    ],
  },
  {
    name: 'react-worker',
    why: "import { handleChartWorkerRequest } from '@aster/react' (+ '@aster/react/vl' inside the worker)",
    imports: `import '@aster/react/vl'\nimport { handleChartWorkerRequest } from '@aster/react'`,
    body: `return { vg: handleChartWorkerRequest({ id: 1, spec: ${lit(BAR_VG)} }), vl: handleChartWorkerRequest({ id: 2, spec: ${lit(BAR_VL)} }) }`,
    check: (r) => [
      [r.vg.id === 1 && /class="mark-rect/.test(r.vg.svg ?? ''), 'a Vega request is answered'],
      [r.vl.id === 2 && /class="mark-rect/.test(r.vl.svg ?? ''), 'a Vega-Lite request is answered (compiler registered in the worker)'],
    ],
  },
  {
    name: 'react-worker-entry',
    why: "import '@aster/react/worker-entry' installs self.onmessage (the whole point of the import)",
    imports: `import '@aster/react/worker-entry'`,
    pre: `globalThis.__sent = []; globalThis.postMessage = (m) => globalThis.__sent.push(m)`,
    body: `
      const handler = globalThis.onmessage
      if (typeof handler !== 'function') return { installed: false }
      handler({ data: { id: 7, spec: ${lit(BAR_VG)} } })
      return { installed: true, sent: globalThis.__sent }`,
    check: (r) => [
      [r.installed === true, 'onmessage is installed'],
      [r.installed && r.sent.length === 1 && r.sent[0].id === 7 && /class="mark-rect/.test(r.sent[0].svg ?? ''), 'a request is answered with the svg'],
    ],
  },
]

// ---------------------------------------------------------------------------------------------------------------

/** Pretend every aster module is side-effect free: what a blanket `"sideEffects": false` tells the bundler. */
const blanketFalse = {
  name: 'blanket-side-effects-false',
  setup(b) {
    b.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData?.skip || args.kind === 'entry-point') return undefined
      const r = await b.resolve(args.path, { kind: args.kind, importer: args.importer, namespace: args.namespace, resolveDir: args.resolveDir, pluginData: { skip: true } })
      if (r.errors.length || !/[\\/]packages[\\/](core|react|vl)[\\/]dist[\\/]/.test(r.path)) return undefined
      return { path: r.path, sideEffects: false }
    })
  },
}

async function esbuildBuild(p, entry, out) {
  const result = await build({
    entryPoints: [entry],
    outdir: out,
    bundle: true,
    minify: true,
    treeShaking: true,
    format: 'esm',
    platform: 'node',
    splitting: !!p.split,
    // React is a peer dependency of the consumer's app, not part of what is being shaken.
    external: ['react', 'react-dom', 'react-dom/*', 'react/jsx-runtime'],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
    metafile: true,
    plugins: BLANKET_FALSE ? [blanketFalse] : [],
  })
  return modulesOf(result.metafile)
}

/**
 * What the bundle is made of, from esbuild's metafile: `parsed` = every input the bundler read, `contributing` = the
 * inputs that put code in the output (bytesInOutput > 0). A pattern asserts on these, so "does not contain the canvas
 * renderer" is a statement about modules, not about a byte count that a refactor could move.
 */
function modulesOf(metafile) {
  const rel = (f) => f.replace(/\\/g, '/')
  const parsed = new Set(Object.keys(metafile.inputs).map(rel))
  const contributing = new Set()
  const outputs = []
  for (const [file, out] of Object.entries(metafile.outputs)) {
    const inputs = []
    for (const [f, info] of Object.entries(out.inputs)) if (info.bytesInOutput > 0) { contributing.add(rel(f)); inputs.push(rel(f)) }
    // (esbuild gives every chunk that a dynamic import() starts an entryPoint too; the app is the one built from app.mjs)
    outputs.push({ file: rel(file), entry: /app\.mjs$/.test(out.entryPoint ?? ''), inputs, static: out.imports.filter((i) => i.kind === 'import-statement').map((i) => rel(i.path)) })
  }
  // what loads up front: the app and every chunk it (transitively) imports with a static import - the rest is fetched on demand
  const initial = new Set()
  const visit = (f) => {
    if (initial.has(f)) return
    initial.add(f)
    for (const i of outputs.find((o) => o.file === f)?.static ?? []) visit(i)
  }
  for (const o of outputs) if (o.entry) visit(o.file)
  for (const o of outputs) o.initial = initial.has(o.file)
  return { parsed: [...parsed], contributing: [...contributing], outputs }
}

/** Dist modules of the three packages, by name: `dist('core', 'canvas')` matches packages/core/dist/canvas.js. */
const distRe = (pkg, name) => new RegExp(`packages/${pkg}/dist/${name}\\.js$`)
const hasModule = (list, pkg, name) => list.some((f) => distRe(pkg, name).test(f))
/** The output files (entry or chunk) in which a dist module contributes code. */
const outputsWith = (m, pkg, name) => m.outputs.filter((o) => hasModule(o.inputs, pkg, name))

async function viteBuild(p, entry, out) {  // (no module report: the metafile is esbuild's)
  if (BLANKET_FALSE) throw new Error('--blanket-false is an esbuild plugin; for vite edit the manifests instead')
  const store = join(ROOT, 'node_modules', '.pnpm')
  const dir = readdirSync(store).filter((d) => /^vite@/.test(d)).sort().pop()
  if (!dir) throw new Error('vite is not installed (it is a vitest dependency in the pnpm store)')
  const vite = await import(pathToFileURL(join(store, dir, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href)
  await vite.build({
    root: dirname(entry),
    configFile: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    ssr: { noExternal: [/^@aster\//], external: ['react', 'react-dom'] },
    build: {
      ssr: entry,
      outDir: out,
      emptyOutDir: true,
      minify: 'esbuild',
      target: 'esnext',
      rollupOptions: { output: { format: 'es', entryFileNames: 'app.js' }, external: [/^react($|\/)/, /^react-dom($|\/)/] },
    },
  })
}

async function bundle(p, dir) {
  const entry = join(dir, 'app.mjs')
  writeFileSync(entry, `${p.imports}\nexport default async function run(env) {${p.body}\n}\n`)
  const out = join(dir, 'out')
  let modules = null
  if (BUNDLER === 'vite') await viteBuild(p, entry, out)
  else modules = await esbuildBuild(p, entry, out)
  // Runner: optional jsdom globals, then the bundle, then one JSON line.
  const runner = join(dir, 'runner.mjs')
  writeFileSync(runner, `
${p.dom ? `import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true, url: 'http://localhost/' })
for (const k of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event', 'MouseEvent', 'MutationObserver', 'DOMParser', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, k, { value: k === 'window' ? dom.window : dom.window[k], configurable: true, writable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = false
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
` : ''}${p.pre ?? ''}
const mod = await import(${JSON.stringify(pathToFileURL(join(out, 'app.js')).href)})
const result = await mod.default(JSON.parse(process.env.ASTER_SHAKE_ENV ?? '{}'))
process.stdout.write('\\n@@RESULT@@' + JSON.stringify(result) + '\\n')
process.exit(0)
`)
  return { runner, modules }
}

function runPattern(p, env) {
  const dir = join(TMP, p.name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return bundle(p, dir).then(({ runner, modules }) => new Promise((resolve) => {
    // async spawn: the parent's http server (core-load) must keep serving while the child runs
    const child = spawn(process.execPath, [runner], { env: { ...process.env, ASTER_SHAKE_ENV: JSON.stringify(env) } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      const m = /@@RESULT@@(.*)/.exec(stdout)
      if (!m) return resolve({ error: (stderr || stdout || `exit ${code}`).trim().split('\n').slice(-6).join('\n') })
      resolve({ result: JSON.parse(m[1]), modules })
    })
  }))
}

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/csv')
  res.end('a,b\n1,2\n4,5\n7,8\n')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const env = { url: `http://127.0.0.1:${server.address().port}/data.csv` }

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
let failures = 0
try {
  for (const p of PATTERNS) {
    if (only && !only.has(p.name)) continue
    let outcome
    try {
      outcome = await runPattern(p, env)
    } catch (e) {
      outcome = { error: `bundle failed: ${e.message}` }
    }
    if (outcome.error) {
      failures++
      console.log(`FAIL ${p.name.padEnd(20)} ${p.why}\n       ${outcome.error.replace(/\n/g, '\n       ')}`)
      continue
    }
    if (argv.includes('--verbose')) console.log(JSON.stringify(outcome.result).slice(0, 600))
    // `p.modules(m)`: assertions on what the bundle is made of (esbuild only; skipped under --bundler vite)
    if (argv.includes('--outputs') && outcome.modules?.outputs) for (const o of outcome.modules.outputs) console.log('  out', o.file, o.entry ? 'ENTRY' : '', o.inputs.filter((f) => /addon|transform-extra/.test(f)).join(','))
    const checks = [...p.check(outcome.result), ...(p.modules && outcome.modules ? p.modules(outcome.modules) : [])]
    const bad = checks.filter(([ok]) => !ok).map(([, what]) => what)
    if (bad.length) {
      failures++
      console.log(`FAIL ${p.name.padEnd(20)} ${p.why}`)
      for (const b of bad) console.log(`       expected: ${b}`)
    } else {
      console.log(`ok   ${p.name.padEnd(20)} ${p.why}`)
    }
  }
} finally {
  server.close()
  rmSync(TMP, { recursive: true, force: true })
}
console.log(failures ? `\n[bundle-shaking] ${failures} pattern(s) FAILED${BLANKET_FALSE ? ' (under --blanket-false)' : ''}` : `\n[bundle-shaking] all patterns passed${BLANKET_FALSE ? ' (under --blanket-false: the check does not bite!)' : ''}`)
process.exit(failures ? 1 : 0)
