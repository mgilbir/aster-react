/**
 * GENERATED live differential of the expression ENGINE: random expressions over the engine's own function table (the number and
 * time formats, math, strings, sequences, type tests...), evaluated per row by real Vega (a `formula` transform in a View) and by
 * Aster (the same spec through `compileChart` / `evaluateChart`), in this process.
 *
 * `differential-vega-interpreter-gen` holds the language core (operators, members, the sandbox) through vega-interpreter's entry
 * points and its small default table. This one holds what the engine adds on top: the functions a spec calls most (`format`,
 * `timeFormat`, `utcFormat` with literal and per-row specifiers, every arity of the variadic built-ins), signals read by their
 * own names, datum paths, and object literals shaped like a tooltip; each compiled expression is evaluated over many rows, so a
 * call site sees a sequence of different values, specifiers and types.
 *
 * Also held: a compiled expression follows a change of the default locale between two evaluations (anything an evaluation keeps
 * for the next one must miss when the locale changes), and a locale change between Views.
 *
 * What is compared, strictly: every row's result (NaN, -0, undefined, Dates, key order of objects aside: see `enc`), or, when the
 * expression throws, that both sides report an error with the same message (a TypeError by its class only: its V8 wording quotes
 * source text, which differs between vega's generated code and Aster's closures).
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, compileExpr, datasetsOfScene, defaultLocale, evaluateChart, resetDefaultLocale } from '@aster-charts/core'
import { enc, withTz } from './differential-util.mts'
import { makeRng, scaled, type Rng } from './differential-gen.mts'

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- the generator --------------------------------------------------------------------------------

const FILLS = [' ', '0', '*', '_', '€']
const NUM_TYPES = ['', '', 'e', 'f', 'f', 'g', 'r', 's', 's', '%', 'p', 'b', 'o', 'd', 'x', 'X', 'c', 'n', 'a', 'z']

/** A number specifier from the grammar `[[fill]align][sign][symbol][0][width][,][.precision][~][type]`; rarely a malformed one. */
function numSpec(r: Rng): string {
  if (r.chance(0.03)) return r.pick(['.3.f', 'q', '%%', ',,', '1.2.3', '~~'])
  const align = r.pick(['', '', '', '<', '>', '=', '^'])
  return (align ? r.pick(FILLS) + align : '')
    + r.pick(['', '', '', '+', '-', '(', ' '])
    + r.pick(['', '', '', '$', '#'])
    + r.pick(['', '', '0'])
    + r.pick(['', '', '', '1', '8', '12'])
    + r.pick(['', '', ','])
    + r.pick(['', '', '.0', '.1', '.2', '.3', '.6', '.12'])
    + r.pick(['', '', '~'])
    + r.pick(NUM_TYPES)
}

const TIME_DIRECTIVES = 'aAbBcdeFfgGHIjLmMpqQsSuUVwWxXyYZ%'.split('')
function timeSpec(r: Rng): string {
  let out = ''
  for (let i = 0, n = r.between(1, 4); i < n; i++) {
    out += r.chance(0.25) ? r.pick([' ', '-', ':', '/', 'T', ', ']) : '%' + (r.chance(0.2) ? r.pick(['-', '_', '0']) : '') + r.pick(TIME_DIRECTIVES)
  }
  return out
}

const q = (s: string): string => JSON.stringify(s)

/** A rows' worth of values of every kind the formats and functions are called with. */
function mkRows(r: Rng, n: number): Record<string, unknown>[] {
  const num = (): unknown => r.pick<() => unknown>([
    () => r.between(-1000, 1000) / r.pick([1, 3, 7, 1000]),
    () => (r.next() - 0.5) * 10 ** r.between(-9, 22),
    () => r.pick([0, -0, 1, -1, 0.5, 1.5, 2.5, -2.5, 9.995, 0.0005, 1e21, -1e21, 123456.789, NaN, Infinity, -Infinity, 2 ** 53]),
    () => r.pick([null, undefined, '12.5', '', 'abc', true, false]),
  ])()
  return Array.from({ length: n }, (_, i) => ({
    i,
    a: num(), b: num(), 'c d': num(), n: null, u: undefined, z: 0,
    s: r.pick(['abc', 'Hello World', '', ' pad ', 'ünï', '12', 'a,b,c']),
    t: r.pick([Date.UTC(2020, r.int(12), 1 + r.int(28), r.int(24), r.int(60), r.int(60), r.int(1000)), 0, -86400000 * r.int(400), NaN, null]),
    spec: r.chance(0.85) ? numSpec(r) : r.pick(['', null, undefined, 5]),
    tspec: timeSpec(r),
    o: { v: num(), w: { x: num() } },
    arr: [num(), num(), num()],
  }))
}

