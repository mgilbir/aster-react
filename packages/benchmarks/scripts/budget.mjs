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
// Measured 2026-10 (gzip, minified; react/react-dom external):
//   @aster/core          109.0 kB
//   @aster/core/dom      110.3 kB
//   @aster/core/canvas    12.3 kB
//   @aster/core/hit        1.5 kB
//   @aster/core/signals   28.1 kB
//   @aster/react         156.0 kB (includes the from-scratch VL compiler)
//
// History of the core floor: the 80 kB budget was re-baselined repeatedly as
// the engine took ownership of its stack (ADR 0001): colour (+3.5), calendar
// (+1.8), format (+4.7), parity tails (+4). The a11y tree (+2.3) and the
// wall-clock limiter (+0.3) are the R10/R12 additions; the stream API and
// length-changing pulse propagation (+~2) plus the streaming React components
// (+~4) are the R13 additions. The budget's job is
// regression detection, so each entry gets measured headroom rather than a
// number that no longer describes the library.
const BUDGETS = {
  '@aster/core': 112 * 1024,
  '@aster/core/dom': 112 * 1024,
  '@aster/core/canvas': 20 * 1024,
  '@aster/core/hit': 6 * 1024,
  '@aster/core/signals': 36 * 1024,
  '@aster/react': 159 * 1024,
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
