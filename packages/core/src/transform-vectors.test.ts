/**
 * Replay of the TRANSFORM-level oracle vectors recorded from real Vega
 * (`packages/conformance/scripts/gen-transform-vectors.mjs` ->
 * `testdata/transform-vectors/vega-transforms*.json`): transform params + input rows ->
 * output rows, compared strictly (NaN, -0, undefined-valued keys, Dates, row
 * order, shared/cyclic structure and thrown errors included).
 *
 * The time-bearing vectors (`timeunit`) were recorded under several non-UTC
 * zones; each case pins `process.env.TZ` while it runs (Node re-reads it).
 *
 * Randomness: the vectors were recorded with vega-statistics' `random` pinned to
 * its seeded LCG (seed 42); the engine draws from the same LCG with the same
 * fixed seed per evaluation (see `transform-random.ts`), so bootstrap (ci0/ci1),
 * `sample` and the like are exact vectors rather than property checks.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import './addon-transforms.js'
import { applyTransforms, type Row } from './transform.js'
import { compileExpr } from './expression.js'
import type { CompiledTransform } from './types.js'

const vectorsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'testdata', 'transform-vectors')

interface VCase {
  name: string
  transform: unknown
  rows: unknown
  extra?: Record<string, unknown>
  signals?: string[]
  tz?: string
  want: unknown
  wantSignals?: Record<string, unknown>
}
interface VSuite { oracle: string; kind: 'transform'; seed: number; cases: VCase[] }
interface VFile { suites: Record<string, VSuite> }

/** Inverse of the generator's codec, including back-references to ancestors. */
function dec(v: unknown, stack: unknown[] = []): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) {
    const out: unknown[] = []
    stack.push(out)
    for (const x of v) out.push(dec(x, stack))
    stack.pop()
    return out
  }
  const o = v as Record<string, unknown>
  switch (o.$) {
    case 'undef': return undefined
    case 'nan': return NaN
    case 'inf': return Infinity
    case '-inf': return -Infinity
    case '-0': return -0
    case 'date': return new Date(o.ms === null ? NaN : (o.ms as number))
    case 're': return new RegExp(o.src as string, o.flags as string)
    case 'bigint': return BigInt(o.v as string)
    case 'fn': return () => undefined
    case 'cycle': return stack[stack.length - (o.up as number)]
    case 'throw': return o
  }
  const out: Record<string, unknown> = {}
  stack.push(out)
  for (const k of Object.keys(o)) Object.defineProperty(out, k, { value: dec(o[k], stack), writable: true, enumerable: true, configurable: true })
  stack.pop()
  return out
}

/** Strict structural equality; returns the path of the first difference, or null. */
function diff(a: unknown, b: unknown, path = '$', seen = new Map<unknown, Set<unknown>>()): string | null {
  if (Object.is(a, b)) return null
  if (a instanceof Date && b instanceof Date) return Object.is(a.getTime(), b.getTime()) ? null : `${path}: Date ${String(a)} vs ${String(b)}`
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return `${path}: ${show(a)} vs ${show(b)}`
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs non-array`
  let s = seen.get(a)
  if (s?.has(b)) return null
  if (!s) seen.set(a, (s = new Set()))
  s.add(b)
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    if (a.length !== bb.length) return `${path}.length: ${a.length} vs ${bb.length}`
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], bb[i], `${path}[${i}]`, seen)
      if (d) return d
    }
    return null
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  const sb = new Set(kb)
  for (const k of ka) if (!sb.has(k)) return `${path}.${k}: extra key in actual (${show((a as Record<string, unknown>)[k])})`
  const sa = new Set(ka)
  for (const k of kb) if (!sa.has(k)) return `${path}.${k}: missing key in actual (want ${show((b as Record<string, unknown>)[k])})`
  for (const k of ka) {
    const d = diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, seen)
    if (d) return d
  }
  return null
}
function show(v: unknown): string {
  if (typeof v === 'object' && v !== null) return Array.isArray(v) ? `[array ${v.length}]` : '{object}'
  return typeof v === 'string' ? JSON.stringify(v) : String(v)
}

const runtime = {
  scale: () => undefined,
  data: () => [],
  expr: (e: string) => compileExpr(e, runtime),
}

/** Freeze a decoded input graph (rows, nested objects/arrays); Dates are left alone. */
function deepFreeze<T>(v: T, seen = new Set<unknown>()): T {
  if (v === null || typeof v !== 'object' || seen.has(v) || v instanceof Date) return v
  seen.add(v)
  Object.freeze(v)
  for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k], seen)
  return v
}

function run(c: VCase, freeze = false): { rows: Row[]; signals: Record<string, unknown> } {
  const extra: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(c.extra ?? {})) extra[k] = (freeze ? deepFreeze(dec(v)) : dec(v)) as Row[]
  const signals: Record<string, unknown> = Object.create(null)
  const ctx = {
    runtime,
    signals,
    datasets: (n: string) => extra[n],
    hierarchies: new Map<string, unknown>(),
  }
  const rows = (freeze ? deepFreeze(dec(c.rows)) : dec(c.rows)) as Row[]
  const transforms = dec(c.transform) as CompiledTransform[]
  return { rows: applyTransforms(rows, transforms, ctx, 'src'), signals }
}

const files = ['vega-transforms.json', 'vega-transforms-time.json']
for (const file of files) {
  const doc = JSON.parse(readFileSync(join(vectorsDir, file), 'utf8')) as VFile
  describe(`transform vectors: ${file}`, () => {
    for (const [suite, s] of Object.entries(doc.suites)) {
      describe(`${suite} (${s.oracle})`, () => {
        for (const c of s.cases) {
          it(c.tz ? `[${c.tz}] ${c.name}` : c.name, () => {
            const prevTz = process.env.TZ
            if (c.tz) process.env.TZ = c.tz
            try {
              const want = c.want as { $?: string; message?: string }
              if (want && want.$ === 'throw') {
                // Vega threw: the engine must refuse too, with Vega's message
                // unless it is an incidental TypeError text of the oracle.
                let msg: string | null = null
                try { run(c) } catch (e) { msg = e instanceof Error ? e.message : String(e) }
                expect(msg, 'engine must throw like Vega').not.toBeNull()
                if (!/Cannot read properties|is not a function|is not iterable/.test(want.message ?? '')) {
                  expect(msg).toContain(want.message)
                }
                return
              }
              const got = run(c)
              const d = diff(got.rows, dec(c.want))
              expect(d, d ?? '').toBeNull()
              // The inputs are never mutated: the same run over deep-frozen rows (a write
              // would throw in strict mode) gives the same output.
              const frozen = run(c, true)
              const df = diff(frozen.rows, dec(c.want))
              expect(df, `frozen inputs: ${df ?? ''}`).toBeNull()
              for (const [k, v] of Object.entries(c.wantSignals ?? {})) {
                const ds = diff(got.signals[k], dec(v), `signal ${k}`)
                expect(ds, ds ?? '').toBeNull()
              }
            } finally {
              if (c.tz) {
                if (prevTz === undefined) delete process.env.TZ
                else process.env.TZ = prevTz
              }
            }
          })
        }
      })
    }
  })
}
