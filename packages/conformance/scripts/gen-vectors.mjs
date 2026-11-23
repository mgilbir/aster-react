/**
 * Records oracle vectors: input -> output pairs captured from the pinned,
 * dev-only upstream packages, written to `packages/core/testdata/vectors/`.
 *
 * Every library `@aster-charts/core` reimplements is replayed against these vectors
 * by a unit test, so a port can be swapped in and verified for exact
 * behaviour — independent of the SVG conformance oracle — before its
 * dependency is dropped. This mirrors the sibling projects' method (Go's
 * `testdata/upstream-vectors`, Kotlin's `test-fixtures/upstream-vectors`).
 *
 * One output file per library. The oracle packages are devDependencies of
 * @aster-charts/conformance, pinned to the exact versions the runtime previously
 * depended on. Run with:
 *
 *   pnpm --filter @aster-charts/conformance run vectors
 *
 * Local-time parsing is pinned to UTC so vectors are machine-independent.
 *
 * A recording is reproducible: no input depends on the clock or on randomness, and regenerating
 * writes the same bytes (src/vectors-reproducible.test.ts regenerates and compares; the colour file
 * is compared within the replay's tolerance because its maths goes through Math.cbrt/pow, whose last
 * bit differs between V8 builds). Two recorded strings depend on the recording engine's ICU data:
 * type `d` (and `,d`) on |x| >= 1e21 and on +-Infinity goes through `toLocaleString('en')` in d3-format
 * (formatDecimal.js), so those eight wants are ICU output (`"1000000000000000000000"`, `"∞"`, `"−∞"`).
 * A runtime without full Intl would record `"1e+21"` / `"Infinity"` and fail them; every supported
 * Node ships full ICU. Every other string comes from toFixed, toExponential, toString(radix) or toPrecision.
 *
 * Only results that do NOT depend on the V8 version belong here. The suites whose results go
 * through Math.pow/exp/log/sin/cos/atan2/sqrt (vega-scale, d3-geo, d3-shape, vega-expression)
 * are LIVE differentials instead (`differential-*.test.mts`, with their inputs in the
 * `*-cases.mjs` modules beside this file); see docs/TESTING.md, "Why live".
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cli } from '../../../scripts/lib/cli.mjs'

cli({ url: import.meta.url, flags: { out: 'value' } })

process.env.TZ = 'UTC'

const here = dirname(fileURLToPath(import.meta.url))
// Base the resolver on a real file inside the package so devDependencies
// (the pinned oracle packages) resolve.
const req = createRequire(join(here, '..', 'package.json'))

// --- value codec -------------------------------------------------------------
// JSON cannot express NaN/Infinity/-0/undefined/Dates/RegExp/Symbols, so
// values are tagged. The replay test (`oracle-vectors.test.ts` (packages/core/src)) mirrors this
// codec; the two must agree.

function enc(v) {
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
  if (typeof v === 'symbol') return { $: 'symbol', desc: v.description ?? null }
  if (v instanceof Int8Array) return { $: 'int8array' }
  if (typeof v === 'function') return { $: 'fn' }
  if (Array.isArray(v)) return v.map(enc)
  if (v !== null && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) o[k] = enc(v[k])
    return o
  }
  return v
}

/** Call fn, capturing a throw as a tagged value (type and message both pinned). */
function call(fn, args) {
  try {
    return fn(...args)
  } catch (err) {
    return { $: 'throw', name: err.name, message: err.message }
  }
}

// --- colour projection -------------------------------------------------------
// Colour objects are projected to plain data: the constructor name, every own
// field, the format methods, `displayable`, and one level of brighter/darker/
// clamp/rgb conversions. The replay test mirrors this exactly.

function colorFields(c) {
  const o = {}
  for (const k of Object.keys(c)) o[k] = enc(c[k])
  return o
}

function proj(c) {
  if (c == null) return c
  return {
    type: c.constructor.name,
    fields: colorFields(c),
    formatRgb: c.formatRgb(),
    formatHex: c.formatHex(),
    formatHex8: c.formatHex8(),
    formatHsl: c.formatHsl(),
    displayable: c.displayable(),
    brighter: colorFields(c.brighter()),
    brighter2: colorFields(c.brighter(2)),
    darker: colorFields(c.darker()),
    clamp: c.clamp ? colorFields(c.clamp()) : null,
    rgb: colorFields(c.rgb()),
    string: String(c),
    brighterHalf: colorFields(c.brighter(0.5)),
    darker2: colorFields(c.darker(2)),
    copy: colorFields(c.copy({ opacity: 0.25 })),
  }
}

/** Wrap a colour-constructor suite: every case is `fn(...args)` -> projection. */
function colorSuite(pkgName, mod, name, cases) {
  const f = mod[name]
  if (typeof f !== 'function') throw new Error(`oracle export missing: ${name}`)
  return {
    oracle: oracleOf(pkgName),
    kind: 'color',
    cases: cases.map((args) => ({ args: args.map(enc), want: enc(proj(call(f, args))) })),
  }
}

/** Pin label for an oracle package: name@version from its own manifest. */
function oracleOf(pkgName) {
  // `${pkgName}/package.json` is not always exported, so walk up from the
  // resolved entry to the manifest that owns it.
  let cur = dirname(req.resolve(pkgName))
  for (let i = 0; i < 6; i++) {
    try {
      const p = JSON.parse(readFileSync(join(cur, 'package.json'), 'utf8'))
      if (p.name === pkgName) return `${p.name}@${p.version}`
    } catch {
      // keep walking
    }
    cur = dirname(cur)
  }
  throw new Error(`manifest not found for oracle package ${pkgName}`)
}

/** Wrap a plain function suite: every case is `fn(...args)` -> want. */
function fnSuite(pkgName, mod, name, cases) {
  const f = mod[name]
  if (typeof f !== 'function') throw new Error(`oracle export missing: ${name}`)
  return {
    oracle: oracleOf(pkgName),
    cases: cases.map((args) => ({ args: args.map(enc), want: enc(call(f, args)) })),
  }
}

/**
 * Suite for accessor factories: check the reported fields/name and the value
 * read off a datum. A malformed path records the throw instead.
 */
function accessorSuite(pkgName, mod, name, cases) {
  const f = mod[name]
  if (typeof f !== 'function') throw new Error(`oracle export missing: ${name}`)
  return {
    oracle: oracleOf(pkgName),
    kind: 'accessor',
    cases: cases.map(({ args, on }) => {
      const a = call(f, args)
      if (a && a.$ === 'throw') return { args: args.map(enc), want: a }
      return {
        args: args.map(enc),
        want: enc({
          fields: a.fields,
          fname: a.fname,
          on,
          value: call(a, [on]),
        }),
      }
    }),
  }
}

/** Load an oracle package from the conformance devDependencies (CJS or ESM). */
async function loadPkg(pkgName) {
  const url = 'file://' + req.resolve(pkgName)
  const m = await import(url)
  return m.default && typeof m.default === 'object' ? m.default : m
}

// --- the vega-util surface @aster-charts/core reimplements ---------------------------

const vegaUtil = await loadPkg('vega-util')
const vegaFunctions = await loadPkg('vega-functions')
const d3Color = await loadPkg('d3-color')
const vegaTime = await loadPkg('vega-time')
const d3Time = await loadPkg('d3-time')
const d3Format = await loadPkg('d3-format')
const d3Array = await loadPkg('d3-array')
const vegaFormat = await loadPkg('vega-format')
const d3Dsv = await loadPkg('d3-dsv')
const topojsonClient = await loadPkg('topojson-client')

const BACKSLASH = String.fromCharCode(92)
/** The string `a\.b` (a, backslash, dot, b) — an escaped dot. */
const ESCAPED_DOT = `a${BACKSLASH}.b`

