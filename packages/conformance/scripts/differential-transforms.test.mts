/**
 * LIVE differential for the whole transform layer: every case of
 * `transform-cases.mjs` (transform params + input rows -> output rows) runs
 * through the pinned real Vega and through `applyTransforms`, in this process,
 * and the two outputs are compared strictly: NaN, -0, undefined-valued keys,
 * Dates, row order, shared/cyclic structure and thrown errors.
 *
 * Why live and not recorded: `Math.pow/exp/log` (regression, `bin` steps,
 * exponential windows, ...) are not bit-identical across V8 versions, so numbers
 * recorded under one Node cannot gate another. Running the oracle in the same
 * engine as the code under test removes the engine from the comparison, without
 * any tolerance.
 *
 * Time cases carry the non-UTC zone they run under; each case pins
 * `process.env.TZ` while it runs (Node re-reads it), for the oracle and Aster alike.
 *
 * `window` cases (and cases flagged `dropOnCrash`) on which real Vega itself
 * crashes with an incidental TypeError are not comparable (a Vega bug, not
 * semantics); the count of those is pinned below so the exclusion cannot grow.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { applyTransforms, compileExpr, type Row } from '@aster/core'
import '@aster/core/transforms'
import { CASES, SEED } from './transform-cases.mjs'

/** Real Vega crashes (incidental TypeErrors) on exactly this many cases; see header. */
const VEGA_CRASH_EXCLUDED = 41

type Case = (typeof CASES)[number]
type Outcome = { out: unknown[]; sig: Record<string, unknown> } | { throw: Error }

async function runVega(c: Case): Promise<Outcome> {
  const data: unknown[] = []
  for (const [name, v] of Object.entries(c.opt.extra ?? {})) data.push({ name, values: structuredClone(v) })
  data.push({ name: 'src', values: structuredClone(c.rows), transform: structuredClone(c.t) })
  const errors: string[] = []
  let view: vega.View
  try {
    vega.setRandom(vega.randomLCG(SEED))
    view = new vega.View(vega.parse({ data } as vega.Spec), { renderer: 'none', logLevel: vega.None })
  } catch (err) {
    return { throw: err as Error }
  }
  view.logger({
    level() { return 1 },
    error(...a: unknown[]) { errors.push(a.map((x) => (x as Error)?.message || String(x)).join(' ')); return this },
    warn() { return this }, info() { return this }, debug() { return this },
  } as unknown as vega.LoggerInterface)
  try {
    await view.runAsync()
  } catch (err) {
    return { throw: err as Error }
  }
  if (errors.length) return { throw: new Error(errors[0].replace(/^Error: /, '')) }
  const sig: Record<string, unknown> = {}
  for (const s of (c.opt.signals ?? []) as string[]) sig[s] = view.signal(s)
  return { out: view.data('src'), sig }
}

const INCIDENTAL = /Cannot read properties|is not a function|is not iterable/
const crashed = (c: Case, r: Outcome): boolean =>
  'throw' in r && (c.opt.dropOnCrash || c.suite === 'window') && /Cannot read properties|is not a function/.test(String(r.throw.message))

/** Strict structural equality; returns the path of the first difference, or null. */
function diff(a: unknown, b: unknown, path = '$', seen = new Map<unknown, Set<unknown>>()): string | null {
  if (Object.is(a, b)) return null
  if (a instanceof Date && b instanceof Date) return Object.is(a.getTime(), b.getTime()) ? null : `${path}: Date ${String(a)} vs ${String(b)}`
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags ? null : `${path}: RegExp ${a} vs ${b}`
  if (typeof a === 'function' && typeof b === 'function') return null
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return `${path}: ${show(a)} vs ${show(b)}`
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs non-array`
  const s = seen.get(a) ?? new Set()
  seen.set(a, s)
  if (s.has(b)) return null
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
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const ka = Object.keys(ra)
  const kb = Object.keys(rb)
  const sb = new Set(kb)
  for (const k of ka) if (!sb.has(k)) return `${path}.${k}: extra key in Aster (${show(ra[k])})`
  const sa = new Set(ka)
  for (const k of kb) if (!sa.has(k)) return `${path}.${k}: missing key in Aster (Vega has ${show(rb[k])})`
  for (const k of ka) {
    const d = diff(ra[k], rb[k], `${path}.${k}`, seen)
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
  expr: (e: string) => compileExpr(e, runtime as never),
}

function deepFreeze<T>(v: T, seen = new Set<unknown>()): T {
  if (v === null || typeof v !== 'object' || seen.has(v) || v instanceof Date) return v
  seen.add(v)
  Object.freeze(v)
  for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k], seen)
  return v
}

function runAster(c: Case, freeze: boolean): { rows: Row[]; signals: Record<string, unknown> } {
  const prep = <T,>(v: T): T => (freeze ? deepFreeze(structuredClone(v)) : structuredClone(v))
  const extra: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(c.opt.extra ?? {})) extra[k] = prep(v) as Row[]
  const signals: Record<string, unknown> = Object.create(null)
  const ctx = { runtime, signals, datasets: (n: string) => extra[n], hierarchies: new Map<string, unknown>() }
  const rows = applyTransforms(prep(c.rows) as Row[], structuredClone(c.t) as never, ctx as never, 'src')
  return { rows, signals }
}

let excluded = 0
const bySuite = new Map<string, Case[]>()
for (const c of CASES) bySuite.set(c.suite, [...(bySuite.get(c.suite) ?? []), c])

describe('transform differential vs real Vega (live, same engine)', { timeout: 60_000 }, () => {
  for (const [suite, cases] of bySuite) {
    describe(suite, () => {
      for (const c of cases) {
        it(c.opt.tz ? `[${c.opt.tz}] ${c.name}` : c.name, async () => {
          const prevTz = process.env.TZ
          process.env.TZ = c.opt.tz ?? 'UTC'
          try {
            const oracle = await runVega(c)
            if (crashed(c, oracle)) { excluded++; return }
            if ('throw' in oracle) {
              // Vega threw: Aster must refuse too, with Vega's message unless it is an incidental TypeError text.
              let msg: string | null = null
              try { runAster(c, false) } catch (e) { msg = e instanceof Error ? e.message : String(e) }
              expect(msg, 'Aster must throw like Vega').not.toBeNull()
              const want = String(oracle.throw.message ?? oracle.throw)
              if (!INCIDENTAL.test(want)) expect(msg).toContain(want)
              return
            }
            const got = runAster(c, false)
            const d = diff(got.rows, oracle.out)
            expect(d, d ?? '').toBeNull()
            // The inputs are never mutated: the same run over deep-frozen inputs gives the same output.
            const frozen = runAster(c, true)
            const df = diff(frozen.rows, oracle.out)
            expect(df, `frozen inputs: ${df ?? ''}`).toBeNull()
            for (const [k, v] of Object.entries(oracle.sig)) {
              const ds = diff(got.signals[k], v, `signal ${k}`)
              expect(ds, ds ?? '').toBeNull()
            }
          } finally {
            if (prevTz === undefined) delete process.env.TZ
            else process.env.TZ = prevTz
          }
        })
      }
    })
  }

  it(`real Vega crashed on exactly ${VEGA_CRASH_EXCLUDED} cases (the bounded exclusion)`, () => {
    // Runs after the cases above (same file, sequential): the exclusion cannot silently grow.
    expect(excluded).toBe(VEGA_CRASH_EXCLUDED)
  })

  it('covers the whole case list', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(3028)
  })
})
