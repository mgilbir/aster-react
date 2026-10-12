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
const d3Format = await loadPkg('d3-format')
const d3Array = await loadPkg('d3-array')
const vegaFormat = await loadPkg('vega-format')
const vegaExpression = await loadPkg('vega-expression')
const vegaInterpreter = await loadPkg('vega-interpreter')
const ve = vegaExpression
const vi = vegaInterpreter

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

// --- the d3-format + vega-format surface @aster/core reimplements ------------

const formatSpecs = [
  'd', 'f', '.2f', '.0f', 'g', '.3g', 's', '.2s', 'e', '.2e', '%', '.1%',
  'r', '.3r', 'p', '.2p', '~g', '~s', ',.2f', ',d', '08.3f', '>10.2f',
  '<10.2f', '^10.2f', '=10.2f', '+$, .2f', '#x', '#o', '#X', 'b', 'n', '',
  '.12g', '.1f', 'c', '5', '.5', ',', '~', 'x', 'X', 'o',
]
const invalidFormatSpecs = ['zzz', '.zzf', '10.2.3f', '#', '+', 'q']

const formatValues = [
  0, -0, 1, -1, 1.5, -1.5, 12345.678, 0.5, 2 / 3, 100, 255, 0.000001, 1e-7,
  1e15, 1e21, 1e22, NaN, Infinity, -Infinity, -1234.5678, 987654321.123,
  0.1, 1e-21, 42,
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
    cases: formatSpecs.flatMap((spec) => formatValues.map((v) => ({
      args: [spec, v].map(enc),
      want: enc(call((s, v) => d3Format.format(s)(v), [spec, v])),
    }))),
  },
  // d3.formatPrefix(spec, value)(x)
  formatPrefix: {
    oracle: oracleOf('d3-format'),
    kind: 'apply1',
    tz: TZ_UTC,
    cases: ['.2s', 's', '.0s', '.3s'].flatMap((spec) =>
      [0, 1, 999, 1000, 1500, 1e6, 2.5e9, -3.7e12, 7e15].flatMap((ref) =>
        [ref, ref * 0.5, 1].map((v) => ({
          args: [spec, ref, v].map(enc),
          want: enc(call((s, r, v) => d3Format.formatPrefix(s, r)(v), [spec, ref, v])),
        })),
      )),
  },
  formatSpecifier: {
    oracle: oracleOf('d3-format'),
    kind: 'specifier',
    tz: TZ_UTC,
    cases: [...formatSpecs, ...invalidFormatSpecs].map((spec) => ({
      args: [spec].map(enc),
      want: enc(call(specifierProjection, [spec])),
    })),
  },
  precisionFixed: fnSuiteTz('d3-format', [[1], [0.1], [0.01], [0.001], [0.25], [1e-7], [10], [0], [NaN]], (s) => d3Format.precisionFixed(s)),
  precisionPrefix: fnSuiteTz('d3-format', [[1, 1], [0.1, 100], [0.001, 2.5e9], [10, 1e3], [0.25, 50], [1e-7, 1e9]], (s, v) => d3Format.precisionPrefix(s, v)),
  precisionRound: fnSuiteTz('d3-format', [[1, 10], [0.1, 100], [0.001, 2.5e9], [10, 1e3], [0.25, 50], [0.5, 0.75]], (s, m) => d3Format.precisionRound(s, m)),
  // d3-array's tickStep backs formatSpan and (later) the scale ticks
  tickStep: fnSuiteTz('d3-array', [[0, 1, 10], [0, 10, 3], [1, 0, 10], [0, 1, 5], [0.5, 1.5, 7], [-1, 1, 4], [0, 100, 7], [1.2, 3.4, 6], [0, 1, 1]], (a, b, c) => d3Array.tickStep(a, b, c)),
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
      .concat([
        // multi-format objects pick a specifier per tick interval
        { year: '%Y', month: '%b', date: '%d' },
        { seconds: ':%S', minutes: '%H:%M', hours: '%H %p' },
        {},
      ].flatMap((spec) => dstDates.map((d) => [spec, d])))),
  localeUtcFormat: tzSuite('apply1', 'vega-format', localeFns, 'localeUtcFormat', TZ_UTC,
    ['%Y-%m-%dT%H:%M:%S', '%B %Y', '%H:%M', '%j', '%V', '%s'].flatMap((spec) => dstDates.map((d) => [spec, d]))),
  localeTimeParse: tzSuite('fn', 'vega-format', localeFns, 'localeTimeParse', TZ_DST, [
    ['%Y-%m-%d', '2024-03-10'], ['%m/%d/%Y', '03/10/2024'], ['%B %d, %Y', 'March 10, 2024'],
    ['%b %d, %Y', 'Mar 10, 2024'], ['%H:%M', '14:30'], ['%I %p', '2 PM'],
    ['%j', '070'], ['%U', '10'], ['%V', '11'], ['%G-W11-4', '2024-W11-4'],
    ['%Y-%m-%dT%H:%M:%S', '2024-03-10T14:30:45'], ['%Y-%m-%dT%H:%M:%S%Z', '2024-03-10T14:30:45+0200'],
    ['%Y-%m-%dT%H:%M:%S%Z', '2024-03-10T14:30:45Z'], ['%s', '1710082245'], ['%Q', '1710082245000'],
    ['%A', 'Sunday'], ['%p', 'PM'], ['garbage', '2024-03-10'], ['%Y-%m-%d', 'not a date'],
    ['%Y-%m-%d', '2024-03-10T12:00:00'], ['%d/%m/%Y', '10/13/2024'],
  ]),
  localeUtcParse: tzSuite('fn', 'vega-format', localeFns, 'localeUtcParse', TZ_UTC, [
    ['%Y-%m-%dT%H:%M:%S', '2024-03-10T14:30:45'], ['%Y-%m-%d', '2024-03-10'],
    ['%H:%M', '14:30'], ['%s', '1710082245'], ['%Y-%m-%dT%H:%M:%S%Z', '2024-03-10T14:30:45+0200'],
  ]),
}