/**
 * The functions of the engine's table that need nothing from a view (no dataset, scale, event, clock or random source): each is
 * called with any arity and any argument types. Some have items of their own instead: `sequence` and `pad` with small sizes (vega
 * allocates what any size asks for, Aster refuses past its built-in ceilings), `format` with specifiers of a bounded width (the
 * same ceiling), and `length` with text (vega's code generator writes `length(3)` as `3.length`, which is no JavaScript: vega
 * refuses the spec with a SyntaxError of V8's; Aster's tree keeps no literal's source text to tell `3` from `3.0`, and answers
 * `undefined`), and `merge` with plain values only (vega's merge copies inherited enumerable members too, which d3-color's objects
 * have: the methods of `rgb()`; Aster's colours keep their methods off the copy).
 */
const ANY_FUNCTION = [
  'isNaN', 'isFinite', 'abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'cos', 'exp', 'floor', 'hypot', 'log', 'max', 'min', 'pow', 'round',
  'sin', 'sqrt', 'tan', 'clamp', 'if',
  'datetime', 'date', 'day', 'year', 'month', 'hours', 'minutes', 'seconds', 'milliseconds', 'time', 'timezoneoffset', 'utc', 'utcdate',
  'utcday', 'utcyear', 'utcmonth', 'utchours', 'utcminutes', 'utcseconds', 'utcmilliseconds', 'quarter', 'utcquarter', 'week', 'utcweek',
  'dayofyear', 'utcdayofyear',
  'parseFloat', 'parseInt', 'upper', 'lower', 'substring', 'split', 'trim', 'encodeURIComponent', 'regexp', 'test', 'indexof',
  'lastindexof', 'join', 'reverse', 'sort', 'slice', 'peek', 'pluck', 'span', 'inrange', 'truncate', 'replace', 'extent',
  'clampRange', 'lerp',
  'isArray', 'isBoolean', 'isDate', 'isDefined', 'isNumber', 'isObject', 'isRegExp', 'isString', 'isTuple', 'isValid', 'toBoolean',
  'toDate', 'toNumber', 'toString',
  'utcFormat', 'timeFormat', 'timeParse', 'utcParse', 'monthFormat', 'monthAbbrevFormat', 'dayFormat', 'dayAbbrevFormat',
  'rgb', 'lab', 'hcl', 'hsl', 'luminance', 'contrast',
  'panLinear', 'panLog', 'panPow', 'panSymlog', 'zoomLinear', 'zoomLog', 'zoomPow', 'zoomSymlog', 'bandspace',
]

/** An argument of any type. */
const anyLeaf = (r: Rng): string => r.pick([
  'datum.a', 'datum.b', 'datum.n', 'datum.u', 'datum.z', 'datum.s', 'datum.t', 'datum.arr', 'datum.o', 'datum.spec', 'datum.tspec',
  '0', '1', '-2.5', '3', '12', '"a,b"', '"%Y"', '"2020-01-02"', '"abc"', '""', '"steelblue"', '[1, 5]', '[3, 1, 2]', '["b", "a"]', '[]',
  '{a: 1}', 'null', '/a/', 'true', 'sx', 'ss',
])

