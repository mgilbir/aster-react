import { build } from 'esbuild'
import { writeFileSync, readFileSync, statSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

// 80 kB gzip for a minimal line-chart renderSpec bundle (regression gate).
//
// Re-baselined from the original 60 kB (set when the engine was a fraction of
// this scope) after measuring every principled cut. Composition of the 79.0 kB
// bundle, per family (gzip, measured by stubbing each dependency):
//
//   ~40 kB  @aster/core itself — compile/evaluate pipeline, axes/legends/
//           facet layout, renderer, exact vega bounds+trellis port
//    ~9 kB  vega-expression + vega-interpreter (the expression language)
//    ~5 kB  d3-shape (19 curve families + arc/symbol/path)
//   ~20 kB  vega's d3 support stack (d3-array/scale/time/time-format/format/
//           color/interpolate + vega-scale/util/time/format)
//
// Cuts already taken: geo projections + contour live behind @aster/core/geo;
// rare-layout transforms (kde/quantile/regression/loess, pack/partition/
// treemap, wordcloud, voronoi) behind @aster/core/transforms; the incremental
// DOM patcher behind @aster/core/dom. Measured-and-rejected: lazy color
// schemes save 0.3 kB gzip (hex data compresses for free); dom/session out of
// the core barrel saves 0.5 kB. Removing the expression engine (-9 kB) would
// drop the product below vega compatibility; the remaining floor is ~76 kB.
// The budget's job is regression detection, which 81 kB with the breakdown
// above does; the pre-expansion 60 kB no longer describes the library.
// (80 -> 81: the event-loop wiring gained ~0.2 kB gzip of genuinely required
// code — scene runtime/compiled metadata + vega mark defaults.)
// (81 -> 85: the reactive differential engine — per-datum dataChanges re-derive,
// persistent scene/items, incremental scales/transforms, DOM-subtree skip, the
// imperative session.change() — is a deliberate feature addition, ~3 kB gzip.)
// (85 -> 90: ADR 0001 — the engine owns its stack instead of importing it. The
// colour module (CSS parser, 148 named colours, RGB/HSL/Lab/HCL conversions,
// oracle-vector-tested) is the first owned library; it replaces d3-color and
// costs ~3.5 kB gzip. Later owned libraries re-baseline this gate the same way,
// each with its measured cost recorded here.)
// (90 -> 92: the calendar module replaces vega-time + the d3-time interval
// engine (intervals, floors, offsets, sequences, unit specifiers; DST covered
// by vectors recorded under America/New_York) — ~1.8 kB gzip.)
// (92 -> 96: the format layer replaces vega-format + d3-format +
// d3-time-format — specifier grammar, locale tables, the strftime engine, the
// tick formatters (formatFloat/formatSpan) and the memoized locale facade;
// 1749 oracle-vector cases — ~4.7 kB gzip.)
const BUDGET_BYTES = 96 * 1024

// Walk up from this file to find the monorepo root:
// packages/benchmarks/scripts -> packages/benchmarks -> packages -> aster-react (root)
const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const MONOREPO_ROOT = dirname(dirname(dirname(THIS_DIR)))
const TMP = join(MONOREPO_ROOT, 'packages', 'benchmarks', '.tmp')
const ENTRY_NAME = 'budget-entry.mjs'
const ENTRY = join(TMP, ENTRY_NAME)
const OUT = join(TMP, 'bundle.mjs')

const ENTRY_SRC = String.raw`import { renderSpec } from '@aster/core'
const spec = { width: 400, height: 300, data: [{ name: 't', values: [{ x: 0, y: 10 }] }], scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' }], marks: [] }
export default () => renderSpec(spec)
`

function setupTmp() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  writeFileSync(ENTRY, ENTRY_SRC)
}

function coreAlreadyBuilt() {
  try {
    statSync(join(MONOREPO_ROOT, 'packages', 'core', 'dist', 'index.js'))
    return true
  } catch {
    return false
  }
}

async function bundle() {
  return build({
    entryPoints: [ENTRY],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'node',
    write: true,
    outfile: OUT,
    logLevel: 'silent',
    alias: {
      '@aster/core': join(MONOREPO_ROOT, 'packages', 'core', 'dist', 'index.js'),
    },
  })
}

const BUDGET_KB = (BUDGET_BYTES / 1024).toFixed(0)

try {
  setupTmp()

  if (!coreAlreadyBuilt()) {
    console.error('Run `pnpm build` first')
    process.exit(1)
  }

  const result = await bundle()

  if (result && result.errors && result.errors.length > 0) {
    console.error('esbuild failed with errors')
    process.exit(1)
  }

  // Read the bundled output
  const bundleContent = readFileSync(OUT)
  const minKB = (bundleContent.length / 1024).toFixed(1)

  // Compute gzip size
  const gzipped = gzipSync(bundleContent)
  const gzKB = (gzipped.length / 1024).toFixed(1)

  const pass = gzipped.length <= BUDGET_BYTES
  const status = pass ? 'PASS' : 'FAIL'

  console.log(
    `@aster/core renderSpec (line chart)\tmin=${minKB} kB\tgzip=${gzKB} kB\tbudget=${BUDGET_KB} kB\t${status}`
  )

  if (!pass) {
    process.exit(1)
  }

} catch (err) {
  console.error(`error: ${err.message}`)
  process.exit(1)
} finally {
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch { /* ignore */ }
}
