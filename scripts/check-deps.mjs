#!/usr/bin/env node
/**
 * Dependency-boundary ratchet.
 *
 * `@aster-charts/core`, `@aster-charts/react` and `@aster-charts/vl` must not import (or declare) the packages
 * they are committed to reimplementing: the Vega/D3 oracle stack. Conformance,
 * benchmarks and the demo may import them — they are the oracle and its
 * drivers, dev-only by definition.
 *
 * The ratchet has two directions, and both fail:
 *   1. a banned import or dependency that the baseline does not list;
 *   2. a baseline entry that no longer matches anything (stale slack).
 *
 * So the baseline can only shrink. The baselines are empty today, and the ratchet
 * keeps the boundary closed.
 *
 * Baselines live beside each package: `<pkg>/dep-baseline.json`, shaped as
 *   { "imports": { "<relative file>": ["<pkg>", ...] }, "deps": ["<pkg>", ...] }
 *
 * Sources are parsed with the TypeScript compiler (scripts/lib/scan-imports.mjs),
 * so every import form is covered (static, type-only, `export from`,
 * `import x = require()`, dynamic `import()` incl. template literals,
 * `require`, `import.meta.resolve`, `import('x').T` types, triple-slash type
 * references, `new URL('..', import.meta.url)`, ambient `declare module`, `/// <reference path>`). A specifier that cannot be resolved
 * statically is itself an error, and so is a specifier that is a URL (`https://esm.sh/vega`, `data:`, `npm:`) or a path that leaves the
 * package directory or enters a `node_modules`, and every way to obtain a loader without calling it on a literal (`createRequire` however
 * reached, `process.getBuiltinModule`, `globalThis['require']`, `eval`, `new Function`).
 *
 * The manifest is checked by name and by range: an alias (`"x": "npm:vega@^6"`), a git, URL, file or link range is an error whatever its
 * key says, because the key is not what gets installed. What ships is every path in `files` (each is scanned), not just `dist`.
 *
 * What ships is checked too: the built `dist` of every package (JS and .d.ts)
 * must import nothing from the banned stack beyond what the baseline admits,
 * because that is what consumers receive. This needs `pnpm build` first.
 *
 * Usage: node scripts/check-deps.mjs [--root <dir>] [--src-only]
 *   --root <dir>  check the repository at <dir> (default: the current directory)
 *   --src-only    skip the built dist of each package (for a checkout that has not been built)
 *
 * Exit codes: 0 clean, 1 a violation or a stale baseline entry, 2 bad usage (an unknown option).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep, posix } from 'node:path'
import { cli } from './lib/cli.mjs'
import { CODE_EXT, classifySpec, isBanned, packageName, scanSource } from './lib/scan-imports.mjs'

cli({ url: import.meta.url, flags: { root: 'value', 'src-only': 'bool' } })

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
    if (name === 'node_modules') continue // never part of what a package ships (bundled dependencies are checked through the manifest)
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/** Files of `src` that never ship (the build excludes them): they may read a sibling package's output by path. */
const TEST_FILE = /\.(?:test|testlib|testkit|assert)\.[cm]?[jt]sx?$/

function isCodeFile(file) {
  // .d.ts/.d.mts/.d.cts end in a CODE_EXT member, so they are covered too.
  return CODE_EXT.has(file.slice(file.lastIndexOf('.')).toLowerCase())
}

/**
 * Scan every code file under `base`. Returns
 *   found:        relFile -> Set<banned package>
 *   unanalyzable: [{ rel, line, text }]
 */
function scanTree(base, prefix, packageDir) {
  const found = new Map()
  const unanalyzable = []
  const escapes = []
  const walked = statSync(base).isDirectory() ? walk(base) : [base]
  for (const file of walked) {
    if (!isCodeFile(file)) continue
    const rel = statSync(base).isDirectory() ? (prefix ? prefix + '/' : '') + relative(base, file).split(sep).join(posix.sep) : prefix
    const { specs, unanalyzable: bad } = scanSource(readFileSync(file, 'utf8'), file)
    for (const spec of specs) {
      const c = classifySpec(spec, { file, packageDir, allowSiblings: TEST_FILE.test(file) })
      if (!c) continue
      if (c.kind === 'banned') {
        if (!found.has(rel)) found.set(rel, new Set())
        found.get(rel).add(c.name)
      } else escapes.push({ rel, spec, why: c.why })
    }
    for (const b of bad) unanalyzable.push({ rel, ...b })
  }
  return { found, unanalyzable, escapes }
}

