/**
 * The arithmetic of the bundle-size budget (packages/benchmarks/scripts/budget-lib.mjs) and the rows it reads (budget-rows.mjs): a
 * measure is judged against its ceiling inside a band, the two tables agree with the rows, each file of an app is gzipped on its own, and
 * the stale-dist check reads the build's own excludes. The runs that plant a fault in the bundler are in bundle-shaking.test.mjs.
 */
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { HEADROOM_MAX, HEADROOM_MIN, buildInputs, distProblems, excludeTest, inconsistencies, judge, weigh } from '../packages/benchmarks/scripts/budget-lib.mjs'
import { BUDGETS, ENTRIES, TOTALS } from '../packages/benchmarks/scripts/budget-rows.mjs'
import { makeTempDir, removeTempDir } from './lib/temp-dir.mjs'

const KB = 1024
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('judge: a measure against its ceiling', () => {
  const ceiling = 100 * KB
  it('passes inside the band (0.3 to 0.7 kB under the ceiling)', () => {
    for (const headroom of [HEADROOM_MIN, 0.5 * KB, HEADROOM_MAX]) expect(judge(ceiling - headroom, ceiling).ok, String(headroom)).toBe(true)
  })

  it('fails over the ceiling, and too close to it', () => {
    expect(judge(ceiling + 1, ceiling)).toMatchObject({ ok: false, why: 'over its ceiling' })
    expect(judge(ceiling - HEADROOM_MIN + 1, ceiling).why).toMatch(/within 0\.3 kB of its ceiling: re-set the ceiling/)
  })

  it('fails when the ceiling is stale, and when the row measured nothing (a bare import shaken out reads 0.00 kB)', () => {
    expect(judge(ceiling - HEADROOM_MAX - 1, ceiling).why).toMatch(/more than 0\.7 kB under its ceiling/)
    expect(judge(0, 16.4 * KB)).toMatchObject({ ok: false, why: 'measured nothing' })
    expect(judge(NaN, ceiling).ok).toBe(false)
    expect(judge(5, 0).why).toBe('has no ceiling')
  })
})

describe('the rows and the ceilings agree', () => {
  it('the committed rows: every row has a ceiling, every React row a total, no ceiling is orphaned', () => {
    expect(inconsistencies(ENTRIES, BUDGETS, TOTALS)).toEqual([])
    for (const v of [...Object.values(BUDGETS), ...Object.values(TOTALS)]) expect(v).toBeGreaterThan(0)
  })

  it('catches a deleted row (its ceiling is left), a row with no ceiling, a missing total and a marginal row over a missing base', () => {
    const rows = [{ name: 'a', platform: 'node' }, { name: 'b', platform: 'node', base: 'a' }, { name: 'r', platform: 'browser', external: ['react'] }]
    const ok = { a: 1, b: 1, r: 1 }
    expect(inconsistencies(rows, ok, { r: 1 })).toEqual([])
    expect(inconsistencies(rows.slice(1), ok, { r: 1 }).join('\n')).toMatch(/BUDGETS names "a", which is no row[\s\S]*marginal over "a"/)
    expect(inconsistencies(rows, { a: 1, r: 1 }, { r: 1 }).join('\n')).toMatch(/row "b" has no ceiling/)
    expect(inconsistencies(rows, ok, {}).join('\n')).toMatch(/React row "r" has no total/)
    expect(inconsistencies(rows, ok, { r: 1, z: 1 }).join('\n')).toMatch(/TOTALS names "z"/)
    expect(inconsistencies([...rows, rows[0]], ok, { r: 1 }).join('\n')).toMatch(/row "a" is listed twice/)
  })
})

