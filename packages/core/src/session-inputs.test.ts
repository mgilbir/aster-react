// @vitest-environment node
/**
 * What a session takes its inputs to be. The oracle for every no-op and change is a fresh evaluation of the same input: a cached
 * scene, a carried setting must give what evaluating that input from nothing gives.
 */
import { describe, expect, it } from 'vitest'
import { createChartSession } from './session.js'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { datasetsOfScene } from './runtime.js'
import { registerExpressionFunction } from './expression.js'
import { AsterLimitError, type SpecLimits } from './limits.js'
import { renderSceneToSvg } from './index.js'
import './addon-transforms.js'
import type { RuntimeInput, SceneRoot, VgSpec } from './types.js'

const svgOf = (s: SceneRoot): string => renderSceneToSvg(s)
const rowsOf = (s: SceneRoot, name: string): unknown => JSON.parse(JSON.stringify(datasetsOfScene(s).get(name) ?? null))
const fresh = (spec: VgSpec, input: RuntimeInput = {}): SceneRoot => evaluateChart(compileChart(structuredClone(spec)), input)

function rng(seed: number): () => number {
  let a = seed | 0
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const textSpec: VgSpec = {
  width: 100, height: 100,
  data: [{ name: 'table' }],
  marks: [{ type: 'text', from: { data: 'table' }, encode: { update: { text: { signal: "isDefined(datum.data) ? '' + datum.data : 'missing'" }, y: { signal: 'datum.data' } } } }],
} as unknown as VgSpec

describe('the session no-op cache answers only for equal inputs (C122, C400)', () => {
  it('rows that are values, not objects, are compared as values (generated)', () => {
    const r = rng(122)
    const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!
    const cells: unknown[] = [0, -0, 1, 2, 'a', 'b', true, null, NaN, { data: 0 }, { data: 1 }, { data: 'a' }]
    for (let k = 0; k < 300; k++) {
      const n = 1 + Math.floor(r() * 4)
      const a = Array.from({ length: n }, () => pick(cells))
      const b = r() < 0.3 ? a.slice() : Array.from({ length: n }, () => pick(cells))
      const session = createChartSession()
      const input = (rows: unknown[]): RuntimeInput => ({ data: { table: rows as never } })
      const first = session.evaluate(textSpec, input(a.filter((x) => x != null)))
      void first
      const got = session.evaluate(textSpec, input(b.filter((x) => x != null)))
      const want = fresh(textSpec, input(b.filter((x) => x != null)))
      expect(svgOf(got), JSON.stringify([a, b])).toBe(svgOf(want))
      expect(rowsOf(got, 'table'), JSON.stringify([a, b])).toEqual(rowsOf(want, 'table'))
    }
  })

  it('a field one row lacks is not the other row\'s undefined field (generated)', () => {
    const spec: VgSpec = {
      width: 100, height: 100, data: [{ name: 'table' }],
      marks: [{ type: 'text', from: { data: 'table' }, encode: { update: { text: { signal: "'' + datum.a + datum.b + datum.c" } } } }],
    } as unknown as VgSpec
    const r = rng(400)
    const names = ['a', 'b', 'c']
    const row = (): Record<string, unknown> => {
      const out: Record<string, unknown> = {}
      for (const k of names) if (r() < 0.5) out[k] = r() < 0.5 ? undefined : Math.floor(r() * 2)
      return out
    }
    for (let k = 0; k < 300; k++) {
      const a = [row(), row()]
      const b = [row(), row()]
      const session = createChartSession()
      session.evaluate(spec, { data: { table: a } })
      const got = session.evaluate(spec, { data: { table: b } })
      expect(svgOf(got), JSON.stringify([Object.keys(a[0]!), Object.keys(b[0]!)])).toBe(svgOf(fresh(spec, { data: { table: b } })))
      expect(Object.keys((datasetsOfScene(got).get('table') as Row[])[0]!).sort()).toEqual(Object.keys(b[0]!).sort())
    }
  })
})

type Row = Record<string, unknown>

describe('the session tells specs apart by what they hold, not by their JSON (C123)', () => {
  const VALUES: unknown[] = [Infinity, -Infinity, NaN, null, 0, -0, 1, '\u0000nInfinity', '\u0000u', [undefined], [null], [Infinity], ['Infinity']]
  const specWith = (v: unknown): VgSpec => ({
    width: 100, height: 100,
    signals: [{ name: 's', value: v }],
    marks: [{ type: 'text', encode: { update: { text: { signal: "isArray(s) ? (!isDefined(s[0]) ? 'undefined' : s[0] === null ? 'null' : '' + s[0]) : isValid(s) ? (s === 0 ? (1 / s > 0 ? '+0' : '-0') : '' + s) : (s === null ? 'null' : 'invalid')" } } } }],
  } as unknown as VgSpec)
  it('every pair of values JSON writes alike evaluates as a fresh chart does', () => {
    for (const a of VALUES) {
      for (const b of VALUES) {
        const session = createChartSession()
        session.evaluate(specWith(a))
        const got = session.evaluate(specWith(b))
        expect(svgOf(got), `${String(a)} then ${String(b)}`).toBe(svgOf(fresh(specWith(b))))
      }
    }
  })
})

describe('the session re-evaluates when an expression function is replaced (C282)', () => {
  it('a replaced function is called in its new form', () => {
    const spec = { width: 50, height: 50, marks: [{ type: 'text', encode: { update: { text: { signal: 'auditfn282()' } } } }] } as unknown as VgSpec
    const drop1 = registerExpressionFunction('auditfn282', () => 'ONE')
    try {
      const session = createChartSession()
      expect(svgOf(session.evaluate(spec))).toContain('ONE')
      const drop2 = registerExpressionFunction('auditfn282', () => 'TWO')
      try {
        expect(svgOf(session.evaluate(spec))).toContain('TWO')
      } finally { drop2() }
    } finally { drop1() }
  })
})

describe('session.change() goes on from the last accepted evaluation (C267)', () => {
  const spec = {
    width: 100, height: 100,
    signals: [{ name: 'k', value: 1 }],
    data: [{ name: 'table', values: [{ v: 1 }, { v: 2 }] }],
    marks: [{ type: 'text', from: { data: 'table' }, encode: { update: { text: { signal: "'k=' + k + ' v=' + datum.v" }, x: { signal: 'width' } } } }],
  } as unknown as VgSpec
  it('keeps the size, the signals and the limits it is not given, and drops one given as undefined', () => {
    const session = createChartSession()
    const limits: SpecLimits = { maxItems: 3 }
    session.evaluate(spec, { data: { table: [{ v: 1 }, { v: 2 }] }, width: 400, signals: { k: 7 }, limits })
    const changed = session.change({ data: { table: [{ v: 1 }, { v: 5 }] }, dataChanges: { table: [1] } })!
    const want = fresh(spec, { data: { table: [{ v: 1 }, { v: 5 }] }, width: 400, signals: { k: 7 } })
    expect(svgOf(changed)).toBe(svgOf(want))
    // the limits came along: four rows are four items, past maxItems 3
    expect(() => session.change({ data: { table: [{ v: 1 }, { v: 5 }, { v: 6 }, { v: 7 }] } })).toThrow(AsterLimitError)
    // a key given as undefined removes the setting; one given replaces it
    const unsized = session.change({ width: undefined, signals: { k: 2 } })!
    expect(svgOf(unsized)).toBe(svgOf(fresh(spec, { data: { table: [{ v: 1 }, { v: 5 }] }, signals: { k: 2 } })))
  })
})

describe('the session does not walk a spec it answers from its cache (C503)', () => {
  it('a cache hit reads no row of the inline data; a miss does (the pre-flight walks them)', () => {
    let reads = 0
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }]
    const counted = new Proxy(rows, { get(t, k, r) { if (typeof k === 'string' && /^\d+$/.test(k)) reads++; return Reflect.get(t, k, r) } })
    const spec = { width: 50, height: 50, data: [{ name: 'table', values: counted }], marks: [{ type: 'rect', from: { data: 'table' } }] } as unknown as VgSpec
    const limits = { maxRows: 100 }
    // (a development build also reads the rows to warn about ones changed in place, see row-watch.ts: this is the production cost)
    const env = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const session = createChartSession()
      session.evaluate(spec, { limits })
      expect(reads).toBeGreaterThan(0)
      reads = 0
      session.evaluate(spec, { limits })
      expect(reads, 'rows read on a cache hit').toBe(0)
    } finally { process.env.NODE_ENV = env }
  })
})

