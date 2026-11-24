/**
 * Fails a conformance test that hands one object to both engines (audit C61).
 *
 * Vega writes onto what it is given (inline rows get a tuple id and whatever the transforms compute: `stack` y0/y1, `pie`
 * angles, `bin` bins, `geopoint` x/y), so an Aster that reads the same rows after the oracle ran reads the oracle's answers. Every
 * harness must give each engine its own copy (src/engines.ts `forEngines`). This setup file holds every test under
 * packages/conformance to that at run time: the oracle's entry points (`vega.parse`, a View's `data` / `insert`) and every
 * function the Aster packages export note each plain object and array reachable from their arguments; an object one side has
 * noted that reaches the other side fails the test (afterEach), naming both entry points and where the second call was made.
 * (vega-lite's `compile` is not an engine: it reads a specification and writes none. What it emits often holds the input's
 * rows, and when those rows reach vega's dataflow the second engine's read of them is what is caught.)
 *
 * Frozen objects are exempt: nothing can be written onto them, by either engine (vega's own write onto a frozen row throws).
 * Scene nodes (objects with a `marktype`) are not walked: they are Aster's output, not a spec.
 *
 * It only runs for test files under packages/conformance (the mocks return the real modules untouched elsewhere).
 * scripts/engine-sharing.test.mjs proves it fails a test that shares, and passes one that copies.
 */
import { afterEach, expect, vi } from 'vitest'

const conformanceTest = () => /[\\/]packages[\\/]conformance[\\/]/.test(expect.getState().testPath ?? '')

/** What each side has read, and the sharing found in the current test (module state: fresh for every test file). */
const seen = { oracle: new WeakMap(), aster: new WeakMap() }
const violations = []

function walkable(o) {
  if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return false
  if (Array.isArray(o)) return true
  const proto = Object.getPrototypeOf(o)
  return (proto === Object.prototype || proto === null) && !('marktype' in o)
}

const LIMIT = 500_000

/** Note what `side`'s entry point `where` was handed; record a violation for anything the other side has noted. */
function note(side, args, where) {
  const mine = seen[side]
  const other = seen[side === 'oracle' ? 'aster' : 'oracle']
  const visited = new Set()
  const stack = [...args]
  let reported = false
  while (stack.length && visited.size < LIMIT) {
    const o = stack.pop()
    if (!walkable(o) || visited.has(o)) continue
    visited.add(o)
    const before = other.get(o)
    if (before !== undefined && !reported) {
      reported = true
      let shown
      try { shown = JSON.stringify(o)?.slice(0, 100) } catch { shown = '(not serialisable)' }
      // (where the harness made the call: the first frame outside this file and outside node_modules)
      const at = (new Error().stack ?? '').split('\n').slice(1).map((l) => l.trim()).find((l) => !l.includes('engine-sharing.setup') && !l.includes('node_modules')) ?? ''
      violations.push(`${where} (${side}) was handed an object ${before} (${side === 'oracle' ? 'aster' : 'oracle'}) was handed first, ${at}: ${shown}`)
    }
    if (!mine.has(o)) mine.set(o, where)
    for (const k of Object.keys(o)) {
      const v = o[k]
      if (v !== null && typeof v === 'object') stack.push(v)
    }
  }
}

const isPlainFunction = (f) => typeof f === 'function' && !/^class\b/.test(Function.prototype.toString.call(f)) && !/^[A-Z]/.test(f.name)

/** Wrap a module's plain function exports (and the methods of a plain object one returns) so their arguments are noted. */
function wrapModule(real, side, label) {
  if (!conformanceTest()) return real
  const out = { ...real }
  for (const [name, f] of Object.entries(real)) {
    if (!isPlainFunction(f)) continue
    out[name] = function (...args) {
      note(side, args, `${label}.${name}`)
      const r = f.apply(this, args)
      if (r !== null && typeof r === 'object' && typeof r.then !== 'function' && Object.getPrototypeOf(r) === Object.prototype && !Object.isFrozen(r)) {
        for (const [k, m] of Object.entries(r)) {
          if (typeof m !== 'function') continue
          try { r[k] = function (...a) { note(side, a, `${label}.${name}().${k}`); return m.apply(this, a) } } catch { /* a read-only method: left as is */ }
        }
      }
      return r
    }
  }
  return out
}

vi.mock('vega', async (importOriginal) => {
  const real = await importOriginal()
  if (!conformanceTest()) return real
  const proto = real.View.prototype
  if (!proto.__engineSharing) {
    Object.defineProperty(proto, '__engineSharing', { value: true })
    for (const m of ['data', 'insert']) {
      const f = proto[m]
      // (vega reads the arguments' count: `data(name)` is the getter, so they are passed on as they came)
      proto[m] = function (...args) {
        if (args.length > 1) note('oracle', [args[1]], `vega View.${m}`)
        return f.apply(this, args)
      }
    }
  }
  return { ...real, parse: (spec, ...rest) => { note('oracle', [spec], 'vega.parse'); return real.parse(spec, ...rest) } }
})
vi.mock('@aster-charts/core', async (importOriginal) => wrapModule(await importOriginal(), 'aster', '@aster-charts/core'))
vi.mock('@aster-charts/core/load', async (importOriginal) => wrapModule(await importOriginal(), 'aster', '@aster-charts/core/load'))
vi.mock('@aster-charts/core/dom', async (importOriginal) => wrapModule(await importOriginal(), 'aster', '@aster-charts/core/dom'))
vi.mock('@aster-charts/core/signals', async (importOriginal) => wrapModule(await importOriginal(), 'aster', '@aster-charts/core/signals'))
vi.mock('@aster-charts/core/canvas', async (importOriginal) => wrapModule(await importOriginal(), 'aster', '@aster-charts/core/canvas'))
vi.mock('@aster-charts/vl', async (importOriginal) => wrapModule(await importOriginal(), 'aster', '@aster-charts/vl'))

afterEach(() => {
  if (violations.length === 0) return
  const found = violations.splice(0)
  throw new Error(`a test handed one object to both engines (give each its own copy: src/engines.ts forEngines):\n  ${found.slice(0, 5).join('\n  ')}${found.length > 5 ? `\n  ... and ${found.length - 5} more` : ''}`)
})
