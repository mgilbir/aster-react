#!/usr/bin/env node
/**
 * Dependency-boundary ratchet.
 *
 * `@aster/core` and `@aster/react` must not import (or declare) the packages
 * they are committed to reimplementing: the Vega/D3 oracle stack. Conformance,
 * benchmarks and the demo may import them — they are the oracle and its
 * drivers, dev-only by definition.
 *
 * The ratchet has two directions, and both fail:
 *   1. a banned import or dependency that the baseline does not list;
 *   2. a baseline entry that no longer matches anything (stale slack).
 *
 * So the baseline can only shrink. Each phase of docs/ROADMAP.md removes its
 * entries when the port's vector replay passes, and the ratchet keeps the
 * boundary closed afterwards.
 *
 * Baselines live beside each package: `<pkg>/dep-baseline.json`, shaped as
 *   { "imports": { "<relative file>": ["<pkg>", ...] }, "deps": ["<pkg>", ...] }
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep, posix } from 'node:path'

const ROOT = process.cwd()

/** Packages whose sources must be free of the oracle stack. */
const PACKAGES = [
  { dir: 'packages/core', baseline: 'packages/core/dep-baseline.json' },
  { dir: 'packages/react', baseline: 'packages/react/dep-baseline.json' },
]

/** The oracle stack: everything on the "own the engine" list. */
const BANNED = [/^vega-/, /^d3-/, /^topojson/]

const CODE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/** Package name of an import specifier, or null for relative/absolute paths. */
function packageName(spec) {
  if (spec.startsWith('.') || spec.startsWith('/')) return null
  const parts = spec.split('/')
  if (spec.startsWith('@')) return parts.length >= 2 ? parts.slice(0, 2).join('/') : spec
  return parts[0]
}

function isBanned(name) {
  return BANNED.some((re) => re.test(name))
}

/**
 * Module specifiers referenced by a source file. Covers the import forms TS
 * and the bundlers emit/consume; anything exotic fails loudly at build time
 * and the ratchet's manifest half still catches the dependency itself.
 */
function specifiers(src) {
  const specs = []
  const patterns = [
    /from\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]/g,
  ]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) specs.push(m[1])
  }
  return specs
}

function checkPackage(pkg) {
  const errors = []
  const baseline = JSON.parse(readFileSync(join(ROOT, pkg.baseline), 'utf8'))
  const baselineImports = baseline.imports ?? {}
  const baselineDeps = new Set(baseline.deps ?? [])
  const found = new Map() // relFile -> Set<package>
  const deps = new Set()

  const manifest = JSON.parse(readFileSync(join(ROOT, pkg.dir, 'package.json'), 'utf8'))
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[section] ?? {})) deps.add(name)
  }

  for (const file of walk(join(ROOT, pkg.dir, 'src'))) {
    const ext = file.slice(file.lastIndexOf('.'))
    if (!CODE_EXT.has(ext)) continue
    if (file.endsWith('.d.ts')) continue // ambient module declarations, erased at build
    const rel = relative(join(ROOT, pkg.dir), file).split(sep).join(posix.sep)
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      const name = packageName(spec)
      if (!name || !isBanned(name)) continue
      if (!found.has(rel)) found.set(rel, new Set())
      found.get(rel).add(name)
    }
  }

  // 1. banned references the baseline does not list
  for (const [rel, names] of found) {
    const allowed = new Set(baselineImports[rel] ?? [])
    for (const name of names) {
      if (!allowed.has(name)) {
        errors.push(
          `banned import not in baseline: ${pkg.dir}/${rel} imports "${name}"\n` +
          `  -> port it (see docs/ROADMAP.md) or, if unavoidable, add it to ${pkg.baseline}`,
        )
      }
    }
  }

  // 2. stale baseline entries (the ratchet only shrinks)
  for (const [rel, names] of Object.entries(baselineImports)) {
    const actual = found.get(rel)
    for (const name of names) {
      if (!actual || !actual.has(name)) {
        errors.push(
          `stale baseline entry: ${pkg.baseline} lists "${name}" for ${rel}, which no longer imports it\n` +
          `  -> remove the entry; the ratchet never grows back`,
        )
      }
    }
  }

  // 3. manifest bans
  for (const name of deps) {
    if (isBanned(name) && !baselineDeps.has(name)) {
      errors.push(
        `banned dependency not in baseline: ${pkg.dir}/package.json declares "${name}"\n` +
          `  -> drop it once no source file imports it`,
      )
    }
  }
  for (const name of baselineDeps) {
    if (!deps.has(name)) {
      errors.push(
        `stale baseline entry: ${pkg.baseline} "deps" lists "${name}", which the manifest no longer declares\n` +
          `  -> remove the entry`,
      )
    }
  }

  const live = [...found.values()].reduce((n, s) => n + s.size, 0)
  const liveDeps = [...deps].filter((n) => isBanned(n)).length
  console.log(
    `[deps] ${pkg.dir}: ${live} banned import(s) under baseline, ${liveDeps} banned dep(s) under baseline`,
  )
  return errors
}

const all = []
for (const pkg of PACKAGES) all.push(...checkPackage(pkg))

if (all.length) {
  console.error(`\n[deps] dependency boundary violated (${all.length} problem[s]):\n`)
  for (const e of all) console.error('  ' + e + '\n')
  process.exit(1)
}
console.log('[deps] dependency boundary holds')
