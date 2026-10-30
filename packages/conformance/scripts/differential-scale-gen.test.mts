/**
 * GENERATED live differential of the whole scale library behind Aster's scale registry (`core/src/scale.ts`, built on
 * `scale-d3.ts`, `interp.ts`, `arr.ts`) against the pinned `vega-scale` 8.1.2 (and the d3-scale it is built on), in one
 * process and one engine. Nothing is recorded: see `differential-util.mts`.
 *
 * For every scale type of the registry (identity, linear, log, pow, sqrt, symlog, time, utc, sequential and diverging
 * in every transform, quantile, quantize, threshold, bin-ordinal, ordinal, band, point) a seeded generator draws
 * PROGRAMS: sequences of method calls on a scale and on copies of it. A method is called as the getter or the setter
 * (by arity), with ordinary and degenerate arguments: reversed, zero-width, NaN, +-Infinity, +-0, Dates, numeric strings,
 * null, wrong lengths, non-iterables, huge tick counts. After every call the observable state is read back (domain, range,
 * the output for probe values, and every property accessor the type has), so a divergence is caught at the call that
 * caused it, not at the end.
 *
 * Compared exactly (the thrown class for engine TypeErrors, class and message for Errors): the result of the call, the
 * state afterwards, which methods exist, whether a method returns the scale itself, that a copy is independent.
 * Functions a call returns (tickFormat, interpolate, interpolator) are compared by what they produce on sample input.
 */
import { appendFileSync } from 'node:fs'
import * as d3time from 'd3-time'
import * as vegaScale from 'vega-scale'
import { describe, expect, it, vi } from 'vitest'
import { implicit as asterImplicit } from '../../core/src/scale-d3.ts'
import * as asterScale from '../../core/src/scale.ts'
import * as asterTime from '../../core/src/time.ts'
import { enc, withTz } from './differential-util.mts'
import { makeRng, scaled, type Rng } from './differential-gen.mts'

vi.setConfig({ testTimeout: 300_000 })

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Side {
  name: 'vega' | 'aster'
  make: (type: string) => any
  interpolateColors: (colors: string[], type?: string, gamma?: number) => (t: number) => unknown
  scheme: (name: string) => any
  interpolate: (type: string, gamma?: number) => any
  implicit: unknown
  time: Record<string, any>
}
const VEGA: Side = {
  name: 'vega',
  make: (type) => (vegaScale as any).scale(type)(),
  interpolateColors: (vegaScale as any).interpolateColors,
  scheme: (vegaScale as any).scheme,
  interpolate: (vegaScale as any).interpolate,
  implicit: (vegaScale as any).scaleImplicit,
  time: d3time as any,
}
const ASTER: Side = {
  name: 'aster',
  make: (type) => (asterScale as any).scale(type)(),
  interpolateColors: asterScale.interpolateColors as any,
  scheme: asterScale.scheme as any,
  interpolate: asterScale.interpolate as any,
  implicit: asterImplicit,
  time: asterTime as any,
}

/** A value built per side (Dates, the implicit sentinel and interval objects are side-specific). */
type Recipe = (s: Side) => unknown

// ---- pools -------------------------------------------------------------------------------------------------

const NUMS = [0, 1, -1, 2, 3, 5, 10, 100, 0.5, 0.1, -0.5, -10, 1e-6, 1e6, 1e9, 3.14159, 7, 42, -100, 1e-9, 1e12, 1e15, 360, 255, 0.3, 1000]
const ODD_NUMERIC: Recipe[] = [
  () => NaN, () => Infinity, () => -Infinity, () => -0, () => null, () => undefined, () => '5', () => ' 7 ', () => '', () => 'x', () => true, () => false,
  () => new Date(5), () => new Date(NaN), () => [4], () => ({ valueOf: () => 3 }), () => 1e21, () => 5e-324,
]
const EPOCHS = [0, 946684800000, 1.5e12, 1.7e12, 1710054000000 - 3600000, 1730000000000, -2e12, 4e12, 1e15]
const SPANS = [1, 250, 1000, 60000, 3600000, 86400000, 7 * 86400000, 31 * 86400000, 400 * 86400000, 3650 * 86400000, 40000 * 86400000, 0, -86400000]
const COUNTS: unknown[] = [undefined, 0, 1, 2, 3, 4, 5, 7, 10, 10, 20, 50, 100, 1000, 20000, 0.5, 1.5, 2.5, -1, NaN, Infinity, '5', null, true, 1e-9]
const TIME_COUNTS: unknown[] = [undefined, 0, 1, 2, 3, 5, 7, 10, 10, 20, 50, 100, 0.5, 2.5, -1, NaN, '5', null]
const SPECS: unknown[] = [undefined, null, ',f', '.2f', '.0f', 's', '%', '.0%', '$,.2f', 'e', '.3e', 'r', '.3r', '.3g', 'g', '+', '+.1f', '.2s', 'x', 'o', 'b', 'c', '~s', '.4~f', ',', '08.2f', '(.2f', ' d', 'bad specifier', '.20f', '_<5', '^20', '.-1f', 'p', 'X', '$']
const TIME_SPECS: unknown[] = [undefined, null, '%Y', '%b %d', '%H:%M', '%Y-%m-%d %H:%M:%S', '%B', '%a %d', '%I %p', '.%L', ':%S', '%q', '%-d', '%Z', '%%', '', 'x', '%x %X', '%c', '%j', '%U', '%W', '%u', '%w', '%e', '%y', '%s', '%Q']
const COLORS = ['red', 'blue', 'steelblue', 'orange', '#fff', '#000', '#ffffe0', '#8b0000', 'rgb(10,20,30)', 'rgba(255,0,0,0.5)', 'hsl(120,50%,50%)', 'white', 'black', 'gray', 'nonsense', 'transparent', '#0f0']
const LABELS = ['a', 'b', 'c', 'd', 'e', 'foo', 'bar', 'x', 'y', 'z', '', 'A', 'a b', '1', '2', '10', '0', 'null', 'NaN']

