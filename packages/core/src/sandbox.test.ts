import { describe, it, expect, afterEach, vi } from 'vitest'
import { compileExpr } from './expression.js'
import { renderSpec } from './index.js'
import { field, pluck, splitAccessPath } from './util.js'
import { timeOffset, timeSequence, utcOffset, utcSequence } from './time.js'

// Regression suite for the expression sandbox (audit C1) and the
// prototype-keyed lookups (C50). Hostile inputs live here only.

const rt = { scale: () => undefined, data: () => undefined, expr: () => () => undefined }
const run = (src: string, datum: unknown = {}, params: Record<string, unknown> = {}): unknown =>
  compileExpr(src, rt as never)(datum, params)

const SENTINEL = '__aster_sandbox_sentinel__'
const g = globalThis as Record<string, unknown>
afterEach(() => { delete g[SENTINEL]; vi.restoreAllMocks() })

/** Every spelling of "reach the Function constructor" we can think of. */
const ESCAPE_PATHS = [
  'constructor.constructor',
  'constructor.constructor.constructor',
  '__proto__.constructor.constructor',
  'a.constructor.constructor',
  "['constructor']['constructor']",
  'toString.constructor',
  'hasOwnProperty.constructor',
  'valueOf.constructor',
  '__defineGetter__.constructor',
]