describe('weigh: what an app weighs', () => {
  const text = (seed) => Buffer.from(Array.from({ length: 4000 }, (_, i) => `${seed}${(i * 7919) % 1000}`).join(','))
  const files = { 'out/app.js': text('a'), 'out/chunk-a.js': text('b'), 'out/chunk-b.js': text('c'), 'out/lazy.js': text('d') }
  const outputs = {
    'out/app.js': { imports: [{ kind: 'import-statement', path: 'out/chunk-a.js' }, { kind: 'dynamic-import', path: 'out/lazy.js' }] },
    'out/chunk-a.js': { imports: [{ kind: 'import-statement', path: 'out/chunk-b.js' }] },
    'out/chunk-b.js': { imports: [] },
    'out/lazy.js': { imports: [{ kind: 'import-statement', path: 'out/chunk-b.js' }] },
    'out/app.js.map': { imports: [] },
  }
  const w = weigh(outputs, 'out/app.js', (o) => files[o])

  it('the up-front set is the entry and its static imports, each gzipped on its own', () => {
    expect(w.initial.files).toBe(3)
    expect(w.initial.gz).toBe(['out/app.js', 'out/chunk-a.js', 'out/chunk-b.js'].reduce((n, f) => n + gzipSync(files[f]).length, 0))
    // (not one gzip of their concatenation: a browser fetches separately compressed files)
    expect(w.initial.gz).not.toBe(gzipSync(Buffer.concat(['out/app.js', 'out/chunk-a.js', 'out/chunk-b.js'].map((f) => files[f]))).length)
  })

  it('what an import() starts is counted apart, and a source map is no output of the app', () => {
    expect(w.lazy.files).toBe(1)
    expect(w.lazy.gz).toBe(gzipSync(files['out/lazy.js']).length)
  })
})

describe('the stale-dist check reads what the build emits', () => {
  it('excludeTest reads tsconfig exclude patterns (a glob under src, a directory)', () => {
    const test = excludeTest('src/**/*.test.ts')
    expect([test('src/a.test.ts'), test('src/x/y/a.test.ts'), test('src/a.ts'), test('src/a.test.tsx')]).toEqual([true, true, false, false])
    const dir = excludeTest('src/testing')
    expect([dir('src/testing/a.ts'), dir('src/testing'), dir('src/testingx/a.ts'), dir('src/a/testing/b.ts')]).toEqual([true, true, false, false])
  })

  const make = (excludes, src, dist) => {
    const dir = makeTempDir('aster-dist-')
    const pkg = join(dir, 'packages', 'p')
    mkdirSync(join(pkg, 'src'), { recursive: true })
    mkdirSync(join(pkg, 'dist'), { recursive: true })
    writeFileSync(join(pkg, 'tsconfig.build.json'), JSON.stringify({ exclude: excludes }))
    for (const f of src) { mkdirSync(dirname(join(pkg, 'src', f)), { recursive: true }); writeFileSync(join(pkg, 'src', f), '') }
    for (const f of dist) { mkdirSync(dirname(join(pkg, 'dist', f)), { recursive: true }); writeFileSync(join(pkg, 'dist', f), '') }
    const past = new Date(Date.now() - 60_000)
    for (const f of src) utimesSync(join(pkg, 'src', f), past, past)
    return { dir, pkg }
  }

  it("only a package's own excludes are skipped: core's testlib is not built, vl's would be", () => {
    const { dir, pkg } = make(['src/**/*.testlib.ts'], ['a.ts', 'a.testlib.ts', 'b.test.ts'], ['a.js', 'b.test.js'])
    try {
      expect(buildInputs(pkg).map((f) => f.slice(pkg.length + 5)).sort()).toEqual(['a.ts', 'b.test.ts'])
      expect(distProblems(dir, ['p'])).toEqual([])
    } finally { removeTempDir(dir) }
  })

  it('reports a missing output, an older one, and one whose source is gone', () => {
    const { dir, pkg } = make([], ['a.ts', 'b.ts'], ['a.js', 'gone.js'])
    try {
      const old = new Date(Date.now() - 3_600_000)
      utimesSync(join(pkg, 'dist', 'a.js'), old, old)
      const problems = distProblems(dir, ['p']).join('\n')
      expect(problems).toMatch(/dist\/a\.js is older than its source/)
      expect(problems).toMatch(/dist\/b\.js is missing/)
      expect(problems).toMatch(/dist\/gone\.js is an orphan: it has no source/)
    } finally { removeTempDir(dir) }
  })

  it('the committed packages: their build inputs are what the build emits (when built)', () => {
    for (const p of ['core', 'react', 'vl']) expect(buildInputs(join(root, 'packages', p)).length, p).toBeGreaterThan(20)
    if (existsSync(join(root, 'packages', 'core', 'dist'))) expect(distProblems(root, ['core', 'react', 'vl']).filter((x) => /is an orphan/.test(x))).toEqual([])
  })
})