const pickNum = (r: Rng): number => r.pick(NUMS)
const oddOr = (r: Rng, p: number, fn: () => Recipe): Recipe => (r.chance(p) ? r.pick(ODD_NUMERIC) : fn())

/** A numeric list recipe of length n of nice values, in an order that makes the interesting shapes. */
function numericList(r: Rng, n: number, kind: 'any' | 'positive' | 'negative' | 'crossing'): number[] {
  const out: number[] = []
  let x = kind === 'positive' ? r.pick([0.01, 1, 10, 100, 0.5, 1e-3, 1e6]) : kind === 'negative' ? -r.pick([1e6, 1000, 10, 100, 1]) : kind === 'crossing' ? -r.pick([100, 1, 5, 0.5]) : pickNum(r)
  const dir = r.pick([1, 1, 1, -1, 0])
  const step = r.pick([1, 10, 100, 0.001, 0.5, 3.7, 1000, 1e6, 1e-7])
  for (let i = 0; i < n; i++) {
    out.push(x)
    x += dir === 0 ? (r.chance(0.5) ? step : -step) * r.next() : kind === 'positive' ? Math.abs(x) * (dir > 0 ? r.pick([1.5, 2, 9, 99, 1.0001]) - 1 : -0.4) + 1e-9 : kind === 'negative' ? (dir > 0 ? Math.abs(x) * 0.5 : -Math.abs(x)) : kind === 'crossing' ? (dir > 0 ? Math.abs(out[0]!) * 2 / Math.max(1, n - 1) : -Math.abs(out[0]!) * 2 / Math.max(1, n - 1)) : dir * step * (0.5 + r.next())
  }
  return out
}

function genNumericDomain(r: Rng, length?: number): Recipe {
  const mode = r.int(24)
  if (mode === 0) return r.pick([() => 5, () => null, () => undefined, () => ({}), () => 'abc', () => new Set([1, 2, 3])]) as Recipe
  if (mode === 1) return () => []
  const kind = r.pick(['any', 'any', 'positive', 'negative', 'crossing'] as const)
  const n = length ?? r.pick([2, 2, 2, 2, 2, 3, 3, 4, 5, 1, 6])
  const list = numericList(r, n, kind)
  if (mode === 2) list.length = Math.min(list.length, 2), list[1] = list[0]! // zero width
  if (mode === 3) list.reverse()
  const wrapped: (Recipe | number)[] = list.map((v) => v)
  if (mode >= 4 && mode < 7) wrapped[r.int(wrapped.length)] = r.pick(ODD_NUMERIC)
  if (mode === 7) wrapped.fill(0)
  if (mode === 8) return (s) => new Set(wrapped.map((w) => (typeof w === 'function' ? w(s) : w)))
  if (mode === 9) return (s) => new Float64Array(wrapped.map((w) => +(typeof w === 'function' ? (w(s) as number) : w)))
  return (s) => wrapped.map((w) => (typeof w === 'function' ? w(s) : w))
}

function timeValue(r: Rng): number {
  const e = r.pick(EPOCHS)
  return e + (r.chance(0.5) ? 0 : r.int(86400000 * 3))
}
function genTimeDomain(r: Rng, length?: number): Recipe {
  const mode = r.int(20)
  if (mode === 0) return r.pick([() => 5, () => null, () => undefined, () => ({})]) as Recipe
  const n = length ?? r.pick([2, 2, 2, 2, 2, 3, 1, 4])
  const start = timeValue(r)
  const span = r.pick(SPANS)
  const vals: number[] = []
  for (let i = 0; i < n; i++) vals.push(start + (i * span) / Math.max(1, n - 1))
  if (mode === 1) vals.reverse()
  const asDate = r.chance(0.7)
  const odd = mode >= 2 && mode < 5 ? r.int(vals.length) : -1
  const oddFn = odd >= 0 ? r.pick(ODD_NUMERIC) : null
  return (s) => vals.map((v, i) => (i === odd ? oddFn!(s) : asDate ? new Date(v) : v))
}

function genNumericRange(r: Rng, length?: number): Recipe {
  const mode = r.int(22)
  if (mode === 0) return r.pick([() => 5, () => null, () => undefined, () => ({}), () => 'ab']) as Recipe
  const n = length ?? r.pick([2, 2, 2, 2, 2, 3, 4, 5, 1, 0])
  if (mode >= 1 && mode < 5) {
    const items = Array.from({ length: n }, () => r.pick(COLORS))
    return () => items.slice()
  }
  if (mode === 5) { const arr = Array.from({ length: n }, () => [pickNum(r), pickNum(r)]); return () => arr.map((a) => a.slice()) }
  if (mode === 6) { const o = Array.from({ length: n }, () => ({ a: pickNum(r), b: r.pick(COLORS) })); return () => o.map((a) => ({ ...a })) }
  if (mode === 7) { const d = Array.from({ length: n }, () => r.pick(EPOCHS)); return () => d.map((v) => new Date(v)) }
  if (mode === 8) { const s = Array.from({ length: n }, () => r.pick(['0', '10', '5.5', 'x', '100px', 'M0,0'])); return () => s.slice() }
  if (mode === 9) { const m = [pickNum(r), pickNum(r)]; const pos = r.int(n + 1); const odd = r.pick(ODD_NUMERIC); return (side) => { const l = m.slice(); l.splice(pos, 0, odd(side) as number); return l } }
  const list = numericList(r, n, 'any')
  if (mode === 10) list.reverse()
  if (mode === 11) list.fill(list[0] ?? 0)
  const px = r.chance(0.5)
  const vals = px ? list.map((v) => Math.round(v * 100) / 100) : list
  return () => vals.slice()
}