const utilSuites = {
  toBoolean: fnSuite('vega-util', vegaUtil, 'toBoolean', [
    [null], [undefined], [''], ['false'], ['true'], ['False'], ['0'], ['1'],
    ['00'], ['0.0'], [' '], [0], [1], [-1], [false], [true], [NaN], [Infinity],
    [[]], [{}], [[0]], [[1]],
  ]),
  toNumber: fnSuite('vega-util', vegaUtil, 'toNumber', [
    [null], [undefined], [''], ['12'], ['12.5'], ['-3'], ['abc'], ['0x10'],
    [' 42 '], ['1e3'], ['.5'], ['Infinity'], ['-Infinity'], ['  '], ['12px'],
    [12], [0], [-0], [false], [true], [NaN], [Infinity], [[]], [[5]], [[5, 6]], [{}],
  ]),
  toDate: fnSuite('vega-util', vegaUtil, 'toDate', [
    [null], [undefined], [''], [0], [12345.5], [-1000],
    [new Date(0)], [new Date('2021-06-01T12:00:00Z')],
    ['2020-01-02T03:04:05.678Z'], ['2020-06-15T12:30:45+02:00'],
    ['2020-01-02'], ['1970-01-01T00:00:00.000Z'],
    ['Jan 1, 2020'], ['Jan 1, 2020 12:30:45'], ['not a date'], ['2020-13-45'],
  ]),
  toString: fnSuite('vega-util', vegaUtil, 'toString', [
    [null], [undefined], [''], [0], [-0], [false], [true], [NaN], [Infinity],
    ['x'], [[]], [[1, 2]], [{}], [{ a: 1 }],
    [Symbol('s')], // _ + '' throws for symbols
  ]),
  isArray: fnSuite('vega-util', vegaUtil, 'isArray', [
    [[]], [[1]], [{}], ['x'], [null], [undefined], [0], [true], [new Int8Array(1)],
  ]),
  isBoolean: fnSuite('vega-util', vegaUtil, 'isBoolean', [
    [true], [false], [0], [1], [''], ['true'], [null], [undefined],
  ]),
  isDate: fnSuite('vega-util', vegaUtil, 'isDate', [
    [new Date(0)], [new Date('not a date')], [0], ['2020-01-01'], [null], [undefined], [1700000000000],
  ]),
  isNumber: fnSuite('vega-util', vegaUtil, 'isNumber', [
    [0], [-0], [NaN], [Infinity], ['1'], [null], [undefined], [true], [new Date(0)],
  ]),
  isObject: fnSuite('vega-util', vegaUtil, 'isObject', [
    [{}], [[]], [null], [undefined], [0], [''], ['x'], [true], [new Date(0)],
    [() => 1], [/a/], [Symbol('s')],
  ]),
  isRegExp: fnSuite('vega-util', vegaUtil, 'isRegExp', [
    [/a/], [new RegExp('a', 'g')], ['/a/'], ['a'], [null], [undefined], [0],
  ]),
  isString: fnSuite('vega-util', vegaUtil, 'isString', [
    [''], ['x'], [0], [null], [undefined], [false], [[]],
  ]),
  extent: fnSuite('vega-util', vegaUtil, 'extent', [
    [[]], [[3, 1, 2]], [[null, 2, NaN, 1]], [['b', 'a']], [[1, '2']], [[-0, 0]],
    [[NaN]], [[null, undefined]], [[0, 1, 2, 3]], [['10', '9']], [[true, false]],
  ]),
  ascending: fnSuite('vega-util', vegaUtil, 'ascending', [
    [1, 2], [2, 1], [1, 1], [null, 1], [1, null], [null, null], [undefined, null],
    [undefined, undefined], ['a', 'b'], ['b', 'a'], ['a', 'a'], ['a', 10],
    [NaN, 1], [1, NaN], [new Date(2), new Date(1)], [new Date(1), new Date(2)],
    [new Date(1), 2], [-0, 0], [0, -0], ['', 'a'], [true, false],
  ]),
  pluck: fnSuite('vega-functions', vegaFunctions, 'pluck', [
    [[{ a: 1 }, { a: 2 }, { b: 3 }], 'a'],
    [[{ a: { b: 1 } }], 'a.b'],
    [[{ a: 1 }], 'missing'],
    [[{ a: 1 }], 'a[0]'],
    [[{ a: 1 }], ''],
    [[{ a: 1 }], 0],
    [['x', 'y'], '0'],
    [{ a: 5 }, 'a'],
    [null, 'a'], // reading a field off null throws
  ]),
  field: accessorSuite('vega-util', vegaUtil, 'field', [
    { args: ['a'], on: { a: 42 } },
    { args: ['a.b'], on: { a: { b: 'v' } } },
    { args: ['a[0]'], on: { a: [7] } },
    { args: ['a', 'custom'], on: { a: 1 } },
    { args: [`a['b.c']`], on: { a: { 'b.c': 9 } } },
    { args: [`a["b"]`], on: { a: { b: 2 } } },
    // A backslash-escaped dot: the datum carries both readings, and the
    // recorded value says which one upstream's path splitter produces.
    { args: [ESCAPED_DOT], on: { 'a.b': 'dotted', ab: 'joined' } },
    { args: ['a[b'], on: null }, // malformed: missing closing bracket
    { args: ['a]b'], on: null }, // malformed: missing open bracket
    { args: [`a'b`], on: null }, // malformed: missing closing quote
  ]),
}

// --- the vega-time + d3-time surface @aster-charts/core reimplements -----------------
// Suites carry the `tz` they were recorded under; the replay pins process.env.TZ
// per suite (Node re-reads it). UTC covers the calendar engine; a DST-observing
// zone covers the local-time paths, including the spring and autumn transitions.

const TZ_UTC = 'UTC'
const TZ_DST = 'America/New_York'

function tzSuite(kind, pkgName, mod, name, tz, cases) {
  const f = mod[name]
  if (typeof f !== 'function') throw new Error(`oracle export missing: ${name}`)
  const isApply1 = kind === 'apply1'
  const apply = isApply1
    ? (...a) => f(...a.slice(0, -1))(...a.slice(-1)) // build with all but the last arg, apply to the last
    : (...a) => f(...a)
  // Record under the zone the suite declares — local-time behaviour and DST
  // transitions are part of the pinned semantics. Node re-reads TZ per call.
  process.env.TZ = tz
  return {
    oracle: oracleOf(pkgName),
    kind,
    tz,
    cases: cases.map((args) => ({ args: args.map(enc), want: enc(call(apply, args)) })),
  }
}

