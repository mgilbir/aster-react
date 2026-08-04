import { build } from 'esbuild'
import { writeFileSync, readFileSync, statSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const BUDGET_BYTES = 60 * 1024 // 60 kB

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