/** The recipes for the values a program feeds a type's `call` / `invert` / `invertExtent`. */
function genProbes(r: Rng, kind: 'num' | 'time' | 'label' | 'range'): Recipe[] {
  const n = r.between(5, 10)
  const out: Recipe[] = []
  for (let i = 0; i < n; i++) {
    if (r.chance(0.18)) out.push(r.pick(ODD_NUMERIC))
    else if (kind === 'num') out.push((() => { const v = pickNum(r) * (r.chance(0.3) ? r.next() : 1); return () => v })())
    else if (kind === 'time') out.push((() => { const v = timeValue(r) + (r.chance(0.5) ? 0 : r.pick(SPANS)); const asDate = r.chance(0.7); return () => (asDate ? new Date(v) : v) })())
    else if (kind === 'range') out.push((() => { const v = pickNum(r); const c = r.pick(COLORS); return r.chance(0.7) ? () => v : () => c })())
    else out.push((() => { const v = r.pick([...LABELS, 0, 1, 2, null, NaN, true]); return () => v })())
  }
  return out
}

// ---- programs ----------------------------------------------------------------------------------------------

interface Op {
  name: string
  /** Index of the scale the call goes to: 0 is the original, k is its k-th copy. */
  target: number
  args: Recipe[]
}
interface TypeSpec {
  type: string
  family: 'continuous' | 'time' | 'color' | 'quantile' | 'quantize' | 'threshold' | 'binordinal' | 'ordinal' | 'band' | 'point' | 'identity'
  log?: boolean
  diverging?: boolean
  utc?: boolean
}
const TYPES: TypeSpec[] = [
  { type: 'identity', family: 'identity' },
  { type: 'linear', family: 'continuous' },
  { type: 'log', family: 'continuous', log: true },
  { type: 'pow', family: 'continuous' },
  { type: 'sqrt', family: 'continuous' },
  { type: 'symlog', family: 'continuous' },
  { type: 'time', family: 'time' },
  { type: 'utc', family: 'time', utc: true },
  ...['sequential', 'sequential-linear', 'sequential-log', 'sequential-pow', 'sequential-sqrt', 'sequential-symlog'].map((type): TypeSpec => ({ type, family: 'color', log: type.endsWith('log') })),
  ...['diverging-linear', 'diverging-log', 'diverging-pow', 'diverging-sqrt', 'diverging-symlog'].map((type): TypeSpec => ({ type, family: 'color', diverging: true, log: type.endsWith('log') })),
  { type: 'quantile', family: 'quantile' },
  { type: 'quantize', family: 'quantize' },
  { type: 'threshold', family: 'threshold' },
  { type: 'bin-ordinal', family: 'binordinal' },
  { type: 'ordinal', family: 'ordinal' },
  { type: 'band', family: 'band' },
  { type: 'point', family: 'point' },
]

const interpolatorFns: ((s: Side) => unknown)[] = [
  () => (t: number) => t,
  () => (t: number) => t * 2 - 0.5,
  (s) => s.interpolateColors(['white', 'steelblue']),
  (s) => s.interpolateColors(['#ffffe0', '#6a9', '#8b0000'], 'hcl'),
  (s) => s.interpolateColors(['red', 'green', 'blue'], 'cubehelix', 2),
  (s) => s.scheme('viridis'),
  (s) => s.scheme('blueorange'),
  () => (t: number) => (t > 0.5 ? 'hi' : 'lo'),
  () => 5,
  () => undefined,
  () => null,
]
const interpolateSpecs: [string, number | undefined][] = [['rgb', undefined], ['hsl', undefined], ['hcl', undefined], ['lab', undefined], ['rgb', 2.2], ['cubehelix', 0.5], ['hsl-long', undefined], ['round', undefined], ['number', undefined], ['string', undefined], ['zoom', undefined], ['basis', undefined], ['discrete', undefined], ['hue', undefined], ['array', undefined], ['date', undefined], ['object', undefined], ['bogus', undefined]]
const intervalNames = ['Minute', 'Hour', 'Day', 'Week', 'Month', 'Year']

