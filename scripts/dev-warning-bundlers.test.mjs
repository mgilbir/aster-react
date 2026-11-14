/**
 * The development warning for rows changed in place (core row-watch.ts) fires in a real development bundle, and only there.
 *
 * A tiny app -- `<Chart>` from the built `@aster-charts/react` dist, its rows changed in place between two renders -- is bundled
 * by esbuild (`define: process.env.NODE_ENV = "development"`) and by Vite (`mode: 'development'`, the toolchain's own Vite), and
 * run inside a jsdom window: a browser-like global scope with no `process` object, as the page a bundler serves. The warning must
 * fire once. Unit tests cannot see this: they run in Node, where `process` exists (a guard on `typeof process` passed every unit
 * test and never ran under Vite). The same app built for production must warn about nothing, and carry none of the warning's code.
 *
 * Needs `pnpm build` (it bundles the packages' dist; the `build` gate runs first).
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// (under packages/react, so `react`, `react-dom` and `@aster-charts/react` resolve as in a consumer's app)
const TMP = join(root, 'packages', 'react', '.tmp-devwarn')
const WARNING = 'were changed in place since the last render'
/** A part of the warning the app does not spell itself: what a production bundle must not contain. */
const LIBRARY_TEXT = 'treats the rows it is given as immutable'

const APP = `
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Chart } from '@aster-charts/react'
const warnings = []
const logger = { error() {}, warn: (m) => { warnings.push(String(m)) } }
const spec = {
  width: 60, height: 30,
  data: [{ name: 't' }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { field: 'v' }, width: { value: 1 }, y: { value: 0 }, height: { value: 1 } } } }],
}
const data = { t: [{ v: 1 }, { v: 2 }, { v: 3 }] }
const host = document.createElement('div')
document.body.appendChild(host)
const root = createRoot(host)
const draw = () => root.render(React.createElement(Chart, { spec, data, width: 60, height: 30, logger }))
draw()
setTimeout(() => {
  data.t.push({ v: 4 })
  draw()
  setTimeout(() => {
    draw()
    setTimeout(() => {
      window.__result = { warnings: warnings.filter((w) => w.includes(${JSON.stringify(WARNING)})).length, hasProcess: typeof process !== 'undefined', svg: !!host.querySelector('svg') }
    }, 20)
  }, 20)
}, 20)
`

/** Run a classic-script bundle in a fresh jsdom window (no Node globals) and return what the app reports. */
async function runInWindow(code) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' })
  const errors = []
  dom.window.addEventListener('error', (e) => errors.push(String(e.error ?? e.message)))
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  dom.window.eval(code)
  for (let i = 0; i < 200 && dom.window.__result === undefined; i++) await new Promise((r) => setTimeout(r, 25))
  const result = dom.window.__result
  dom.window.close()
  return { result, errors }
}

async function esbuildApp(mode, format = 'iife') {
  const entry = join(TMP, 'app.mjs')
  const r = await build({
    entryPoints: [entry], bundle: true, write: false, format: format === 'es' ? 'esm' : 'iife', platform: 'browser', minify: mode === 'production',
    define: { 'process.env.NODE_ENV': JSON.stringify(mode) }, logLevel: 'silent',
  })
  return r.outputFiles.map((f) => f.text).join('\n')
}

async function viteApp(mode, format = 'iife') {
  // the Vite of the repo's toolchain (vitest's own), not one installed for this test
  const vitePath = createRequire(createRequire(join(root, 'package.json')).resolve('vitest/package.json')).resolve('vite')
  const vite = await import(vitePath)
  const outDir = join(TMP, `vite-${mode}-${format}`)
  // (Vite writes the Node process's own NODE_ENV into the bundle when it has one, and vitest sets it to "test": the build gets the
  // NODE_ENV a real `vite build --mode <mode>` run has)
  const saved = process.env.NODE_ENV
  process.env.NODE_ENV = mode
  try {
    await viteBuild(vite, mode, outDir, format)
  } finally {
    process.env.NODE_ENV = saved
  }
  const assets = join(outDir, 'assets')
  return readdirSync(assets).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(assets, f), 'utf8')).join('\n')
}

async function viteBuild(vite, mode, outDir, format) {
  await vite.build({
    root: TMP, mode, logLevel: 'silent', configFile: false,
    build: {
      outDir, emptyOutDir: true, minify: mode === 'production',
      rollupOptions: { input: join(TMP, 'index.html'), output: { format, inlineDynamicImports: true } },
    },
  })
}

beforeAll(() => {
  for (const pkg of ['core', 'react']) {
    if (!existsSync(join(root, 'packages', pkg, 'dist', 'index.js'))) throw new Error(`packages/${pkg}/dist is missing: run pnpm build`)
  }
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  writeFileSync(join(TMP, 'app.mjs'), APP)
  writeFileSync(join(TMP, 'index.html'), '<!doctype html><html><body><script type="module" src="./app.mjs"></script></body></html>')
})
afterAll(() => { rmSync(TMP, { recursive: true, force: true }) })

describe('the development warning in real bundles, run where there is no `process`', () => {
  for (const [bundler, bundle] of [['esbuild', esbuildApp], ['Vite', viteApp]]) {
    it(`${bundler}, development: an in-place change warns once`, async () => {
      const code = await bundle('development')
      expect(code.includes(LIBRARY_TEXT)).toBe(true)
      const { result, errors } = await runInWindow(code)
      expect(errors).toEqual([])
      expect(result).toEqual({ warnings: 1, hasProcess: false, svg: true })
    }, 120_000)

    it(`${bundler}, production: nothing, and none of its code`, async () => {
      // (none of it in the bundle as the bundler writes it by default -- Vite: ES modules; Rollup keeps a call written inside a `try`
      // when it writes a classic script, as dead code the guard never reaches; see core's row-watch.ts)
      const code = await bundle('production', 'es')
      expect(code.includes(LIBRARY_TEXT)).toBe(false)
      const { result, errors } = await runInWindow(await bundle('production'))
      expect(errors).toEqual([])
      expect(result).toEqual({ warnings: 0, hasProcess: false, svg: true })
    }, 120_000)
  }

  it('unbundled, where `process` is not defined, the guards as built are off and do not throw', async () => {
    // every guard of the built session, its check replaced by a flag, run as a classic script in a window with no `process`
    const built = readFileSync(join(root, 'packages', 'core', 'dist', 'session.js'), 'utf8')
    const guards = [...built.matchAll(/try \{\s*if \(process\.env\.NODE_ENV !== 'production'\)\s*checkChartRows\([^;]*\);\s*\}\s*catch \(e\) \{\s*if \(typeof process !== 'undefined'\)\s*throw e;\s*\}/g)].map((m) => m[0])
    expect(guards).toHaveLength(2)
    const { result, errors } = await runInWindow(`
      const out = []
      for (const run of [${guards.map((g) => `() => { let ran = false; const checkChartRows = () => { ran = true }; ${g}; return ran }`).join(', ')}]) {
        try { out.push(run()) } catch (e) { out.push('threw ' + e) }
      }
      window.__result = out`)
    expect(errors).toEqual([])
    expect(result).toEqual([false, false])
  })
})
