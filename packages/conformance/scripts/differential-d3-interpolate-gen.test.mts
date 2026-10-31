/**
 * GENERATED live differential of every interpolator in `core/src/interp.ts` against the pinned d3-interpolate 3.0.1
 * (the one `vega-scale` is built on), in one process and one engine. The existing `differential-interpolate` pins the
 * table `vega-scale` exposes at 231 hand-picked cases; this one draws its cases from seeded generators:
 *
 *  - numbers (extreme magnitudes, NaN, +-Infinity, +-0, numeric strings, Dates, `valueOf` objects), the rounding and the
 *    date / string / array / number-array / object / generic interpolators;
 *  - strings with embedded numbers (signs, fractions, exponents, unequal counts, equal numbers, empty remainders);
 *  - colours in every space (rgb, hsl, hsl-long, lab, hcl, hcl-long, cubehelix, cubehelix-long), each with gamma, from
 *    names, hex, css functions, malformed strings and colour objects of every class, with NaN channels;
 *  - rgb / basis / basis-closed splines over colour lists and number lists (typed arrays too), discrete, hue, zoom
 *    (with its rho), piecewise (explicit and default interpolator).
 *
 * Every interpolator is evaluated at a list of positions in a drawn order, extremes included, and each result is
 * serialised the moment it is produced (several interpolators hand back the same mutable array every call). A
 * colour object is built from the side's own colour library, so both sides see equivalent input.
 */
import * as d3c from 'd3-color'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import * as asterColor from '../../core/src/color.ts'
import * as aster from '../../core/src/interp.ts'
import { enc } from './differential-util.mts'
import { compareCases, makeRng, scaled, type Rng } from './differential-gen.mts'

vi.setConfig({ testTimeout: 120_000 })

/* eslint-disable @typescript-eslint/no-explicit-any */
const d3Path = createRequire(createRequire(import.meta.url).resolve('vega-scale')).resolve('d3-interpolate')
const d3: Record<string, any> = (await import(pathToFileURL(d3Path).href)) as Record<string, any>

interface Side {
  name: 'd3' | 'aster'
  lib: Record<string, any>
  colors: Record<string, any>
}
const D3: Side = { name: 'd3', lib: { ...d3, interpolateValue: d3.interpolate }, colors: d3c as unknown as Record<string, any> }
const ASTER: Side = { name: 'aster', lib: aster as unknown as Record<string, any>, colors: asterColor as unknown as Record<string, any> }

/** A value that is built per side (colour objects and Dates are not shared between libraries or calls). */
type Recipe = (s: Side) => unknown

const T_FIXED = [0, 1, 0.5, 0.25, 0.75, -0.25, 1.25, 0.333333, -0, 1e-9, 0.999999]
const T_ODD = [NaN, Infinity, -Infinity, 7, -3, 1e6]

function ts(r: Rng): number[] {
  const n = r.between(2, 7)
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(r.chance(0.55) ? r.pick(T_FIXED) : r.chance(0.2) ? r.pick(T_ODD) : r.next() * 1.4 - 0.2)
  return out
}

/** Call `g` at each position, serialising each result at once; a throw is that call's result. */
function sample(make: () => unknown, positions: number[], extra?: (g: any) => unknown): unknown {
  let g: any
  try {
    g = make()
  } catch (e) {
    return { made: 'throw', cls: (e as Error).constructor.name, msg: e instanceof TypeError && !STRICT ? '' : (e as Error).message }
  }
  if (typeof g !== 'function') return { made: enc(g) }
  const out = positions.map((t) => {
    try {
      return enc(g(t))
    } catch (e) {
      return { threw: (e as Error).constructor.name, msg: e instanceof TypeError && !STRICT ? '' : (e as Error).message }
    }
  })
  return { out, extra: extra ? enc(extra(g)) : undefined, type: typeof g }
}

/** `ASTER_DIFF_MESSAGES=1` compares the engine's own wording of a TypeError too (it quotes variables of the library that raised it). */
const STRICT = !!process.env.ASTER_DIFF_MESSAGES

const NUM = [0, 1, -1, 10, 255, 0.5, 3.14159, 1e-9, 1e9, 123456.789, 1e21, -1e-7, -0, 360, 180, 359.9, NaN, Infinity, -Infinity, 5e-324, 1.7976931348623157e308]

function genNumeric(r: Rng): Recipe {
  const v = r.chance(0.85) ? r.pick(NUM) : r.next() * r.pick([1, 100, 1e6, 360])
  switch (r.int(20)) {
    case 0: return () => String(v)
    case 1: return () => new Date(Math.abs(Number.isFinite(v) ? v : 0) * 1000)
    case 2: return () => ({ valueOf: () => v })
    case 3: return () => null
    case 4: return () => undefined
    case 5: return () => true
    case 6: return () => 'abc'
    case 7: return () => new Number(v)
    default: return () => v
  }
}