// --- the expression-language surface @aster/core reimplements ------------------
// Two oracles: vega-expression's parser (the AST is the contract) and
// vega-interpreter's evaluator (language semantics with its own default
// function table). Function-table semantics beyond that core are validated by
// the per-library vectors and the SVG conformance corpus.

const parseCodes = [
  '1', '1.5', '.5', '0x1f', '017', '1e3', '1E+3', '"abc"', "'abc'", '"a\\u00e9b"',
  'true', 'false', 'null', 'NaN', 'PI', 'E', 'MAX_VALUE',
  'a', 'datum', 'item', 'event', '$signal', '_value', 'if',
  'a + b', 'a - b', 'a * b', 'a / b', 'a % b', 'a === b',
  'a || b', 'a && b', '!a', '-a', '+a', '~a',
  'a < b', 'a > b', 'a <= b', 'a >= b', 'a == b', 'a != b', 'a === b', 'a !== b',
  'a & b', 'a | b', 'a ^ b', 'a << b', 'a >> b', 'a >>> b',
  'a + b * c', '(a + b) * c', 'a + b + c', 'a < b && c > d || !e',
  'a ? b : c', 'a ? b : c ? d : e', 'a ? b ? c : d : e',
  'datum.value', 'datum["a b"]', 'datum[0]', 'datum.a.b', 'datum["a"]["b"]',
  'datum.map.length', 'fn(a, b)', 'fn()', 'datum.fn(a)', 'fn(a)(b)',
  '[1, 2, 3]', '[]', '[a, [b, c]]', '{a: 1}', '{"a b": 1, c: d}', '{}',
  'if (a, b, c)', 'upper(datum.name)', '_space(1)', 'datum.list[0] + datum.list[1]',
  'a in b', 'a instanceof b', 'indatum("table", datum.x)',
  '/ab+c/g', '/[a-z]/i', '/\\d/', '/x/u', '/(?:)/', '""', "''",
  '  a  +  b  ', 'a\tb', 'a b'.replace(' ', ''), '(((a)))', '$signal',
]

const parseErrorCodes = [
  '1 +', 'a = 1', 'a, b', 'function () {}', '++a', 'a++', 'typeof a', 'void 0',
  'delete a.b', 'var a', 'new A()', '"unterminated', "'x", '1x', '09', '0x',
  '#', 'a..b', '{a: 1, a: 2}', 'while (a)', 'case 1', '\\u0041', '.',
]

