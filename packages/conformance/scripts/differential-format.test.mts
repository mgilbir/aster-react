/**
 * GENERATED live differential of number formatting: Aster's `format.ts` and the number half of `locale.ts` against the
 * pinned d3-format and vega-format in one process, over the whole specifier grammar, the awkward numbers (-0, NaN,
 * +-Infinity, huge, tiny, rounding ties, non-numbers) and generated locales (separators, grouping, numerals, currency,
 * minus, nan, percent; some of them malformed).
 *
 * The recorded vectors (`packages/core/testdata/vectors/d3-format.json`, `vega-format.json`) pin a few hundred
 * cases; this draws thousands more from seeded generators (see `differential-gen.mts`).
 */
import * as d3a from 'd3-array'
import * as d3 from 'd3-format'
import * as vf from 'vega-format'
import { describe, expect, it, vi } from 'vitest'
import {
  format as asterFormat, formatLocale, formatPrefix as asterFormatPrefix, formatSpecifier as asterSpecifier,
  precisionFixed, precisionPrefix, precisionRound, tickStep,
} from '../../core/src/format.ts'
import { locale as asterLocale, numberFormatLocale as asterNumberLocale } from '../../core/src/locale.ts'
import { compareCases, makeRng, scaled, type Rng } from './differential-gen.mts'

vi.setConfig({ testTimeout: 60_000 })

// --- generators --------------------------------------------------------------

const FILLS = [' ', '0', '*', '_', '-', '.', '€', '~', '%', ',', '\u{1F600}']
const SPEC_TYPES = ['', '', 'e', 'f', 'g', 'r', 's', '%', 'p', 'b', 'o', 'd', 'x', 'X', 'c', 'n', 'a', 'z', 'E', 'F', 'S', 'y']

/** A specifier from the grammar `[[fill]align][sign][symbol][0][width][,][.precision][~][type]`. */
function genSpecifier(r: Rng): string {
  const align = r.pick(['', '', '<', '>', '=', '^'])
  return (align ? r.pick(FILLS) + align : '')
    + r.pick(['', '', '+', '-', '(', ' '])
    + r.pick(['', '', '$', '#'])
    + r.pick(['', '', '0'])
    + r.pick(['', '', '1', '5', '12', '30', '100'])
    + r.pick(['', '', ',', ','])
    + r.pick(['', '', '.0', '.1', '.2', '.3', '.6', '.12', '.20', '.21', '.30', '.99'])
    + r.pick(['', '', '~'])
    + r.pick(SPEC_TYPES)
}

/** Mostly-valid text near the grammar: characters of every role, in any order. */
function genSpecifierSoup(r: Rng): string {
  return r.text(['<', '>', '=', '^', '+', '-', '(', ' ', '$', '#', '0', '1', '9', ',', '.', '~', 'd', 'f', 's', '%', 'x', 'q', 'é', '\n', ')'], 0, 9)
}

const SPECIAL_NUMBERS = [
  0, -0, 1, -1, 0.5, -0.5, 1.5, 2.5, 0.05, 0.005, 1e-7, -1e-7, 123456.789, -1234567.891, 999999.5, 0.1 + 0.2,
  1e21, -1e21, 1e21 - 1e5, 1e22, 123456789012345680000, 1e100, -1e100, 1.7976931348623157e308, 5e-324, 2.2250738585072014e-308,
  1e-300, 1e-10, 9.995, 99.995, 0.99995, 1e3, 1e6, 1e9, 999.9999, 12345678, 2 ** 53, 2 ** 31, -(2 ** 31),
  NaN, Infinity, -Infinity, 42, -42.5, 7, 255, 65535,
]
const ODD_VALUES: unknown[] = ['12', '', ' ', 'abc', '0x10', '1e3', null, undefined, true, false, [], [5], [1, 2], {}, new Date(86400000), 10n, '-0']

function genValue(r: Rng): unknown {
  const k = r.int(10)
  if (k < 4) return r.pick(SPECIAL_NUMBERS)
  if (k < 5) return r.pick(ODD_VALUES)
  if (k < 7) return (r.next() - 0.5) * 10 ** r.between(-12, 25)
  if (k < 8) return r.between(-100000, 100000) / 10 ** r.between(0, 6)
  if (k < 9) return Math.round((r.next() - 0.5) * 2000) / 8
  return r.pick([1, -1]) * 10 ** r.between(-9, 24) * r.pick([1, 1.5, 9.99, 9.995, 5, 0.1])
}

const DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩']