/** The directories and files a package ships: every positive entry of `files` (npm always adds package.json and the README/LICENSE, which are not code). */
function shippedPaths(manifest, pkgDir) {
  const out = []
  const errors = []
  for (const entry of manifest.files ?? ['.']) {
    if (typeof entry !== 'string' || entry.startsWith('!')) continue
    if (/[*?[\]{}]/.test(entry)) {
      errors.push(`${pkgDir}/package.json "files" entry "${entry}" is a pattern: list the shipped paths explicitly so each can be scanned`)
      continue
    }
    out.push(entry.replace(/^\.\//, '').replace(/\/+$/, '').replace(/^\.$/, ''))
  }
  return { out, errors }
}

/** Why a dependency range cannot be trusted to be the package its key names, or null. */
function suspiciousRange(range) {
  if (typeof range !== 'string') return 'is not a string'
  const r = range.trim()
  if (/^workspace:/.test(r)) return null
  // `npm:<name>@<range>` installs <name> under another key; judge the real name.
  const alias = /^npm:(.+?)(?:@[^@]*)?$/.exec(r)
  if (alias) return isBanned(packageName(alias[1]) ?? '') ? `aliases the banned package "${alias[1]}"` : null
  // git / URL / file / link / tarball / github shorthand: what is installed is not a registry version of the key.
  if (/^[a-z][a-z0-9+.-]*:/i.test(r) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(r) || r.startsWith('.') || r.startsWith('/') || r.startsWith('~/')) return `is not a registry range ("${r.slice(0, 60)}")`
  return null
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
    if (v && !Array.isArray(v)) {
      for (const [name, range] of Object.entries(v)) {
        const why = suspiciousRange(range)
        if (why) errors.push(`${pkg.dir}/package.json ${section}["${name}"] ${why}\n  -> declare a registry version range; an alias, git, URL, file or link range can install the oracle stack under another name`)
        const alias = typeof range === 'string' ? /^npm:(.+?)(?:@[^@]*)?$/.exec(range.trim()) : null
        if (alias) { const real = packageName(alias[1]); if (real && isBanned(real)) deps.add(real) }
      }
    }
  }
  // package.json "imports" (#aliases) can redirect to a banned package behind a local name.
  for (const target of flattenTargets(manifest.imports)) {
    const name = packageName(target)
    if (name && isBanned(name)) deps.add(name)
  }

  const packageDir = join(ROOT, pkg.dir)
  const src = scanTree(join(packageDir, 'src'), 'src', packageDir)
  const found = src.found // relFile -> Set<package>
  const escapeErrors = (where, tree, label) => {
    for (const e of tree.escapes) {
      errors.push(`module specifier outside the boundary${label}: ${pkg.dir}/${e.rel} imports ${e.why}\n  -> import a package by name, or a file inside the package`)
    }
  }
  escapeErrors('', src, '')
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
      const dist = scanTree(distDir, 'dist', packageDir)
      escapeErrors('', dist, ' in shipped output')
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
    // every other path the package ships (`files`): a `bin/` or `lib/` added there is scanned like dist
    const shipped = shippedPaths(manifest, pkg.dir)
    errors.push(...shipped.errors)
    for (const entry of shipped.out) {
      if (entry === 'dist' || entry === 'src') continue
      const abs = join(packageDir, entry)
      if (!existsSync(abs)) continue // a listed path that a build has not produced is not shipped
      const tree = scanTree(abs, entry, packageDir)
      escapeErrors('', tree, ' in shipped output')
      for (const [rel, names] of tree.found) {
        for (const name of names) {
          errors.push(`banned import in shipped output: ${pkg.dir}/${rel} imports "${name}"\n  -> the published package would require the oracle stack; fix the source import`)
        }
      }
      for (const u of tree.unanalyzable) errors.push(`unanalyzable module specifier in shipped output: ${pkg.dir}/${u.rel}:${u.line} (${u.text})`)
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
