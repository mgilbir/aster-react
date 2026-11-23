/**
 * GENERATED live differential of how a scale spec's OPTIONS are applied (C18, C333, C288): every key of a scale spec that the
 * builder does not read itself is an option, applied to the scale by name. Real Vega (vega-parser + vega-encode) and Aster
 * build the same spec in one process; the two scales are projected identically and compared, and so are the warnings and
 * errors each logs (vega warns `Unsupported scale property: <key>` for a key the scale has no method for).
 *
 * What is drawn: every scale type, written as registered and in other cases (`BAND`, `Linear`); keys that are a method of the
 * scale of that type, of another type, misspellings, and names every object or function inherits (`constructor`,
 * `toString`, `apply`, `caller`, `__defineGetter__`, ...), with values of every kind. A spec's text must never reach the
 * `Function` constructor: one test runs the inherited names with code generation from strings refused.
 */
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import * as vega from 'vega'
import { getChartInfo } from '../../core/src/runtime.ts'
import { renderSpec } from '../../core/src/index.ts'
import { attempt } from './differential-util.mts'
import { makeRng, scaled, type Rng } from './differential-gen.mts'

vi.setConfig({ testTimeout: 120_000 })

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyScale = ((x: unknown) => unknown) & Record<string, any>

const TYPES = ['linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc', 'sequential', 'ordinal', 'band', 'point', 'quantile', 'quantize', 'threshold', 'bin-ordinal', 'identity']

/** Names every object or every function has: none is a scale option. */
const INHERITED = [
  'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'apply', 'call', 'bind', 'caller', 'arguments',
]
/** Methods of some scale types (an option of one is unsupported on another), and plain slips. */
const METHODS = [
  'padding', 'paddingInner', 'paddingOuter', 'align', 'clamp', 'exponent', 'base', 'constant', 'unknown', 'interpolator', 'ticks',
  'tickFormat', 'copy', 'invert', 'invertExtent', 'invertRange', 'bandwidth', 'step', 'quantiles', 'thresholds', 'rangeRound',
  'domainImplicit', 'nice',
]
const SLIPS = ['paddingInnner', 'zeros', 'clmap', 'Padding', 'length', 'prototype', 'bogus', 'x', '']

const VALUES: unknown[] = [0, 0.3, 1, 2, -1, true, false, 'a', 'return 1', 'this is not ( javascript', null, [1, 2], 'center']

function domainFor(type: string, r: Rng): unknown {
  if (['ordinal', 'band', 'point'].includes(type)) return r.pick([['a', 'b', 'c'], ['x']])
  if (type === 'threshold') return [1, 5]
  if (type === 'log' || type === 'sequential') return [1, 100]
  return r.pick([[0, 10], [2, 50]])
}

function rangeFor(type: string): unknown {
  if (['ordinal', 'quantile', 'quantize', 'threshold', 'bin-ordinal'].includes(type)) return ['red', 'green', 'blue']
  if (type === 'sequential') return { scheme: 'blues' }
  return 'width'
}

function casing(type: string, r: Rng): string {
  switch (r.int(10)) {
    case 0: return type.toUpperCase()
    case 1: return type.charAt(0).toUpperCase() + type.slice(1)
    default: return type
  }
}