function gen(r: Rng, depth: number): string {
  const numLeaf = (): string => r.pick<() => string>([
    () => 'datum.a', () => 'datum.b', () => 'datum["c d"]', () => 'datum.n', () => 'datum.u', () => 'datum.z', () => 'datum.o.v',
    () => 'datum.o["w"].x', () => 'datum.arr[1]', () => 'datum["arr"][0]', () => 'sx', () => 'sn', () => 'PI', () => 'datum.i',
    () => String(r.pick([0, 1, 2, 0.5, 10, 1234.5678, 1e6, 0.001])), () => '-' + String(r.pick([1, 3.25, 1e-7])), () => 'NaN',
  ])()
  const strLeaf = (): string => r.pick<() => string>([() => 'datum.s', () => 'ss', () => q(r.pick(['x', 'abc', '', 'A B', '%'])), () => 'datum.spec'])()
  const sub = (): string => (depth > 0 ? gen(r, depth - 1) : r.chance(0.6) ? numLeaf() : strLeaf())
  const num = (): string => (depth > 0 && r.chance(0.35) ? gen(r, depth - 1) : numLeaf())
  const str = (): string => (depth > 0 && r.chance(0.3) ? gen(r, depth - 1) : strLeaf())
  const args = (n: number, a: () => string): string => Array.from({ length: n }, a).join(', ')
  const anyCall = (): string => {
    const name = r.pick(ANY_FUNCTION)
    return `${name}(${args(r.between(name === 'datetime' ? 1 : 0, 4), () => (r.chance(0.3) ? sub() : anyLeaf(r)))})`
  }
  return r.pick<() => string>([
    // the formats: literal, per-row and signal specifiers; time formats over instants and dates
    () => `format(${num()}, ${q(numSpec(r))})`,
    () => `format(${num()}, ${q(numSpec(r))})`,
    () => `format(${num()}, datum.spec)`,
    () => `format(${num()}, sspec)`,
    () => `format(${num()})`,
    () => `${r.pick(['timeFormat', 'utcFormat'])}(${r.pick(['datum.t', 'datum.a', 'datetime(2021, 5, 6, 7)', 'datum.n', num()])}, ${q(timeSpec(r))})`,
    () => `${r.pick(['timeFormat', 'utcFormat'])}(datum.t, datum.tspec)`,
    () => `utcFormat(datum.t, {year: "%Y", month: "%b", date: "%d", hours: "%H"})`,
    // tooltip-shaped object literals
    () => `{${Array.from({ length: r.between(1, 7) }, (_, k) => `${r.chance(0.5) ? `"k ${k}"` : `k${k}`}: ${r.chance(0.7) ? `format(${numLeaf()}, ${q(numSpec(r))})` : sub()}`).join(', ')}}`,
    () => `[${args(r.between(0, 4), sub)}]`,
    // operators and control flow
    () => `${num()} ${r.pick(['+', '-', '*', '/', '%', '<', '>=', '===', '==', '&&', '||'])} ${num()}`,
    () => `${sub()} ? ${sub()} : ${sub()}`,
    () => `if(${sub()}, ${sub()}, ${sub()})`,
    () => `!${sub()}`,
    () => `-${num()}`,
    // any function of the table, any arity, arguments of any type (`datetime()` with none is the clock, which no two runs share)
    () => anyCall(),
    () => anyCall(),
    // calls vega writes as a method of their first argument: what follows it is never evaluated (nor refused when unknown)
    () => `${r.pick(['upper', 'lower', 'trim', 'year', 'utcdate', 'time', 'length'])}(${r.pick(['datum.s', 'ss'])}, ${r.pick(['datum.n.x', 'foo()', 'nosuch', 'sqrt(datum.n.x)', sub()])})`,
    // variadic and fixed-arity built-ins, every arity
    () => `${r.pick(['max', 'min', 'hypot'])}(${args(r.between(0, 5), num)})`,
    () => `${r.pick(['abs', 'round', 'floor', 'ceil', 'sqrt', 'log', 'exp', 'sin', 'toNumber', 'isValid', 'isNumber', 'isString', 'isDefined', 'toString', 'toBoolean'])}(${sub()})`,
    () => `${r.pick(['pow', 'atan2'])}(${num()}, ${num()})`,
    () => `clamp(${num()}, ${num()}, ${num()})`,
    // the order the arguments are evaluated in: the first to throw names its own specifier (vega reads clamp's `lo`, `hi`, then `v`)
    () => `clamp(${args(3, () => r.pick(['format(1, "a!")', 'format(1, "b!")', 'format(1, "c!")', 'datum.a', 'sx']))})`,
    () => `${r.pick(['upper', 'lower', 'trim', 'length'])}(${str()})`,
    () => `substring(${str()}, ${r.int(4)}${r.chance(0.5) ? `, ${r.int(6)}` : ''})`,
    () => `pad(${str()}, ${r.int(12)}, ${q(r.pick(['*', ' ', '0']))}, ${q(r.pick(['left', 'right', 'center']))})`,
    () => `pad(${r.pick(['datum.s', 'datum.a', 'datum.n', 'ss'])}, ${r.pick(['0', '3', '7.5', '12', 'datum.z', '"9"'])}, ${r.pick(['5', '0', 'null', '""', '"ab"', '[1]', 'true', 'datum.u'])}${r.chance(0.5) ? `, ${r.pick(['"left"', '"center"', 'null'])}` : ''})`,
    () => `truncate(${str()}, ${r.int(8)}, ${q(r.pick(['left', 'right', 'center']))})`,
    () => `replace(${str()}, ${q(r.pick(['a', 'l', ' ']))}, ${q(r.pick(['', 'Z']))})`,
    () => `indexof(${str()}, ${q(r.pick(['a', 'b', '']))})`,
    () => `join([${args(r.between(0, 3), sub)}], ${q(r.pick([',', ' - ', '']))})`,
    () => `peek(datum.arr) + ${num()}`,
    () => `merge(${args(r.between(0, 3), () => r.pick(['datum.o', 'datum.arr', '{a: 1, b: datum.s}', 'ss', 'null', '[1, 2]', 'datum.o.w']))})`,
    () => `extent(datum.arr)`,
    () => `length(sequence(${r.int(5)}, ${r.int(9)}))`,
    () => `test(${r.pick(['/a/', '/^\\d+$/', '/l+/i'])}, ${str()})`,
    () => `split(${str()}, ${q(r.pick([',', ' ', '']))})`,
    () => `${r.pick(['year', 'utcmonth', 'date', 'hours', 'quarter', 'utcweek', 'dayofyear'])}(${r.pick(['datum.t', 'datum.a', 'datum.n'])})`,
    () => `inrange(${num()}, [${num()}, ${num()}])`,
    // member reads off computed values
    () => `({v: ${sub()}, w: ${sub()}}).${r.pick(['v', 'w', 'x'])}`,
    () => `[${sub()}, ${sub()}][${r.int(3)}]`,
  ])()
}

