/**
 * Replay of the oracle vectors recorded from the pinned upstream packages
 * (`packages/conformance/scripts/gen-vectors.mjs` -> `testdata/vectors/*.json`).
 *
 * Every suite asserts the port's output matches the oracle's exactly —
 * including `NaN`, `-0`, `undefined`, thrown errors, `Date` identity and
 * colour projections — which is what licenses dropping the upstream
 * dependency. One suite kind per shape:
 *
 *   'fn'       — plain functions: `fn(...args)` -> want
 *   'accessor' — accessor factories: report fields/name and the value on a datum
 *   'color'    — colour constructors: project the object's fields and methods
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Local-time parsing in the vectors was recorded with TZ=UTC; pin it here too
// so `Jan 1, 2020`-style cases match on any machine. Must run before the
// first Date parse in this file's worker.
process.env.TZ = 'UTC'

import {
  accessor, accessorFields, accessorName, ascending, extent, field, isArray,
  isBoolean, isDate, isNumber, isObject, isRegExp, isString, pluck, toBoolean,
  toDate, toNumber, toString, type Accessor,
} from './util.js'
import { color, gray, hcl, hsl, lab, lch, rgb } from './color.js'
import {
  millisecond, second, timeDay, timeFloor, timeHour, timeMinute, timeMonth,
  timeWeek, timeYear, utcDay, utcFloor, utcHour, utcMinute, utcMonth, utcWeek,
  utcYear, dayofyear, timeOffset, timeSequence, timeUnitSpecifier, timeUnits,
  utcdayofyear, utcOffset, utcSequence, utcweek, week,
  type TimeInterval,
} from './time.js'

const vectorsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'testdata', 'vectors')

interface VectorFile {
  suites: Record<string, Suite>
}
interface Suite {
  oracle: string
  kind?: 'fn' | 'accessor' | 'color' | 'apply1' | 'interval'
  tz?: string
  cases: Array<{ args: unknown[]; want: unknown }>
}

/** Tagged value -> the runtime value it stood for (mirror of the generator's `enc`). */
function dec(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(dec)
  const tag = (v as Record<string, unknown>)['$']
  switch (tag) {
    case 'undef': return undefined
    case 'nan': return NaN
    case 'inf': return Infinity
    case '-inf': return -Infinity
    case '-0': return -0
    case 'date': return new Date((v as { ms: number }).ms)
    case 're': return new RegExp((v as { src: string }).src, (v as { flags: string }).flags)
    case 'symbol': return Symbol((v as { desc: string }).desc)
    case 'int8array': return new Int8Array(1)
    case 'fn': return () => 1
    default: {
      const o: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = dec(val)
      return o
    }
  }
}

/** Runtime value -> tagged form, so comparisons are exact (NaN, -0, Date, throw). */
function enc(v: unknown): unknown {
  if (v === undefined) return { $: 'undef' }
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $: 'nan' }
    if (v === Infinity) return { $: 'inf' }
    if (v === -Infinity) return { $: '-inf' }
    if (v === 0 && 1 / v < 0) return { $: '-0' }
    return v
  }
  if (v instanceof Date) return { $: 'date', ms: v.getTime() }
  if (v instanceof RegExp) return { $: 're', src: v.source, flags: v.flags }
  if (Array.isArray(v)) return v.map(enc)
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) o[k] = enc((v as Record<string, unknown>)[k])
    return o
  }
  return v
}

/** Call fn, capturing a throw as the tagged value the vectors record. */
function call(fn: (...args: never[]) => unknown, args: unknown[]): unknown {
  try {
    return (fn as (...a: unknown[]) => unknown)(...args)
  } catch (err) {
    return { $: 'throw', name: (err as Error).name, message: (err as Error).message }
  }
}

// --- suite kinds -------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
const fns: Record<string, (...args: any[]) => any> = {
  toBoolean, toDate, toNumber, toString, isArray, isBoolean, isDate, isNumber,
  isObject, isRegExp, isString, extent, ascending, pluck,
  timeOffset, utcOffset, timeSequence, utcSequence, dayofyear, utcdayofyear,
  week, utcweek, timeUnitSpecifier, timeUnits, timeFloor, utcFloor,
}

const accessorFactories: Record<string, (...args: any[]) => any> = { field }

const colorFactories: Record<string, (...args: any[]) => any> = {
  parse: color, color, rgb, hsl, lab, hcl, gray, lch,
}

/** The d3-time interval names the suites reference, mapped to the port. */
const intervals: Record<string, TimeInterval> = {
  timeMillisecond: millisecond, timeSecond: second,
  timeMinute, timeHour, timeDay, timeWeek, timeMonth, timeYear,
  utcMillisecond: millisecond, utcSecond: second,
  utcMinute, utcHour, utcDay, utcWeek, utcMonth, utcYear,
}

function colorFields(c: unknown): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const k of Object.keys(c as object)) o[k] = enc((c as Record<string, unknown>)[k])
  return o
}

function proj(c: unknown): unknown {
  if (c == null) return c
  const o = c as any
  return {
    type: o.constructor.name,
    fields: colorFields(c),
    formatRgb: o.formatRgb(),
    formatHex: o.formatHex(),
    formatHex8: o.formatHex8(),
    formatHsl: o.formatHsl(),
    displayable: o.displayable(),
    brighter: colorFields(o.brighter()),
    brighter2: colorFields(o.brighter(2)),
    darker: colorFields(o.darker()),
    clamp: o.clamp ? colorFields(o.clamp()) : null,
    rgb: colorFields(o.rgb()),
  }
}