// Timestamps around the 2024 US transitions in America/New_York (spring forward 2024-03-10 07:00Z,
// fall back 2024-11-03 06:00Z), and instants that vary every field a floor, an offset or a format
// reads. The comment used to say these straddled the transitions; the first eleven did not: they
// are all BEFORE the offset change of their day (the first 01:30 of Nov 3 is the only one that
// sits in the repeated hour). What each group is for:
//   - before the change:    03-10T05:30Z (00:30 EST), 03-10T06:30Z (01:30 EST), 11-03T04:30Z (00:30 EDT),
//                           11-03T05:30Z (the FIRST 01:30 EDT)
//   - after the change:     03-10T07:30Z (03:30 EDT, the first instant after the gap), 11-03T06:30Z
//                           (the SECOND 01:30, now EST)
//   - one day before, so a +1 day offset lands IN the gap (03-09T07:30Z is 02:30 EST; +1 day is
//                           the nonexistent 02:30 of Mar 10) or on the repeated hour (11-02T05:30Z is 01:30 EDT)
//   - sub-second fields:    03-10T06:59:59.999Z (the last millisecond before the gap), 06-15T12:37:41.123Z
//                           and 12:37:41.457Z (minutes 37, seconds 41 and milliseconds 123 / 457: the minutes are a multiple
//                           of neither 3 nor 5, the milliseconds of 3 only at .123; seconds and milliseconds are non-zero)
const dstDates = [
  '2024-03-09T12:00:00Z', '2024-03-10T05:30:00Z', '2024-03-10T06:30:00Z',
  '2024-11-02T12:00:00Z', '2024-11-03T04:30:00Z', '2024-11-03T05:30:00Z',
  '2024-01-15T12:00:00Z', '2024-07-15T12:00:00Z', '1970-01-01T00:00:00Z',
  '1999-12-31T23:59:59Z', '2000-02-29T00:00:00Z',
  '2024-03-10T07:30:00Z', '2024-11-03T06:30:00Z',
  '2024-03-09T07:30:00Z', '2024-11-02T05:30:00Z',
  '2024-03-10T06:59:59.999Z', '2024-06-15T12:37:41.123Z', '2024-06-15T12:37:41.457Z',
].map((s) => new Date(s))

// Instants on a local boundary of each level of a multi-format object (America/New_York for the local
// suites, the same wall-clock instants in UTC for the UTC suites): the first instant of a year, a
// non-quarter month, a quarter, a Sunday, a weekday, an hour, a minute, a second, a millisecond.
/** The instants of both lists, each once (a case recorded twice checks nothing the first did not). */
const distinctDates = (...lists) => [...new Map(lists.flat().map((d) => [d.getTime(), d])).values()]
const multiFormatLocalDates = [
  '2024-01-01T05:00:00Z', '2024-03-01T05:00:00Z', '2024-04-01T04:00:00Z',
  '2024-03-10T05:00:00Z', '2024-03-12T04:00:00Z', '2024-06-15T16:00:00Z',
  '2024-06-15T16:37:00Z', '2024-06-15T16:37:41Z', '2024-06-15T16:37:41.123Z',
].map((s) => new Date(s))
const multiFormatUtcDates = [
  '2024-01-01T00:00:00Z', '2024-03-01T00:00:00Z', '2024-04-01T00:00:00Z',
  '2024-03-10T00:00:00Z', '2024-03-12T00:00:00Z', '2024-06-15T12:00:00Z',
  '2024-06-15T12:37:00Z', '2024-06-15T12:37:41Z', '2024-06-15T12:37:41.123Z',
].map((s) => new Date(s))
// Objects: the clock-only pair of the first recording, the date-only object, the empty object (all
// defaults), and one that overrides every level with a marker so each level's pattern is observable.
const multiFormatObjects = [
  { year: '%Y', month: '%b', date: '%d' },
  { seconds: ':%S', minutes: '%H:%M', hours: '%H %p' },
  {},
  {
    milliseconds: 'L%L', seconds: 'S%S', minutes: 'M%M', hours: 'H%H', date: 'D%d', week: 'W%b%d',
    month: 'Mo%m', quarter: 'Q%q', year: 'Y%Y',
  },
  { day: 'A%a', quarter: 'Qu%q' },
]

const unitsList = [
  ['year'], ['quarter'], ['month'], ['week'], ['date'], ['day'], ['hours'],
  ['minutes'], ['seconds'], ['milliseconds'], ['year', 'month', 'date'],
  ['year', 'month'], ['year', 'hours'], ['hours', 'minutes'],
  ['year', 'month', 'date', 'hours', 'minutes', 'seconds'],
  ['year', 'quarter'], ['year', 'week', 'day'], ['year', 'dayofyear'],
  ['year', 'date', 'hours'], ['seconds', 'minutes', 'hours'],
]

const offsetCases = []
// Steps: integers, zero, and the coercion branch (a fractional step floors: -0.5 is one back, 1.5 is one
// forward; an absent step is 1).
for (const unit of ['year', 'quarter', 'month', 'week', 'date', 'day', 'dayofyear', 'hours', 'minutes', 'seconds', 'milliseconds']) {
  for (const d of dstDates) {
    offsetCases.push(
      [unit, d, 1], [unit, d, 3], [unit, d, -2], [unit, d, 12],
      [unit, d, 0], [unit, d, 1.5], [unit, d, -0.5], [unit, d, undefined],
    )
  }
}

const sequenceUnits = [
  // [unit, start, stop, step] — windows sized to the unit so a sequence stays
  // in the thousands of entries, not the hundreds of millions
  ['year', '2000-01-01T00:00:00Z', '2012-01-01T00:00:00Z'],
  ['quarter', '2023-01-01T00:00:00Z', '2024-10-01T00:00:00Z'],
  ['month', '2023-01-01T00:00:00Z', '2024-10-01T00:00:00Z'],
  ['week', '2024-01-01T00:00:00Z', '2024-03-15T00:00:00Z'],
  ['date', '2024-01-01T00:00:00Z', '2024-01-20T00:00:00Z'],
  ['day', '2024-01-01T00:00:00Z', '2024-01-20T00:00:00Z'],
  ['dayofyear', '2024-01-01T00:00:00Z', '2024-01-20T00:00:00Z'],
  ['hours', '2024-03-08T00:00:00Z', '2024-03-13T00:00:00Z'],
  ['minutes', '2024-03-10T05:00:00Z', '2024-03-10T05:30:00Z'],
  ['seconds', '2024-03-10T05:29:00Z', '2024-03-10T05:29:30Z'],
  ['milliseconds', '2024-03-10T05:29:00.000Z', '2024-03-10T05:29:00.100Z'],
  ['year', '2023-01-01T00:00:00Z', '2031-01-01T00:00:00Z', 2],
  ['month', '2023-01-01T00:00:00Z', '2024-10-01T00:00:00Z', 3],
  ['date', '2024-03-08T00:00:00Z', '2024-03-20T00:00:00Z', 2],
  ['hours', '2024-11-01T00:00:00Z', '2024-11-06T00:00:00Z', 6],
  ['date', '2024-06-01T00:00:00Z', '2024-06-10T00:00:00Z', 0],
  ['minutes', '2024-03-10T05:00:00Z', '2024-03-10T05:01:00Z', 30],
  ['day', '2024-03-08T00:00:00Z', '2024-03-20T00:00:00Z', 2],
  ['dayofyear', '2024-03-08T00:00:00Z', '2024-03-20T00:00:00Z', 3],
]
const sequenceCases = sequenceUnits.map((u) => [
  u[0], new Date(u[1]), new Date(u[2]), u[3] !== undefined ? Number(u[3]) : undefined,
])

const floorCases = []
// Every instant of dstDates: the first recording sliced the first eight, all of which have zero seconds
// and milliseconds and minutes of 0 or 30, so the seconds and milliseconds units, every minute/second/
// millisecond step and the y-m-d-H-M-S floor could not fail.
for (const units of unitsList) {
  for (const d of dstDates) {
    floorCases.push([units, undefined, d], [units, 5, d], [units, 3, d])
  }
}
// Steps act on the finest unit of the list, so the hours/minutes/seconds/milliseconds steps under DST
// are only distinguishable on instants whose field is not a multiple of the step (src/vectors-coverage.test.ts).

const dayHelpers = dstDates.map((d) => [d])

