/**
 * The arithmetic of the bundle-size budget (budget.mjs runs it, scripts/budget.test.mjs checks it): what a bundle weighs, whether a
 * measure is inside its ceiling's band, whether the rows and the ceilings agree, and whether `dist` is the build of the sources.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'

const KB = 1024
/** A ceiling is the measure + 0.5 kB: the measure may sit this far below it, no closer and no further. */
export const HEADROOM_MIN = Math.round(0.3 * KB)
export const HEADROOM_MAX = Math.round(0.7 * KB)

export const gzipBytes = (buf) => gzipSync(buf).length

/**
 * What an app weighs, from esbuild's metafile. `initial` is the entry and every chunk it imports statically; `lazy` is every other
 * output (chunks an `import()` starts). Each file is gzipped on its own, as a browser fetches them, and the numbers are the sums.
 * `read(path)` returns an output's bytes.
 */
export function weigh(outputs, entryOut, read) {
  const initial = new Set()
  const visit = (o) => {
    if (initial.has(o)) return
    initial.add(o)
    for (const imp of outputs[o].imports) if (imp.kind === 'import-statement' && outputs[imp.path]) visit(imp.path)
  }
  visit(entryOut)
  const sum = (paths) => {
    let min = 0
    let gz = 0
    for (const o of paths) {
      const buf = read(o)
      min += buf.length
      gz += gzipBytes(buf)
    }
    return { files: paths.length, min, gz }
  }
  const lazy = Object.keys(outputs).filter((o) => !initial.has(o) && !o.endsWith('.map'))
  return { initial: sum([...initial]), lazy: sum(lazy) }
}

/**
 * Judge a measure against its ceiling. Over the ceiling fails. So does a measure that leaves the band below it (HEADROOM_MIN to
 * HEADROOM_MAX): too close means the ceiling must be re-set in the change that moved the row, too far means the ceiling has gone stale
 * (or the row has stopped measuring what it names: an import shaken out measures 0). `why` says which.
 */
export function judge(measured, ceiling) {
  const headroom = ceiling - measured
  if (!(ceiling > 0)) return { ok: false, headroom, why: 'has no ceiling' }
  if (!Number.isFinite(measured) || measured <= 0) return { ok: false, headroom, why: 'measured nothing' }
  if (headroom < 0) return { ok: false, headroom, why: 'over its ceiling' }
  if (headroom < HEADROOM_MIN) return { ok: false, headroom, why: `within ${(HEADROOM_MIN / KB).toFixed(1)} kB of its ceiling: re-set the ceiling (measure + 0.5 kB) in the change that grew it` }
  if (headroom > HEADROOM_MAX) return { ok: false, headroom, why: `more than ${(HEADROOM_MAX / KB).toFixed(1)} kB under its ceiling: lower the ceiling (measure + 0.5 kB), or the row no longer measures what it names` }
  return { ok: true, headroom, why: '' }
}

/** Where the rows, the ceilings and the totals disagree. Empty when every row has both a ceiling and (for React) a total, and no ceiling is orphaned. */
export function inconsistencies(entries, budgets, totals) {
  const names = entries.map((e) => e.name)
  const problems = []
  const seen = new Set()
  for (const n of names) {
    if (seen.has(n)) problems.push(`row "${n}" is listed twice`)
    seen.add(n)
  }
  for (const n of names) if (!Object.hasOwn(budgets, n)) problems.push(`row "${n}" has no ceiling in BUDGETS`)
  for (const n of Object.keys(budgets)) if (!seen.has(n)) problems.push(`BUDGETS names "${n}", which is no row (its gate was deleted, or the name is misspelt)`)
  for (const n of Object.keys(totals)) if (!seen.has(n)) problems.push(`TOTALS names "${n}", which is no row`)
  for (const e of entries) {
    if (e.platform === 'browser' && e.external && !Object.hasOwn(totals, e.name)) problems.push(`React row "${e.name}" has no total in TOTALS`)
    if (e.base && !seen.has(e.base)) problems.push(`row "${e.name}" is marginal over "${e.base}", which is no row`)
  }
  return problems
}

// --- is `dist` the build of the sources? --------------------------------------------------------------------------------------

/** A tsconfig `exclude` pattern as a test of a path relative to the package (`src/**\/*.test.ts`, `src/testing`). */
export function excludeTest(pattern) {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*')
  const whole = new RegExp(`^${re}(?:/.*)?$`)
  return (rel) => whole.test(rel)
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
}

/** The files of `packages/<pkg>/src` that `tsc -p tsconfig.build.json` emits, as that package's own `exclude` says. */
export function buildInputs(pkgDir) {
  const config = JSON.parse(readFileSync(join(pkgDir, 'tsconfig.build.json'), 'utf8'))
  const excluded = (config.exclude ?? []).map(excludeTest)
  return walk(join(pkgDir, 'src')).filter((f) => {
    const rel = relative(pkgDir, f).split('\\').join('/')
    return /\.tsx?$/.test(rel) && !/\.d\.ts$/.test(rel) && !excluded.some((x) => x(rel))
  })
}

/**
 * Problems that make the measured dist describe code that is not there: a source with no output, an output older than its source, an
 * output whose source is gone.
 */
export function distProblems(root, packages) {
  const problems = []
  for (const pkg of packages) {
    const pkgDir = join(root, 'packages', pkg)
    const srcDir = join(pkgDir, 'src')
    const distDir = join(pkgDir, 'dist')
    const expected = new Set()
    for (const file of buildInputs(pkgDir)) {
      const rel = relative(srcDir, file).split('\\').join('/').replace(/\.tsx?$/, '.js')
      expected.add(rel)
      expected.add(rel.replace(/\.js$/, '.d.ts'))
      let dist
      try {
        dist = statSync(join(distDir, rel))
      } catch {
        problems.push(`packages/${pkg}/dist/${rel} is missing`)
        continue
      }
      if (dist.mtimeMs < statSync(file).mtimeMs) problems.push(`packages/${pkg}/dist/${rel} is older than its source`)
    }
    let built = []
    try {
      built = walk(distDir)
    } catch { /* a missing dist is reported file by file above */ }
    for (const file of built) {
      const rel = relative(distDir, file).split('\\').join('/')
      if (/\.(js|d\.ts)$/.test(rel) && !expected.has(rel)) problems.push(`packages/${pkg}/dist/${rel} has no source (a build of sources that are gone)`)
    }
  }
  return problems
}