function genOps(r: Rng, ts: TypeSpec, probes: Recipe[], rangeProbes: Recipe[]): Op[] {
  const ops: Op[] = []
  const n = r.between(2, 9)
  let scales = 1
  const logish = ts.log === true
  const numDom = (len?: number): Recipe => (logish && r.chance(0.7) ? genLogDomain(r, len) : genNumericDomain(r, len))
  const timeFmtSpec = (): Recipe => { const v = r.pick(TIME_SPECS); return () => v }
  const op = (name: string, ...args: Recipe[]): void => { ops.push({ name, target: scales > 1 && r.chance(0.35) ? r.int(scales) : 0, args }) }
  const constant = <T,>(v: T): Recipe => () => v
  const count = (): Recipe => constant(r.pick(COUNTS))
  const fmtSample = (): Recipe[] => probes.slice(0, 6)

  for (let i = 0; i < n; i++) {
    const startWithState = i < 2 && r.chance(0.8)
    switch (ts.family) {
      case 'identity':
      case 'continuous': {
        const choices = ['domain', 'domain', 'range', 'call', 'call', 'call', 'invert', 'invertRange', 'invertExtent', 'ticks', 'tickFormat', 'nice', 'copy', 'unknown', 'getDomain', 'getRange']
        if (ts.family === 'continuous') choices.push('clamp', 'clamp', 'rangeRound', 'interpolate', 'getInterpolate')
        if (ts.type === 'log') choices.push('base', 'base', 'getBase')
        if (ts.type === 'pow') choices.push('exponent', 'exponent', 'getExponent')
        if (ts.type === 'sqrt') choices.push('exponent', 'getExponent')
        if (ts.type === 'symlog') choices.push('constant', 'constant', 'getConstant')
        const c = startWithState ? (i === 0 ? 'domain' : 'range') : r.pick(choices)
        switch (c) {
          case 'domain': op('domain', numDom()); break
          case 'range': op('range', genNumericRange(r)); break
          case 'call': op('call', r.pick(probes)); break
          case 'invert': op('invert', r.pick(rangeProbes)); break
          case 'invertRange': op('invertRange', ((a, b) => (s: Side) => [a(s), b(s)])(r.pick(rangeProbes), r.pick(rangeProbes))); break
          case 'invertExtent': op('invertExtent', r.pick(rangeProbes)); break
          case 'ticks': op('ticks', count()); break
          case 'tickFormat': op('tickFormat', count(), constant(r.pick(SPECS)), ...fmtSample()); break
          case 'nice': op('nice', ...(r.chance(0.3) ? [] : [count()])); break
          case 'copy': scales++; op('copy'); break
          case 'unknown': op('unknown', ...(r.chance(0.3) ? [] : [constant(r.pick([undefined, null, 'u', 0, NaN, -1, '#ccc']))])); break
          case 'clamp': op('clamp', constant(r.pick([true, false, 1, 0, 'x', null, undefined, ''])) ); break
          case 'rangeRound': op('rangeRound', genNumericRange(r)); break
          case 'interpolate': { const [t, g] = r.pick(interpolateSpecs); op('interpolate', (s) => s.interpolate(t, g)); break }
          case 'base': op('base', constant(r.pick([10, 2, Math.E, 3, 0.5, 1, 0, -2, NaN, '10', 1.5, 100]))); break
          case 'exponent': op('exponent', constant(r.pick([1, 0.5, 2, 3, 0, -1, NaN, '2', 0.3, 1 / 3, -0.5, Infinity]))); break
          case 'constant': op('constant', constant(r.pick([1, 0.1, 10, 0, -1, NaN, '2', 1e-9, 1000]))); break
          case 'getDomain': op('domain'); break
          case 'getRange': op('range'); break
          case 'getInterpolate': op('interpolate'); break
          case 'getBase': op('base'); break
          case 'getExponent': op('exponent'); break
          case 'getConstant': op('constant'); break
        }
        break
      }
      case 'time': {
        const choices = ['domain', 'domain', 'range', 'call', 'call', 'call', 'invert', 'ticks', 'ticks', 'tickFormat', 'nice', 'nice', 'copy', 'clamp', 'unknown', 'rangeRound', 'getDomain', 'getRange', 'interpolate']
        const c = startWithState ? (i === 0 ? 'domain' : 'range') : r.pick(choices)
        const prefix = ts.utc ? 'utc' : 'time'
        // a tick interval is bounded to the units a 100-year domain can hold in memory (an hour or a minute would list millions)
        const intervalArg = (coarse = false): Recipe => { const name = prefix + r.pick(coarse ? intervalNames.slice(3) : intervalNames); return (s) => s.time[name] }
        switch (c) {
          case 'domain': op('domain', genTimeDomain(r)); break
          case 'range': op('range', genNumericRange(r)); break
          case 'call': op('call', r.pick(probes)); break
          case 'invert': op('invert', r.pick(rangeProbes)); break
          case 'ticks': op('ticks', r.chance(0.3) ? intervalArg(true) : constant(r.pick(TIME_COUNTS))); break
          case 'tickFormat': op('tickFormat', constant(r.pick(TIME_COUNTS)), timeFmtSpec(), ...fmtSample()); break
          case 'nice': op('nice', ...(r.chance(0.25) ? [] : r.chance(0.4) ? [intervalArg()] : [constant(r.pick(TIME_COUNTS))])); break
          case 'copy': scales++; op('copy'); break
          case 'clamp': op('clamp', constant(r.pick([true, false, 1, 0]))); break
          case 'unknown': op('unknown', constant(r.pick([undefined, null, 'u', 0, NaN]))); break
          case 'rangeRound': op('rangeRound', genNumericRange(r)); break
          case 'getDomain': op('domain'); break
          case 'getRange': op('range'); break
          case 'interpolate': { const [t, g] = r.pick(interpolateSpecs); op('interpolate', (s) => s.interpolate(t, g)); break }
        }
        break
      }
      case 'color': {
        const k = ts.diverging ? 3 : 2
        const choices = ['domain', 'domain', 'range', 'range', 'call', 'call', 'call', 'ticks', 'tickFormat', 'nice', 'copy', 'clamp', 'clamp', 'unknown', 'interpolator', 'interpolator', 'getInterpolator', 'getDomain', 'getRange', 'rangeRound', 'invert']
        if (ts.type.endsWith('log')) choices.push('base', 'getBase')
        if (ts.type.endsWith('pow')) choices.push('exponent', 'getExponent')
        if (ts.type.endsWith('sqrt')) choices.push('exponent')
        if (ts.type.endsWith('symlog')) choices.push('constant', 'getConstant')
        const c = startWithState ? (i === 0 ? 'domain' : r.pick(['range', 'interpolator'])) : r.pick(choices)
        switch (c) {
          case 'domain': op('domain', r.chance(0.8) ? (logish && r.chance(0.7) ? genLogDomain(r, k) : genNumericDomain(r, k)) : genNumericDomain(r)); break
          case 'range': op('range', r.chance(0.7) ? genColorRange(r, k) : genNumericRange(r)); break
          case 'call': op('call', r.pick(probes)); break
          case 'ticks': op('ticks', count()); break
          case 'tickFormat': op('tickFormat', count(), constant(r.pick(SPECS)), ...fmtSample()); break
          case 'nice': op('nice', ...(r.chance(0.3) ? [] : [count()])); break
          case 'copy': scales++; op('copy'); break
          case 'clamp': op('clamp', constant(r.pick([true, false, 1, 0, undefined]))); break
          case 'unknown': op('unknown', ...(r.chance(0.3) ? [] : [constant(r.pick([undefined, null, 'u', 0, NaN]))])); break
          case 'interpolator': { const f = r.pick(interpolatorFns); op('interpolator', f); break }
          case 'getInterpolator': op('interpolator'); break
          case 'getDomain': op('domain'); break
          case 'getRange': op('range'); break
          case 'rangeRound': op('rangeRound', genNumericRange(r, k)); break
          case 'invert': op('invert', r.pick(rangeProbes)); break
          case 'base': op('base', constant(r.pick([10, 2, Math.E, 3, 0.5, 1, 0, NaN, '10']))); break
          case 'exponent': op('exponent', constant(r.pick([1, 0.5, 2, 3, 0, -1, NaN, 0.3]))); break
          case 'constant': op('constant', constant(r.pick([1, 0.1, 10, 0, -1, NaN]))); break
          case 'getBase': op('base'); break
          case 'getExponent': op('exponent'); break
          case 'getConstant': op('constant'); break
        }
        break
      }
      case 'quantile':
      case 'quantize':
      case 'threshold': {
        const choices = ['domain', 'domain', 'range', 'range', 'call', 'call', 'call', 'invertExtent', 'invertExtent', 'thresholds', 'quantiles', 'copy', 'unknown', 'getDomain', 'getRange', 'ticks', 'nice', 'tickFormat']
        const c = startWithState ? (i === 0 ? 'domain' : 'range') : r.pick(choices)
        switch (c) {
          case 'domain': op('domain', ts.family === 'quantile' ? genQuantileDomain(r) : ts.family === 'quantize' ? genNumericDomain(r, r.pick([2, 2, 2, 2, 3, 1, 0])) : genThresholdDomain(r)); break
          case 'range': op('range', genDiscreteRange(r)); break
          case 'call': op('call', r.pick(probes)); break
          case 'invertExtent': op('invertExtent', r.chance(0.7) ? ((i) => () => i)(r.pick(['a', 'b', 'c', 'd', 0, 1, 2, 'zz', NaN, undefined, null])) : r.pick(rangeProbes)); break
          case 'thresholds': op('thresholds'); break
          case 'quantiles': op('quantiles', ...(r.chance(0.5) ? [] : [constant(r.pick([1, 2, 4, 10, 0, -1, NaN]))])); break
          case 'copy': scales++; op('copy'); break
          case 'unknown': op('unknown', ...(r.chance(0.3) ? [] : [constant(r.pick([undefined, null, 'u', 0, NaN]))])); break
          case 'getDomain': op('domain'); break
          case 'getRange': op('range'); break
          case 'ticks': op('ticks', count()); break
          case 'nice': op('nice', count()); break
          case 'tickFormat': op('tickFormat', count(), constant(r.pick(SPECS)), ...fmtSample()); break
        }
        break
      }
      case 'binordinal': {
        const choices = ['domain', 'domain', 'range', 'range', 'call', 'call', 'call', 'tickFormat', 'copy', 'getDomain', 'getRange', 'bins']
        const c = startWithState ? (i === 0 ? 'domain' : 'range') : r.pick(choices)
        switch (c) {
          case 'domain': op('domain', genNumericDomain(r, r.pick([2, 3, 4, 5, 0, 6]))); break
          case 'range': op('range', genDiscreteRange(r)); break
          case 'call': op('call', r.pick(probes)); break
          case 'tickFormat': op('tickFormat', count(), constant(r.pick(SPECS)), ...fmtSample()); break
          case 'copy': scales++; op('copy'); break
          case 'getDomain': op('domain'); break
          case 'getRange': op('range'); break
          case 'bins': { const b = numericList(r, r.between(0, 5), 'any'); op('bins', () => b.slice()); break }
        }
        break
      }
      case 'ordinal':
      case 'band':
      case 'point': {
        const ord = ts.family === 'ordinal'
        const choices = ['domain', 'domain', 'range', 'range', 'call', 'call', 'call', 'copy', 'getDomain', 'getRange', 'unknown']
        if (ord) choices.push('invert', 'invertRange', 'unknown', 'ticks')
        else choices.push('rangeRound', 'round', 'getRound', 'padding', 'paddingOuter', 'align', 'bandwidth', 'step', 'invert', 'invertRange', 'invertRange', 'getPadding', 'getAlign', 'paddingInner', 'getPaddingOuter', 'invertExtent')
        const c = startWithState ? (i === 0 ? 'domain' : 'range') : r.pick(choices)
        const unit = (): Recipe => constant(r.pick([0, 1, 0.5, 0.1, 0.25, 0.9, -1, 2, NaN, '0.3', null, undefined, 1e-9, 0.99999]))
        switch (c) {
          case 'domain': op('domain', genLabelDomain(r)); break
          case 'range': op('range', ord ? genDiscreteRange(r) : genBandRange(r)); break
          case 'call': op('call', r.pick(probes)); break
          case 'copy': scales++; op('copy'); break
          case 'getDomain': op('domain'); break
          case 'getRange': op('range'); break
          case 'unknown': { const u = r.pick([undefined, null, 'u', 0, NaN, 'IMPLICIT']); op('unknown', ...(r.chance(0.3) ? [] : [(s: Side) => (u === 'IMPLICIT' ? s.implicit : u)])); break }
          case 'invert': op('invert', r.pick(rangeProbes)); break
          case 'invertRange': op('invertRange', ((a, b) => (s: Side) => [a(s), b(s)])(r.pick(rangeProbes), r.pick(rangeProbes))); break
          case 'invertExtent': op('invertExtent', r.pick(rangeProbes)); break
          case 'ticks': op('ticks', count()); break
          case 'rangeRound': op('rangeRound', genBandRange(r)); break
          case 'round': op('round', constant(r.pick([true, false, 1, 0, 'x', undefined, null]))); break
          case 'getRound': op('round'); break
          case 'padding': op('padding', unit()); break
          case 'paddingInner': op('paddingInner', unit()); break
          case 'paddingOuter': op('paddingOuter', unit()); break
          case 'getPaddingOuter': op('paddingOuter'); break
          case 'getPadding': op('padding'); break
          case 'align': op('align', unit()); break
          case 'getAlign': op('align'); break
          case 'bandwidth': op('bandwidth'); break
          case 'step': op('step'); break
        }
        break
      }
    }
  }
  return ops
}