// --- the two sides ----------------------------------------------------------------------------------

const SIGNALS = { sx: 2.5, sn: null, ss: 'sig', sspec: ',.2f' }
const specOf = (expr: string, rows: unknown[]): Record<string, unknown> => ({
  signals: Object.entries(SIGNALS).map(([name, value]) => ({ name, value })),
  data: [{ name: 'src', values: rows, transform: [{ type: 'formula', expr, as: 'r' }] }],
})

type Outcome = { rows: unknown } | { error: string }
const errorText = (e: unknown): string => {
  const err = e as { name?: string; message?: string }
  if (err instanceof TypeError || err?.name === 'TypeError') return 'TypeError'
  return String(err?.message ?? e).replace(/^Error: /, '')
}

function onVega(expr: string, rows: unknown[]): Outcome {
  const errors: unknown[] = []
  const logger = {
    level() { return logger }, error: (...a: unknown[]) => { errors.push(a[0]); return logger },
    warn: () => logger, info: () => logger, debug: () => logger,
  }
  let view: any
  try {
    view = new (vega as any).View(vega.parse(specOf(expr, structuredClone(rows)) as never), { renderer: 'none', logger })
    view.run()
  } catch (e) {
    return { error: errorText(e) }
  }
  try {
    if (errors.length) return { error: errorText(errors[0]) }
    return { rows: enc(view.data('src').map((d: { r: unknown }) => d.r)) }
  } finally {
    view.finalize()
  }
}

function onAster(expr: string, rows: unknown[]): Outcome {
  const errors: unknown[] = []
  const logger = { error: (...a: unknown[]) => { errors.push(a[0]) }, warn: () => {} }
  try {
    const scene = evaluateChart(compileChart(specOf(expr, structuredClone(rows)) as never), { logger } as never)
    if (errors.length) return { error: errorText(errors[0]) }
    const got = datasetsOfScene(scene).get('src') as Array<{ r: unknown }> | null
    return { rows: enc(got?.map((d) => d.r)) }
  } catch (e) {
    return { error: errorText(e) }
  }
}

// --- locales ----------------------------------------------------------------------------------------

