import { build } from 'esbuild'
import { writeFileSync, readFileSync, statSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

// Per-entry bundle gates (R11.5).
//
// The original gate only measured `renderSpec` from the core barrel. This one
// measures every published entry point independently, so an accidental import
// from the canvas/dom/hit/signals addons (or from the React wrapper) into the
// base bundle fails a named row instead of being hidden by one aggregate.
//
// Measured 2026-10 on the integrated audit stack (gzip, minified; react/react-dom external;
// main: core 109.2, dom 111.7, canvas 12.7, hit 1.5, signals 28.1, react 137.4, react/vl 159.8):
//   @aster/core          113.4 kB
//   @aster/core/dom      116.6 kB
//   @aster/core/canvas    15.3 kB
//   @aster/core/hit       15.6 kB
//   @aster/core/signals   27.8 kB
//   @aster/react         145.7 kB (Vega only)
//   @aster/react/vl      168.1 kB (base + the from-scratch VL compiler)
//
// Re-baselined for the strict-oracle PR (+4.4 kB gzip on core and core/dom, measured
// 113.6 / 116.4 kB; the previous budget was met to the byte). What the oracle forced in,
// each of it a vega behaviour the engine lacked: vega's default config and its merge rule
// (config-defaults, ~0.9 kB), the SVG path parser/renderer for custom symbol shapes
// (svg-path, ~1.4 kB), content-addressed clip/gradient ids (svg-defs), the shared paint
// table + vega text/transform/clip/image markup in render and dom (net ~+0.5 kB: dom shrank
// 0.8 kB), exact guide order, gradient stops from the scale, the Overlap transform for
// gradient labels, axis/legend/header properties and the sequential-scale path (runtime,
// compiler, scale(s), ~1.5 kB). Headroom over the measured values is ~1.5 kB, as before.
//
// History of the core floor: the 80 kB budget was re-baselined repeatedly as
// the engine took ownership of its stack (ADR 0001): colour (+3.5), calendar
// (+1.8), format (+4.7), parity tails (+4). The a11y tree (+2.3) and the
// wall-clock limiter (+0.3) are the R10/R12 additions; the stream API and
// length-changing pulse propagation (+~2) plus the streaming React components
// (+~4) are the R13 additions. The budget's job is
// regression detection, so each entry gets measured headroom rather than a
// number that no longer describes the library.
//
// Audit C43/C47 re-baseline: the DOM descriptor now takes every attribute from
// render.ts's per-element lists (dom +2.4 kB: clipped rounded bars, leaf clips,
// frame parity were missing from the DOM path), and the hit index picks against
// the PAINTED geometry instead of bounding boxes (hit 1.5 -> 14.0 kB standalone:
// path flattening, arc/line/area/trail outlines and the layout's text bounds).
// Alongside @aster/core the hit entry shares most of that code, so its marginal
// cost in an app is far smaller than the standalone row suggests.
const BUDGETS = {
  // Untrusted-input work (limit meters, parser depth guard, image url policy, vega-exact
  // stratify/bin): core 113.4 -> 116.3, dom 116.6 -> 119.6 gzip (+2.9/+3.0). Ceilings are
  // measured + 0.5 kB; the owner decides whether to keep them (flagged in the PR).
  // Static ReDoS screen (regex-screen.ts, ~2.0 kB gzip): core 116.3 -> 118.3, dom 119.6 -> 121.7.
  // Vega-faithful transform layer (aggregate/joinaggregate/pivot/window measure engine incl. bootstrap CI,
  // bin, timeunit with vega-time bin/detectTimeUnits, impute, lookup, stack, sample, access paths):
  // core 118.3 -> 122.9, dom 121.7 -> 126.3 gzip (+4.6). Ceilings are measured + 0.5 kB; OWNER DECISION
  // (flagged in the report): the old hand-written transforms were smaller because they were wrong.
  // Faithful scale/projection/interpolator ports (vega-parser parseScale + vega-encode Scale transform,
  // vega-geo Projection, the d3-interpolate colour spaces): core 123.0 -> 124.0, dom 126.3 -> 127.3 gzip
  // (+1.0). Ceilings are measured + 0.5 kB (owner approved).
  // Vega-faithful signal event loop (event-selector parser, stream graph, event extension, logger: signals
  // 32.4 -> 41.0 gzip, the entry also carries the expression engine), the entry evaluator, error recovery and group
  // paint/clip (core 124.1 -> 125.3, dom 127.4 -> 128.6). Ceilings are measured + 0.5 kB (owner approved raises).
  '@aster/core': 125.8 * 1024,
  '@aster/core/dom': 129.1 * 1024,
  '@aster/core/canvas': 20 * 1024,
  '@aster/core/hit': 16 * 1024,
  '@aster/core/signals': 41.5 * 1024,
  // 180 kB leaves headroom for feature work; measured values are recorded at
  // the top of this file and in `pnpm bench:bundle`.
  '@aster/react': 180 * 1024,
  // Base + VL compiler. The compiler is opt-in (`import '@aster/react/vl'`),
  // so the base row above is the one to watch for React-side regressions.
  // 209 = measured 208.5 + 0.5. The compiler is ~51.5 kB gzip of that (react base 157.0): it grew
  // from ~22.6 kB when @aster/vl became production-usable (validation layer, VL transform table,
  // composition nesting, errorbar/errorband, config.scale, invalid-value modes, safe escaping).
  // 213.8 = measured 213.3 + 0.5 (owner approved). The React audit fixes grew the base entry 157.0 -> 161.7
  // gzip and so this row by the same ~4.7 kB: positional-scale derivation and serialized scales (pan/zoom for
  // any scale name and for worker scenes), the worker protocol (limits, text metrics and url policy by name,
  // validation, bounded producer queue), content-keyed lifecycles, stream recovery, the roving-tabindex a11y
  // tree and the LoadOptions pass-through.
  '@aster/react/vl': 218.8 * 1024,
}

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const MONOREPO_ROOT = dirname(dirname(dirname(THIS_DIR)))
const TMP = join(MONOREPO_ROOT, 'packages', 'benchmarks', '.tmp')

const ENTRIES = [
  {
    name: '@aster/core',
    file: 'core.mjs',
    platform: 'node',
    src: String.raw`import { renderSpec } from '@aster/core'
const spec = { width: 400, height: 300, data: [{ name: 't', values: [{ x: 0, y: 10 }] }], scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' }], marks: [] }
export default () => renderSpec(spec)
`,
  },
  {
    name: '@aster/core/dom',
    file: 'dom.mjs',
    platform: 'node',
    src: String.raw`import { createChartSession, patchSceneDom } from '@aster/core/dom'
export default { createChartSession, patchSceneDom }
`,
  },
  {
    name: '@aster/core/canvas',
    file: 'canvas.mjs',
    platform: 'node',
    src: String.raw`import { renderSceneToCanvas } from '@aster/core/canvas'
export default renderSceneToCanvas
`,
  },
  {
    name: '@aster/core/hit',
    file: 'hit.mjs',
    platform: 'node',
    src: String.raw`import { buildHitIndex } from '@aster/core/hit'
export default buildHitIndex
`,
  },
  {
    name: '@aster/core/signals',
    file: 'signals.mjs',
    platform: 'node',
    src: String.raw`import { bindSceneSignals } from '@aster/core/signals'
export default bindSceneSignals
`,
  },
  {
    name: '@aster/react',
    file: 'react.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import { Chart } from '@aster/react'
export default Chart
`,
  },
  {
    name: '@aster/react/vl',
    file: 'react-vl.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import '@aster/react/vl'
import { Chart } from '@aster/react'
export default Chart
`,
  },
]

function setupTmp() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
}

