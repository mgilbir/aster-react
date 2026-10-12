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
 * The oracle packages are devDependencies of @aster/conformance, pinned to
 * the exact versions the runtime previously depended on. Run with:
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

/** Call fn, capturing a throw as a tagged value. */
function call(fn, args) {
  try {
    return fn(...args)
  } catch (err) {
    return { $: 'throw', name: err.name }
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

// --- write -------------------------------------------------------------------

const suites = {}
for (const [name, suite] of Object.entries(utilSuites)) suites[name] = suite

const out = { suites }
const dest = join(here, '..', '..', 'core', 'testdata', 'vectors', 'vega-util.json')
mkdirSync(dirname(dest), { recursive: true })
writeFileSync(dest, JSON.stringify(out, null, 2) + '\n')

let n = 0
for (const s of Object.values(suites)) n += s.cases.length
console.log(`[vectors] wrote ${n} cases across ${Object.keys(suites).length} suites -> ${dest}`)