/** A locale definition for d3-format and vega-format: every field present, absent, or (rarely) malformed. */
function genNumberLocale(r: Rng): Record<string, unknown> {
  const def: Record<string, unknown> = {}
  const set = (key: string, options: unknown[]) => {
    const v = r.pick(options)
    if (v !== undefined) def[key] = v
  }
  set('decimal', ['.', ',', '·', '٫', '', '.', undefined])
  set('thousands', [',', '.', ' ', ' ', '', "'", undefined, ','])
  set('grouping', [[3], [3], [3, 2], [2], [1], [0], [4, 3, 2], ['3'], ['3', '2'], [], [3, 0], undefined])
  set('currency', [['$', ''], ['', '€'], ['US$', ' USD'], ['', ''], ['£'], undefined, 'ab', ['$', '']])
  set('numerals', [undefined, undefined, DIGITS, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']])
  set('percent', [undefined, '%', ' %', '‰', ''])
  set('minus', [undefined, '-', '−', '–', '', '− '])
  set('nan', [undefined, 'NaN', 'n/a', '', '—'])
  if (r.chance(0.04)) {
    const [k, v] = r.pick<[string, unknown]>([
      ['grouping', 5], ['grouping', 'abc'], ['numerals', 'abc'], ['numerals', 5], ['currency', null], ['thousands', 5],
      ['decimal', null], ['grouping', null], ['percent', null], ['minus', null], ['nan', null], ['currency', 5], ['currency', []],
    ])
    def[k] = v
  }
  return def
}

const show = (v: unknown): string =>
  typeof v === 'bigint' ? `${v}n` : Object.is(v, -0) ? '-0' : typeof v === 'string' ? JSON.stringify(v) : v instanceof Date ? `Date(${+v})` : Array.isArray(v) ? `[${v.map(String)}]` : String(v)

const fields = (s: { fill: unknown; align: unknown; sign: unknown; symbol: unknown; zero: unknown; width: unknown; comma: unknown; precision: unknown; trim: unknown; type: unknown; toString(): string }) =>
  ({ fill: s.fill, align: s.align, sign: s.sign, symbol: s.symbol, zero: s.zero, width: s.width, comma: s.comma, precision: s.precision, trim: s.trim, type: s.type, str: s.toString() })

// --- d3-format ---------------------------------------------------------------

describe('number format vs d3-format (generated, live)', () => {
  it('format(specifier)(value) over the whole grammar', () => {
    const r = makeRng(0xf0a1)
    const stats = compareCases('format', scaled(24000), () => {
      const spec = genSpecifier(r)
      const values = [genValue(r), genValue(r), genValue(r)]
      return {
        label: `${JSON.stringify(spec)} ${values.map(show).join(' | ')}`,
        oracle: () => { const f = d3.format(spec); return [f.toString(), ...values.map((v) => f(v))] },
        aster: () => { const f = asterFormat(spec); return [f.toString(), ...values.map((v) => f(v))] },
      }
    })
    expect(stats.refused).toBeLessThan(stats.cases * 0.2)
  })

  it('refuses malformed specifiers with the same message', () => {
    const r = makeRng(0xf0a2)
    const stats = compareCases('format(soup)', scaled(6000), () => {
      const spec = genSpecifierSoup(r)
      const v = genValue(r)
      return { label: JSON.stringify(spec), oracle: () => d3.format(spec)(v), aster: () => asterFormat(spec)(v) }
    })
    expect(stats.refused).toBeGreaterThan(100)
    expect(stats.refused).toBeLessThan(stats.cases)
  })

  it('accepts what String() makes of a non-string specifier', () => {
    const odd: unknown[] = [undefined, null, 5, 0, true, {}, [], ['d'], ',.2f', { toString: () => '.3s' }, d3.formatSpecifier('+.2%'), { toString: () => 5 }]
    compareCases('format(non-string)', odd.length, (i) => ({
      label: show(odd[i]),
      oracle: () => d3.format(odd[i] as string)(1234.5678),
      aster: () => asterFormat(odd[i])(1234.5678),
    }))
  })

  it('formatSpecifier: every field and the string form', () => {
    const r = makeRng(0xf0a3)
    compareCases('formatSpecifier', scaled(8000), () => {
      const spec = r.chance(0.3) ? genSpecifierSoup(r) : genSpecifier(r)
      return {
        label: JSON.stringify(spec),
        oracle: () => fields(d3.formatSpecifier(spec)),
        aster: () => fields(asterSpecifier(spec)),
      }
    })
  })

  it('formatPrefix(specifier, reference)(value)', () => {
    const r = makeRng(0xf0a4)
    compareCases('formatPrefix', scaled(8000), () => {
      const spec = r.pick(['', '.2', ',.3', '$.1', '08', '+', '(', '^20', '*>12', '.0', '~', ',', '#', 'x', 'garbage!']) + r.pick(['f', 's', 'e', '', 'd', '%', 'g', 'r', 'p'])
      const ref = r.pick([0, 1e3, 1e-6, 1e9, 123, -1e4, 5e-324, 1e300, NaN, Infinity, 0.5, 999999, 1e24, 1e-30]) * r.pick([1, 1, 3.7, -1])
      const values = [genValue(r), genValue(r)]
      return {
        label: `${JSON.stringify(spec)} ref ${ref} ${values.map(show).join(' | ')}`,
        oracle: () => { const f = d3.formatPrefix(spec, ref); return values.map((v) => f(v)) },
        aster: () => { const f = asterFormatPrefix(spec, ref); return values.map((v) => f(v)) },
      }
    })
  })

  it('precisionFixed, precisionPrefix, precisionRound', () => {
    const r = makeRng(0xf0a5)
    const steps = (): unknown => r.chance(0.12) ? r.pick([NaN, Infinity, -Infinity, 0, -0, '0.5', null, undefined, 1e-320, 1e308]) : r.pick([1, -1]) * 10 ** r.between(-18, 18) * r.pick([1, 2, 2.5, 5, 7.3, 9.99])
    compareCases('precision*', scaled(9000), () => {
      const step = steps() as number
      const value = steps() as number
      return {
        label: `${show(step)} ${show(value)}`,
        oracle: () => [d3.precisionFixed(step), d3.precisionPrefix(step, value), d3.precisionRound(step, value)],
        aster: () => [precisionFixed(step), precisionPrefix(step, value), precisionRound(step, value)],
      }
    })
  })

  it('tickStep, the step formatSpan and timeBin are built on', () => {
    const r = makeRng(0xf0a7)
    compareCases('tickStep', scaled(12000), () => {
      const start = r.pick([0, 1, -3.3, 1e-9, 12, 1000, 0.25, -250, 1e6, 147471 / 31536000000, 1.7e12 / 31536000000, NaN, Infinity]) + (r.chance(0.3) ? r.next() : 0)
      const stop = start + r.pick([0, 1, 7, 100, 1e5, 0.001, -4, 1e-7, 12960000147471 / 31536000000, 3.3, 41, 1e9, NaN])
      const count = r.pick([0, 0.4, 0.5, 0.75, 1, 1.5, 1.99, 2, 2.5, 3, 5, 10, 20, 40, 100, 1000, -1, NaN, Infinity, '5', null])
      return {
        label: `${start} ${stop} ${String(count)}`,
        oracle: () => d3a.tickStep(start, stop, count as number),
        aster: () => tickStep(start, stop, count as number),
      }
    })
  })

  it('formatLocale(definition): format and formatPrefix', () => {
    const r = makeRng(0xf0a6)
    compareCases('formatLocale', scaled(16000), () => {
      const def = genNumberLocale(r)
      const spec = genSpecifier(r)
      const values = [genValue(r), genValue(r)]
      const ref = r.pick([1, 1e3, 1e-6, 1e6, 12345])
      return {
        label: `${JSON.stringify(def)} ${JSON.stringify(spec)} ${values.map(show).join(' | ')}`,
        oracle: () => {
          const l = d3.formatLocale(def)
          return [values.map((v) => l.format(spec)(v)), values.map((v) => l.formatPrefix(spec, ref)(v))]
        },
        aster: () => {
          const l = formatLocale(def)
          return [values.map((v) => l.format(spec)(v)), values.map((v) => l.formatPrefix(spec, ref)(v))]
        },
      }
    })
  })

  it('formatDefaultLocale replaces the module-level format and formatPrefix', async () => {
    const aster = await import('../../core/src/format.ts')
    const def = { decimal: ',', thousands: '.', grouping: [3], currency: ['', ' €'], minus: '-' }
    try {
      d3.formatDefaultLocale(def)
      aster.formatDefaultLocale(def)
      for (const spec of ['$,.2f', ',.0f', '.3s', '+,d', '%']) {
        for (const v of [1234567.891, -0.5, 0, NaN]) {
          expect(aster.format(spec)(v), `${spec} ${v}`).toBe(d3.format(spec)(v))
          expect(aster.formatPrefix(spec, 1e3)(v), `prefix ${spec} ${v}`).toBe(d3.formatPrefix(spec, 1e3)(v))
        }
      }
    } finally {
      d3.formatDefaultLocale({ thousands: ',', grouping: [3], currency: ['$', ''] })
      aster.formatDefaultLocale({ thousands: ',', grouping: [3], currency: ['$', ''] })
    }
  })
})

// --- vega-format -------------------------------------------------------------

const FLOAT_SPECS = [undefined, null, '', ',', 'f', '.2f', ',.3f', '%', '.1%', 'e', '.3e', 's', '.2s', 'd', '$', '$,', 'r', 'g', 'p', '+', '(,', '~f', '0>8,f', '^20', 'x', 'garbage!']
const SPAN_SPECS = [undefined, null, ',f', 'f', 's', 'e', 'g', 'p', 'r', '%', '', '.2f', '$s', '.3e', ',d', '+', 'x', 'bogus?']

describe('number locale (vega-format) vs the pinned vega-format (generated, live)', () => {
  it('format, formatPrefix, formatFloat and formatSpan of a locale', () => {
    const r = makeRng(0xf0b1)
    compareCases('vega-format number locale', scaled(10000), () => {
      const def = r.chance(0.2) ? undefined : genNumberLocale(r)
      const kind = r.int(4)
      const spec = kind === 3 ? r.pick(SPAN_SPECS) : r.chance(0.5) ? r.pick(FLOAT_SPECS) : genSpecifier(r)
      const values = [genValue(r), genValue(r)]
      const a = r.pick([0, 1, -3.3, 1e-9, 12, 1000, 0.25, -250, 1e6])
      const b = a + r.pick([0, 1, 7, 100, 1e5, 0.001, -4, 1e-7])
      const count = r.pick([0, 1, 2, 5, 10, 20, 100, NaN])
      const run = (loc: typeof vf.locale) => {
        const l = loc(def as never)
        switch (kind) {
          case 0: return values.map((v) => l.format(spec as string)(v))
          case 1: return values.map((v) => l.formatPrefix(spec as string, a)(v))
          case 2: return values.map((v) => l.formatFloat(spec as string)(v))
          default: return values.map((v) => l.formatSpan(a, b, count, spec as string)(v))
        }
      }
      return {
        label: `kind ${kind} ${JSON.stringify(def)} ${JSON.stringify(spec)} a=${a} b=${b} count=${count} ${values.map(show).join(' | ')}`,
        oracle: () => run(vf.locale as never),
        aster: () => run(asterLocale as never),
      }
    })
  })

  it('numberFormatLocale, and the memoised formatters: same function for the same specifier', () => {
    const def = { decimal: ',', thousands: '.', grouping: [3] }
    const o = vf.numberFormatLocale(def)
    const a = asterNumberLocale(def)
    for (const s of ['.2f', ',d', 's', '$,.2f']) {
      expect(o.format(s) === o.format(s)).toBe(true)
      expect(a.format(s) === a.format(s), s).toBe(true)
      expect(String(a.format(s)), s).toBe(String(o.format(s)))
    }
    for (const s of ['.2f', ',.3f', '%']) expect(a.formatFloat(s) === a.formatFloat(s), `formatFloat ${s}`).toBe(o.formatFloat(s) === o.formatFloat(s))
    expect(a.formatFloat(undefined) === a.formatFloat(undefined)).toBe(o.formatFloat(undefined) === o.formatFloat(undefined))
  })

  it('numberFormatDefaultLocale / defaultLocale / resetDefaultLocale', async () => {
    const aster = await import('../../core/src/locale.ts')
    const num = { decimal: ',', thousands: ' ', grouping: [3], currency: ['', ' kr'] }
    const time = { dateTime: '%A %c', date: '%d.%m.%Y', time: '%H.%M', periods: ['fm', 'em'], days: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], shortDays: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], months: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'], shortMonths: ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'] }
    const probe = (l: { format(s: string): (v: number) => string; timeFormat(s: string): (d: Date) => string; utcParse(s: string): (t: string) => Date | null }) =>
      [l.format('$,.2f')(1234567.891), l.format('~s')(0.00012), l.timeFormat('%a %b %d')(new Date(Date.UTC(2024, 2, 9, 12))), +(l.utcParse('%d.%m.%Y')('09.03.2024') ?? 0)]
    try {
      expect(() => aster.defaultLocale(num as never)).toThrow('defaultLocale expects either zero or two arguments.')
      expect(() => vf.defaultLocale(num as never)).toThrow('defaultLocale expects either zero or two arguments.')
      const want = probe(vf.defaultLocale(num as never, { ...time, dateTime: '%A' } as never) as never)
      expect(probe(aster.defaultLocale(num as never, { ...time, dateTime: '%A' } as never) as never)).toEqual(want)
      expect(probe(aster.locale() as never)).toEqual(probe(vf.locale() as never))
      expect(probe(aster.currentLocale() as never)).toEqual(want)
      const reset = probe(vf.resetDefaultLocale() as never)
      expect(probe(aster.resetDefaultLocale() as never)).toEqual(reset)
      expect(probe(aster.currentLocale() as never)).toEqual(reset)
      vf.numberFormatDefaultLocale(num as never)
      aster.numberFormatDefaultLocale(num as never)
      expect(probe(aster.locale() as never)).toEqual(probe(vf.locale() as never))
    } finally {
      vf.resetDefaultLocale()
      aster.resetDefaultLocale()
    }
  })
})