const specifierCases = [
  [['year']], [['year', 'month']], [['year', 'month', 'date']],
  [['year', 'quarter']], [['year', 'week', 'day']], [['hours', 'minutes']],
  [['year', 'month', 'date', 'hours', 'minutes', 'seconds', 'milliseconds']],
  [['year', 'date']], [['month', 'date']], [['dayofyear']],
  [['year', 'month'], { year: 'Y', month: 'M' }],
  [['hours', 'minutes', 'seconds'], { hours: 'H', minutes: 'M', seconds: 'S' }],
  // The case above ('year','month' with year/month overrides) is inert: the default composite key
  // 'year-month' wins. These override the composite keys themselves, and pass null / undefined specifiers.
  [['year', 'month'], { 'year-month': '%Y/%m' }],
  [['year', 'month', 'date'], { 'year-month-date': '%d.%m.%Y', year: 'Y' }],
  [['hours', 'minutes'], { 'hours-minutes': '%I:%M %p' }],
  [['year', 'month'], null],
  [['year', 'month'], { 'year-month': null }],
  [['year', 'month'], { year: null, month: 'M' }],
  [['dayofyear'], { dayofyear: 'D%j' }],
]

const unitValidation = [
  [['year']], [['month', 'year']], [['nope']], [[]],
  [['year', 'week']], [['week', 'day']], [['year', 'quarter', 'date']],
  [['date', 'dayofyear']], [['hours', 'date', 'month']], [['year', 'hours', 'minutes']],
]

const intervalOps = [
  ['floor', '2024-03-10T05:30:00Z', undefined],
  ['ceil', '2024-03-10T05:30:00Z', undefined],
  ['round', '2024-03-10T05:30:00Z', undefined],
  ['offset', '2024-03-10T05:30:00Z', 2],
  ['offset', '2024-11-03T04:30:00Z', -3],
  // an instant off every boundary (the one above is on a boundary of the millisecond, second and minute
  // intervals, so floor, ceil and round returned the input there)
  ['floor', '2024-03-10T05:30:17.345Z', undefined],
  ['ceil', '2024-03-10T05:30:17.345Z', undefined],
  ['round', '2024-03-10T05:30:17.345Z', undefined],
  ['offset', '2024-03-10T05:30:17.345Z', 5],
  ['offset', '2024-03-10T05:30:17.345Z', -5],
]

// count / range / every(3).range windows per interval, sized to the unit. The sub-day windows start
// off-boundary; the local hour and minute windows straddle the spring transition (2024-03-10 07:00Z).
// The year window starts mid-2021 and contains 2022, 2025 and 2028: every(3) of a year is a multiple of three, so a window
// without one wants [] whatever its floor does.
const intervalWindows = {
  Millisecond: [['2024-03-10T05:30:17.345Z', '2024-03-10T05:30:17.395Z']],
  Second: [['2024-03-10T05:29:17.345Z', '2024-03-10T05:30:02.500Z']],
  Minute: [['2024-03-10T06:41:17.345Z', '2024-03-10T07:12:30.000Z']],
  Hour: [['2024-03-09T20:17:00.000Z', '2024-03-10T12:00:00.000Z']],
  Day: [['2024-03-01T05:30:00Z', '2024-03-20T00:00:00Z']],
  Week: [['2024-01-03T12:00:00Z', '2024-04-20T00:00:00Z']],
  Month: [['2023-01-15T00:00:00Z', '2024-10-01T00:00:00Z']],
  Year: [['2021-06-15T00:00:00Z', '2030-01-01T00:00:00Z']],
}
// The first recording's windows (day and larger): a count over 2024, a range over Jan-Feb,
// every(3) over the first half of 2024. Both zones record them.
const legacyIntervalCases = ['Day', 'Week', 'Month', 'Year'].flatMap((unit) => [
  { op: 'count', w: ['2024-01-01', '2025-01-01'] },
  { op: 'range', w: ['2024-01-01', '2024-03-01'] },
  { op: 'every3_range', w: ['2024-01-01', '2024-07-01'] },
].map((c) => ({ ...c, unit })))
function intervalWindowCases(prefix) {
  return [
    ...legacyIntervalCases,
    ...Object.entries(intervalWindows).flatMap(([unit, ws]) => ws.flatMap((w) => ['count', 'range', 'every3_range'].map((op) => ({ op, w, unit })))),
  ].map((c) => ({ ...c, name: `${prefix}${c.unit}` }))
}
function intervalWindowRecord(mod, { name, op, w }) {
  const [a, b] = w
  const want = op === 'count' ? callIntervalCount(mod, name, a, b)
    : op === 'range' ? callIntervalRange(mod, name, a, b) : callIntervalEveryRange(mod, name, a, b)
  return { args: [name, op, new Date(a), new Date(b)].map(enc), want: enc(want) }
}

const timeSuites = {
  timeOffset: tzSuite('fn', 'vega-time', vegaTime, 'timeOffset', TZ_DST, offsetCases),
  utcOffset: tzSuite('fn', 'vega-time', vegaTime, 'utcOffset', TZ_UTC, offsetCases),
  timeSequence: tzSuite('fn', 'vega-time', vegaTime, 'timeSequence', TZ_DST, sequenceCases),
  utcSequence: tzSuite('fn', 'vega-time', vegaTime, 'utcSequence', TZ_UTC, sequenceCases),
  dayofyear: tzSuite('fn', 'vega-time', vegaTime, 'dayofyear', TZ_DST, dayHelpers),
  week: tzSuite('fn', 'vega-time', vegaTime, 'week', TZ_DST, dayHelpers),
  utcdayofyear: tzSuite('fn', 'vega-time', vegaTime, 'utcdayofyear', TZ_UTC, dayHelpers),
  utcweek: tzSuite('fn', 'vega-time', vegaTime, 'utcweek', TZ_UTC, dayHelpers),
  timeUnitSpecifier: tzSuite('fn', 'vega-time', vegaTime, 'timeUnitSpecifier', TZ_UTC, specifierCases),
  timeUnits: tzSuite('fn', 'vega-time', vegaTime, 'timeUnits', TZ_UTC, unitValidation),
  // localDate/utcDate and the day/week helpers are internal to upstream's build;
  // they are exercised transitively by the floor and offset suites above.
  timeFloor: tzSuite('apply1', 'vega-time', vegaTime, 'timeFloor', TZ_DST, floorCases),
  utcFloor: tzSuite('apply1', 'vega-time', vegaTime, 'utcFloor', TZ_UTC, floorCases),
  d3Intervals: (() => {
    process.env.TZ = TZ_DST
    return {
      oracle: oracleOf('d3-time'),
      kind: 'interval',
      tz: TZ_DST,
      cases: ['timeMillisecond', 'timeSecond', 'timeMinute', 'timeHour', 'timeDay', 'timeWeek', 'timeMonth', 'timeYear']
        .flatMap((unit) => intervalOps.map(([op, date, step]) => ({
          args: [unit, op, new Date(date), step].filter((a) => a !== undefined).map(enc),
          want: enc(callInterval(d3Time, unit, op, new Date(date), step)),
        })))
        .concat(intervalWindowCases('time')
          .map((c) => intervalWindowRecord(d3Time, c))),
    }
  })(),
  utcIntervals: (() => {
    process.env.TZ = TZ_UTC
    return {
      oracle: oracleOf('d3-time'),
      kind: 'interval',
      tz: TZ_UTC,
      cases: ['utcMillisecond', 'utcSecond', 'utcMinute', 'utcHour', 'utcDay', 'utcWeek', 'utcMonth', 'utcYear']
        .flatMap((unit) => intervalOps.map(([op, date, step]) => ({
          args: [unit, op, new Date(date), step].filter((a) => a !== undefined).map(enc),
          want: enc(callInterval(d3Time, unit, op, new Date(date), step)),
        })))
        .concat(intervalWindowCases('utc')
          .map((c) => intervalWindowRecord(d3Time, c))),
    }
  })(),
}

