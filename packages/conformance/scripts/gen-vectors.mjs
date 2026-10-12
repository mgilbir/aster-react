/**
 * Records oracle vectors: input -> output pairs captured from the pinned,
 * dev-only upstream packages, written to `packages/core/testdata/vectors/`.
 *
 * Every library `@aster/core` reimplements is replayed against these vectors
 * by a unit test, so a port can be swapped in and verified for exact
 * behaviour — independent of the SVG conformance oracle — before its
 * dependency is dropped. This mirrors the sibling projects' method (Go's
 * `testdata/upstream-vectors`, Kotlin's `test-fixtures/upstream-vectors`).
 *
 * One output file per library. The oracle packages are devDependencies of
 * @aster/conformance, pinned to the exact versions the runtime previously
 * depended on. Run with:
 *
 *   pnpm --filter @aster/conformance run vectors
 *
 * Local-time parsing is pinned to UTC so vectors are machine-independent.
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.TZ = 'UTC'

const here = dirname(fileURLToPath(import.meta.url))
// Base the resolver on a real file inside the package so devDependencies
// (the pinned oracle packages) resolve.
const req = createRequire(join(here, '..', 'package.json'))

// --- value codec -------------------------------------------------------------
// JSON cannot express NaN/Infinity/-0/undefined/Dates/RegExp/Symbols, so
// values are tagged. The replay test (`util-vectors.test.ts`) mirrors this
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

// --- the vega-util surface @aster/core reimplements ---------------------------

const vegaUtil = await loadPkg('vega-util')
const vegaFunctions = await loadPkg('vega-functions')
const d3Color = await loadPkg('d3-color')
const vegaTime = await loadPkg('vega-time')
const d3Time = await loadPkg('d3-time')

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
    [new Date(0)], [new Date('not a date')], [0], ['2020-01-01'], [null], [undefined], [Date.now()],
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

// --- the vega-time + d3-time surface @aster/core reimplements -----------------
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

// Timestamps chosen to straddle the 2024 US transitions (2024-03-10 02:00 local,
// 2024-11-03 02:00 local) plus an ambiguous/absolute pair for each.
const dstDates = [
  '2024-03-09T12:00:00Z', '2024-03-10T05:30:00Z', '2024-03-10T06:30:00Z',
  '2024-11-02T12:00:00Z', '2024-11-03T04:30:00Z', '2024-11-03T05:30:00Z',
  '2024-01-15T12:00:00Z', '2024-07-15T12:00:00Z', '1970-01-01T00:00:00Z',
  '1999-12-31T23:59:59Z', '2000-02-29T00:00:00Z',
].map((s) => new Date(s))

const unitsList = [
  ['year'], ['quarter'], ['month'], ['week'], ['date'], ['day'], ['hours'],
  ['minutes'], ['seconds'], ['milliseconds'], ['year', 'month', 'date'],
  ['year', 'month'], ['year', 'hours'], ['hours', 'minutes'],
  ['year', 'month', 'date', 'hours', 'minutes', 'seconds'],
  ['year', 'quarter'], ['year', 'week', 'day'], ['year', 'dayofyear'],
  ['year', 'date', 'hours'], ['seconds', 'minutes', 'hours'],
]

const offsetCases = []
for (const unit of ['year', 'quarter', 'month', 'week', 'date', 'day', 'hours', 'minutes', 'seconds', 'milliseconds']) {
  for (const d of dstDates) {
    offsetCases.push([unit, d, 1], [unit, d, 3], [unit, d, -2], [unit, d, 12])
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
]
const sequenceCases = sequenceUnits.map((u) => [
  u[0], new Date(u[1]), new Date(u[2]), u[3] !== undefined ? Number(u[3]) : undefined,
])

const floorCases = []
for (const units of unitsList) {
  for (const d of dstDates.slice(0, 8)) {
    floorCases.push([units, undefined, d], [units, 5, d], [units, 3, d])
  }
}
// 'year' with step 5 floors across 2024 fine; 'hours'/'minutes' steps are the
// interesting ones under DST.

const dayHelpers = dstDates.map((d) => [d])

const specifierCases = [
  [['year']], [['year', 'month']], [['year', 'month', 'date']],
  [['year', 'quarter']], [['year', 'week', 'day']], [['hours', 'minutes']],
  [['year', 'month', 'date', 'hours', 'minutes', 'seconds', 'milliseconds']],
  [['year', 'date']], [['month', 'date']], [['dayofyear']],
  [['year', 'month'], { year: 'Y', month: 'M' }],
  [['hours', 'minutes', 'seconds'], { hours: 'H', minutes: 'M', seconds: 'S' }],
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
]

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
        .concat(
          ['timeDay', 'timeWeek', 'timeMonth', 'timeYear'].flatMap((unit) => [
            { args: [unit, 'count', new Date('2024-01-01'), new Date('2025-01-01')].map(enc), want: enc(callIntervalCount(d3Time, unit, '2024-01-01', '2025-01-01')) },
            { args: [unit, 'range', new Date('2024-01-01'), new Date('2024-03-01')].map(enc), want: enc(callIntervalRange(d3Time, unit, '2024-01-01', '2024-03-01')) },
            { args: [unit, 'every3_range', new Date('2024-01-01'), new Date('2024-07-01')].map(enc), want: enc(callIntervalEveryRange(d3Time, unit, '2024-01-01', '2024-07-01')) },
          ]),
        ),
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
        }))),
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
]

const colorSuites = {
  parse: colorSuite('d3-color', d3Color, 'color', parseSpecs.map((s) => [s])),
  rgb: colorSuite('d3-color', d3Color, 'rgb', [
    ...parseSpecs.map((s) => [s]),
    [255, 128, 0], [255, 128, 0, 0.5], [255, 128, 0, '0.5'], [255, 128, 0, 0],
    [255.7, 128.2, 0.9, 0.1], [300, 0, 0], [-5, 0, 0], [NaN, 0, 0],
    [0, 0, 0], [255, 255, 255], [128, 128, 128, 0],
  ]),
  hsl: colorSuite('d3-color', d3Color, 'hsl', [
    ...parseSpecs.map((s) => [s]),
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

// --- write -------------------------------------------------------------------

// One file per library, so a suite's growth does not churn unrelated diffs.
const files = {
  'vega-util.json': { suites: utilSuites },
  'd3-color.json': { suites: colorSuites },
  'vega-time.json': { suites: timeSuites },
}

const destDir = join(here, '..', '..', 'core', 'testdata', 'vectors')
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