const evalLangCodes = [
  '1 + 2 * 3', '(1 + 2) * 3', '2 * 3 + 1', '10 / 4', '7 % 3', '1 + "a"', '"a" + 1',
  '"1" == 1', '"1" === 1', 'null == undefined', 'null === undefined', 'NaN === NaN',
  '1/0', '-0 === 0', '1/-0', '!"a"', '~0', '-"5"', '+true', 'true ? 1 : 2',
  'false ? 1 : 2', 'null || "fallback"', '0 && "never"', '"a" && "b"',
  '1 < 2 < 3', '3 > 2 > 1', '"b" > "a"', '"a" > 1', 'undefined + 1', 'null + 1',
  '[1, 2, 3]', '[1, 2, 3][1]', '({a: 1}).a', '({a: 1, b: "x"}).b', '({})',
  'PI', 'E', 'LN10', 'MAX_VALUE', 'NaN', 'abs(-5)', 'max(1, 2, 3)', 'min(4, 2)',
  'round(2.5)', 'ceil(1.2)', 'floor(-1.2)', 'pow(2, 10)', 'sqrt(16)', 'isNaN(NaN)',
  'isFinite(1)', 'upper("abc")', 'lower("ABC")', 'trim("  x  ")', 'split("a,b", ",")',
  'indexof("abc", "b")', 'lastindexof("abc", "c")', 'substring("abcdef", 1, 3)',
  'length([1, 2, 3])', 'join(["a", "b"], "-")', 'reverse([1, 2, 3])', 'sort([3, 1, 2])',
  'parseFloat("1.5")', 'parseInt("12px")', 'replace("aaa", "a", "b")',
  'year(datetime(2024, 2, 10))', 'month(datetime(2024, 2, 10))',
  'utcyear(datetime(2024, 2, 10))', 'date(datetime(2024, 2, 10))',
  'regexp("a+")', 'test(/b/, "abc")', 'test("b", "abc")',
  'encodeURIComponent("a b")', 'clamp(5, 0, 3)', 'clamp(-5, 0, 3)',
]

const evalDatum = {
  a: 1, b: 2, 'a b': 3, list: [1, 2], nested: { deep: true }, name: 'hello',
  s: '5', flag: true,
}
const evalParams = { shift: 5, bound: 10 }

const evalCodes = [
  'datum.a + datum.b', 'datum["a b"]', 'datum.list[0] + datum.list[1]',
  'datum.nested.deep', 'datum.name + "!"', 'upper(datum.name)',
  'datum.a > 1 ? "big" : "small"', 'datum.s * 2', '+datum.s',
  'datum.a + $shift', 'datum.b * $bound', 'datum.flag ? datum.a : datum.b',
  'if (datum.a > 0, datum.a, -datum.a)', 'max(datum.a, datum.b, $shift)',
  'length(datum.list)', 'datum.missing', 'datum.nested.missing',
  'clamp(datum.a + $shift, 0, $bound)',
]

const evalErrorCodes = [
  'undefinedFn(1)', 'a.b.c', 'null.x', '{}.x.y',
  'Function("return 1")()', 'datum.constructor', '({toString: 1})',
  'eval("1+1")', 'setTimeout(null, 0)',
  'a in b', // Binary has no 'in' op upstream; pin the resulting throw
]

const expressionSuites = {
  parse: {
    oracle: oracleOf('vega-expression'),
    kind: 'ast',
    tz: TZ_UTC,
    cases: parseCodes.map((code) => ({ args: [code].map(enc), want: enc(call(vegaExpression.parseExpression, [code])) })),
  },
  parseError: {
    oracle: oracleOf('vega-expression'),
    kind: 'ast',
    tz: TZ_UTC,
    cases: parseErrorCodes.map((code) => ({ args: [code].map(enc), want: enc(call(vegaExpression.parseExpression, [code])) })),
  },
  evalLang: {
    oracle: oracleOf('vega-interpreter'),
    kind: 'eval',
    tz: TZ_UTC,
    cases: evalLangCodes.map((code) => ({
      args: [code, null, null].map(enc),
      want: enc(call((c, d, p) => callEval(ve, vi, c, d, p), [code, undefined, {}])),
    })),
  },
  evalDatum: {
    oracle: oracleOf('vega-interpreter'),
    kind: 'eval',
    tz: TZ_UTC,
    cases: evalCodes.map((code) => ({
      args: [code, evalDatum, evalParams].map(enc),
      want: enc(call((c, d, p) => callEval(ve, vi, c, d, p), [code, evalDatum, evalParams])),
    })),
  },
  evalSecurity: {
    oracle: oracleOf('vega-interpreter'),
    kind: 'eval',
    tz: TZ_UTC,
    cases: evalErrorCodes.map((code) => ({
      args: [code, evalDatum, {}].map(enc),
      want: enc(call((c, d, p) => callEval(ve, vi, c, d, p), [code, evalDatum, {}])),
    })),
  },
}

// Evaluate `code` through the pinned vega-interpreter with an empty host
// function table (its own default table supplies the core functions).
function callEval(ve, vi, code, datum, params) {
  const ast = ve.parseExpression(code)
  const evalParam = vi.expressionInterpreter.parameter({ functions: {} }, { ast })
  return evalParam(datum, params)
}

const files = {
  'vega-util.json': { suites: utilSuites },
  'd3-color.json': { suites: colorSuites },
  'vega-time.json': { suites: timeSuites },
  'd3-format.json': { suites: formatSuites },
  'vega-format.json': { suites: localeSuites },
  'vega-expression.json': { suites: expressionSuites },
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
