import { build } from 'esbuild'
import { writeFileSync, readFileSync, statSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

// Per-import-pattern bundle gates (R11.5, reshaped with the `sideEffects` work).
//
// Every row bundles a tiny app that imports ONE documented pattern (esbuild, minify, NODE_ENV=production, tree-shaking
// on, react/react-dom external) and gates its gzip size. What a row means:
//
//   absolute rows  the whole bundle of that app: core `renderSpec`, `useChart`, `<Chart>`, `<Chart>` + the VL compiler.
//   marginal rows  "+ @aster/core/<addon>": the addon's gzip ADDED to the `@aster/core` app. The addons share most of
//                  their code with core, so a standalone figure (the old rows: hit 15.6, load 14.6) double counts it
//                  and hid regressions: what an app pays for `+ hit` is ~5 kB.
//
// Tree-shaking is part of what these rows watch. Without a correct `sideEffects` field in the package manifests the
// `useChart` app drags in Chart, ChartStream, the worker host and the batch helpers (163.9 kB instead of 126.4), so
// that row fails the moment the field is dropped or widened (`ASTER_BUDGET_IGNORE_SIDE_EFFECTS=1` simulates it and
// scripts/bundle-shaking.test.mjs asserts the row fails). The opposite failure, a `sideEffects` list that is too
// narrow, is caught by scripts/check-bundle-shaking.mjs, which executes the bundles.
//
// Every ceiling is the measured value + 0.5 kB (gzip, default level; `pnpm --filter @aster/benchmarks run budget`).
// A change that needs more room edits the number here, in the PR, where the owner sees it. The history of why the
// core row grew (colour, calendar, format, transforms, scales, signals, limits, ...) is in docs/PERFORMANCE.md and the
// git log of this file.
//
// Selections (vega-selections port, modify, the vl* expression functions, dataset edits and {scale} events in the signal
// loop, and the VL selection compiler) raised core to 125.7, signals 5.7, useChart 129.1, Chart 161.4, SvgChart 144.8,
// SvgChart + interaction 155.7 and Chart + VL 227.6 (the VL row carries ~14 kB of the selection compiler).
// Group scopes (scoped signals in the runtime, the loop's per-scope streams and batching, the group pick) and composed-view
// selections in the VL compiler then took core to 126.3, signals 6.8, useChart 129.7, Chart 163.2, SvgChart + interaction 157.5
// and Chart + VL 230.7.
// Earlier measurement, 2026-10-23 (kB gzip): core 123.1; marginal dom 5.7, canvas 4.8, hit 5.0, signals 4.4, load 5.1,
// geo 12.3, transforms 15.1; useChart 126.4; Chart 157.2; Chart + VL 211.3; SvgChart 142.0; SvgChart + interaction 151.5.
// `<Chart>` was 156.5 (+ VL 210.7) before it became a shell over ChartCore with injected capabilities: the +0.7 is the
// capability indirection (property reads the minifier cannot rename) and the report of a missing capability, which
// `<Chart>` never needs but shares with `<SvgChart>` (one implementation is the point; see docs/ARCHITECTURE.md).
// Measured 2026-10-26 (kB gzip), after the Vega-Lite maps and animation work: core 125.3 (+2.2: the d3-timer port, real
// `modify`, the vega-selections functions, the fit-projection registry); marginal signals 5.8 (+1.4: timer streams, owners,
// the data hook); geo 12.5; useChart 128.6; Chart 161.1; SvgChart 144.2; SvgChart + interaction 155.4; Chart + VL 223.5
// (+12.2 over the 211.3 above: the maps and animation compile in @aster/vl and the core runtime they need).
// Measured 2026-10-26 after the Vega-Lite maps and animation work on top of the selections work (kB gzip): signals marginal
// 7.8 (+0.4 over the selections raise: the d3-timer port and timer owners in the event loop); Chart 164.8 (+1.0), SvgChart 145.9
// (+0.6), SvgChart + interaction 159.1 (+1.1): the timer port, the fit-projection registry and unrounded geoshape bounds
// in core; Chart + VL 240.0 (+8.8): the maps (projections, geojson / geopoint data, geoshape marks) and animation (the time
// channel's scale, frame dataset and the timer selection) compile in @aster/vl.
// Runtime parity (guides built from ports of vega-parser's guide encoders, shared immutable plans, per-scope abort model,
// legend part metadata) on top of the above, measured 2026-10-27 (kB gzip): core 133.8 (+8.5 over 125.3; the guide ports),
// useChart 137.7, Chart 172.4, SvgChart 153.0, SvgChart + interaction 166.2, Chart + VL 247.4. Marginal rows unchanged.
// vega's event config (config.events prevent/allow, ported from vega-view) and one resolved view size (measuredSize, a
// live containerSize) then took, measured 2026-10-27 (kB gzip): core 133.9, useChart 137.8, Chart 172.9, SvgChart 153.4,
// SvgChart + interaction 166.7, Chart + VL 247.9.
// The item cursor (vega-view cursor.js: resolveCursor, the pointer tracker, HitIndex.pick with its interactivity and the
// guide parts it finds, the container's cursor state in ChartCore) then took, measured (kB gzip): hit marginal 5.6 (+0.4),
// Chart 174.1 (+1.2), SvgChart 153.9 (+0.5), SvgChart + interaction 167.8 (+1.1), Chart + VL 249.1 (+1.2). Core and the
// other marginal rows stay inside their ceilings.
// The pointer through the svg's screen CTM (core/pointer.ts, one cached map for the cursor, tooltip and gestures), the
// painted-geometry hit index and the inert flags, merged, measured (kB gzip): hit marginal 5.8, Chart 174.8, SvgChart 154.3,
// SvgChart + interaction 168.7, Chart + VL 249.9.
// The @aster/vl compiler ports vega-lite's layout-size, band/bin/time-unit position, path-overlay, stack-order, resolve and
// legend-merge rules (gallery conformance): Chart + VL 257.6 (+7.7: the binned discrete fields and the layered axis merge came last).
// Nothing outside the VL row moved.
// The dataflow-failure containment (a throwing dataset stops the pass like vega's): SvgChart 154.4 (+0.1 over the budget before it).
const BUDGETS = {
  '@aster/core': 134.3 * 1024,
  '+ @aster/core/dom': 6.2 * 1024,
  '+ @aster/core/canvas': 5.3 * 1024,
  '+ @aster/core/hit': 6.1 * 1024,
  '+ @aster/core/signals': 8.3 * 1024,
  '+ @aster/core/load': 5.6 * 1024,
  '+ @aster/core/geo': 12.8 * 1024,
  '+ @aster/core/transforms': 15.6 * 1024,
  '@aster/react useChart': 138.2 * 1024,
  '@aster/react Chart': 175.3 * 1024,
  // The light chart (`@aster/react/lite`): SVG only, no canvas renderer; alone and with the `interaction` capability.
  '@aster/react SvgChart': 154.9 * 1024,
  '@aster/react SvgChart + interaction': 169.2 * 1024,
  // Base + the VL compiler (opt-in: `import '@aster/react/vl'`).
  '@aster/react Chart + VL': 258.1 * 1024,
}

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const MONOREPO_ROOT = dirname(dirname(dirname(THIS_DIR)))
const TMP = join(MONOREPO_ROOT, 'packages', 'benchmarks', '.tmp')

const CORE_APP = String.raw`import { renderSpec } from '@aster/core'
const spec = { width: 400, height: 300, data: [{ name: 't', values: [{ x: 0, y: 10 }] }], scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' }], marks: [] }
export default () => renderSpec(spec)
`

/**
 * A row is either absolute (`base` unset: the whole bundle of the app) or MARGINAL (`base` names another row: the
 * row's gzip minus that row's, i.e. what the addon adds to an app that already renders with core). The addons share
 * most of their code with core, so a standalone figure double counts it; the marginal one is what an app pays.
 */
const ENTRIES = [
  { name: '@aster/core', file: 'core.mjs', platform: 'node', src: CORE_APP },
  {
    name: '+ @aster/core/dom',
    base: '@aster/core',
    file: 'dom.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { createChartSession, patchSceneDom } from '@aster/core/dom'
export const dom = { createChartSession, patchSceneDom }
`,
  },
  {
    name: '+ @aster/core/canvas',
    base: '@aster/core',
    file: 'canvas.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { renderSceneToCanvas } from '@aster/core/canvas'
export const canvas = renderSceneToCanvas
`,
  },
  {
    name: '+ @aster/core/hit',
    base: '@aster/core',
    file: 'hit.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { buildHitIndex } from '@aster/core/hit'
export const hit = buildHitIndex
`,
  },
  {
    name: '+ @aster/core/signals',
    base: '@aster/core',
    file: 'signals.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { bindSceneSignals } from '@aster/core/signals'
export const signals = bindSceneSignals
`,
  },
  {
    name: '+ @aster/core/load',
    base: '@aster/core',
    file: 'load.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import { loadSpecData } from '@aster/core/load'
export const load = loadSpecData
`,
  },
  {
    name: '+ @aster/core/geo',
    base: '@aster/core',
    file: 'geo.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import '@aster/core/geo'
`,
  },
  {
    name: '+ @aster/core/transforms',
    base: '@aster/core',
    file: 'transforms.mjs',
    platform: 'node',
    src: CORE_APP + String.raw`import '@aster/core/transforms'
`,
  },
  {
    name: '@aster/react useChart',
    file: 'react-usechart.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import { useChart } from '@aster/react'
export default useChart
`,
  },
  {
    name: '@aster/react Chart',
    file: 'react.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import { Chart } from '@aster/react'
export default Chart
`,
  },
  {
    name: '@aster/react SvgChart',
    file: 'react-svgchart.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import { SvgChart } from '@aster/react/lite'
export default SvgChart
`,
  },
  {
    name: '@aster/react SvgChart + interaction',
    file: 'react-svgchart-interaction.tsx',
    platform: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    src: String.raw`import { SvgChart } from '@aster/react/lite'
import { interaction } from '@aster/react/interaction'
export { SvgChart, interaction }
`,
  },
  {
    name: '@aster/react Chart + VL',
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

const PUBLIC_PACKAGES = ['core', 'react', 'vl']
// (mirrors tsconfig.build.json: test files, `src/testing/` helpers and type-only `*.assert.ts` modules emit nothing)
const isBuildInput = (name) => /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) && !/\.(test|testlib|testkit|assert)\.tsx?$/.test(name)

function listSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? (e.name === 'testing' ? [] : listSources(p)) : isBuildInput(e.name) ? [p] : []
  })
}

/**
 * The budget must measure what `pnpm build` produces from the CURRENT sources (C86): a dist that is
 * missing, or older than the source file it was built from, makes the numbers describe code that no
 * longer exists. Returns a list of problems (empty when every dist file is at least as new as its source).
 */
function distProblems() {
  const problems = []
  for (const pkg of PUBLIC_PACKAGES) {
    const srcDir = join(MONOREPO_ROOT, 'packages', pkg, 'src')
    const distDir = join(MONOREPO_ROOT, 'packages', pkg, 'dist')
    for (const file of listSources(srcDir)) {
      const rel = file.slice(srcDir.length + 1).replace(/\.tsx?$/, '.js')
      let dist
      try {
        dist = statSync(join(distDir, rel))
      } catch {
        problems.push(`packages/${pkg}/dist/${rel} is missing`)
        continue
      }
      if (dist.mtimeMs < statSync(file).mtimeMs) problems.push(`packages/${pkg}/dist/${rel} is older than its source`)
    }
  }
  return problems
}

// Test hook (scripts/bundle-shaking.test.mjs): bundle as if the packages declared no `sideEffects` field at all, i.e.
// every dist module may have effects. The rows must then FAIL: that is what proves the budget watches tree-shaking.
const IGNORE_SIDE_EFFECTS = process.env.ASTER_BUDGET_IGNORE_SIDE_EFFECTS === '1'
const ignoreSideEffects = {
  name: 'ignore-side-effects-field',
  setup(b) {
    b.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData?.skip || args.kind === 'entry-point') return undefined
      const r = await b.resolve(args.path, { kind: args.kind, importer: args.importer, namespace: args.namespace, resolveDir: args.resolveDir, pluginData: { skip: true } })
      if (r.errors.length || !/[\\/]packages[\\/](core|react|vl)[\\/]dist[\\/]/.test(r.path)) return undefined
      return { path: r.path, sideEffects: true }
    })
  },
}

const KB = (n) => (n / 1024).toFixed(1)

try {
  setupTmp()
  const stale = distProblems()
  if (stale.length) {
    console.error(`Refusing to measure a stale or missing dist (${stale.length} problem${stale.length === 1 ? '' : 's'}); run \`pnpm build\` first:`)
    for (const p of stale.slice(0, 5)) console.error(`  ${p}`)
    process.exit(1)
  }

  const sizes = new Map()
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
      plugins: IGNORE_SIDE_EFFECTS ? [ignoreSideEffects] : [],
    })
    const buf = readFileSync(outPath)
    const gz = gzipSync(buf).length
    sizes.set(entry.name, { min: buf.length, gz })
    // Marginal rows report what the addon adds on top of its base row.
    const base = entry.base ? sizes.get(entry.base) : null
    const measured = base ? gz - base.gz : gz
    const budget = BUDGETS[entry.name]
    if (budget == null) throw new Error(`no budget for "${entry.name}"`)

    const pass = measured <= budget
    if (!pass) failed = true
    console.log(
      `${entry.name.padEnd(26)} min=${KB(base ? buf.length - base.min : buf.length).padStart(7)} kB  gzip=${KB(measured).padStart(6)} kB${base ? ' (marginal)' : '           '}  budget=${KB(budget).padStart(5)} kB  ${pass ? 'PASS' : 'FAIL'}`,
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