describe('C1: Function constructor is unreachable from expressions', () => {
  const body = `globalThis.${SENTINEL}=1`

  it('two-argument toDate never calls its second argument', () => {
    for (const p of ESCAPE_PATHS) {
      const e = `toDate(0, toDate('${body}', pluck(datum, '${p}')))`
      let out: unknown
      try { out = run(e, { a: {} }) } catch { out = 'threw' }
      expect(g[SENTINEL], e).toBeUndefined()
      expect(typeof out).not.toBe('function')
    }
  })

  it('toDate is unary like vega-functions (extra arguments suppressed)', () => {
    expect(run("toDate('2020-01-01', 5)")).toBe(Date.parse('2020-01-01'))
    // a callable in any argument position is refused outright (stricter than vega)
    expect(() => run("toDate('2020-01-01', datum.x)", { x: () => 1 })).toThrow(/Function argument refused/)
  })

  it('pluck never yields a function through inherited/prototype keys', () => {
    // a walk that dead-ends throws (as in vega); it must never produce a function
    const val = (f: () => unknown): unknown => { try { return f() } catch { return 'threw' } }
    for (const p of ESCAPE_PATHS) {
      expect(typeof val(() => pluck({ a: {} }, p)), p).not.toBe('function')
      expect(typeof val(() => pluck([{ a: {} }], p)), p).not.toBe('function')
      expect(typeof val(() => field(p)({ a: {} })), p).not.toBe('function')
    }
    expect(pluck({ a: {} }, 'constructor')).toBeUndefined()
    expect(pluck({ a: {} }, 'a.constructor')).toBeUndefined()
  })

  it('computed member access cannot reach Function either', () => {
    // vega-interpreter yields the inert `Object` here (oracle-pinned); one more hop must not give Function
    for (const e of ["datum['constructor']['constructor']", 'datum[k][k]', 'datum.__proto__.constructor.constructor', 'datum.a.constructor.constructor']) {
      expect(run(e, { a: {} }, { k: 'constructor' }), e).toBeUndefined()
    }
    expect(run('datum[k][k]', {}, { k: ['constructor'] })).toBeUndefined()
  })

  it('own data keys with risky names still read as data', () => {
    const d = JSON.parse('{"constructor":3,"toString":"t","__proto__":{"x":1}}')
    expect(run('datum.constructor', d)).toBe(3)
    expect(pluck(d, 'toString')).toBe('t')
  })

  it('no function value is ever accepted as an argument to an expression function', () => {
    // a function-valued argument reaches the call from a host-provided datum
    const fn = (): string => { g[SENTINEL] = 1; return 'x' }
    const d = { f: fn }
    for (const e of [
      'replace("abc", "b", datum.f)', 'replace("abc", datum.f, "x")', 'toDate("1", datum.f)',
      'timeFormat(0, datum.f)', 'join([1,2], datum.f)', 'merge(datum, datum)', 'sort(datum.f)',
      'indata("t", "f", datum.f)', 'pad("a", 5, datum.f)', 'regexp(datum.f)', 'split("a", datum.f)',
    ]) {
      try { run(e, d) } catch { /* rejecting is fine */ }
      expect(g[SENTINEL], e).toBeUndefined()
    }
  })

  it('unknown/inherited function names are rejected, not dispatched', () => {
    for (const n of ['constructor', 'valueOf', 'hasOwnProperty', '__defineGetter__', 'isPrototypeOf']) {
      expect(() => run(`${n}(1)`), n).toThrow()
    }
  })

  it('end to end: untrusted formula cannot run host code', () => {
    const spec = {
      width: 50, height: 50,
      data: [{
        name: 't', values: [{ a: 1 }],
        transform: [{
          type: 'formula', as: 'r',
          expr: `toDate(0, toDate('${body}', pluck(datum, 'constructor.constructor')))`,
        }],
      }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { value: 1 }, y: { value: 1 } } } }],
    }
    try { renderSpec(spec as never) } catch { /* may throw */ }
    expect(g[SENTINEL]).toBeUndefined()
  })

  it('merge does not let a __proto__ key swap the result prototype', () => {
    const evil = JSON.parse('{"__proto__":{"polluted":true},"ok":1}')
    const out = run('merge(datum)', evil) as Record<string, unknown>
    expect(out.ok).toBe(1)
    expect(out.polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('time-unit tables are own-property lookups', () => {
    const d = new Date(0)
    for (const u of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(timeOffset(u, d, 1), u).toBeUndefined()
      expect(utcOffset(u, d, 1), u).toBeUndefined()
      expect(timeSequence(u, d, d), u).toBeUndefined()
      expect(utcSequence(u, d, d), u).toBeUndefined()
    }
  })

  it('splitAccessPath is unchanged for legitimate paths', () => {
    expect(splitAccessPath("a.b['c.d'][0]")).toEqual(['a', 'b', 'c.d', '0'])
  })
})

// --- C50: spec-keyed lookups must not see Object.prototype --------------------

const HOSTILE_NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', '__defineGetter__', 'isPrototypeOf']

function marksOf(svg: string): number {
  return (svg.match(/<path /g) ?? []).length
}

const symbolsSpec = (dataset: string, values?: unknown[], extra: Record<string, unknown> = {}): never => JSON.parse(JSON.stringify({
  width: 100, height: 100, padding: 5, autosize: 'none',
  data: [{ name: dataset, ...(values ? { values } : {}) }],
  marks: [{ type: 'symbol', from: { data: dataset }, encode: { update: { x: { field: 'x' }, y: { value: 10 }, size: { value: 40 } } } }],
  ...extra,
})) as never

describe('C50: prototype-named datasets, signals and tables', () => {
  const rows = [{ x: 10 }, { x: 20 }, { x: 30 }]
  const with3 = marksOf(renderSpec(symbolsSpec('benign', rows)))
  const with0 = marksOf(renderSpec(symbolsSpec('benign')))
  it('reference renders differ (test sanity)', () => { expect(with3).toBe(with0 + 3) })

  it.each(HOSTILE_NAMES)('dataset named %s renders its rows (inline values)', (name) => {
    expect(marksOf(renderSpec(symbolsSpec(name, rows)))).toBe(with3)
  })

  it.each(HOSTILE_NAMES)('dataset named %s renders its rows (host input data)', (name) => {
    const input = JSON.parse(`{"data":{${JSON.stringify(name)}:${JSON.stringify(rows)}}}`)
    expect(marksOf(renderSpec(symbolsSpec(name), input))).toBe(with3)
  })

  it.each(HOSTILE_NAMES)('dataset named %s absent from input renders nothing, not an inherited value', (name) => {
    expect(marksOf(renderSpec(symbolsSpec(name)))).toBe(with0)
  })

  it.each(HOSTILE_NAMES)('signal named %s resolves to its own value', (name) => {
    const spec = JSON.parse(`{"width":100,"height":100,"padding":0,"autosize":"none",
      "signals":[{"name":${JSON.stringify(name)},"value":3}],
      "marks":[{"type":"rect","encode":{"update":{"x":{"signal":${JSON.stringify(name)}},"y":{"value":1},"width":{"value":5},"height":{"value":5}}}}]}`)
    const svg = renderSpec(spec)
    expect(svg).not.toMatch(/native code|function|\[object/)
    expect(svg).toContain('d="M3,1h5v5h-5Z"')
  })

  it('a prototype-named signal passed by the host does not alter the signal store', () => {
    const signals = JSON.parse('{"__proto__":{"polluted":true},"w":5}')
    const spec = JSON.parse('{"width":100,"height":100,"autosize":"none","signals":[{"name":"w","value":1}],"marks":[]}')
    renderSpec(spec, { signals })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('named scheme/range/curve/projection/linkpath lookups ignore inherited names', () => {
    for (const n of HOSTILE_NAMES) {
      const spec = JSON.parse(`{"width":100,"height":100,"autosize":"none",
        "data":[{"name":"t","values":[{"x":1,"y":1},{"x":2,"y":2}]}],
        "scales":[{"name":"c","type":"ordinal","domain":[1,2],"range":${JSON.stringify(n)}}],
        "marks":[{"type":"line","from":{"data":"t"},"encode":{"update":{"x":{"field":"x"},"y":{"field":"y"},"interpolate":{"value":${JSON.stringify(n)}},"stroke":{"scale":"c","value":1}}}}]}`)
      try { renderSpec(spec) } catch (e) {
        // an unknown named range is refused cleanly; it must not be a TypeError from calling a prototype member
        expect(String((e as Error).message), n).not.toMatch(/is not a function|native code/)
      }
    }
  })
})
