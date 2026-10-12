/**
 * Replay of the oracle vectors recorded from the pinned upstream packages
 * (`packages/conformance/scripts/gen-vectors.mjs` -> `testdata/vectors/`).
 *
 * Every suite asserts the port's output matches the oracle's exactly —
 * including `NaN`, `-0`, `undefined`, thrown errors and `Date` identity —
 * which is what licenses dropping the upstream dependency.
 */
import { readFileSync } from 'node:fs'
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

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, '..', 'testdata', 'vectors', 'vega-util.json')
const { suites } = JSON.parse(readFileSync(file, 'utf8')) as VectorFile

interface VectorFile {
  suites: Record<string, Suite>
}
interface Suite {
  oracle: string
  kind?: string
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

/** Call the port, capturing a throw as the tagged value the vectors record. */
function call(fn: (...args: any[]) => any, args: unknown[]): unknown {
  try {
    return fn(...args)
  } catch (err) {
    return { $: 'throw', name: (err as Error).name }
  }
}

// A dispatch table across differently-typed oracle surfaces; the vector
// replay calls each through the tagged-value codec, so the signatures meet here.
/* eslint-disable @typescript-eslint/no-explicit-any */
const fns: Record<string, (...args: any[]) => any> = {
  toBoolean, toDate, toNumber, toString, isArray, isBoolean, isDate, isNumber,
  isObject, isRegExp, isString, extent, ascending, pluck,
}

describe('vega-util oracle vectors', () => {
  for (const [name, suite] of Object.entries(suites)) {
    if (suite.kind === 'accessor') {
      describe(`${name} (accessor factory)`, () => {
        it(`matches ${suite.oracle}`, () => {
          const factory = name === 'field' ? field : accessor
          for (const { args, want } of suite.cases) {
            const decoded = args.map((a) => dec(a) as never)
            const got = call(factory as (...a: any[]) => any, decoded)
            const thrown = got !== null && typeof got === 'object' && (got as { $?: string }).$ === 'throw'
            if (thrown) {
              // malformed path: the factory itself threw, as recorded
              expect(enc(got)).toEqual(want)
              continue
            }
            // rebuild the recorded shape: reported fields/name + value on the datum
            const f = got as Accessor
            const datum = (want as { on: unknown }).on
            const value = call(f, [dec(datum)])
            expect(enc({ fields: f.fields, fname: f.fname, on: datum, value })).toEqual(want)
          }
        })
      })
      continue
    }
    const fn = fns[name]
    if (!fn) throw new Error(`no port for vector suite "${name}"`)
    describe(name, () => {
      it(`matches ${suite.oracle} (${suite.cases.length} cases)`, () => {
        for (const { args, want } of suite.cases) {
          const decoded = args.map(dec)
          expect(enc(call(fn, decoded))).toEqual(want)
        }
      })
    })
  }
})

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

  it('covers every suite the file ships (no silent skips)', () => {
    expect(Object.keys(suites).sort()).toEqual([
      'ascending', 'field', 'isArray', 'isBoolean', 'isDate', 'isNumber',
      'isObject', 'isRegExp', 'isString', 'pluck', 'extent', 'toBoolean',
      'toDate', 'toNumber', 'toString',
    ].sort())
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