function callInterval(mod, unit, op, date, step) {
  const ival = mod[unit]
  if (op === 'floor') return ival.floor(date)
  if (op === 'ceil') return ival.ceil(date)
  if (op === 'round') return ival.round(date)
  if (op === 'offset') return ival.offset(date, step)
  throw new Error(`unsupported interval op ${op}`)
}

function callIntervalCount(mod, unit, start, end) {
  return mod[unit].count(new Date(start), new Date(end))
}

function callIntervalRange(mod, unit, start, end) {
  return mod[unit].range(new Date(start), new Date(end))
}

function callIntervalEveryRange(mod, unit, start, end) {
  return mod[unit].every(3).range(new Date(start), new Date(end))
}

const parseSpecs = [
  // hex forms
  '#f00', '#ff0000', '#ff000080', '#f000', '#F00', '#ff', '#fffffff', '#',
  // rgb()/rgba() integer and percent
  'rgb(255, 0, 0)', 'rgb(255,128,0)', 'rgb( 100% , 0% , 0% )',
  'rgba(255, 0, 0, 0.5)', 'rgba(0,0,0,0)', 'rgba(10,20,30,1)',
  'rgb(1,2,3,0.5)', 'rgb(1 2 3)', 'rgb (1,2,3)', 'rgb(-5,10,300)',
  // hsl()/hsla()
  'hsl(120, 50%, 50%)', 'hsl(120,50%,50%)', 'hsla(120,50%,50%,0.5)',
  'hsl(0,0%,0%)', 'hsl(0,0%,100%)', 'hsl(0,0%,50%)',
  'hsl(120,50%,0%)', 'hsl(120,50%,100%)', 'hsl(120,0%,50%)',
  'hsl(-120,50%,50%)', 'hsl(480,50%,50%)', 'hsl(120,150%,50%)',
  // named, transparent, junk
  'red', 'rebeccapurple', 'lime', 'gray', 'grey', 'darkslategray',
  'darkslategrey', 'steelblue', 'transparent', 'none', '', 'notacolor',
  'REDBLUE', 'red ', ' steelblue', 'red\t', 'rgb(255,0,0) ',
  // percent with alpha, 4- and 8-digit hex with real alpha bytes, case folding, fractional/out-of-range
  // hue and alpha (the first table never entered the rgba(%) branch, never read a non-zero 4-digit alpha,
  // and only ever lower-cased a hex)
  'rgba(100%,0%,0%,0.5)', 'rgba(10%, 20.5%, 30%, 0)', 'rgba(100%,0%,0%,2)', '#f008', '#abcd', '#FF0000C0', '#12345678', '#ff0000ff',
  'RGB(255,0,0)', 'Red', 'TRANSPARENT', 'RGBA(1,2,3,0.5)', 'HSL(120,50%,50%)', 'HSLA(120,50%,50%,0.25)', 'SteelBlue',
  'hsl(1.5,50%,50%)', 'hsl(120deg,50%,50%)', 'hsla(120,50%,50%,2)', 'rgba(1,2,3,2)', 'rgba(1,2,3,-1)', 'rgb(1.5,2.5,3.5)',
]

const colorSuites = {
  parse: colorSuite('d3-color', d3Color, 'color', parseSpecs.map((s) => [s])),
  rgb: colorSuite('d3-color', d3Color, 'rgb', [
    ...parseSpecs.map((s) => [s]),
    [undefined], [null], [0x112233], [255, 128, 0, undefined], [255, 128, 0, null],
    [255, 128, 0], [255, 128, 0, 0.5], [255, 128, 0, '0.5'], [255, 128, 0, 0],
    [255.7, 128.2, 0.9, 0.1], [300, 0, 0], [-5, 0, 0], [NaN, 0, 0],
    [0, 0, 0], [255, 255, 255], [128, 128, 128, 0],
  ]),
  hsl: colorSuite('d3-color', d3Color, 'hsl', [
    ...parseSpecs.map((s) => [s]),
    [undefined], [null], [0x112233],
    [120, 0.5, 0.5], [120, 0.5, 0.5, 0.5], [120, 0.5, 0.5, 0],
    [-240, 1, 0.5], [480, 1, 0.5], [0, 0, 0], [0, 0, 1],
    [0, 1, 0.5], [120, 1.5, 0.5], [120, 0.5, 1.5], [120, NaN, 0.5],
  ]),
  lab: colorSuite('d3-color', d3Color, 'lab', [
    ...parseSpecs.map((s) => [s]),
    [50, 40, 20], [50, -40, -20], [100, 0, 0], [0, 0, 0],
    [50, NaN, 20], [50, 40, NaN], [50, 40, 20, 0.5],
    [-10, 0, 0], [200, 0, 0],
  ]),
  hcl: colorSuite('d3-color', d3Color, 'hcl', [
    ...parseSpecs.map((s) => [s]),
    [120, 40, 50], [0, 0, 50], [120, 40, 50, 0.5], [-120, 40, 50],
    [120, 0, 50], [120, 40, 0], [120, 40, 100], [120, 40, 200],
    [120, NaN, 50], [0, 0, 0], [0, 0, 100],
  ]),
  gray: colorSuite('d3-color', d3Color, 'gray', [[0], [50], [100], [50, 0.5], [NaN]]),
  lch: colorSuite('d3-color', d3Color, 'lch', [
    [50, 40, 120], [50, 40, 120, 0.5], [50, 0, 0],
  ]),
}

// --- the d3-format + vega-format surface @aster-charts/core reimplements ------------

const formatSpecs = [
  'd', 'f', '.2f', '.0f', 'g', '.3g', 's', '.2s', 'e', '.2e', '%', '.1%',
  'r', '.3r', 'p', '.2p', '~g', '~s', ',.2f', ',d', '08.3f', '>10.2f',
  '<10.2f', '^10.2f', '=10.2f', '+$, .2f', '#x', '#o', '#X', 'b', 'n', '',
  '.12g', '.1f', 'c', '5', '.5', ',', '~', 'x', 'X', 'o',
]
// Specifiers that fail to parse (the formatSpecifier suite records the throw).
const invalidFormatSpecs = ['zzz', '.zzf', '10.2.3f']
// Specifiers that parse, with the options each one switches: a bare '#', '+' and 'q' (an unknown type
// falls back to ~.12g) and every sign / symbol / zero-pad / grouping option reaching a value. They go
// through the format suite as well as the formatSpecifier suite: the first recording only parsed them.
const edgeFormatSpecs = [
  '#', '+', 'q', '.3q', '+.2f', '-.2f', ' .2f', '(.2f', '$.2f', '$,.2f', '+$,.2f', '($,.2f', '$.2s', '+,.3s', '(.2e', '+.2%', '$d', '+d', '(d',
  '+08.2f', '$010,.2f', '#.0f', '#b', '#.3s', '~%', '.0%', '.2~s', '+~g', '0=10d', '*^12.3f',
]
const formatValues = [
  0, -0, 1, -1, 1.5, -1.5, 12345.678, 0.5, 2 / 3, 100, 255, 0.000001, 1e-7,
  1e15, 1e21, 1e22, NaN, Infinity, -Infinity, -1234.5678, 987654321.123,
  0.1, 1e-21, 42,
  // beyond the SI prefixes (y below 1e-24, Y above 1e24), and what d3 coerces with +value
  1e-24, 1e-27, 1e24, 1e27, 7.5e-26, '42', ' 12.5 ', '1e3', '', 'abc', null, undefined, true, false, [], [5],
]

const specifierProjection = (spec) => {
  const s = d3Format.formatSpecifier(spec)
  return { ...s, str: s.toString() }
}

const fnSuiteTz = (pkg, cases, build) => ({
  oracle: oracleOf(pkg),
  kind: 'fn',
  tz: TZ_UTC,
  cases: cases.map((args) => ({ args: args.map(enc), want: enc(call(build, args)) })),
})

