/**
 * Bundle-size budgets: one tiny app per documented import pattern is bundled (esbuild, production, minify) and its gzip size is
 * checked against the ceiling in budget-rows.mjs (the measured size + 0.5 kB, within a band: budget-lib.mjs `judge`). Needs
 * `pnpm build` and refuses a stale dist.
 *
 * Run: pnpm --filter @aster-charts/benchmarks run budget   (the `budget` gate of `pnpm check`)
 * Environment (test hooks: scripts/bundle-shaking.test.mjs runs the budget with each and requires it to FAIL):
 *   ASTER_BUDGET_SIDE_EFFECTS=all   bundle as if every dist module had effects (no `sideEffects` field): nothing shakes
 *   ASTER_BUDGET_SIDE_EFFECTS=none  bundle as if no dist module had effects: a row built on a bare `import '...'` loses its import
 *   ASTER_BUDGET_IGNORE_SIDE_EFFECTS=1  the old name of `all`
 *
 * Exit codes: 0 every pattern is within its budget, 1 a budget is off or a pattern fails to bundle, 2 bad usage (an unknown option).
 */
import { build } from 'esbuild'
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cli } from '../../../scripts/lib/cli.mjs'
import { BUDGETS, ENTRIES, TOTALS } from './budget-rows.mjs'
import { distProblems, inconsistencies, judge, weigh } from './budget-lib.mjs'

cli({ url: import.meta.url })

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const MONOREPO_ROOT = dirname(dirname(dirname(THIS_DIR)))
const TMP = join(MONOREPO_ROOT, 'packages', 'benchmarks', '.tmp')
const PUBLIC_PACKAGES = ['core', 'react', 'vl']

// Test hooks: every module of the published packages with effects (`all`), or with none (`none`).
const SIDE_EFFECTS = process.env.ASTER_BUDGET_SIDE_EFFECTS ?? (process.env.ASTER_BUDGET_IGNORE_SIDE_EFFECTS === '1' ? 'all' : '')
if (SIDE_EFFECTS !== '' && SIDE_EFFECTS !== 'all' && SIDE_EFFECTS !== 'none') {
  console.error(`error: ASTER_BUDGET_SIDE_EFFECTS is "all" or "none", not "${SIDE_EFFECTS}"`)
  process.exit(2)
}
const sideEffectsPlugin = {
  name: 'side-effects-field',
  setup(b) {
    b.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData?.skip || args.kind === 'entry-point') return undefined
      const r = await b.resolve(args.path, { kind: args.kind, importer: args.importer, namespace: args.namespace, resolveDir: args.resolveDir, pluginData: { skip: true } })
      if (r.errors.length || !/[\\/]packages[\\/](core|react|vl)[\\/]dist[\\/]/.test(r.path)) return undefined
      return { path: r.path, sideEffects: SIDE_EFFECTS === 'all' }
    })
  },
}

const KB = (n) => (n / 1024).toFixed(2)

/** Bundle one row; what it weighs up front and what it can fetch later, and what esbuild said about it. */
async function measure(entry) {
  const entryPath = join(TMP, entry.file)
  const outDir = join(TMP, 'out')
  rmSync(outDir, { recursive: true, force: true })
  writeFileSync(entryPath, entry.src)
  // Code-split, so an add-on that is only ever `import()`ed (the shells load @aster-charts/core/geo, /transforms and /load on demand,
  // see @aster-charts/core/addons) is a chunk of its own, as it is in a real build. The up-front figure is the entry and every chunk it
  // imports statically; the chunks fetched later are counted apart.
  const built = await build({
    entryPoints: [entryPath],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: entry.platform,
    splitting: true,
    write: true,
    outdir: outDir,
    metafile: true,
    absWorkingDir: MONOREPO_ROOT,
    logLevel: 'silent',
    external: entry.external,
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: SIDE_EFFECTS ? [sideEffectsPlugin] : [],
  })
  const outputs = built.metafile.outputs
  // (esbuild gives every chunk that a dynamic import() starts an entryPoint too: the app is the output built from its own file)
  const entryOut = Object.keys(outputs).find((o) => outputs[o].entryPoint !== undefined && join(MONOREPO_ROOT, outputs[o].entryPoint) === entryPath)
  if (entryOut === undefined) throw new Error(`no output of ${entry.file} is its entry point`)
  const w = weigh(outputs, entryOut, (o) => readFileSync(join(MONOREPO_ROOT, o)))
  return { ...w, warnings: built.warnings.map((m) => m.text) }
}

let failed = false
const fail = (message) => {
  failed = true
  console.error(message)
}

try {
  const inconsistent = inconsistencies(ENTRIES, BUDGETS, TOTALS)
  for (const p of inconsistent) fail(`budget rows: ${p}`)
  mkdirSync(TMP, { recursive: true })
  const stale = distProblems(MONOREPO_ROOT, PUBLIC_PACKAGES)
  if (stale.length) {
    console.error(`Refusing to measure a stale or missing dist (${stale.length} problem${stale.length === 1 ? '' : 's'}); run \`pnpm build\` first:`)
    for (const p of stale.slice(0, 5)) console.error(`  ${p}`)
    failed = true
  } else if (!inconsistent.length) {
    const sizes = new Map()
    for (const entry of ENTRIES) {
      const m = await measure(entry)
      for (const text of m.warnings) fail(`${entry.name}: esbuild warned: ${text}`)
      sizes.set(entry.name, m.initial)
      // Marginal rows report what the addon adds on top of its base row.
      const base = entry.base ? sizes.get(entry.base) : null
      const measured = base ? m.initial.gz - base.gz : m.initial.gz
      const verdict = judge(measured, BUDGETS[entry.name])
      if (!verdict.ok) failed = true
      const total = Object.hasOwn(TOTALS, entry.name) ? m.initial.gz + m.lazy.gz : null
      const totalVerdict = total === null ? null : judge(total, TOTALS[entry.name])
      if (totalVerdict && !totalVerdict.ok) failed = true
      console.log(
        `${entry.name.padEnd(44)} min=${KB(base ? m.initial.min - base.min : m.initial.min).padStart(7)} kB  gzip=${KB(measured).padStart(7)} kB${base ? ' (marginal)' : '           '}` +
          `  ceiling=${KB(BUDGETS[entry.name]).padStart(7)} kB  headroom=${KB(verdict.headroom).padStart(5)} kB  ${verdict.ok ? 'PASS' : `FAIL (${verdict.why})`}` +
          (total === null ? '' : `\n${''.padEnd(44)} total up front + on demand=${KB(total).padStart(7)} kB (${m.initial.files} + ${m.lazy.files} files, on demand ${KB(m.lazy.gz)} kB)  ceiling=${KB(TOTALS[entry.name]).padStart(7)} kB  headroom=${KB(totalVerdict.headroom).padStart(5)} kB  ${totalVerdict.ok ? 'PASS' : `FAIL (${totalVerdict.why})`}`),
      )
    }
  }
} catch (err) {
  console.error(`error: ${err.message}`)
  failed = true
} finally {
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch { /* ignore */ }
}
// (a verdict, not process.exit(): the clean-up above has run, so a failing run leaves nothing in the tree)
process.exitCode = failed ? 1 : 0