const NUMBER_LOCALES = [
  { decimal: ',', thousands: '.', grouping: [3], currency: ['', ' €'] },
  { decimal: '.', thousands: ' ', grouping: [3, 2], currency: ['₹', ''], minus: '-', nan: 'n/a', percent: ' %' },
  { decimal: '٫', thousands: '٬', grouping: [3], currency: ['', ' ج.م.'], numerals: ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'] },
]
const TIME_LOCALE = {
  dateTime: '%A, %e de %B de %Y, %X', date: '%d/%m/%Y', time: '%H:%M:%S', periods: ['a. m.', 'p. m.'],
  days: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'], shortDays: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
  months: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  shortMonths: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
}
const setLocales = (n: unknown, t: unknown): void => {
  ;(vega as any).defaultLocale(n, t)
  defaultLocale(n as never, t as never)
}
const resetLocales = (): void => {
  ;(vega as any).resetDefaultLocale()
  resetDefaultLocale()
}

afterEach(resetLocales)

// --- the tests ----------------------------------------------------------------------------------------

const SEED = 0xE1E5
const N = scaled(1500)

describe('generated: the expression engine vs real Vega (formula per row)', () => {
  it('agrees on every row, or on the error, over random expressions (UTC and a zone with DST)', () =>
    withTz('UTC', async () => {
      const r = makeRng(SEED)
      const bad: string[] = []
      let errored = 0
      let formats = 0
      for (let i = 0; i < N && bad.length < Number(process.env.ASTER_ENGINE_MAXBAD ?? 8); i++) {
        const expr = gen(r, r.int(3))
        const rows = mkRows(r, 12)
        // a tenth of the cases under another default locale, and a few in a zone with DST
        const local = i % 10 === 9 ? NUMBER_LOCALES[r.int(NUMBER_LOCALES.length)] : undefined
        if (local) setLocales(local, TIME_LOCALE)
        const zone = i % 7 === 3 ? 'America/Santiago' : 'UTC'
        try {
          const [want, got] = await withTz(zone, () => [onVega(expr, rows), onAster(expr, rows)])
          if ('error' in want) errored++
          if (/format\(/i.test(expr)) formats++
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            bad.push(`#${i} ${zone}${local ? ' (locale)' : ''} ${expr}\n   vega:  ${JSON.stringify(want).slice(0, 600)}\n   aster: ${JSON.stringify(got).slice(0, 600)}`)
          }
        } finally {
          if (local) resetLocales()
        }
      }
      expect(bad).toEqual([])
      // the corpus exercises both outcomes and is mostly about formatting
      expect(errored).toBeGreaterThan(N * 0.01)
      expect(errored).toBeLessThan(N * 0.5)
      expect(formats).toBeGreaterThan(N * 0.3)
    }), 300_000)

  it('a compiled expression follows the default locale when it changes between two evaluations', () =>
    withTz('UTC', () => {
      const r = makeRng(SEED ^ 0x10c)
      const runtime: any = { scale: () => undefined, data: () => undefined, expr: (e: string) => compileExpr(e, runtime) }
      const bad: string[] = []
      for (let i = 0; i < scaled(120) && bad.length < 8; i++) {
        const expr = r.chance(0.5)
          ? `format(${r.pick(['datum.a', 'datum.b', 'datum.o.v'])}, ${q(numSpec(r))})`
          : `{n: format(datum.a, ${q(numSpec(r))}), t: timeFormat(datum.t, ${q(timeSpec(r))}), u: utcFormat(datum.t, ${q(timeSpec(r))})}`
        const rows = mkRows(r, 6)
        const locale = NUMBER_LOCALES[i % NUMBER_LOCALES.length]
        // one compiled expression, evaluated over the rows under the default locale, another, and the default again
        const compiled = (() => { try { return compileExpr(expr, runtime) } catch { return undefined } })()
        if (!compiled) continue
        const evalAll = (): unknown => rows.map((row) => { try { return enc(compiled(row, SIGNALS)) } catch (e) { return { error: errorText(e) } } })
        // (one View per row: vega's dataflow stops at the first row that throws, the compiled expression is called per row)
        const viaVega = (): unknown => rows.map((row) => {
          const out = onVega(expr, [row])
          return 'rows' in out ? (out.rows as unknown[])[0] : out
        })
        const before = [evalAll(), viaVega()]
        setLocales(locale, TIME_LOCALE)
        const during = [evalAll(), viaVega()]
        resetLocales()
        const after = [evalAll(), viaVega()]
        for (const [label, [got, want]] of [['before', before], ['during', during], ['after', after]] as const) {
          if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`#${i} ${label} ${expr}\n   vega:  ${JSON.stringify(want).slice(0, 400)}\n   aster: ${JSON.stringify(got).slice(0, 400)}`)
        }
      }
      expect(bad).toEqual([])
    }), 120_000)
})