const formatSuites = {
  // d3.format(spec)(value)
  format: {
    oracle: oracleOf('d3-format'),
    kind: 'apply1',
    tz: TZ_UTC,
    cases: [...formatSpecs, ...edgeFormatSpecs].flatMap((spec) => formatValues.map((v) => ({
      args: [spec, v].map(enc),
      want: enc(call((s, v) => d3Format.format(s)(v), [spec, v])),
    }))),
  },
  // d3.formatPrefix(spec, value)(x)
  formatPrefix: {
    oracle: oracleOf('d3-format'),
    kind: 'apply1',
    tz: TZ_UTC,
    // Refs cover every prefix (y .. Y), the clamp beyond 1e+-24, zero (formatDecimalParts is null for 0, so
    // the want is "NaN") and the non-finite refs. A value triple [ref, ref / 2, 1] collides for ref 0 and 1
    // (each repeated an earlier case), so triples are de-duplicated and ref * 3 is added as a value that
    // does not collide. More specs than the plain `s` family: grouping, sign, symbol, trim.
    cases: ['.2s', 's', '.0s', '.3s', '~s', ',.3s', '+.2s', '$.2s', '.2~s', '(.1s', '08.2s', '.2f', 'd'].flatMap((spec) =>
      [0, 1e-24, 1e-21, 1e-18, 1e-15, 1e-12, 1e-9, 1e-6, 0.001, 0.5, 1, 999, 1000, 1500, 1e6, 2.5e9, -3.7e12, 7e15, 1e18, 1e21, 1e24, 1e27, NaN, Infinity, -Infinity].flatMap((ref) =>
        // (the prefix scales the value by Math.pow(10, -e), which differs in the last bit between V8 builds for |e| >= 18: a
        // value that lands on a rounding boundary after it, ref / 2 under `.0s`, would record the engine, not d3. Those refs
        // are applied to themselves and to 3 * ref, which no precision of these specs rounds at a boundary)
        [...new Set([ref, ...(Math.abs(ref) >= 1e18 ? [] : [ref * 0.5, 1]), ref * 3, ...(Math.abs(ref) >= 1e18 ? [] : [123456])])].map((v) => ({
          args: [spec, ref, v].map(enc),
          want: enc(call((s, r, v) => d3Format.formatPrefix(s, r)(v), [spec, ref, v])),
        })),
      )),
  },
  formatSpecifier: {
    oracle: oracleOf('d3-format'),
    kind: 'specifier',
    tz: TZ_UTC,
    cases: [...formatSpecs, ...edgeFormatSpecs, ...invalidFormatSpecs].map((spec) => ({
      args: [spec].map(enc),
      want: enc(call(specifierProjection, [spec])),
    })),
  },
  precisionFixed: fnSuiteTz('d3-format', [[1], [0.1], [0.01], [0.001], [0.25], [1e-7], [10], [0], [NaN]], (s) => d3Format.precisionFixed(s)),
  // zero, negative, NaN and infinite steps / values / maxima (precisionFixed already records 0 and NaN)
  precisionPrefix: fnSuiteTz('d3-format', [[1, 1], [0.1, 100], [0.001, 2.5e9], [10, 1e3], [0.25, 50], [1e-7, 1e9],
    [0, 1], [1, 0], [-1, 1e3], [1, -1e3], [NaN, 1], [1, NaN], [Infinity, 1], [1, Infinity], [-Infinity, 1], [1, -Infinity],
    [0.5, 1e-9], [5, 1e24], [1e-30, 1e27], [1, 1e-30], [-0, 1], [1, -0]], (s, v) => d3Format.precisionPrefix(s, v)),
  precisionRound: fnSuiteTz('d3-format', [[1, 10], [0.1, 100], [0.001, 2.5e9], [10, 1e3], [0.25, 50], [0.5, 0.75],
    [0, 1], [1, 0], [-1, 10], [1, -10], [NaN, 1], [1, NaN], [Infinity, 1], [1, Infinity], [1, -Infinity], [-Infinity, 1],
    [0.5, 1e-9], [1e-30, 1], [-0, 1], [1, -0], [1, 1], [1, 0.5]], (s, m) => d3Format.precisionRound(s, m)),
  // d3-array's tickStep backs formatSpan and (later) the scale ticks
  tickStep: fnSuiteTz('d3-array', [[0, 1, 10], [0, 10, 3], [1, 0, 10], [0, 1, 5], [0.5, 1.5, 7], [-1, 1, 4], [0, 100, 7], [1.2, 3.4, 6], [0, 1, 1],
    // count 0 / negative / non-integer / non-finite, start == stop, non-finite and subnormal bounds
    [0, 1, 0], [0, 1, -3], [0, 1, 2.5], [0, 1, NaN], [0, 1, Infinity], [0, 10, 0.5], [5, 5, 10], [5, 5, 0], [0, 0, 10],
    [NaN, 1, 10], [0, NaN, 10], [0, Infinity, 10], [-Infinity, 0, 10], [-Infinity, Infinity, 10], [1, 0, 0], [-1, -2, 5],
    [5e-324, 1e-323, 10], [0, 5e-324, 10], [-5e-324, 5e-324, 3], [1e-300, 1e300, 10], [1e307, 1.7976931348623157e308, 10],
    [0, 1e-7, 5], [0, 1e21, 5]], (a, b, c) => d3Array.tickStep(a, b, c)),
}

// --- the vega-format facade (locale) ------------------------------------------

// The facade surface, bound to the default locale like a host would. Each
// suite is built through tzSuite, which pins the zone BEFORE the cases are
// computed - the recording zone is part of the pinned semantics.
const localeFns = {
  localeFormat: (spec) => vegaFormat.locale(undefined).format(spec),
  localeFormatFloat: (spec) => vegaFormat.locale(undefined).formatFloat(spec),
  localeFormatSpan: (a, b, c, spec) => vegaFormat.locale(undefined).formatSpan(a, b, c, spec),
  localeTimeFormat: (spec) => vegaFormat.locale(undefined).timeFormat(spec),
  localeUtcFormat: (spec) => vegaFormat.locale(undefined).utcFormat(spec),
  localeTimeParse: (spec, str) => vegaFormat.locale(undefined).timeParse(spec)(str),
  localeUtcParse: (spec, str) => vegaFormat.locale(undefined).utcParse(spec)(str),
}

const localeNumberSpecs = ['', ',', '.1f', '.2~f', '~g', '.3g', 'd', 's']
const localeValues = [0, 1, -1, 0.25, 1234.5678, 1234567.89, -0.5]