function genSpec(r: Rng): { spec: Record<string, unknown>; probes: unknown[] } {
  const type = r.pick(TYPES)
  const s: Record<string, unknown> = { name: 's', type: casing(type, r), domain: domainFor(type, r), range: rangeFor(type) }
  const n = r.between(1, 3)
  for (let i = 0; i < n; i++) {
    const pool = r.pick([INHERITED, METHODS, METHODS, SLIPS])
    s[r.pick(pool)] = r.pick(VALUES)
  }
  // the domain settings the builder reads itself, which vega also warns about (a log domain through zero, a middle outside the
  // ends) or refuses (padding an empty domain)
  if (r.chance(0.4)) {
    if (r.chance(0.3)) s.domain = r.pick<unknown>([[], [-1, 10], [0, 5], [3], [-4, -1]])
    for (const key of ['domainMin', 'domainMax', 'domainMid', 'zero', 'padding', 'domainRaw']) {
      if (!r.chance(0.25)) continue
      s[key] = key === 'zero' ? r.chance(0.5) : key === 'padding' ? r.pick([0, 1, 5]) : key === 'domainRaw' ? r.pick<unknown>([[0, 4], [-2, 3], null]) : r.pick([-3, 0, 2, 3.7, 60])
    }
    // an empty domain whose last end is set: padded, it has ends to zoom about in Aster's old reading, none in vega's
    if (r.chance(0.15)) Object.assign(s, { domain: [], [r.pick(['domainMax', 'domainMin'])]: r.pick([3.7, -2]), padding: r.pick([1, 4]) })
  }
  return { spec: { width: 200, height: 100, scales: [s] }, probes: [-1, 0, 0.5, 1, 3, 7, 50, 'a', 'b', 'x', 'q'] }
}

function project(s: AnyScale, probes: unknown[]): Record<string, unknown> {
  const o: Record<string, unknown> = { type: s.type }
  o.domain = attempt(() => s.domain())
  o.range = attempt(() => s.range())
  o.samples = probes.map((p) => attempt(() => s(p)))
  for (const name of ['bandwidth', 'step', 'clamp', 'padding', 'paddingInner', 'paddingOuter', 'align', 'base', 'exponent', 'constant', 'unknown', 'thresholds']) {
    if (typeof s[name] === 'function') o[name] = attempt(() => s[name]())
  }
  return o
}

interface Outcome { scale: unknown; warnings: string[]; errors: string[] }

function collect(): { logger: Record<string, (...a: unknown[]) => unknown>; warnings: string[]; errors: string[] } {
  const warnings: string[] = []
  const errors: string[] = []
  const logger: Record<string, (...a: unknown[]) => unknown> = {
    level: () => logger,
    error: (...a) => { errors.push(a.map((e) => String((e as Error)?.message ?? e)).join(' ')); return logger },
    warn: (...a) => { warnings.push(a.map(String).join(' ')); return logger },
    info: () => logger,
    debug: () => logger,
  }
  return { logger, warnings, errors }
}

async function vegaOutcome(spec: unknown, probes: unknown[]): Promise<Outcome> {
  const { logger, warnings, errors } = collect()
  try {
    const view = new vega.View(vega.parse(structuredClone(spec) as vega.Spec), { renderer: 'none', logger: logger as never })
    view.logger(logger as never)
    await view.runAsync()
    // (a scale whose options threw is the operator's half-made value in vega: what it holds is not a chart)
    return { scale: errors.length ? null : project(view.scale('s') as AnyScale, probes), warnings, errors }
  } catch (e) {
    return { scale: null, warnings, errors: [...errors, String((e as Error).message)] }
  }
}

function asterOutcome(spec: unknown, probes: unknown[]): Outcome {
  const { logger, warnings, errors } = collect()
  try {
    const s = getChartInfo(structuredClone(spec) as never, { logger: logger as never }).scales.get('s') as AnyScale | undefined
    return { scale: s && !errors.length ? project(s, probes) : null, warnings, errors }
  } catch (e) {
    return { scale: null, warnings, errors: [...errors, String((e as Error).message)] }
  }
}