function genLogDomain(r: Rng, length?: number): Recipe {
  const n = length ?? r.pick([2, 2, 2, 3, 4])
  const sign = r.pick([1, 1, 1, -1, 0])
  const list = numericList(r, n, sign === 0 ? 'crossing' : sign < 0 ? 'negative' : 'positive')
  if (r.chance(0.12)) list[r.int(list.length)] = 0
  if (r.chance(0.2)) list.reverse()
  return () => list.slice()
}

function genQuantileDomain(r: Rng): Recipe {
  const n = r.pick([0, 1, 2, 3, 5, 9, 20])
  const mode = r.pick(['clean', 'clean', 'sparse', 'odd', 'dups', 'allnull'])
  const list: (Recipe | number)[] = Array.from({ length: n }, () => (mode === 'allnull' ? r.pick(ODD_NUMERIC.slice(0, 5)) : mode === 'dups' ? r.pick([1, 2, 2, 5, 0, -0]) : r.chance(mode === 'odd' ? 0.6 : mode === 'sparse' ? 0.2 : 0) ? r.pick(ODD_NUMERIC) : Math.round((r.next() * 30 - 8) * 4) / 4))
  return (s) => list.map((v) => (typeof v === 'function' ? v(s) : v))
}

function genThresholdDomain(r: Rng): Recipe {
  const n = r.pick([0, 1, 2, 3, 4])
  const sorted = r.chance(0.85)
  const list = numericList(r, n, 'any')
  if (sorted) list.sort((a, b) => a - b)
  const odd = r.chance(0.1) ? r.pick(ODD_NUMERIC) : null
  const at = r.int(Math.max(1, list.length))
  return (s) => { const l: unknown[] = list.slice(); if (odd && l.length) l[at] = odd(s); return l }
}