const localeSuites = {
  localeFormat: tzSuite('apply1', 'vega-format', localeFns, 'localeFormat', TZ_UTC,
    localeNumberSpecs.flatMap((spec) => localeValues.map((v) => [spec, v]))),
  localeFormatFloat: tzSuite('apply1', 'vega-format', localeFns, 'localeFormatFloat', TZ_UTC,
    ['', '~g', 'e', '%', '.2f', 's'].flatMap((spec) =>
      [0, 1, 0.123456789012, 123456.789012345, -42.5].map((v) => [spec, v]))),
  localeFormatSpan: tzSuite('apply1', 'vega-format', localeFns, 'localeFormatSpan', TZ_UTC,
    [[0, 1, 10], [0, 100, 5], [0, 1e6, 8], [-50, 50, 6], [0, 0.5, 5]].flatMap(([start, stop, count]) =>
      ['', 'f', 's', 'g', '.2f'].flatMap((spec) =>
        [start, stop / 2, stop].map((v) => [start, stop, count, spec, v])))),
  localeTimeFormat: tzSuite('apply1', 'vega-format', localeFns, 'localeTimeFormat', TZ_DST,
    [
      '%Y-%m-%d', '%H:%M:%S', '%I %p', '%B %Y', '%b %d', '%A', '%a', '%j',
      '%U', '%W', '%V', '%G', '%C', '%Z', '%%', '%x', '%X', '%c', '%e', '%-d',
      '%_m', '%0e', '%q', '%s', '%Q', '%L', '%f', '%y', '%g',
    ].flatMap((spec) => dstDates.map((d) => [spec, d]))
      .concat(
        // multi-format objects pick a specifier per tick interval, so they are applied to the dates
        // that sit on a boundary of each level as well as to dstDates (none of which is a local midnight)
        multiFormatObjects.flatMap((spec) => distinctDates(dstDates, multiFormatLocalDates).map((d) => [spec, d])),
      )),
  localeUtcFormat: tzSuite('apply1', 'vega-format', localeFns, 'localeUtcFormat', TZ_UTC,
    ['%Y-%m-%dT%H:%M:%S', '%B %Y', '%H:%M', '%j', '%V', '%s'].flatMap((spec) => dstDates.map((d) => [spec, d]))
      // multi-format objects, applied to the instants on each level's boundary (UTC midnights, ...) as well
      .concat(multiFormatObjects.flatMap((spec) => distinctDates(dstDates, multiFormatUtcDates).map((d) => [spec, d])))),
  localeTimeParse: tzSuite('fn', 'vega-format', localeFns, 'localeTimeParse', TZ_DST, [
    ['%Y-%m-%d', '2024-03-10'], ['%m/%d/%Y', '03/10/2024'], ['%B %d, %Y', 'March 10, 2024'],
    ['%b %d, %Y', 'Mar 10, 2024'], ['%H:%M', '14:30'], ['%I %p', '2 PM'],
    ['%j', '070'], ['%U', '10'], ['%V', '11'], ['%G-W11-4', '2024-W11-4'],
    // ISO week date: the case above takes `W11-4` as literal text; these resolve year + week + weekday
    ['%G-W%V-%u', '2024-W11-4'], ['%G-W%V-%u', '2024-W01-1'], ['%G-W%V-%u', '2021-W53-7'], ['%u', '4'], ['%w', '4'],
    // the skipped hour (02:30 on 2024-03-10 never happened) and the repeated hour (01:30 on 2024-11-03 happened twice)
    ['%Y-%m-%dT%H:%M:%S', '2024-03-10T02:30:00'], ['%Y-%m-%dT%H:%M:%S', '2024-11-03T01:30:00'],
    ['%Y-%m-%dT%H:%M:%S', '2024-03-10T03:00:00'], ['%Y-%m-%dT%H:%M:%S.%L', '2024-06-15T12:37:41.123'],
    ['%Y-%m-%dT%H:%M:%S', '2024-03-10T14:30:45'], ['%Y-%m-%dT%H:%M:%S%Z', '2024-03-10T14:30:45+0200'],
    ['%Y-%m-%dT%H:%M:%S%Z', '2024-03-10T14:30:45Z'], ['%s', '1710082245'], ['%Q', '1710082245000'],
    ['%A', 'Sunday'], ['%p', 'PM'], ['garbage', '2024-03-10'], ['%Y-%m-%d', 'not a date'],
    ['%Y-%m-%d', '2024-03-10T12:00:00'], ['%d/%m/%Y', '10/13/2024'],
  ]),
  localeUtcParse: tzSuite('fn', 'vega-format', localeFns, 'localeUtcParse', TZ_UTC, [
    ['%Y-%m-%dT%H:%M:%S', '2024-03-10T14:30:45'], ['%Y-%m-%d', '2024-03-10'],
    ['%H:%M', '14:30'], ['%s', '1710082245'], ['%Y-%m-%dT%H:%M:%S%Z', '2024-03-10T14:30:45+0200'],
    ['%G-W%V-%u', '2024-W11-4'], ['%Y-%m-%dT%H:%M:%S.%L', '2024-06-15T12:37:41.123'],
    ['%Y-%m-%dT%H:%M:%S', '2024-03-10T02:30:00'], ['%Y-%m-%dT%H:%M:%S', '2024-11-03T01:30:00'],
  ]),
}

// --- the d3-dsv + topojson-client surface @aster-charts/core reimplements ------------

// named converter/filter variants the replay reconstructs

const deltaArcs = [
  [[0, 0], [1, 0], [0, 1]],   // arc 0: bottom of left square
  [[1, 0], [0, 1]],           // arc 1: shared edge, bottom->top
  [[1, 0], [0, 1], [-1, 0]],  // arc 2: bottom of right square
  [[-1, 0], [0, -1], [1, 0]], // arc 3: top of right square (reversed use)
  [[0, -1], [-1, 0], [1, 0]], // arc 4: top of left square
]

const quantized = {
  type: 'Topology',
  transform: { scale: [10, 10], translate: [0, 0] },
  arcs: deltaArcs,
  objects: {
    squares: {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Polygon', arcs: [[0, 1, ~4]], properties: { name: 'left' }, id: 'L' },
        { type: 'Polygon', arcs: [[~1, 2, 3]], properties: { name: 'right' } },
      ],
    },
    border: { type: 'LineString', arcs: [1] },
    point: { type: 'Point', coordinates: [2, 3] },
  },
}

const absolute = {
  type: 'Topology',
  arcs: [
    [[0, 0], [10, 0], [10, 10]],
    [[10, 0], [10, 10]],
    [[10, 0], [20, 0], [20, 10]],
    [[20, 10], [10, 10], [0, 10]],
    [[0, 10], [0, 0], [10, 0]],
  ],
  objects: {
    squares: {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Polygon', arcs: [[0, 1, ~4]], properties: { name: 'left' }, id: 'L' },
        { type: 'Polygon', arcs: [[~1, 2, 3]], properties: { name: 'right' } },
      ],
    },
    border: { type: 'LineString', arcs: [1] },
    point: { type: 'Point', coordinates: [20, 30] },
  },
}

const dsvConverters = {
  rowPlusIndex: (row, i) => ({ ...row, i }),
  pickA: (row) => row.a,
  dropOdd: (row, i) => i % 2 === 0 ? row : null,
}

const topologies = { quantized, absolute }

const topoFilters = {
  interior: (a, b) => a === b,
  any: undefined,
  byName: (a, b) => a.properties?.name === b.properties?.name,
}

const topoSuites = {
  topoFeatureCollection: {
    oracle: oracleOf('topojson-client'),
    kind: 'fn',
    tz: TZ_UTC,
    cases: [quantized, absolute].map((t) => ({
      args: [enc(t)].map(enc),
      want: enc(call((t) => topojsonClient.feature(t, t.objects.squares), [t])),
    })),
  },
  topoFeatureNamed: {
    oracle: oracleOf('topojson-client'),
    kind: 'fn',
    tz: TZ_UTC,
    cases: [['squares', quantized], ['border', quantized], ['point', quantized]].map(([name, t]) => ({
      args: [t, name].map(enc),
      want: enc(call((t, n) => topojsonClient.feature(t, n), [t, name])),
    })),
  },
  topoMesh: {
    oracle: oracleOf('topojson-client'),
    kind: 'fn',
    tz: TZ_UTC,
    cases: [quantized, absolute].map((t) => ({
      args: [enc(t)].map(enc),
      want: enc(call((t) => topojsonClient.mesh(t), [t])),
    })),
  },
  // named arc-filter variants, reconstructed by the replay
  topoMeshFiltered: {
    oracle: oracleOf('topojson-client'),
    kind: 'topomesh',
    tz: TZ_UTC,
    cases: [
      ['quantized', 'squares', 'interior'],
      ['quantized', 'border', 'any'],
      ['absolute', 'squares', 'byName'],
    ].map(([t, name, variant]) => ({
      args: [topologies[t], name].map(enc),
      variant,
      want: enc(call((t, n, v) => topojsonClient.mesh(t, t.objects[n], topoFilters[v]), [topologies[t], name, variant])),
    })),
  },
  topoMeshOuter: {
    oracle: oracleOf('topojson-client'),
    kind: 'topomesh',
    tz: TZ_UTC,
    cases: [['quantized', 'squares', 'interior']].map(([t, name, variant]) => ({
      args: [topologies[t], name].map(enc),
      variant,
      want: enc(call((t, n, v) => topojsonClient.mesh(t, t.objects[n], topoFilters[v]), [topologies[t], name, variant])),
    })),
  },
}