/** Run `count` generated specs through both engines; the first mismatches, and how often each outcome and message came up. */
async function sweep(count: number, gen: () => { spec: Record<string, unknown>; probes: unknown[] }) {
  const bad: string[] = []
  let warned = 0
  const byKind = new Map<string, number>()
  let refused = 0
  let built = 0
  for (let i = 0; i < count; i++) {
    const { spec, probes } = gen()
    const want = await vegaOutcome(spec, probes)
    const got = asterOutcome(spec, probes)
    if (want.warnings.length) warned++
    for (const m of [...want.warnings, ...want.errors]) {
      const kind = m.replace(/:.*$/, '').replace(/ -?\d+(\.\d+)?$/, '')
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1)
    }
    if (want.scale) built++
    else refused++
    // the same scale (or none), the same warnings in the same order, and an error exactly where vega has one
    const same = JSON.stringify(want.scale) === JSON.stringify(got.scale)
      && JSON.stringify(want.warnings) === JSON.stringify(got.warnings)
      && (want.errors.length > 0) === (got.errors.length > 0)
      && (want.errors[0] ?? '') === (got.errors[0] ?? '')
    if (!same && bad.length < 5) bad.push(`#${i} ${JSON.stringify((spec as { scales: unknown[] }).scales)} signals=${JSON.stringify(spec.signals)}\n   vega  ${JSON.stringify(want).slice(0, 400)}\n   aster ${JSON.stringify(got).slice(0, 400)}`)
  }
  return { bad: bad.join('\n'), warned, byKind, refused, built }
}

/** Scale properties a `{signal}` may give, each with the kind of scale that reads it. */
const SIGNAL_PROPS: Array<[string, string]> = [
  ['nice', 'linear'], ['zero', 'linear'], ['reverse', 'linear'], ['clamp', 'linear'], ['round', 'linear'], ['padding', 'linear'],
  ['domainMin', 'linear'], ['domainMax', 'linear'], ['domainMid', 'linear'], ['domainRaw', 'linear'], ['unknown', 'linear'],
  ['base', 'log'], ['exponent', 'pow'], ['constant', 'symlog'], ['paddingInner', 'band'], ['paddingOuter', 'band'], ['align', 'band'],
  ['round', 'band'], ['reverse', 'band'], ['domainImplicit', 'ordinal'],
]
// (`interpolate: {signal}` is not drawn: vega's parser crashes on it and Aster resolves it, a deviation docs/ARCHITECTURE.md lists)
/**
 * What a `{signal}` may say: the language's literals and constants, signals of the spec and of the view, names that are neither, and
 * expressions. Not drawn, each a difference of its own outside how a scale reads the reference: `autosize` and `background` (view
 * signals the runtime's signal map lacks, C133's neighbour in the audit) and `datum` / `event` / `item` (what the expression
 * evaluator gives for them in a signal's context, where vega's generated code raises `datum is not defined`).
 */
const SIGNAL_TEXTS = [
  'true', 'false', 'null', 'NaN', 'PI', 'E', 'MAX_VALUE', 'LN2', 'mySig', 'flag', 'nothing', 'width', 'height', 'nosuch', 'undefined',
  'Infinity', 'x', '!true', 'true && false', 'null || 3', '1 > 0', 'mySig * 2', '[1, 5]', '"center"', '0.25',
  'flag ? 2 : null', '[2, 30]', 'nothing || [0, 4]',
]

