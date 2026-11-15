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
import { JSDOM, VirtualConsole } from 'jsdom'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// (under packages/react, so `react`, `react-dom` and `@aster-charts/react` resolve as in a consumer's app)
const TMP = join(root, 'packages', 'react', '.tmp-devwarn')
const WARNING = 'were changed in place since the last render'
/** A part of the warning the app does not spell itself: what a production bundle must not contain. */
const LIBRARY_TEXT = 'treats the rows it is given as immutable'

// The app moves on when the chart has drawn what the step before asked for, never after a fixed delay: a render slower than the
// delay (a machine under load) would let the rows change before the first render saw them, and the run would read "no warning"
// for a reason that has nothing to do with the warning. Every error the page sees -- the chart's own (onError, its logger), React's, the
// window's -- is collected and reported with the result.
const APP = `
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Chart } from '@aster-charts/react'
const warnings = []
const errors = []
const note = (where) => (e) => { errors.push(where + ': ' + String(e && e.stack ? e.stack : e)) }
const logger = { error: (...a) => errors.push('chart logger: ' + a.map(String).join(' ')), warn: (m) => { warnings.push(String(m)) } }
const spec = {
  width: 60, height: 30,
  data: [{ name: 't' }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { field: 'v' }, width: { value: 1 }, y: { value: 0 }, height: { value: 1 } } } }],
}
const data = { t: [{ v: 1 }, { v: 2 }, { v: 3 }] }
const host = document.createElement('div')
document.body.appendChild(host)
const root = createRoot(host, { onUncaughtError: note('React (uncaught)'), onCaughtError: note('React (caught)'), onRecoverableError: note('React (recoverable)') })
const commits = new Set()
function Committed({ step, children }) {
  React.useEffect(() => { commits.add(step) }, [step])
  return children
}
const draw = (step) => root.render(React.createElement(Committed, { step }, React.createElement(Chart, { spec, data, width: 60, height: 30, logger, onError: note('chart onError') })))
const items = () => host.querySelectorAll('.mark-rect path').length
const finish = (extra) => {
  window.__result = { warnings: warnings.filter((w) => w.includes(${JSON.stringify(WARNING)})).length, hasProcess: typeof process !== 'undefined', svg: !!host.querySelector('svg'), ...extra }
  window.__errors = errors
}
const until = (step, rows, then) => {
  let tries = 0
  const tick = () => {
    if (commits.has(step) && (rows === undefined || items() === rows)) return then()
    if (errors.length > 0) return finish({ stuck: 'step ' + step + ' failed' })
    if (++tries > 800) return finish({ stuck: 'step ' + step + ' never drew: ' + items() + ' items, committed ' + commits.has(step) })
    setTimeout(tick, 25)
  }
  tick()
}
draw(1)
until(1, 3, () => {
  data.t.push({ v: 4 })
  draw(2)
  // (the chart takes its rows as immutable: the same array, changed in place, draws as it did, and is warned about)
  until(2, 3, () => {
    draw(3)
    until(3, 3, () => finish({}))
  })
})
`

/**
 * Run a classic-script bundle in a fresh jsdom window (no Node globals) and return what the app reports, with every error the page
 * saw: the window's error events, what jsdom itself reports (its virtual console), and what the app collected (the chart's logger,
 * React's error callbacks).
 */
async function runInWindow(code) {
  const virtualConsole = new VirtualConsole()
  const errors = []
  virtualConsole.on('jsdomError', (e) => errors.push(`jsdom: ${e.stack ?? e}`))
  virtualConsole.on('error', (...a) => errors.push(`console.error: ${a.map(String).join(' ')}`))
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/', virtualConsole })
  dom.window.addEventListener('error', (e) => errors.push(`window: ${String(e.error?.stack ?? e.error ?? e.message)}`))
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  dom.window.eval(code)
  // (the app gives up on a step after 20 s and says which; this is a bound for an app that never got to run its steps at all)
  for (let i = 0; i < 1000 && dom.window.__result === undefined; i++) await new Promise((r) => setTimeout(r, 25))
  const result = dom.window.__result ?? { stuck: 'the app never reported' }
  errors.push(...(dom.window.__errors ?? []))
  dom.window.close()
  return { result, errors }
}

