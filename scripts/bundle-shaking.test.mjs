/**
 * Guards for the `sideEffects` manifests and the two gates that depend on them
 * (scripts/check-bundle-shaking.mjs, packages/benchmarks/scripts/budget.mjs).
 *
 * The slow tests plant the fault the gates exist to catch and require the gate to FAIL: a blanket
 * `"sideEffects": false`, and a manifest with no `sideEffects` at all. A gate that has never been seen
 * to fail proves nothing. They bundle the built packages, so they need `pnpm build` (the `build` gate runs first).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { spawnAsync } from './lib/spawn-async.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = (pkg) => JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8'))
const sourcesOf = (pkg) => readdirSync(join(root, 'packages', pkg, 'src')).filter((f) => /\.tsx?$/.test(f) && !/\.(test|testlib|testkit)\.tsx?$/.test(f) && !f.endsWith('.d.ts'))

describe('sideEffects manifests', () => {
  it('are declared on every public package, as dist paths that exist', () => {
    for (const pkg of ['core', 'react', 'vl']) {
      const se = manifest(pkg).sideEffects
      expect(se === false || Array.isArray(se), `${pkg}: sideEffects must be false or a list`).toBe(true)
      for (const f of Array.isArray(se) ? se : []) {
        expect(f.startsWith('./dist/') && f.endsWith('.js'), `${pkg}: ${f}`).toBe(true)
        expect(existsSync(join(root, 'packages', pkg, f)), `${pkg}: ${f} is not built (pnpm build)`).toBe(true)
      }
    }
  })

  it('list every module that is imported for its side effect alone (`import "./x.js"`), and every addon entry', () => {
    for (const pkg of ['core', 'react', 'vl']) {
      const se = new Set(Array.isArray(manifest(pkg).sideEffects) ? manifest(pkg).sideEffects : [])
      for (const file of sourcesOf(pkg)) {
        for (const m of readFileSync(join(root, 'packages', pkg, 'src', file), 'utf8').matchAll(/^import '\.\/([\w-]+)\.js'/gm)) {
          expect(se.has(`./dist/${m[1]}.js`), `${pkg}/src/${file} imports ./${m[1]}.js for its effect, so the manifest must list ./dist/${m[1]}.js`).toBe(true)
        }
      }
    }
    // the addon entries that register themselves into the core registries
    const core = new Set(manifest('core').sideEffects)
    for (const f of ['addon-geo', 'addon-load', 'addon-transforms']) expect(core.has(`./dist/${f}.js`), f).toBe(true)
    const react = new Set(manifest('react').sideEffects)
    for (const f of ['vl', 'worker-entry']) expect(react.has(`./dist/${f}.js`), f).toBe(true)
  })
})

const run = (script, args, env = {}) => spawnAsync(process.execPath, [join(root, script), ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 280_000 })

describe('the gates bite', () => {
  it('check-bundle-shaking passes on the manifests as they are', async () => {
    const r = await run('scripts/check-bundle-shaking.mjs', [])
    expect(r.stdout + r.stderr).toContain('all patterns passed')
    expect(r.status).toBe(0)
  }, 300_000)

  it('check-bundle-shaking FAILS when every module is declared side-effect free ("sideEffects": false)', async () => {
    const r = await run('scripts/check-bundle-shaking.mjs', ['--blanket-false'])
    expect(r.status).toBe(1)
    // the patterns that live on an import side effect must be the ones that break
    for (const name of ['core-renderSpec', 'core-geo', 'core-transforms', 'core-load-bare', 'core-dom', 'react-vl', 'react-worker', 'react-worker-entry']) {
      expect(r.stdout, name).toMatch(new RegExp(`^FAIL ${name} `, 'm'))
    }
  }, 300_000)

  it('the budget FAILS when the manifests do not shake (no sideEffects field): the useChart row regains Chart, streams and workers', async () => {
    const r = await run('packages/benchmarks/scripts/budget.mjs', [], { ASTER_BUDGET_SIDE_EFFECTS: 'all' })
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/@aster-charts\/react useChart .*FAIL/)
    expect(r.stdout).toMatch(/@aster-charts\/react Chart .*FAIL/)
    // a failing run leaves nothing in the tree (it used to exit inside the try, past the clean-up)
    expect(readdirSync(join(root, 'packages', 'benchmarks')).filter((n) => /^\.tmp/.test(n))).toEqual([])
  }, 300_000)

  it('the budget FAILS when an import that a row is built on is shaken out: it must not print PASS at 0.00 kB (C522)', async () => {
    const r = await run('packages/benchmarks/scripts/budget.mjs', [], { ASTER_BUDGET_SIDE_EFFECTS: 'none' })
    expect(r.status).toBe(1)
    for (const row of ['@aster-charts/core/geo', '@aster-charts/core/transforms']) expect(r.stdout, row).toMatch(new RegExp(`\\+ ${row.replace(/[/]/g, '\\/')} .*FAIL \\((measured nothing|more than 0\\.7 kB under its ceiling)`))
    // the React rows that are built on a bare import
    for (const row of ['Chart + all', 'Chart + VL']) expect(r.stdout, row).toMatch(new RegExp(`@aster-charts/react ${row.replace('+', '\\+')} .*FAIL`))
    expect(r.stdout).not.toMatch(/gzip= *0\.00 kB.*PASS/)
    expect(readdirSync(join(root, 'packages', 'benchmarks')).filter((n) => /^\.tmp/.test(n))).toEqual([])
  }, 300_000)

  it('the budget refuses an unknown ASTER_BUDGET_SIDE_EFFECTS', async () => {
    const r = await run('packages/benchmarks/scripts/budget.mjs', [], { ASTER_BUDGET_SIDE_EFFECTS: 'maybe' })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/ASTER_BUDGET_SIDE_EFFECTS is "all" or "none"/)
  }, 60_000)
})

describe('check-bundle-shaking refuses arguments that would select nothing (C496)', () => {
  const run = (...args) => spawnAsync(process.execPath, [join(root, 'scripts', 'check-bundle-shaking.mjs'), ...args], { timeout: 120_000 })

  it('--only with a name that is no pattern exits 2 and says which', async () => {
    const r = await run('--only', 'react-vll')
    expect(r.status, r.stdout + r.stderr).toBe(2)
    expect(r.stderr).toMatch(/unknown pattern for --only: react-vll/)
    expect(r.stdout).not.toMatch(/all patterns passed/)
  }, 150_000)

  it('--only with one good and one bad name, and with an empty value, exit 2', async () => {
    const mixed = await run('--only', 'react-vl,nope')
    expect(mixed.status).toBe(2)
    expect(mixed.stderr).toMatch(/unknown pattern for --only: nope/)
    const empty = await run('--only', '')
    expect(empty.status).toBe(2)
    expect(empty.stderr).toMatch(/\(none given\)/)
  }, 150_000)

  it('--bundler with an unknown value exits 2 instead of running esbuild', async () => {
    const r = await run('--bundler', 'rollup')
    expect(r.status, r.stdout + r.stderr).toBe(2)
    expect(r.stderr).toMatch(/--bundler must be esbuild or vite/)
  }, 150_000)

  it('a real pattern still runs and passes (control)', async () => {
    const r = await run('--only', 'core-geo')
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toMatch(/ok\s+core-geo/)
  }, 150_000)

  it('a run keeps to its own scratch directory: another run\'s files in the old shared one survive it', async () => {
    // The scratch directory used to be a fixed path that every run deleted and recreated, so a run by hand while `pnpm test` ran this script
    // removed the other's bundles. A sentinel in that old path must be untouched now.
    const shared = join(root, 'packages', 'react', '.tmp-shaking')
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(shared, 'other-run.txt'), 'x')
    try {
      const r = await run('--only', 'core-geo')
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(existsSync(join(shared, 'other-run.txt'))).toBe(true)
      expect(readdirSync(join(root, 'packages', 'react')).filter((n) => /^\.tmp-shaking-\d+$/.test(n)), 'the run removes its own directory').toEqual([])
    } finally {
      rmSync(shared, { recursive: true, force: true })
    }
  }, 150_000)
})
