/**
 * Development only: a warning when the rows a chart was given are changed in place between two evaluations.
 *
 * The rows a chart is given (a spec's inline `values` and `datasets`, the host's `data`, `dataChanges`, a stream's inputs) are the
 * caller's, and they are treated as immutable: a chart compares them by identity, so a row edited, replaced, added or removed in the
 * array it already has is seen only by what happens to evaluate again -- the chart can end up inconsistent, as vega's can. To change
 * the data, pass a new array, or say what changed (`dataChanges`, a stream's `append` / `data`).
 *
 * Every chart (a session, and the React shells over it) keeps a watch: for each top-level dataset, a fingerprint of a bounded,
 * deterministic sample of its rows (at most SAMPLE_ROWS rows, evenly spaced, first and last included; at most SAMPLE_FIELDS own
 * fields of each) and the array's length. When the chart evaluates or renders again with the very same array, a changed fingerprint
 * means the array was changed in place: one warning per chart and dataset, through the chart's logger. A dataset named in that
 * evaluation's change description (`dataChanges`, `dataPulse`, `changedDatasets`) is expected to have changed: its fingerprint is
 * taken again. A field that is a getter is not called (its presence is fingerprinted, not its value); a Proxy row is read through its
 * `ownKeys` and `getOwnPropertyDescriptor` traps, never `get`. The cost is O(sample) per dataset, not O(rows), and a change outside
 * the sample (in a field past the first SAMPLE_FIELDS, or a row between the sampled ones, of an array of the same length) is not seen.
 *
 * None of this exists in a production build. Every caller is written
 *
 *   try { if (process.env.NODE_ENV !== 'production') check() } catch (e) { if (typeof process !== 'undefined') throw e }
 *
 * - Bundlers replace `process.env.NODE_ENV` in development as in production (Vite's dev server and builds, webpack, esbuild's
 *   `define`), so in a development bundle the check runs even though the page has no `process` object; it must not be gated on
 *   `typeof process`, which is false there (an earlier form was, and never ran under Vite).
 * - In a production bundle the test folds to `false` and the whole statement to nothing: the calls, this module and its strings
 *   are removed (scripts/check-bundle-shaking.mjs asserts it for every documented import pattern). Rollup is the exception when it
 *   writes a classic script or runs without a minifier: it keeps any call written inside a `try` (its try/catch deoptimization),
 *   so this module stays in the bundle as dead code behind a `false` guard. No guard both runs under Vite's dev server and leaves
 *   Rollup nothing to keep: a `typeof process` test is false there, and the plain test throws where there is no `process`.
 * - Imported unbundled (ES modules from a CDN) there is no `process`: reading it throws a ReferenceError, caught there, so nothing
 *   is checked. Wherever `process` exists (Node, tests) an error of the check itself is rethrown, not hidden.
 * scripts/dev-warning-bundlers.test.mjs bundles a real app with the published dist in esbuild's and Vite's development modes and
 * runs it in a window with no `process`.
 */

import { consoleLogger, type Logger } from './logger.js'
import { dataInputOf, specList, valuesSignal } from './spec-structure.js'
import { ownGet } from './util.js'

const SAMPLE_ROWS = 16
const SAMPLE_FIELDS = 8

/** A field that is a getter: fingerprinted as present, never called. */
const ACCESSOR = Symbol('accessor')

interface Print {
  rows: readonly unknown[]
  length: number
  /** per sampled row: its index, the row, its first fields and their values */
  picks: Array<{ at: number; row: unknown; fields: string[]; values: unknown[] }>
}

function printOf(rows: readonly unknown[]): Print {
  const n = rows.length
  const picks: Print['picks'] = []
  const count = Math.min(n, SAMPLE_ROWS)
  let last = -1
  for (let k = 0; k < count; k++) {
    const at = count === 1 ? 0 : Math.round((k * (n - 1)) / (count - 1))
    if (at === last) continue
    last = at
    const row = rows[at]
    picks.push({ at, row, ...printRow(row) })
  }
  return { rows, length: n, picks }
}

/** A row's first fields and their values (a getter is present, never called). */
function printRow(row: unknown): { fields: string[]; values: unknown[] } {
  const fields: string[] = []
  const values: unknown[] = []
  if (row !== null && typeof row === 'object') {
    for (const f of Object.keys(row)) {
      if (fields.length === SAMPLE_FIELDS) break
      const d = Object.getOwnPropertyDescriptor(row, f)
      fields.push(f)
      values.push(d === undefined ? undefined : 'value' in d ? d.value : ACCESSOR)
    }
  }
  return { fields, values }
}

function samePrint(a: Print, b: Print): boolean {
  if (a.length !== b.length || a.picks.length !== b.picks.length) return false
  for (let i = 0; i < a.picks.length; i++) {
    const p = a.picks[i]!
    const q = b.picks[i]!
    if (p.at !== q.at || !Object.is(p.row, q.row) || p.fields.length !== q.fields.length) return false
    for (let j = 0; j < p.fields.length; j++) if (p.fields[j] !== q.fields[j] || !Object.is(p.values[j], q.values[j])) return false
  }
  return true
}

/**
 * Whether a sampled row of `before` that `rows` (a new array) holds at the same index -- the very row object -- holds other values
 * now: rows changed in place and handed back in a new array (`rows[3].v = 3; setData([...rows])`), which the diff takes for unchanged
 * rows (the same objects) as it takes the same array.
 */