/** A bundle and what its bundler said while making it (warnings; an error ends the build and is thrown with this log). */
const built = (label, code, log) => ({ label, code, log })

/** The failure message of a run: which bundle, and everything its build logged, so a failed or partial build is never read as "no warning". */
const about = (bundle) => `${bundle.label}${bundle.log.length ? `\nthe build logged:\n${bundle.log.join('\n')}` : ''}`

async function esbuildApp(mode, format = 'iife') {
  const label = `esbuild, ${mode}, ${format}`
  const entry = join(TMP, 'app.mjs')
  let r
  try {
    r = await build({
      entryPoints: [entry], bundle: true, write: false, format: format === 'es' ? 'esm' : 'iife', platform: 'browser', minify: mode === 'production',
      define: { 'process.env.NODE_ENV': JSON.stringify(mode) }, logLevel: 'silent',
    })
  } catch (e) {
    throw new Error(`the ${label} build failed: ${e.message}`, { cause: e })
  }
  const log = r.warnings.map((w) => `warning: ${w.text}${w.location ? ` (${w.location.file}:${w.location.line})` : ''}`)
  const code = r.outputFiles.map((f) => f.text).join('\n')
  if (code.trim() === '') throw new Error(`the ${label} build wrote no code\n${log.join('\n')}`)
  return built(label, code, log)
}

async function viteApp(mode, format = 'iife') {
  const label = `Vite, ${mode}, ${format}`
  // the Vite of the repo's toolchain (vitest's own), not one installed for this test
  const vitePath = createRequire(createRequire(join(root, 'package.json')).resolve('vitest/package.json')).resolve('vite')
  const vite = await import(vitePath)
  const outDir = join(TMP, `vite-${mode}-${format}`)
  const log = []
  // (Vite writes the Node process's own NODE_ENV into the bundle when it has one, and vitest sets it to "test": the build gets the
  // NODE_ENV a real `vite build --mode <mode>` run has)
  const saved = process.env.NODE_ENV
  process.env.NODE_ENV = mode
  try {
    await viteBuild(vite, mode, outDir, format, log)
  } catch (e) {
    throw new Error(`the ${label} build failed: ${e.message}${log.length ? `\nthe build logged:\n${log.join('\n')}` : ''}`, { cause: e })
  } finally {
    process.env.NODE_ENV = saved
  }
  // (an error Vite logged and recovered from is a failed build all the same)
  if (log.some((l) => l.startsWith('error:'))) throw new Error(`the ${label} build logged an error:\n${log.join('\n')}`)
  const assets = join(outDir, 'assets')
  const files = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith('.js')) : []
  if (files.length === 0) throw new Error(`the ${label} build wrote no script\n${log.join('\n')}`)
  return built(label, files.map((f) => readFileSync(join(assets, f), 'utf8')).join('\n'), log)
}

async function viteBuild(vite, mode, outDir, format, log) {
  // Vite's own log, kept instead of silenced: a build can log an error it recovers from, and that is what a failure report needs
  const customLogger = {
    info() {},
    warn: (msg) => { log.push(`warning: ${msg}`) },
    warnOnce: (msg) => { log.push(`warning: ${msg}`) },
    error: (msg, options) => { log.push(`error: ${msg}${options?.error?.stack ? `\n${options.error.stack}` : ''}`) },
    clearScreen() {},
    hasErrorLogged: () => false,
    hasWarned: false,
  }
  await vite.build({
    root: TMP, mode, customLogger, configFile: false,
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
      const app = await bundle('development')
      expect(app.code.includes(LIBRARY_TEXT), about(app)).toBe(true)
      expect(await runInWindow(app.code), about(app)).toEqual({ result: { warnings: 1, hasProcess: false, svg: true }, errors: [] })
    }, 120_000)

    it(`${bundler}, production: nothing, and none of its code`, async () => {
      // (none of it in the bundle as the bundler writes it by default -- Vite: ES modules; Rollup keeps a call written inside a `try`
      // when it writes a classic script, as dead code the guard never reaches; see core's row-watch.ts)
      const es = await bundle('production', 'es')
      expect(es.code.includes(LIBRARY_TEXT), about(es)).toBe(false)
      const app = await bundle('production')
      expect(await runInWindow(app.code), about(app)).toEqual({ result: { warnings: 0, hasProcess: false, svg: true }, errors: [] })
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