function genDiscreteRange(r: Rng): Recipe {
  const n = r.pick([0, 1, 2, 3, 4, 5, 7])
  const mode = r.pick(['labels', 'labels', 'colors', 'numbers', 'mixed'])
  const items: unknown[] = Array.from({ length: n }, () => (mode === 'labels' ? r.pick(LABELS) : mode === 'colors' ? r.pick(COLORS) : mode === 'numbers' ? pickNum(r) : r.pick([...LABELS, ...NUMS, null, undefined])))
  if (r.chance(0.05)) return r.pick([() => 5, () => null, () => undefined]) as Recipe
  return () => items.slice()
}

function genColorRange(r: Rng, k: number): Recipe {
  const n = r.chance(0.8) ? k : r.pick([0, 1, 2, 3, 4])
  const items = Array.from({ length: n }, () => r.pick(COLORS))
  return () => items.slice()
}

function genLabelDomain(r: Rng): Recipe {
  const n = r.pick([0, 1, 2, 3, 4, 5, 6, 10])
  const mode = r.pick(['labels', 'labels', 'numbers', 'mixed', 'dates', 'dups'])
  const items: unknown[] = Array.from({ length: n }, () => (mode === 'labels' ? r.pick(LABELS.slice(0, 8)) : mode === 'numbers' ? r.pick([0, 1, 2, 3, 4, 5, 10, -1, 0.5]) : mode === 'dups' ? r.pick(['a', 'b', 'a', 'c']) : mode === 'dates' ? r.pick([0, 1e12, 1e12, 5]) : r.pick([...LABELS.slice(0, 5), 0, 1, null, NaN, true, '1'])))
  if (r.chance(0.05)) return r.pick([() => 5, () => null, () => undefined]) as Recipe
  return mode === 'dates' ? () => items.map((v) => new Date(v as number)) : () => items.slice()
}