describe(`scale options from specs vs vega@${vega.version} (generated, live)`, () => {
  it('applies own methods, warns about the rest as vega does, and refuses a type not written as registered', async () => {
    const r = makeRng(0x0c18)
    const count = scaled(3000)
    const { bad, warned, byKind, refused, built } = await sweep(count, () => genSpec(r))
    expect(bad).toBe('')
    // every outcome must be common, or the sweep says little
    expect(built).toBeGreaterThan(count * 0.4)
    expect(refused).toBeGreaterThan(count * 0.05)
    expect(warned).toBeGreaterThan(count * 0.2)
    expect(byKind.get('Log scale domain includes zero') ?? 0).toBeGreaterThan(count * 0.002)
    expect(byKind.get('Scale domainMid exceeds domain min or max.') ?? 0).toBeGreaterThan(count * 0.002)
    expect(byKind.get('Domain array must not be empty') ?? 0).toBeGreaterThan(count * 0.001)
  })

  it('reads a {signal} in a scale property as vega does: a literal, a constant, a signal or an expression (C133)', async () => {
    const r = makeRng(0x0c133)
    const count = scaled(2000)
    const { bad, refused, built } = await sweep(count, () => {
      const n = r.between(1, 2)
      const s: Record<string, unknown> = { name: 's' }
      let type = 'linear'
      for (let i = 0; i < n; i++) {
        const [prop, kind] = r.pick(SIGNAL_PROPS)
        if (i === 0) type = kind
        else if (kind !== type) continue
        s[prop] = { signal: r.pick(SIGNAL_TEXTS) }
      }
      Object.assign(s, { type, domain: domainFor(type, r), range: rangeFor(type) })
      const signals = [{ name: 'mySig', value: r.pick([7, 0.5, -2]) }, { name: 'flag', value: r.chance(0.5) }, { name: 'nothing', value: null }]
      return { spec: { width: 200, height: 100, signals, scales: [s] }, probes: [-1, 0, 0.5, 1, 3, 7, 50, 'a', 'b', 'x', 'q'] }
    })
    expect(bad).toBe('')
    expect(built).toBeGreaterThan(count * 0.4)
    expect(refused).toBeGreaterThan(count * 0.05)
  })

  it('the resolved {signal} positions docs/ARCHITECTURE.md lists as deviations still differ from vega, and only as listed', async () => {
    const probes = [0, 2, 10, 50]
    const cases: Array<[string, Record<string, unknown>]> = [
      ['interpolate', { interpolate: { signal: '"hcl"' }, range: ['red', 'blue'] }],
      ['interpolate type', { interpolate: { type: { signal: '"hcl"' } }, range: ['red', 'blue'] }],
      ['gamma', { interpolate: { type: 'rgb', gamma: { signal: '2' } }, range: ['red', 'blue'] }],
      ['nice interval', { type: 'utc', nice: { interval: { signal: '"day"' }, step: 2 } }],
      ['nice step', { type: 'utc', nice: { interval: 'day', step: { signal: '2' } } }],
    ]
    for (const [name, extra] of cases) {
      const spec = { width: 200, height: 100, scales: [{ name: 's', type: 'linear', domain: [2, 50], range: 'width', ...extra }] }
      const want = await vegaOutcome(spec, probes)
      const got = asterOutcome(spec, probes)
      expect(want.errors, name).toEqual(["Cannot read properties of undefined (reading 'signalRef')"])
      expect(got.errors, name).toEqual([])
      // resolved to what the literal gives
      const literal = JSON.parse(JSON.stringify(spec).replace(/\{"signal":"\\"(\w+)\\""\}/g, '"$1"').replace(/\{"signal":"(\d+)"\}/g, '$1'))
      expect(got.scale, name).toEqual(asterOutcome(literal, probes).scale)
      expect(JSON.stringify(literal), name).not.toContain('signal')
    }
    // a nested range list: vega leaves the reference unresolved, Aster resolves it; a top-level entry is resolved by both
    const nested = { width: 200, height: 100, scales: [{ name: 's', type: 'ordinal', domain: ['a', 'b'], range: [[0, { signal: 'width' }], [1, 2]] }] }
    const want = await vegaOutcome(nested, ['a'])
    expect(JSON.stringify(want.scale)).toContain('$ref')
    expect(asterOutcome(nested, ['a']).scale).toMatchObject({ samples: [[0, 200]] })
  })

  it('a colour scale whose range it cannot give is no error until something reads it (C408)', async () => {
    const r = makeRng(0x0408)
    let rendered = 0
    let failed = 0
    const bad: string[] = []
    for (let i = 0; i < scaled(300); i++) {
      const type = r.pick(['sequential', 'linear', 'log', 'sqrt', 'symlog', 'quantize'])
      const range = r.pick<unknown[]>([[], [], ['red'], ['red', 'blue'], ['red', 'white', 'blue']])
      const use = r.pick(['none', 'none', 'fill', 'legend'])
      const spec = {
        width: 100, height: 50, data: [{ name: 't', values: [{ v: 1 }, { v: 2 }, { v: 4 }] }],
        scales: [{ name: 'c', type, domain: type === 'log' ? [1, 5] : [0, 5], range }, { name: 'x', type: 'linear', domain: [0, 5], range: 'width' }],
        marks: [{ type: 'rect', from: { data: 't' }, encode: { enter: { x: { scale: 'x', field: 'v' }, width: { value: 4 }, height: { value: 4 }, fill: use === 'fill' ? { scale: 'c', field: 'v' } : { value: 'red' } } } }],
        ...(use === 'legend' ? { legends: [{ fill: 'c' }] } : {}),
      }
      const errors: string[] = []
      let want: string
      try {
        const { logger } = collect()
        const view = new vega.View(vega.parse(structuredClone(spec) as vega.Spec), { renderer: 'none', logger: { ...logger, error: (e: unknown) => { errors.push(String((e as Error)?.message ?? e)); return logger } } as never })
        await view.runAsync()
        const svg = await view.toSVG()
        want = errors.length ? `logged ${errors[0]}` : `paths ${(svg.match(/<path/g) ?? []).length}`
      } catch (e) {
        want = `threw ${(e as Error).message}`
      }
      const aerrors: string[] = []
      let got: string
      try {
        const svg = renderSpec(structuredClone(spec) as never, { logger: { error: (e: unknown) => aerrors.push(String((e as Error)?.message ?? e)), warn() {}, info() {}, debug() {} } })
        got = aerrors.length ? `logged ${aerrors[0]}` : `paths ${(svg.match(/<path/g) ?? []).length}`
      } catch (e) {
        got = `threw ${(e as Error).message}`
      }
      if (want.startsWith('paths')) rendered++
      else failed++
      // a failure on both sides is the same kind of failure (the engines word the TypeError of the missing interpolator differently)
      const same = want.startsWith('paths') ? want === got : !got.startsWith('paths')
      if (!same && bad.length < 5) bad.push(`#${i} ${type} ${JSON.stringify(range)} ${use}: vega ${want} | aster ${got}`)
    }
    expect(bad.join('\n')).toBe('')
    expect(rendered).toBeGreaterThan(scaled(300) * 0.4)
    expect(failed).toBeGreaterThan(scaled(300) * 0.02)
  })

  it('never compiles spec text, under a code-generation ban (what a CSP without unsafe-eval does)', () => {
    const script = `
      const { getChartInfo, renderSpec } = await import(${JSON.stringify(new URL('../../core/dist/index.js', import.meta.url).href)})
      const out = []
      for (const key of ${JSON.stringify(INHERITED)}) {
        for (const value of ['return 1', 'this is not ( javascript']) {
          const errors = []
          const spec = { width: 50, height: 50, scales: [{ name: 's', type: 'linear', domain: [0, 1], range: 'width', [key]: value }],
            marks: [{ type: 'rect', encode: { enter: { x: { scale: 's', value: 0.5 }, width: { value: 5 }, height: { value: 5 } } } }] }
          const logger = { error: (e) => errors.push(String(e && e.message || e)), warn() {}, info() {}, debug() {} }
          getChartInfo(spec, { logger })
          renderSpec(spec, { logger })
          out.push({ key, value, errors })
        }
      }
      console.log(JSON.stringify(out))`
    const run = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 })
    expect(run.status, run.stderr).toBe(0)
    const out = JSON.parse(run.stdout) as Array<{ key: string; value: string; errors: string[] }>
    expect(out.length).toBe(INHERITED.length * 2)
    // nothing was compiled: no EvalError, no SyntaxError from parsing the text; `caller` / `arguments` are the strict-mode read
    // vega's own read of them raises
    for (const o of out) {
      const allowed = o.key === 'caller' || o.key === 'arguments' ? [/'caller', 'callee', and 'arguments' properties may not be accessed/] : []
      for (const e of o.errors) expect(allowed.some((re) => re.test(e)), `${o.key}=${o.value}: ${e}`).toBe(true)
    }
  })
})