function expectSuite(name: string, suite: Suite, run: (args: unknown[], want: unknown) => void): void {
  describe(name, () => {
    it(`matches ${suite.oracle} (${suite.cases.length} cases)`, () => {
      // The suite records the zone it was pinned to (local-time behaviour,
      // DST transitions); Node re-reads process.env.TZ per call.
      if (suite.tz) process.env.TZ = suite.tz
      for (const { args, want } of suite.cases) run(args.map(dec), want)
    })
  })
}

// --- load every vector file and replay by kind -------------------------------

const files = readdirSync(vectorsDir).filter((f) => f.endsWith('.json')).sort()
expect(files.length).toBeGreaterThan(0)

for (const file of files) {
  const { suites } = JSON.parse(readFileSync(join(vectorsDir, file), 'utf8')) as VectorFile

  describe(`oracle vectors: ${file}`, () => {
    for (const [name, suite] of Object.entries(suites)) {
      if (suite.kind === 'color') {
        const factory = colorFactories[name]
        if (!factory) throw new Error(`no port for color suite "${name}"`)
        expectSuite(name, suite, (args, want) => {
          expect(enc(proj(call(factory, args)))).toEqual(want)
        })
        continue
      }
      if (suite.kind === 'interval') {
        expectSuite(name, suite, (args, want) => {
          const [unit, op, a, b] = args as [string, string, Date, number]
          const ival = intervals[unit]
          if (!ival) throw new Error(`no interval "${unit}"`)
          let got: unknown
          switch (op) {
            case 'floor': got = ival.floor(a); break
            case 'ceil': got = ival.ceil(a); break
            case 'round': got = ival.round(a); break
            case 'offset': got = ival.offset(a, b); break
            case 'count': got = ival.count!(a, b); break
            case 'range': got = ival.range(a, b); break
            case 'every3_range': got = ival.every!(3)!.range(a, b); break
            default: throw new Error(`unsupported interval op "${op}"`)
          }
          expect(enc(got)).toEqual(want)
        })
        continue
      }
      if (suite.kind === 'apply1') {
        const fn = fns[name]
        if (!fn) throw new Error(`no port for apply1 suite "${name}"`)
        expectSuite(name, suite, (args, want) => {
          // build with all but the last arg, apply to the last
          const built = (fn as (...a: any[]) => any)(...args.slice(0, -1))
          expect(enc(call(built as (...a: never[]) => unknown, [args[args.length - 1]]))).toEqual(want)
        })
        continue
      }
      if (suite.kind === 'accessor') {
        const factory = accessorFactories[name]
        if (!factory) throw new Error(`no port for accessor suite "${name}"`)
        expectSuite(`${name} (accessor factory)`, suite, (args, want) => {
          const got = call(factory, args)
          const thrown = got !== null && typeof got === 'object' && (got as { $?: string }).$ === 'throw'
          if (thrown) {
            // malformed path: the factory itself threw, as recorded
            expect(enc(got)).toEqual(want)
            return
          }
          // rebuild the recorded shape: reported fields/name + value on the datum
          const f = got as Accessor
          const datum = (want as { on: unknown }).on
          const value = call(f as (...a: never[]) => unknown, [dec(datum)])
          expect(enc({ fields: f.fields, fname: f.fname, on: datum, value })).toEqual(want)
        })
        continue
      }
      const fn = fns[name]
      if (!fn) throw new Error(`no port for vector suite "${name}"`)
      expectSuite(name, suite, (args, want) => {
        expect(enc(call(fn, args))).toEqual(want)
      })
    }
  })
}

describe('vector codec self-check', () => {
  it('enc/dec round-trips the tagged values the suites rely on', () => {
    const samples = [NaN, Infinity, -Infinity, -0, undefined, new Date(42), /a/g, Symbol('s')]
    for (const v of samples) {
      expect(dec(enc(v))).toEqual(v)
    }
    // NaN and -0 need Object.is semantics
    expect(Number.isNaN(dec(enc(NaN)))).toBe(true)
    expect(Object.is(dec(enc(-0)), -0)).toBe(true)
  })
})

describe('accessor helpers (not vector-representable)', () => {
  it('accessor attaches fields and name without changing behaviour', () => {
    const fn = (d: unknown) => (d as { v: number }).v * 2
    const a = accessor(fn, ['v'], 'twice v')
    expect(a({ v: 3 })).toBe(6)
    expect(accessorFields(a)).toEqual(['v'])
    expect(accessorName(a)).toBe('twice v')
  })

  it('accessor defaults fields to [] and name to undefined', () => {
    const a = accessor((d: unknown) => d)
    expect(accessorFields(a)).toEqual([])
    expect(accessorName(a)).toBeNull()
  })

  it('accessorName/Fields are null for non-accessors', () => {
    expect(accessorName(null)).toBeNull()
    expect(accessorFields(undefined)).toBeNull()
  })

  it('extent honours an accessor the same way it honours values', () => {
    expect(extent([{ v: 3 }, { v: 1 }, { v: 2 }], (d) => (d as { v: number }).v)).toEqual([1, 3])
    expect(extent([{ v: null }, { v: 2 }], (d) => (d as { v: number | null }).v)).toEqual([2, 2])
  })

  it('field accessors keep the oracle fields contract across path shapes', () => {
    expect(accessorFields(field('a'))).toEqual(['a'])
    expect(accessorFields(field('a.b'))).toEqual(['a.b'])
    expect(accessorName(field('a', 'named'))).toBe('named')
  })
})
