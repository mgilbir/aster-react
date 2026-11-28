import { describe, it, expect, afterEach, vi } from 'vitest'
import { compileExpr } from './expression.js'
import { applyTransforms, compileChart, evaluateChart, renderSpec } from './index.js'
import { eventsOf } from './geo-events.js'
import { field, pluck, splitAccessPath } from './util.js'
import { timeOffset, timeSequence, utcOffset, utcSequence } from './time.js'
import './addon-geo.js'
import './addon-transforms.js'

// Regression suite for the expression sandbox and the
// prototype-keyed lookups. Hostile inputs live here only.

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

describe('Function constructor is unreachable from expressions', () => {
  const body = `globalThis.${SENTINEL}=1`

  it('two-argument toDate never calls its second argument, whatever route hands it a function', () => {
    // (C343) a route through `pluck` never reaches toDate: pluck throws on every escape path before the call (pinned in the next
    // test). These routes DO evaluate to a host function (asserted first, so the case is not vacuous), and toDate must refuse it.
    let called = 0
    const f = (): string => { called++; g[SENTINEL] = 1; return 'x' }
    const d = { f, o: { f } }
    for (const route of ['datum.f', 'datum.o.f', 'if(true, datum.f, 0)', 'peek([datum.f])', "pluck(datum, 'f')"]) {
      expect(typeof run(route, d), route).toBe('function')
      expect(() => run(`toDate(0, ${route})`, d), route).toThrow(/Function argument refused: toDate/)
      expect(() => run(`toDate('${body}', ${route})`, d), route).toThrow(/Function argument refused: toDate/)
    }
    expect(called).toBe(0)
    expect(g[SENTINEL]).toBeUndefined()
    // every escape path dies inside pluck, before toDate runs
    for (const p of ESCAPE_PATHS) {
      expect(() => run(`toDate(0, toDate('${body}', pluck(datum, '${p}')))`, { a: {} }), p).toThrow()
      expect(g[SENTINEL], p).toBeUndefined()
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
    // The first hop is no longer the inert `Object` vega-interpreter answers: an inherited `constructor` / `__proto__` reads as
    // undefined (expression-sandbox.test, C384), so the second hop is a read past undefined and throws the TypeError any such read
    // throws, in vega too. Whatever the spelling, no hop yields a function and nothing runs.
    for (const k of ['constructor', ['constructor']]) {
      for (const first of ["datum['constructor']", 'datum[k]', 'datum.__proto__', 'datum.a.constructor', 'datum.a[k]']) {
        expect(run(first, { a: {} }, { k }), first).toBeUndefined()
      }
      for (const e of ["datum['constructor']['constructor']", 'datum[k][k]', 'datum.__proto__.constructor.constructor', 'datum.a.constructor.constructor']) {
        let out: unknown
        let err: unknown
        try { out = run(e, { a: {} }, { k }) } catch (x) { err = x }
        expect(out, e).toBeUndefined()
        expect(err, e).toBeInstanceOf(TypeError)
        expect((err as Error).message, e).toMatch(/^Cannot read properties of undefined/)
      }
    }
  })

  it('own data keys with risky names still read as data', () => {
    const d = JSON.parse('{"constructor":3,"toString":"t","__proto__":{"x":1}}')
    expect(run('datum.constructor', d)).toBe(3)
    expect(pluck(d, 'toString')).toBe('t')
    // an own `__proto__` key is data too, read as the object it holds (not the row's prototype)
    expect(run('datum.__proto__', d)).toEqual({ x: 1 })
    expect(run('datum["__proto__"].x', d)).toBe(1)
    expect(pluck(d, '__proto__')).toEqual({ x: 1 })
  })

  it('no function value is ever accepted as an argument to an expression function', () => {
    // a function-valued argument reaches the call from a host-provided datum
    const fn = (): string => { g[SENTINEL] = 1; return 'x' }
    const d = { f: fn }
    for (const e of [
      'replace("abc", "b", datum.f)', 'replace("abc", datum.f, "x")', 'toDate("1", datum.f)',
      'timeFormat(0, datum.f)', 'join([1,2], datum.f)', 'merge({a: 1}, datum.f)', 'sort(datum.f)',
      'indata("t", "f", datum.f)', 'pad("a", 5, datum.f)', 'regexp(datum.f)', 'split("a", datum.f)',
    ]) {
      try { run(e, d) } catch { /* rejecting is fine */ }
      expect(g[SENTINEL], e).toBeUndefined()
    }
  })

  it('a function nested inside an argument (an array, a conditional, a string concatenation) is never called (C108)', () => {
    // A host-provided datum may hold a function; expressions may pass it around inside values as vega's codegen does (vega too
    // hands `peek([datum.f])` back), but no expression function and no operator ever calls it.
    let called = 0
    const f = (): string => { called++; g[SENTINEL] = 1; return 'x' }
    const d = { f, o: { f } }
    const nested = [
      'peek([datum.f])', 'if(true, datum.f, 0)', "datum.f + ''", 'lerp([datum.f, 1], 0.5)', 'join([datum.f])', 'join([datum.f], datum.f)',
      'sort([datum.f, datum.f])', 'span([datum.f])', 'extent([datum.f])', 'merge(datum.o)', 'indexof([datum.f], datum.f)',
      'replace("abc", "b", if(true, datum.f, 0))', 'toDate(0, peek([datum.f]))', 'format(peek([datum.f]), "d")', 'length([datum.f])',
    ]
    for (const e of nested) {
      try { run(e, d) } catch { /* rejecting is fine */ }
    }
    expect(called).toBe(0)
    expect(g[SENTINEL]).toBeUndefined()
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

// --- spec-keyed lookups must not see Object.prototype --------------------

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

describe('prototype-named datasets, signals and tables', () => {
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
    // (C344) the store an evaluation reads its signals from (`signalParams`) must hold the host's `__proto__` as an own signal whose
    // value is the object given, keep its own (null) prototype, and take the host's other signals.
    const signals = JSON.parse('{"__proto__":{"polluted":true},"w":5}')
    const spec = JSON.parse(`{"width":100,"height":100,"padding":0,"autosize":"none","signals":[{"name":"w","value":1}],
      "marks":[{"type":"rect","encode":{"update":{"x":{"signal":"w"},"y":{"value":1},"width":{"value":5},"height":{"value":5}}}}]}`)
    const scene = evaluateChart(compileChart(spec), { signals })
    const store = (scene as unknown as { signalParams: Record<string, unknown> }).signalParams
    expect(Object.getPrototypeOf(store)).toBe(null)
    expect(Object.getOwnPropertyDescriptor(store, '__proto__')?.value).toEqual({ polluted: true })
    expect(store.polluted).toBeUndefined()
    expect(store.w).toBe(5)
    expect(renderSpec(spec, { signals })).toContain('d="M5,1h5v5h-5Z"')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  // (C342) one spec per named lookup; each hostile name must give exactly the outcome of an unknown benign name (the same output,
  // the same error, the same log lines, the name aside), so no inherited member is ever dispatched.
  const LOOKUPS: Record<string, (n: string) => unknown> = {
    scheme: (n) => ({ scales: [{ name: 'c', type: 'ordinal', domain: [1, 2], range: { scheme: n } }], marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { value: 1 }, fill: { scale: 'c', field: 'x' } } } }] }),
    range: (n) => ({ scales: [{ name: 'c', type: 'ordinal', domain: [1, 2], range: n }], marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { value: 1 }, fill: { scale: 'c', field: 'x' } } } }] }),
    curve: (n) => ({ marks: [{ type: 'line', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, interpolate: { value: n } } } }] }),
    projection: (n) => ({ projections: [{ name: 'p', type: n }], marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { signal: "scale('p', [datum.x, datum.y])[0]" }, y: { value: 1 } } } }] }),
    linkpath: (n) => ({ marks: [{ type: 'path', from: { data: 't' }, transform: [{ type: 'linkpath', sourceX: 'datum.x', sourceY: 'datum.y', targetX: 'datum.y', targetY: 'datum.x', shape: n }] }] }),
    'scale type': (n) => ({ scales: [{ name: 'c', type: n, domain: [1, 2], range: [0, 10] }], marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'c', field: 'x' }, y: { value: 1 } } } }] }),
    'transform type': (n) => ({ data: [{ name: 't', values: [{ x: 1, y: 1 }, { x: 2, y: 2 }], transform: [{ type: n }] }], marks: [] }),
    'mark type': (n) => ({ marks: [{ type: n, from: { data: 't' }, encode: { update: { x: { field: 'x' } } } }] }),
  }
  const lookupOutcome = (lookup: string, name: string): string => {
    const logs: string[] = []
    const logger = { error: (...a: unknown[]) => logs.push('error ' + a.map(String).join(' ')), warn: (...a: unknown[]) => logs.push('warn ' + a.map(String).join(' ')), info() {}, debug() {} }
    const spec = JSON.parse(JSON.stringify({ width: 100, height: 100, padding: 0, autosize: 'none', data: [{ name: 't', values: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }], ...(LOOKUPS[lookup]!(name) as object) }))
    let out: string
    try { out = renderSpec(spec, { logger } as never) } catch (e) { out = 'ERR ' + String((e as Error).message) }
    return [out, ...logs].join('\n').replaceAll(name, 'NAME')
  }
  /** A name each lookup knows: the unknown name's outcome must differ from it, so the lookup is reached and decides the outcome. */
  const KNOWN: Record<string, string> = { scheme: 'blues', range: 'category', curve: 'step', projection: 'mercator', linkpath: 'orthogonal', 'scale type': 'sqrt', 'transform type': 'collect', 'mark type': 'symbol' }
  it.each(Object.keys(LOOKUPS))('the %s lookup is reached: a known name and an unknown one differ', (lookup) => {
    expect(lookupOutcome(lookup, 'zz_unknown')).not.toBe(lookupOutcome(lookup, KNOWN[lookup]!))
  })
  for (const lookup of Object.keys(LOOKUPS)) {
    it.each(HOSTILE_NAMES)(`named ${lookup} lookup: %s is an unknown name like any other`, (name) => {
      const benign = lookupOutcome(lookup, 'zz_unknown')
      const hostile = lookupOutcome(lookup, name)
      expect(hostile).not.toMatch(/native code|\[object |is not a constructor/)
      expect(hostile).toBe(benign)
    })
  }

  it.each(HOSTILE_NAMES)('absent signal named %s is refused by the compile-time validator exactly like any other absent signal', (name) => {
    // (C656) every route below (width, a scale domain, bins, padding) is checked when the spec is compiled, so the runtime lookups are
    // never reached here: what this pins is the validator's own-name check. The runtime store lookups are pinned by the
    // 'prototype-named signal passed by the host' test above and by 'signal named %s resolves to its own value'.
    const outcome = (sig: string): string => {
      const spec = JSON.parse(`{"width":{"signal":${JSON.stringify(sig)}},"height":80,"autosize":"none",
        "data":[{"name":"t","values":[{"v":1},{"v":2}]}],
        "scales":[{"name":"x","type":"linear","domain":{"signal":${JSON.stringify(sig)}},"range":[0,50],"bins":{"signal":${JSON.stringify(sig)}}},
                  {"name":"y","type":"linear","domain":{"data":"t","field":"v"},"range":"height","padding":{"signal":${JSON.stringify(sig)}}}],
        "marks":[{"type":"symbol","from":{"data":"t"},"encode":{"update":{"x":{"scale":"x","field":"v"},"y":{"scale":"y","field":"v"}}}}]}`)
      try { return renderSpec(spec).replaceAll(sig, 'SIG') } catch (e) { return 'ERR ' + String((e as Error).message).replaceAll(sig, 'SIG') }
    }
    expect(outcome(name)).toBe(outcome('zz_absent'))
    expect(outcome(name)).toMatch(/^ERR Unrecognized signal name: "SIG"/)
  })

  it.each(HOSTILE_NAMES)('aggregate op named %s is an unsupported op, not an inherited function', (name) => {
    const rows = [{ g: 'a', v: 1 }, { g: 'a', v: 2 }]
    const ctx = { runtime: { scale: () => undefined, data: () => undefined, expr: () => () => undefined }, signals: Object.create(null) }
    for (const t of [
      { type: 'aggregate', groupby: ['g'], fields: ['v'], ops: [name], as: ['o'] },
      { type: 'pivot', field: 'g', value: 'v', op: name },
    ]) {
      expect(() => applyTransforms(rows as never, [t] as never, ctx as never), `${t.type}:${name}`).toThrow(/unsupported aggregate op/)
    }
  })

  it.each(HOSTILE_NAMES)('GeoJSON type %s from data is not dispatched through the handler tables', (name) => {
    // neither as an object type nor as a geometry type: no handler runs, so no event is produced
    expect(() => eventsOf({ type: name })).not.toThrow()
    expect(eventsOf({ type: name }).length).toBe(0)
    expect(eventsOf({ type: 'Feature', geometry: { type: name } }).length).toBe(0)
  })
})
