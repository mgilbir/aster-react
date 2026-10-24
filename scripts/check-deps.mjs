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
 *
 * Sources are parsed with the TypeScript compiler (scripts/lib/scan-imports.mjs),
 * so every import form is covered (static, type-only, `export from`,
 * `import x = require()`, dynamic `import()` incl. template literals,
 * `require`, `import.meta.resolve`, `import('x').T` types, triple-slash type
 * references). A specifier that cannot be resolved statically is itself an error.
 *
 * What ships is checked too: the built `dist` of every package (JS and .d.ts)
 * must import nothing from the banned stack beyond what the baseline admits,
 * because that is what consumers receive. This needs `pnpm build` first.
 *
 * Usage: node scripts/check-deps.mjs [--root <dir>] [--src-only]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep, posix } from 'node:path'
import { CODE_EXT, isBanned, packageName, scanSource } from './lib/scan-imports.mjs'

const argv = process.argv.slice(2)
const rootIdx = argv.indexOf('--root')
const ROOT = rootIdx >= 0 ? resolve(argv[rootIdx + 1] ?? '') : process.cwd()
const SRC_ONLY = argv.includes('--src-only')

/** Packages whose sources and built output must be free of the oracle stack. */
const PACKAGES = [
  { dir: 'packages/core', baseline: 'packages/core/dep-baseline.json' },
  { dir: 'packages/react', baseline: 'packages/react/dep-baseline.json' },
  { dir: 'packages/vl', baseline: 'packages/vl/dep-baseline.json' },
]

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

function isCodeFile(file) {
  // .d.ts/.d.mts/.d.cts end in a CODE_EXT member, so they are covered too.
  return CODE_EXT.has(file.slice(file.lastIndexOf('.')).toLowerCase())
}

/**
 * Scan every code file under `base`. Returns
 *   found:        relFile -> Set<banned package>
 *   unanalyzable: [{ rel, line, text }]
 */
function scanTree(base, prefix) {
  const found = new Map()
  const unanalyzable = []
  for (const file of walk(base)) {
    if (!isCodeFile(file)) continue
    const rel = prefix + '/' + relative(base, file).split(sep).join(posix.sep)
    const { specs, unanalyzable: bad } = scanSource(readFileSync(file, 'utf8'), file)
    for (const spec of specs) {
      const name = packageName(spec)
      if (!name || !isBanned(name)) continue
      if (!found.has(rel)) found.set(rel, new Set())
      found.get(rel).add(name)
    }
    for (const b of bad) unanalyzable.push({ rel, ...b })
  }
  return { found, unanalyzable }
}

/** Every string leaf of a (possibly nested) package.json conditions map. */
function flattenTargets(v) {
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.flatMap(flattenTargets)
  if (v && typeof v === 'object') return Object.values(v).flatMap(flattenTargets)
  return []
}

function checkPackage(pkg) {
  const errors = []
  const baseline = JSON.parse(readFileSync(join(ROOT, pkg.baseline), 'utf8'))
  const baselineImports = baseline.imports ?? {}
  const baselineDeps = new Set(baseline.deps ?? [])
  const deps = new Set()

  const manifest = JSON.parse(readFileSync(join(ROOT, pkg.dir, 'package.json'), 'utf8'))
  for (const section of [
    'dependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies',
  ]) {
    const v = manifest[section]
    // bundled*Dependencies is an array of names; the others are name -> range maps.
    for (const name of Array.isArray(v) ? v : Object.keys(v ?? {})) deps.add(name)
  }
  // package.json "imports" (#aliases) can redirect to a banned package behind a local name.
  for (const target of flattenTargets(manifest.imports)) {
    const name = packageName(target)
    if (name && isBanned(name)) deps.add(name)
  }

  const src = scanTree(join(ROOT, pkg.dir, 'src'), 'src')
  const found = src.found // relFile -> Set<package>
  for (const u of src.unanalyzable) {
    errors.push(
      `unanalyzable module specifier: ${pkg.dir}/${u.rel}:${u.line} (${u.text})\n` +
        `  -> use a static string specifier so the dependency boundary can be checked`,
    )
  }

  // 0. what ships: the built output must honour the same boundary
  if (!SRC_ONLY) {
    const distDir = join(ROOT, pkg.dir, 'dist')
    if (!existsSync(distDir)) {
      errors.push(`${pkg.dir}/dist is missing -> run \`pnpm build\` first (or pass --src-only)`)
    } else {
      const dist = scanTree(distDir, 'dist')
      const admitted = new Set(Object.values(baselineImports).flat())
      for (const [rel, names] of dist.found) {
        for (const name of names) {
          if (!admitted.has(name)) {
            errors.push(
              `banned import in shipped output: ${pkg.dir}/${rel} imports "${name}"\n` +
                `  -> the published package would require the oracle stack; fix the source import`,
            )
          }
        }
      }
      for (const u of dist.unanalyzable) {
        errors.push(
          `unanalyzable module specifier in shipped output: ${pkg.dir}/${u.rel}:${u.line} (${u.text})`,
        )
      }
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