function rowsChangedInPlace(before: Print, rows: readonly unknown[]): boolean {
  for (const p of before.picks) {
    if (rows[p.at] !== p.row || p.row === null || typeof p.row !== 'object') continue
    // (field by field, as `printRow` reads them, without making a print: this runs on every evaluation given a new array)
    let j = 0
    for (const f in p.row) {
      if (!Object.hasOwn(p.row, f)) continue
      if (j === SAMPLE_FIELDS) break
      if (f !== p.fields[j]) return true
      const d = Object.getOwnPropertyDescriptor(p.row, f)
      if (!Object.is(d === undefined ? undefined : 'value' in d ? d.value : ACCESSOR, p.values[j])) return true
      j++
    }
    if (j !== p.fields.length) return true
  }
  return false
}

interface Watch {
  prints: Map<string, Print>
  warned: Set<string>
}

/** The watch of a chart, by the object that owns it (a session; a React chart shares one between its sessions). */
const WATCHES = new WeakMap<object, Watch>()

function watchOf(owner: object): Watch {
  let w = WATCHES.get(owner)
  if (w === undefined) WATCHES.set(owner, (w = { prints: new Map(), warned: new Set() }))
  return w
}

/** @internal Make `to` keep its fingerprints in `from`'s watch: two sessions of one chart warn once between them. */
export function shareRowWatch(from: object, to: object): void {
  WATCHES.set(to, watchOf(from))
}

/** The arrays a Vega-Lite compile copied the user's rows from (registered by `@aster-charts/vl`): a compiled array stands for them. */
const ORIGINS_KEY = Symbol.for('@aster-charts/row-origins')
const originOf = (rows: readonly unknown[]): { rows: readonly unknown[]; vl: boolean } => {
  const origins = (globalThis as { [ORIGINS_KEY]?: WeakMap<object, readonly unknown[]> })[ORIGINS_KEY]
  const origin = origins?.get(rows)
  return origin === undefined ? { rows, vl: false } : { rows: origin, vl: true }
}

/** What an evaluation is given: the host's rows and its description of what changed. */
export interface RowWatchInput {
  data?: Record<string, unknown> | null
  dataChanges?: Record<string, unknown> | null
  dataPulse?: Record<string, unknown> | ReadonlyMap<string, unknown> | null
  changedDatasets?: readonly string[] | null
  logger?: Logger
}

/**
 * @internal Compare the rows `spec` and `input` give a chart with the ones it was given last (see the module comment), warn once
 * per dataset whose array was changed in place, and keep the new fingerprints. Called only behind a development-build check.
 */
export function checkChartRows(owner: object, spec: unknown, input: RowWatchInput): void {
  const w = watchOf(owner)
  const hinted = new Set<string>(input.changedDatasets ?? [])
  for (const k of Object.keys(input.dataChanges ?? {})) hinted.add(k)
  const pulse = input.dataPulse
  if (pulse instanceof Map) for (const k of pulse.keys()) hinted.add(k)
  else if (pulse) for (const k of Object.keys(pulse)) hinted.add(k)
  const host = input.data ?? undefined
  const seen = new Set<string>()
  const look = (name: string, rows: unknown): void => {
    if (!Array.isArray(rows) || seen.has(name)) return
    seen.add(name)
    const { rows: arr, vl } = originOf(rows)
    const prev = w.prints.get(name)
    const next = printOf(arr)
    w.prints.set(name, next)
    if (prev === undefined || hinted.has(name) || w.warned.has(name)) return
    if (prev.rows === arr ? samePrint(prev, next) : !rowsChangedInPlace(prev, arr)) return
    w.warned.add(name)
    const what = vl ? 'the inline `data.values` (or `datasets` entry) of the Vega-Lite spec' : `dataset "${name}"`
    ;(input.logger ?? consoleLogger).warn(
      `[aster] the rows of ${what} were changed in place since the last render (the same array, with rows edited, replaced, added or removed). ` +
      'A chart treats the rows it is given as immutable: only what evaluates again sees such a change, so the chart can be inconsistent. ' +
      'A row object edited and handed back in a new array is changed in place too. ' +
      `Pass a new array instead, or describe the change with \`dataChanges\` (a stream: \`push\` an \`append\` or a \`data\` snapshot). Dataset: "${name}".`,
    )
  }
  const spec_ = spec as { data?: unknown } | null
  for (const d of specList(spec_?.data)) {
    if (!d || typeof d !== 'object') continue
    const def = d as { name?: unknown; values?: unknown; url?: unknown; source?: unknown }
    if (typeof def.name !== 'string' || dataInputOf(def) === 'source') continue
    const given = host ? ownGet(host as Record<string, unknown>, def.name) : undefined
    look(def.name, given !== undefined ? given : valuesSignal(def.values) === undefined ? def.values : undefined)
  }
  if (host) for (const [name, rows] of Object.entries(host)) look(name, rows)
}

/**
 * @internal Whether the spec object a chart is evaluated with again is still what its skeleton says: one edited in place is not seen
 * (the session takes the skeleton it made for that object, see session.ts), and a development build says so, once per chart. Called
 * only behind a development-build check.
 */
export function checkSpecInPlace(owner: object, spec: unknown, skeleton: string, input: RowWatchInput, skeletonOf: (spec: never) => string): void {
  const w = watchOf(owner)
  if (w.warned.has(SPEC_KEY) || skeletonOf(spec as never) === skeleton) return
  w.warned.add(SPEC_KEY)
  ;(input.logger ?? consoleLogger).warn(
    '[aster] the spec object was changed in place since the last render. A chart treats the spec it is given as immutable (it is ' +
    'compared by identity: an object it has seen is not read again), so this change is not drawn. Pass a new object instead.',
  )
}
const SPEC_KEY = '\u0000spec'