function genBandRange(r: Rng): Recipe {
  const mode = r.int(14)
  if (mode === 0) return r.pick([() => 5, () => null, () => undefined, () => [], () => [1]]) as Recipe
  const a = r.pick([0, 0, 10, 100, 500, -50, 1e6, 0.3, 7, 1000])
  const b = r.pick([100, 500, 1000, 0, 10, a, -100, 333, 1e-3, 99.5])
  if (mode === 1) return () => [a, NaN]
  if (mode === 2) return () => [a, Infinity]
  if (mode === 3) return () => [String(a), String(b)]
  if (mode === 4) return () => [a, b, 123]
  return () => [a, b]
}

// ---- running a program -------------------------------------------------------------------------------------

const SURFACE = ['domain', 'range', 'rangeRound', 'clamp', 'nice', 'ticks', 'tickFormat', 'invert', 'invertRange', 'invertExtent', 'copy', 'interpolate', 'interpolator', 'unknown', 'base', 'exponent', 'constant', 'bandwidth', 'step', 'round', 'padding', 'paddingInner', 'paddingOuter', 'align', 'thresholds', 'quantiles', 'type', 'bins']

const GETTERS = ['clamp', 'unknown', 'base', 'exponent', 'constant', 'bandwidth', 'step', 'round', 'padding', 'paddingInner', 'paddingOuter', 'align', 'thresholds', 'quantiles', 'interpolator']

function safe(f: () => unknown): unknown {
  try {
    return enc(f())
  } catch (e) {
    return { threw: (e as Error).constructor.name, msg: e instanceof TypeError ? '' : (e as Error).message }
  }
}

/** What a function a call returned does, on sample input: the comparable image of a format / interpolator / interpolate. */
function image(name: string, f: any, side: Side, samples: Recipe[]): unknown {
  if (typeof f !== 'function') return enc(f)
  if (name === 'tickFormat') return samples.map((p) => safe(() => f(p(side))))
  if (name === 'interpolate') {
    return [safe(() => f(0, 10)(0.5)), safe(() => f('red', 'blue')(0.25)), safe(() => f([1, 2], [3, 4])(0.75)), safe(() => f(1, 5)(1.5)), safe(() => f('#ffffe0', '#8b0000')(0.5))]
  }
  if (name === 'interpolator') return [0, 0.25, 0.5, 1, -0.5, 1.5, NaN].map((t) => safe(() => f(t)))
  return { $: 'fn', len: f.length }
}

function snapshot(s: any, probes: Recipe[], side: Side): unknown {
  const o: Record<string, unknown> = {
    domain: safe(() => s.domain()),
    range: typeof s.range === 'function' ? safe(() => s.range()) : 'none',
    calls: probes.map((p) => safe(() => s(p(side)))),
  }
  for (const g of GETTERS) if (typeof s[g] === 'function') o[g] = g === 'interpolator' ? safe(() => image('interpolator', s[g](), side, [])) : safe(() => s[g]())
  if (typeof s.interpolate === 'function') o.interpolate = safe(() => image('interpolate', s.interpolate(), side, []))
  o.bins = s.bins === undefined ? 'unset' : safe(() => s.bins)
  return o
}

function runProgram(side: Side, ts: TypeSpec, ops: Op[], probes: Recipe[]): unknown {
  const scales: any[] = []
  let first: any
  try {
    first = side.make(ts.type)
  } catch (e) {
    return { made: 'throw', cls: (e as Error).constructor.name }
  }
  scales.push(first)
  const out: unknown[] = []
  out.push({ surface: SURFACE.map((m) => (m === 'type' ? first.type : typeof first[m])), start: snapshot(first, probes, side) })
  const fmtSamples = probes
  for (const op of ops) {
    const s = scales[Math.min(op.target, scales.length - 1)]
    const args = op.args.map((a) => a(side))
    let result: unknown
    try {
      if (op.name === 'call') result = enc(s(args[0]))
      else if (typeof s[op.name] !== 'function') result = { absent: op.name }
      else {
        const ret = s[op.name](...args)
        if (op.name === 'copy') {
          scales.push(ret)
          result = { copy: true, sameAsSource: ret === s }
        } else if (ret === s) result = { self: true }
        else if (typeof ret === 'function') result = image(op.name, ret, side, op.name === 'tickFormat' ? args.slice(2).map((v) => () => v) : fmtSamples)
        else result = enc(ret)
      }
    } catch (e) {
      result = { threw: (e as Error).constructor.name, msg: e instanceof TypeError ? '' : (e as Error).message }
    }
    out.push({ op: op.name, target: op.target, result, state: scales.map((x) => snapshot(x, probes, side)) })
  }
  return out
}

