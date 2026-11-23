/**
 * Whether the built `dist` of the public packages is what `pnpm build` makes from the current sources (the budget refuses to measure
 * anything else, and so can any other reader of `dist`):
 *   - a source file with no built counterpart, or one built before its source was last changed, is a stale dist;
 *   - a built `.js` or `.d.ts` with NO source is an orphan: `tsc` never deletes what it emitted before, so a module whose source was
 *     removed or renamed stays in `dist`, stays in the tarball a local `pnpm pack` makes, and keeps an `exports` or `sideEffects`
 *     entry that names it green locally while a clean checkout (CI) goes red. `pnpm build` now removes `dist` first, so an orphan means
 *     the dist was not built by it.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const PUBLIC_PACKAGES = ['core', 'react', 'vl']

// (mirrors tsconfig.build.json: test files, `src/testing/` helpers and type-only `*.assert.ts` modules emit nothing)
const isBuildInput = (name) => /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) && !/\.(test|testlib|testkit|assert)\.tsx?$/.test(name)

function listSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? (e.name === 'testing' ? [] : listSources(p)) : isBuildInput(e.name) ? [p] : []
  })
}

function listBuilt(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? listBuilt(p) : /\.(js|d\.ts)$/.test(e.name) ? [p] : []
  })
}

/** A list of problems (empty when every dist file is at least as new as its source and has one). */
export function distProblems(root, packages = PUBLIC_PACKAGES) {
  const problems = []
  for (const pkg of packages) {
    const srcDir = join(root, 'packages', pkg, 'src')
    const distDir = join(root, 'packages', pkg, 'dist')
    const sources = listSources(srcDir)
    const expected = new Set()
    for (const file of sources) {
      const rel = file.slice(srcDir.length + 1).replace(/\.tsx?$/, '.js')
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
    try { built = listBuilt(distDir) } catch { /* no dist: every source is reported missing above */ }
    for (const file of built) {
      const rel = file.slice(distDir.length + 1).split('\\').join('/')
      if (!expected.has(rel)) problems.push(`packages/${pkg}/dist/${rel} is an orphan: no source builds it (a stale dist; \`pnpm build\` cleans dist first)`)
    }
  }
  return problems
}
