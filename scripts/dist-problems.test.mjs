/** dist-problems (the budget's stale/orphan check) and clean-dist (what `pnpm build` runs first), on throw-away trees (C566). */
import { mkdirSync, rmSync, utimesSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { makeTempDir, removeTempDir } from './lib/temp-dir.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { distProblems } from '../packages/benchmarks/scripts/budget-lib.mjs'
import { spawnAsync } from './lib/spawn-async.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const made = []
afterAll(() => { for (const d of made) removeTempDir(d) })

function put(root, rel, text = 'x', age = 0) {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
  const t = new Date(Date.now() - age * 1000)
  utimesSync(p, t, t)
}

/** A tree with one built package (`core`: a.ts, b.tsx, a test file and a testing helper that its tsconfig.build.json excludes). */
function tree() {
  const root = makeTempDir('aster-dist-')
  made.push(root)
  put(root, 'packages/core/tsconfig.build.json', JSON.stringify({ exclude: ['src/**/*.test.ts', 'src/testing'] }), 100)
  put(root, 'packages/core/src/a.ts', 'export const a = 1', 100)
  put(root, 'packages/core/src/b.tsx', 'export const b = 1', 100)
  put(root, 'packages/core/src/a.test.ts', 'test', 100)
  put(root, 'packages/core/src/testing/h.ts', 'helper', 100)
  put(root, 'packages/core/src/types.d.ts', 'declare const t: 1', 100)
  for (const f of ['a.js', 'a.d.ts', 'b.js', 'b.d.ts']) put(root, `packages/core/dist/${f}`, 'x', 10)
  return root
}

describe('distProblems', () => {
  it('is empty for a dist built from the current sources', () => {
    expect(distProblems(tree(), ['core'])).toEqual([])
  })
  it('reports a missing built file, a stale one, and an orphan', () => {
    const missing = tree(); rmSync(join(missing, 'packages/core/dist/b.js'))
    expect(distProblems(missing, ['core']).join('\n')).toMatch(/dist\/b\.js is missing/)
    const stale = tree(); put(stale, 'packages/core/src/a.ts', 'export const a = 2', 0)
    expect(distProblems(stale, ['core']).join('\n')).toMatch(/dist\/a\.js is older than its source/)
    const orphan = tree(); put(orphan, 'packages/core/dist/svg-path.js', 'x', 5)
    expect(distProblems(orphan, ['core']).join('\n')).toMatch(/dist\/svg-path\.js is an orphan/)
  })
  it('reports an orphan declaration and one in a sub-directory, but not the declaration of a real source', () => {
    const t = tree(); put(t, 'packages/core/dist/old/gone.d.ts', 'x', 5)
    const p = distProblems(t, ['core'])
    expect(p.join('\n')).toMatch(/dist\/old\/gone\.d\.ts is an orphan/)
    expect(p.filter((l) => /a\.d\.ts|b\.d\.ts/.test(l))).toEqual([])
  })
  it('does not count files that are not module output (maps, json)', () => {
    const t = tree(); put(t, 'packages/core/dist/a.js.map', '{}', 5)
    expect(distProblems(t, ['core'])).toEqual([])
  })
  it('the real tree has none (a dist that was not built from these sources would be refused by the budget)', () => {
    expect(distProblems(repo)).toEqual([])
  })
})

describe('scripts/clean-dist.mjs and the build scripts', () => {
  it('removes dist, and is fine without one', async () => {
    const root = tree()
    const run = () => spawnAsync(process.execPath, [join(repo, 'scripts', 'clean-dist.mjs')], { cwd: join(root, 'packages/core'), timeout: 30_000 })
    put(root, 'packages/core/package.json', '{}')
    expect((await run()).status).toBe(0)
    expect(existsSync(join(root, 'packages/core/dist'))).toBe(false)
    expect(existsSync(join(root, 'packages/core/src/a.ts'))).toBe(true)
    expect((await run()).status).toBe(0)
  })
  it('refuses to run where there is no package.json (it would remove the wrong dist)', async () => {
    const dir = makeTempDir('aster-clean-'); made.push(dir)
    mkdirSync(join(dir, 'dist')); writeFileSync(join(dir, 'dist', 'keep.js'), 'x')
    const r = await spawnAsync(process.execPath, [join(repo, 'scripts', 'clean-dist.mjs')], { cwd: dir, timeout: 30_000 })
    expect(r.status).toBe(2)
    expect(existsSync(join(dir, 'dist', 'keep.js'))).toBe(true)
  })
  it('every published package builds from a clean dist', () => {
    for (const pkg of ['core', 'react', 'vl']) {
      const build = JSON.parse(readFileSync(join(repo, 'packages', pkg, 'package.json'), 'utf8')).scripts.build
      expect(build, pkg).toMatch(/^node \.\.\/\.\.\/scripts\/clean-dist\.mjs && tsc /)
    }
  })
})
