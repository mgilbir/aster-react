/**
 * Guards for the `sideEffects` manifests and the two gates that depend on them
 * (scripts/check-bundle-shaking.mjs, packages/benchmarks/scripts/budget.mjs).
 *
 * The slow tests plant the fault the gates exist to catch and require the gate to FAIL: a blanket
 * `"sideEffects": false`, and a manifest with no `sideEffects` at all. A gate that has never been seen
 * to fail proves nothing. They bundle the built packages, so they need `pnpm build` (the `build` gate runs first).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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

const run = (script, args, env = {}) => spawnSync(process.execPath, [join(root, script), ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 280_000 })

describe('the gates bite', () => {
  it('check-bundle-shaking passes on the manifests as they are', () => {
    const r = run('scripts/check-bundle-shaking.mjs', [])
    expect(r.stdout + r.stderr).toContain('all patterns passed')
    expect(r.status).toBe(0)
  }, 300_000)

  it('check-bundle-shaking FAILS when every module is declared side-effect free ("sideEffects": false)', () => {
    const r = run('scripts/check-bundle-shaking.mjs', ['--blanket-false'])
    expect(r.status).toBe(1)
    // the patterns that live on an import side effect must be the ones that break
    for (const name of ['core-renderSpec', 'core-geo', 'core-transforms', 'core-load-bare', 'core-dom', 'react-vl', 'react-worker', 'react-worker-entry']) {
      expect(r.stdout, name).toMatch(new RegExp(`^FAIL ${name} `, 'm'))
    }
  }, 300_000)

  it('the budget FAILS when the manifests do not shake (no sideEffects field): the useChart row regains Chart, streams and workers', () => {
    const r = run('packages/benchmarks/scripts/budget.mjs', [], { ASTER_BUDGET_IGNORE_SIDE_EFFECTS: '1' })
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/@aster\/react useChart .*FAIL/)
    expect(r.stdout).toMatch(/@aster\/react Chart .*FAIL/)
  }, 300_000)
})