const COLOR_STRINGS = [
  'red', 'steelblue', 'orange', 'white', 'black', 'gray', 'transparent', '#f00', '#ff0000', '#ff000080', '#fa3b', '#123', '#abcdef', '#ABCDEF',
  'rgb(255,0,0)', 'rgb(10, 200, 30)', 'rgba(255,0,0,0.5)', 'rgb(100%, 0%, 50%)', 'rgba(0,0,0,0)', 'rgb(300, -20, 4)', 'rgb(1.5, 2.5, 3.5)',
  'hsl(10,50%,50%)', 'hsl(200, 80%, 30%)', 'hsla(120, 100%, 25%, 0.4)', 'hsl(0,0%,50%)', 'hsl(360,100%,50%)', 'hsl(-30, 40%, 60%)',
  'nonsense', '', '#12', 'rgb(1,2)', 'NaN', 'rgb(NaN,0,0)', ' red ', 'RED',
]
const CHAN = [0, 1, 64, 128, 255, 256, 300, -20, 0.5, 360, 100, 50, 40, 25.5, NaN, undefined]

function genColor(r: Rng): Recipe {
  const k = r.int(10)
  if (k < 5) {
    const s = r.pick(COLOR_STRINGS)
    return () => s
  }
  if (k < 9) {
    const space = r.pick(['rgb', 'hsl', 'lab', 'hcl', 'cubehelix'])
    const ch = [r.pick(CHAN), r.pick(CHAN), r.pick(CHAN), r.chance(0.6) ? undefined : r.pick([0, 0.5, 1, 2, NaN, -1])]
    return (s) => s.colors[space](...ch)
  }
  const odd = r.pick([null, undefined, 5, {}, [], NaN])
  return () => odd
}

function genStringWithNumbers(r: Rng): string {
  const parts: string[] = []
  const n = r.between(0, 5)
  for (let i = 0; i < n; i++) {
    if (r.chance(0.5)) parts.push(r.pick(['a', 'b ', ' c', '-', '+', '.', 'e', 'px', 'M', ',', '(', ')', 'rgb(', 'E+', ' ']))
    const num = r.pick(['0', '1', '-5', '+3', '1.5', '.5', '5.', '1e3', '2E-2', '1e', '-.5e+2', '007', '10', '255', '1e400', '-0', '0.1', '12345678901234567890'])
    parts.push(num)
  }
  if (r.chance(0.5)) parts.push(r.pick(['z', ' tail', '%', 'px']))
  return parts.join(r.pick(['', '', ' ']))
}