function coreAlreadyBuilt() {
  try {
    statSync(join(MONOREPO_ROOT, 'packages', 'core', 'dist', 'index.js'))
    statSync(join(MONOREPO_ROOT, 'packages', 'react', 'dist', 'index.js'))
    return true
  } catch {
    return false
  }
}

const KB = (n) => (n / 1024).toFixed(1)

try {
  setupTmp()
  if (!coreAlreadyBuilt()) {
    console.error('Run `pnpm build` first')
    process.exit(1)
  }

  let failed = false
  for (const entry of ENTRIES) {
    const entryPath = join(TMP, entry.file)
    const outPath = join(TMP, 'out.mjs')
    writeFileSync(entryPath, entry.src)
    await build({
      entryPoints: [entryPath],
      bundle: true,
      minify: true,
      format: 'esm',
      platform: entry.platform,
      write: true,
      outfile: outPath,
      logLevel: 'silent',
      external: entry.external,
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    const buf = readFileSync(outPath)
    const gz = gzipSync(buf).length
    const budget = BUDGETS[entry.name]
    const pass = gz <= budget
    if (!pass) failed = true
    console.log(
      `${entry.name.padEnd(20)} min=${KB(buf.length).padStart(7)} kB  gzip=${KB(gz).padStart(6)} kB  budget=${KB(budget).padStart(5)} kB  ${pass ? 'PASS' : 'FAIL'}`,
    )
  }
  if (failed) process.exit(1)
} catch (err) {
  console.error(`error: ${err.message}`)
  process.exit(1)
} finally {
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch { /* ignore */ }
}