function describeProgram(ts: TypeSpec, ops: Op[]): string {
  const show = (side: Side): string => ops.map((o) => `${o.target ? `#${o.target}.` : ''}${o.name}(${o.args.map((a) => { try { const v = a(side); return typeof v === 'function' ? 'fn' : JSON.stringify(v, (_k, x) => (x === undefined ? '__undef' : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x)) } catch { return '?' } }).join(', ')})`).join(' ; ')
  return `${ts.type}: ${show(VEGA)}`
}

function firstDifference(a: unknown, b: unknown, path = ''): string {
  if (JSON.stringify(a) === JSON.stringify(b)) return ''
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) { const d = firstDifference(a[i], b[i], `${path}[${i}]`); if (d) return d }
  } else if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDifference((a as any)[k], (b as any)[k], `${path}.${k}`); if (d) return d }
  }
  return `${path}: vega ${JSON.stringify(a)?.slice(0, 200)} / aster ${JSON.stringify(b)?.slice(0, 200)}`
}

const PROGRAMS_PER_TYPE = 400

function programsFor(ts: TypeSpec, seed: number): { ops: Op[]; probes: Recipe[] }[] {
  const r = makeRng(seed)
  const list: { ops: Op[]; probes: Recipe[] }[] = []
  for (let i = 0; i < scaled(PROGRAMS_PER_TYPE); i++) {
    const kind = ts.family === 'time' ? 'time' : ts.family === 'ordinal' || ts.family === 'band' || ts.family === 'point' ? 'label' : 'num'
    const probes = genProbes(r, kind)
    const rangeProbes = genProbes(r, 'range')
    list.push({ ops: genOps(r, ts, probes, rangeProbes), probes })
  }
  return list
}

describe(`scale registry vs vega-scale@${(vegaScale as any).version ?? '8'} (generated programs)`, () => {
  for (const [ti, ts] of TYPES.entries()) {
    for (const tz of ts.family === 'time' ? ['UTC', 'America/New_York'] : ['UTC']) {
      it(`${ts.type}${ts.family === 'time' ? ` (${tz})` : ''}`, async () => {
        await withTz(tz, () => {
          const programs = programsFor(ts, 0x5ca1e + ti * 7919)
          const bad: string[] = []
          let informative = 0
          let failures = 0
          programs.forEach(({ ops, probes }, i) => {
            if (process.env.ASTER_DIFF_TRACE) appendFileSync(process.env.ASTER_DIFF_TRACE, `${ts.type} #${i} ${describeProgram(ts, ops)}\n`)
            const want = runProgram(VEGA, ts, ops, probes)
            const got = runProgram(ASTER, ts, ops, probes)
            if (JSON.stringify(want) !== JSON.stringify(got)) {
              failures++
              if (bad.length < 4) bad.push(`  #${i} ${describeProgram(ts, ops).slice(0, 600)}\n     ${firstDifference(want, got)}`)
            }
            if (Array.isArray(want) && want.some((s: any) => s.result && !s.result.threw && !s.result.absent)) informative++
          })
          expect(failures, `${failures}/${programs.length} programs differ\n${bad.join('\n')}`).toBe(0)
          expect(informative).toBeGreaterThan(programs.length * 0.6)
        })
      })
    }
  }
})

// ---- time ticks across every span ------------------------------------------------------------------------------

/**
 * The tick interval a time scale picks is a table of 18 (interval, step) rows searched by the target step, and the default
 * format is a ladder of eight units. A program rarely lands on every row, so this sweeps the span log-uniformly from a
 * millisecond to four centuries, at starts on, just before and just after the unit boundaries (DST changes included),
 * for every count that picks a different row.
 */
describe('time scales across every span (generated)', () => {
  const STARTS = [0, 946684800000, 1710054000000 - 1, 1710054000000, 1730613600000 - 5000, 1.7e12, 1735689600000, -1e12, 2e12, 4102444800000]
  for (const type of ['time', 'utc'] as const) {
    for (const tz of ['UTC', 'America/New_York']) {
      it(`${type} (${tz})`, async () => {
        await withTz(tz, () => {
          const r = makeRng(type === 'time' ? 0x71e : 0x71f)
          let failures = 0
          const bad: string[] = []
          for (let i = 0; i < scaled(2500); i++) {
            const span = Math.exp(r.next() * Math.log(400 * 365.25 * 86400000)) * (r.chance(0.2) ? 1 : 1)
            const start = r.pick(STARTS) + (r.chance(0.5) ? 0 : Math.floor(r.next() * 86400000))
            const dom = [start, start + span]
            if (r.chance(0.1)) dom.reverse()
            const count = r.pick([1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 40, 60, 90, 0.5, 1.5, undefined])
            const specifier = r.pick([undefined, undefined, '%Y-%m-%d %H:%M:%S.%L', '%b'])
            const run = (side: Side): unknown => {
              const s = side.make(type)
              s.domain(dom.map((v) => new Date(v)))
              const ticks = s.ticks(count)
              const fmt = s.tickFormat(count, specifier)
              const niceCopy = s.copy().nice(count)
              const niceDefault = s.copy().nice()
              return {
                ticks: enc(ticks),
                labels: (ticks as Date[]).slice(0, 40).map((t) => fmt(t)),
                nice: enc(niceCopy.domain()),
                niceDefault: enc(niceDefault.domain()),
              }
            }
            const want = JSON.stringify(run(VEGA))
            const got = JSON.stringify(run(ASTER))
            if (want !== got) {
              failures++
              if (bad.length < 3) bad.push(`  span=${span} start=${start} count=${count} spec=${specifier}\n     vega  ${want.slice(0, 240)}\n     aster ${got.slice(0, 240)}`)
            }
          }
          expect(failures, bad.join('\n')).toBe(0)
        })
      })
    }
  }
})