describe('interp.ts vs d3-interpolate 3.0.1 (generated)', () => {
  it('number, round', () => {
    const r = makeRng(0x11)
    const out = compareCases('number', scaled(4000), () => {
      const a = genNumeric(r)
      const b = genNumeric(r)
      const pos = ts(r)
      const name = r.pick(['interpolateNumber', 'interpolateRound'])
      return {
        label: `${name} ${pos}`,
        oracle: () => sample(() => D3.lib[name](a(D3), b(D3)), pos),
        aster: () => sample(() => ASTER.lib[name](a(ASTER), b(ASTER)), pos),
      }
    })
    expect(out.informative).toBeGreaterThan(3000)
  })

  it('string', () => {
    const r = makeRng(0x12)
    compareCases('string', scaled(4000), () => {
      const a = r.chance(0.9) ? genStringWithNumbers(r) : (genNumeric(r)(D3) as string)
      const b = r.chance(0.9) ? genStringWithNumbers(r) : (genNumeric(r)(D3) as string)
      const pos = ts(r)
      return {
        label: JSON.stringify([a, b]),
        oracle: () => sample(() => d3.interpolateString(a, b), pos),
        aster: () => sample(() => aster.interpolateString(a, b), pos),
      }
    })
  })

  it('date', () => {
    const r = makeRng(0x13)
    compareCases('date', scaled(1000), () => {
      const a = genNumeric(r)
      const b = genNumeric(r)
      const pos = ts(r)
      return {
        label: String(pos),
        oracle: () => sample(() => d3.interpolateDate(a(D3), b(D3)), pos),
        aster: () => sample(() => aster.interpolateDate(a(ASTER) as Date, b(ASTER) as Date), pos),
      }
    })
  })

  const SPACES: [string, string][] = [
    ['interpolateRgb', 'rgb'], ['interpolateHsl', 'hsl'], ['interpolateHslLong', 'hsl-long'], ['interpolateLab', 'lab'],
    ['interpolateHcl', 'hcl'], ['interpolateHclLong', 'hcl-long'], ['interpolateCubehelix', 'cubehelix'], ['interpolateCubehelixLong', 'cubehelix-long'],
  ]
  it('colours in every space, with and without gamma', () => {
    const r = makeRng(0x14)
    const out = compareCases('colour', scaled(14000), () => {
      const [name] = r.pick(SPACES)
      const a = genColor(r)
      const b = genColor(r)
      const pos = ts(r)
      const gamma = name === 'interpolateRgb' || name.startsWith('interpolateCubehelix') ? r.pick([undefined, undefined, 1, 0.5, 2.2, 3, 0, -1, NaN, '2', 1.0000001]) : undefined
      const make = (side: Side): unknown => {
        let f = side.lib[name]
        if (gamma !== undefined) f = f.gamma(gamma)
        return f(a(side), b(side))
      }
      return { label: `${name} gamma=${gamma} ${pos}`, oracle: () => sample(() => make(D3), pos), aster: () => sample(() => make(ASTER), pos) }
    })
    expect(out.informative).toBeGreaterThan(8000)
  })

  it('colour interpolators called again at earlier positions (no state kept between calls)', () => {
    const r = makeRng(0x15)
    compareCases('colour-replay', scaled(1500), () => {
      const [name] = r.pick(SPACES)
      const a = genColor(r)
      const b = genColor(r)
      const pos = ts(r)
      const replay = [...pos, ...pos.slice().reverse(), ...pos]
      return {
        label: `${name} ${pos}`,
        oracle: () => sample(() => D3.lib[name](a(D3), b(D3)), replay),
        aster: () => sample(() => ASTER.lib[name](a(ASTER), b(ASTER)), replay),
      }
    })
  })

  it('rgb / basis / basis-closed splines over colour lists and number lists', () => {
    const r = makeRng(0x16)
    compareCases('spline', scaled(5000), () => {
      const name = r.pick(['interpolateRgbBasis', 'interpolateRgbBasisClosed', 'interpolateBasis', 'interpolateBasisClosed'])
      const n = r.pick([0, 1, 2, 3, 4, 5, 9])
      const items = Array.from({ length: n }, () => (name.includes('Rgb') ? genColor(r) : genNumeric(r)))
      const typed = !name.includes('Rgb') && r.chance(0.2) ? r.pick(['Float64Array', 'Int16Array', 'Uint8Array']) : null
      const pos = ts(r)
      const build = (side: Side): unknown => {
        const list = items.map((it) => it(side))
        return side.lib[name](typed ? (globalThis as any)[typed].from(list.map((v) => +(v as number) || 0)) : list)
      }
      return { label: `${name}${typed ? ' ' + typed : ''} n=${n} ${pos}`, oracle: () => sample(() => build(D3), pos), aster: () => sample(() => build(ASTER), pos) }
    })
  })

  it('discrete', () => {
    const r = makeRng(0x17)
    compareCases('discrete', scaled(1500), () => {
      const n = r.pick([0, 1, 2, 3, 7])
      const items = Array.from({ length: n }, () => genNumeric(r))
      const pos = ts(r)
      return {
        label: `n=${n} ${pos}`,
        oracle: () => sample(() => d3.interpolateDiscrete(items.map((i) => i(D3))), pos),
        aster: () => sample(() => aster.interpolateDiscrete(items.map((i) => i(ASTER))), pos),
      }
    })
  })

  it('hue', () => {
    const r = makeRng(0x18)
    compareCases('hue', scaled(3000), () => {
      const a = genNumeric(r)
      const b = genNumeric(r)
      const pos = ts(r)
      return {
        label: String(pos),
        oracle: () => sample(() => d3.interpolateHue(a(D3), b(D3)), pos),
        aster: () => sample(() => aster.interpolateHue(a(ASTER), b(ASTER)), pos),
      }
    })
  })

  it('zoom, with its rho and duration', () => {
    const r = makeRng(0x19)
    const V = [0, 1, 10, 100, 1e-7, 1e6, -5, 0.5, NaN, Infinity, 300, 42]
    compareCases('zoom', scaled(4000), () => {
      const p0 = Array.from({ length: r.pick([3, 3, 3, 2, 4]) }, () => r.pick(V))
      const p1 = r.chance(0.25) ? p0.map((v) => v + (r.chance(0.5) ? 0 : 1e-8)) : Array.from({ length: 3 }, () => r.pick(V))
      const rho = r.pick([undefined, undefined, 1, 1.41421356, 2, 0.1, 0, -2, NaN, '3'])
      const pos = ts(r)
      const make = (z: any): unknown => (rho === undefined ? z : z.rho(rho))(p0, p1)
      return {
        label: `${JSON.stringify([p0, p1])} rho=${rho}`,
        oracle: () => sample(() => make(d3.interpolateZoom), pos, (g) => g.duration),
        aster: () => sample(() => make(aster.interpolateZoom), pos, (g) => g.duration),
      }
    })
  })

  /** A nested value (numbers, strings, colours, dates, arrays, typed arrays, objects); `shape` makes pairs related. */
  function genNested(r: Rng, depth: number): Recipe {
    const k = r.int(depth > 0 ? 14 : 9)
    if (k < 3) return genNumeric(r)
    if (k === 3) { const s = genStringWithNumbers(r); return () => s }
    if (k === 4) return genColor(r)
    if (k === 5) { const ms = r.pick([0, 1e12, 1.7e12, NaN]); return () => new Date(ms) }
    if (k === 6) { const v = Array.from({ length: r.between(0, 4) }, () => r.pick([0, 1, 5.5, NaN, -3])); const T = r.pick(['Float64Array', 'Uint8Array', 'Int16Array', 'Float32Array']); return () => (globalThis as any)[T].from(v) }
    if (k === 7) { const w = r.int(7); return () => [null, undefined, true, false, 'x', {}, []][w] }
    if (k === 8) return genNumeric(r)
    if (k < 11) {
      const items = Array.from({ length: r.between(0, 4) }, () => genNested(r, depth - 1))
      return (s) => items.map((i) => i(s))
    }
    const keys = Array.from({ length: r.between(0, 4) }, () => r.pick(['a', 'b', 'c', 'd', 'valueOf', 'x']))
    const vals = keys.map(() => genNested(r, depth - 1))
    return (s) => {
      const o: Record<string, unknown> = {}
      keys.forEach((key, i) => (o[key] = vals[i]!(s)))
      return o
    }
  }

  /** A plain object (the object interpolator walks `for..in`, which a colour class of another library would extend). */
  function genPlainObject(r: Rng): Recipe {
    const keys = Array.from({ length: r.between(0, 4) }, () => r.pick(['a', 'b', 'c', 'd', 'valueOf', 'x']))
    const vals = keys.map(() => genNested(r, 1))
    return (s) => {
      const o: Record<string, unknown> = {}
      keys.forEach((key, i) => (o[key] = vals[i]!(s)))
      return o
    }
  }

  it('generic value, array, object (nested) and number-array', () => {
    const r = makeRng(0x1a)
    const out = compareCases('generic', scaled(9000), () => {
      const name = r.pick(['interpolateValue', 'interpolateValue', 'interpolateArray', 'interpolateObject', 'interpolateNumberArray'])
      const lib = (s: Side): any => s.lib[name]
      let a: Recipe
      let b: Recipe
      if (name === 'interpolateObject') { a = genPlainObject(r); b = r.chance(0.7) ? a : genPlainObject(r) }
      else if (name === 'interpolateNumberArray') {
        const mk = (): Recipe => { const v = Array.from({ length: r.between(0, 4) }, () => r.pick([0, 1, 5.5, -2, NaN, 100])); const T = r.pick([null, 'Float64Array', 'Uint8Array', 'Int8Array', 'Float32Array']); return () => (T ? (globalThis as any)[T].from(v) : v.slice()) }
        a = r.chance(0.1) ? () => null : mk(); b = r.chance(0.05) ? () => undefined : mk()
      } else {
        a = genNested(r, 2)
        b = r.chance(0.6) ? a : genNested(r, 2)
      }
      const pos = ts(r)
      return {
        label: `${name} ${pos}`,
        oracle: () => sample(() => lib(D3)(a(D3), b(D3)), pos),
        aster: () => sample(() => lib(ASTER)(a(ASTER), b(ASTER)), pos),
      }
    })
    expect(out.informative).toBeGreaterThan(5000)
  })

  it('piecewise (explicit interpolator and the default)', () => {
    const r = makeRng(0x1b)
    compareCases('piecewise', scaled(3000), () => {
      const n = r.pick([0, 1, 2, 3, 5])
      const kind = r.pick(['interpolateNumber', 'interpolateRgb', 'interpolateHsl', 'interpolateLab', 'interpolateString', 'default', 'interpolateRound'])
      const items = Array.from({ length: n }, () => (kind === 'interpolateRgb' || kind === 'interpolateHsl' || kind === 'interpolateLab' ? genColor(r) : kind === 'interpolateString' ? ((s) => () => s)(genStringWithNumbers(r)) : kind === 'default' ? genNested(r, 1) : genNumeric(r)))
      const pos = ts(r)
      const make = (side: Side): unknown => {
        const values = items.map((i) => i(side))
        const pw = side.name === 'd3' ? d3.piecewise : aster.piecewise
        return kind === 'default' ? pw(values) : pw(side.lib[kind], values)
      }
      return { label: `${kind} n=${n} ${pos}`, oracle: () => sample(() => make(D3), pos), aster: () => sample(() => make(ASTER), pos) }
    })
  })
})