const dsvTexts = [
  'a,b,c\n1,2,3\n4,5,6',
  'a,b\n"quoted,comma",2\n"say ""hi""",3',
  'a,b\n1\n2,3',            // ragged rows
  'a,b,c\n1,2',              // short rows
  'a,b\n,\n,',
  'a,b\r\n1,2\r\n3,4',    // CRLF
  'a,b\n1,2\n',             // trailing newline
  'a,b\n1,2',                // no trailing newline
  'name,zero,flag\n"x",0,true',
  'a,b\n"multi\nline",2',
  'a;b\n1;2',                // (parsed with ';' delimiter below)
  'a\ta\n1\t2',            // (parsed with tab below)
  'x\n"leading',             // unterminated quote: parser consumes to EOF
  'a,b\n"" ,2',
]

const dsvSuites = {
  dsvParse: {
    oracle: oracleOf('d3-dsv'),
    kind: 'fn',
    tz: TZ_UTC,
    cases: dsvTexts.slice(0, 11).map((text) => ({
      args: [text].map(enc),
      want: enc(call((t) => {
        const rows = d3Dsv.dsvFormat(',').parse(t)
        const out = rows.map((r) => ({ ...r }))
        out.columns = rows.columns
        return out
      }, [text])),
    })),
  },
  // parseRows with a non-comma delimiter (these two suites were called dsvParseSemi / dsvParseTab, which
  // read as `parse`; they have always recorded arrays of arrays)
  dsvParseRowsSemi: {
    oracle: oracleOf('d3-dsv'),
    kind: 'fn',
    tz: TZ_UTC,
    cases: [dsvTexts[10]].map((text) => ({
      args: [text].map(enc),
      want: enc(call((t) => d3Dsv.dsvFormat(';').parseRows(t), [text])),
    })),
  },
  dsvParseRowsTab: {
    oracle: oracleOf('d3-dsv'),
    kind: 'fn',
    tz: TZ_UTC,
    cases: [dsvTexts[11]].map((text) => ({
      args: [text].map(enc),
      want: enc(call((t) => d3Dsv.dsvFormat('\t').parseRows(t), [text])),
    })),
  },
  // parse (to objects) with a non-comma delimiter, including a duplicate header
  dsvParseSemi: {
    oracle: oracleOf('d3-dsv'),
    kind: 'fn',
    tz: TZ_UTC,
    cases: [dsvTexts[10], 'a;b;a\n1;2;3', 'a;b\n"x;y";2\n3;4'].map((text) => ({
      args: [text].map(enc),
      want: enc(call((t) => d3Dsv.dsvFormat(';').parse(t).map((r) => ({ ...r })), [text])),
    })),
  },
  dsvParseTab: {
    oracle: oracleOf('d3-dsv'),
    kind: 'fn',
    tz: TZ_UTC,
    cases: [dsvTexts[11], 'a\tb\n1\t2\n3\t4', 'a\tb\n"x\ty"\t2'].map((text) => ({
      args: [text].map(enc),
      want: enc(call((t) => d3Dsv.dsvFormat('\t').parse(t).map((r) => ({ ...r })), [text])),
    })),
  },
  dsvParseRows: {
    oracle: oracleOf('d3-dsv'),
    kind: 'fn',
    tz: TZ_UTC,
    cases: dsvTexts.map((text) => ({
      args: [text].map(enc),
      want: enc(call((t) => d3Dsv.dsvFormat(',').parseRows(t), [text])),
    })),
  },
  // named row-converter variants, reconstructed by the replay
  dsvParseCustom: {
    oracle: oracleOf('d3-dsv'),
    kind: 'dsvcustom',
    tz: TZ_UTC,
    cases: [
      ['a,b\n1,2\n3,4', 'rowPlusIndex'],
      ['a,b\n1,2', 'pickA'],
      ['a,b\n1,2', 'dropOdd'],
      // three or more rows, so the converter's null for an odd index actually drops a row
      ['a,b\n1,2\n3,4\n5,6', 'dropOdd'],
      ['a,b\n1,2\n3,4\n5,6\n7,8\n9,10', 'dropOdd'],
    ].map(([text, variant]) => ({
      args: [text].map(enc),
      variant,
      want: enc(call((t, v) => d3Dsv.dsvFormat(',').parse(t, dsvConverters[v]), [text, variant])),
    })),
  },
  dsvFormat: {
    oracle: oracleOf('d3-dsv'),
    kind: 'fn',
    tz: TZ_UTC,
    cases: [
      [{ a: 1, b: 'x,y' }, { a: 2, b: 'say "hi"' }],
      [{ a: null, b: undefined }, { a: 0, b: false }],
      [{ a: new Date(Date.UTC(2024, 0, 15)), b: new Date(Date.UTC(2024, 5, 15, 12, 30, 45, 500)) }],
      [{ a: 'plain', b: 'has\nnewline' }],
    ].map((rows) => ({
      args: [enc(rows)],
      want: enc(call((r) => d3Dsv.dsvFormat(',').format(r), [rows])),
    })),
  },
  dsvFormatRow: {
    oracle: oracleOf('d3-dsv'),
    kind: 'fn',
    tz: TZ_UTC,
    cases: [
      [[1, 'x,y']], [['say ""hi""', null]], [[new Date(Date.UTC(2024, 0, 1)), 'z']],
    ].map((row) => ({
      args: [enc(row)],
      want: enc(call((r) => d3Dsv.dsvFormat(',').formatRow(r), [row])),
    })),
  },
}

// A small topology: a 2x1 grid of two squares sharing an edge (arc 1),
// with quantized coordinates, plus the same geometry unquantized.


const files = {
  'vega-util.json': { suites: utilSuites },
  'd3-color.json': { suites: colorSuites },
  'vega-time.json': { suites: timeSuites },
  'd3-format.json': { suites: formatSuites },
  'vega-format.json': { suites: localeSuites },
  'd3-dsv.json': { suites: dsvSuites },
  'topojson-client.json': { suites: topoSuites },
}

// `--out <dir>` records into another directory: the reproducibility test (src/vectors-reproducible.test.ts)
// regenerates there and compares with the committed files.
const outFlag = process.argv.indexOf('--out')
const destDir = outFlag >= 0 ? resolve(process.argv[outFlag + 1]) : join(here, '..', '..', 'core', 'testdata', 'vectors')
mkdirSync(destDir, { recursive: true })

let n = 0
for (const [file, doc] of Object.entries(files)) {
  const dest = join(destDir, file)
  writeFileSync(dest, JSON.stringify(doc, null, 2) + '\n')
  const cases = Object.values(doc.suites).reduce((m, s) => m + s.cases.length, 0)
  n += cases
  console.log(`[vectors] wrote ${cases} cases across ${Object.keys(doc.suites).length} suites -> ${dest}`)
}
console.log(`[vectors] ${n} cases in total`)
