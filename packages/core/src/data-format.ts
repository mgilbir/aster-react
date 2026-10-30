/**
 * Reading data in the formats a Vega `data` entry names: choosing the reader by `format.type`, then converting the
 * columns named by `format.parse` (to numbers, booleans, dates, ...) or inferred from the values (`parse: 'auto'`).
 *
 * Text formats that need a real parser (csv/tsv/dsv, topojson) and fetching URLs live in the `@aster/core/load` addon,
 * which registers its readers in `dataFormatRegistry`; json is built in.
 */
import { dataFormatRegistry } from './registry.js'
import { currentLocale } from './locale.js'
import { safeGet, toBoolean, toDate, toNumber, toString } from './util.js'

/** The converter for each column type a `parse` entry can name. */
export const typeParsers: Record<string, (v: unknown) => unknown> = {
  boolean: toBoolean,
  integer: toNumber,
  number: toNumber,
  date: toDate,
  string: toString,
  unknown: (v) => v,
}

export interface DataFormatSpec {
  type?: string
  parse?: Record<string, string> | string
  property?: string
  feature?: string
  mesh?: string
  filter?: string
  delimiter?: string
  header?: unknown[]
}

/** The converter for one `parse` entry: a column type, or `date:<pattern>` / `utc:<pattern>` (the pattern may be quoted). */
function converterFor(field: string, type: string): (v: unknown) => unknown {
  if (type && (type.startsWith('date:') || type.startsWith('utc:'))) {
    let pattern = type.slice(type.indexOf(':') + 1)
    const quote = pattern[0]
    if ((quote === "'" || quote === '"') && pattern[pattern.length - 1] === quote) pattern = pattern.slice(1, -1)
    const locale = currentLocale()
    const parse = type.startsWith('utc:') ? locale.utcParse(pattern) : locale.timeParse(pattern)
    return (v) => parse(v as string)
  }
  if (!Object.hasOwn(typeParsers, type)) throw new Error(`[aster] illegal format pattern: ${field}:${type}`)
  return typeParsers[type]!
}

/**
 * Convert the columns `parse` names in every row (`'auto'`: every column of the first row, by the type its values
 * suggest). A date pattern turns a cell into a Date, or null where it does not match. The rows are copied.
 */
export function coerceRows(rows: Record<string, unknown>[], parse: Record<string, string> | string): Record<string, unknown>[] {
  if (!rows.length) return rows
  const types = parse === 'auto' ? inferTypes(rows, Object.keys(rows[0]!)) : parse
  const columns = Object.entries(types).map(([field, type]) => [field, converterFor(field, type)] as const)
  return rows.map((row) => {
    const out = { ...row }
    for (const [field, convert] of columns) out[field] = convert(out[field])
    return out
  })
}

// -- inferring column types -------------------------------------------------------------------------------------------

const isPresent = (v: unknown): boolean => v != null && v === v
const looksNumeric = (v: unknown): boolean => !Number.isNaN(+(v as number)) && !(v instanceof Date)

/** The types a column can be, most specific first, with what a value must be to be one. */
const CANDIDATES: ReadonlyArray<readonly [type: string, accepts: (v: unknown) => boolean]> = [
  ['boolean', (v) => v === 'true' || v === 'false' || v === true || v === false],
  ['integer', (v) => looksNumeric(v) && Number.isInteger(+(v as number))],
  ['number', looksNumeric],
  ['date', (v) => !Number.isNaN(Date.parse(v as string))],
]

/**
 * The type of a column: the first of boolean, integer, number and date that every value (missing ones, null or NaN,
 * excepted) fits; `string` when none; `unknown` for no values at all; and `boolean` when every value is missing.
 * `field` picks the column out of row objects.
 */
export function inferType(values: unknown[], field?: string): string {
  if (!values || !values.length) return 'unknown'
  const open = CANDIDATES.map(() => true)
  let remaining = CANDIDATES.length
  for (const row of values) {
    const value = field ? (row as Record<string, unknown> | undefined)?.[field] : row
    if (!isPresent(value)) continue
    for (let k = 0; k < CANDIDATES.length; k++) {
      if (open[k] && !CANDIDATES[k]![1](value)) {
        open[k] = false
        if (--remaining === 0) return 'string'
      }
    }
  }
  return CANDIDATES[open.indexOf(true)]![0]
}

export function inferTypes(data: unknown[], fields: string[]): Record<string, string> {
  const types: Record<string, string> = {}
  for (const field of fields) types[field] = inferType(data, field)
  return types
}

/**
 * Read data per a vega data `format` spec — the same contract as
 * vega-loader's `read`: dispatch by `format.type`, then apply `parse`
 * coercion. Object arrays pass through the coercion only; string inputs are
 * parsed by the registered reader for the type (json is built in; csv/tsv/
 * dsv/topojson come from the `@aster/core/load` addon).
 */
export function readData(data: unknown, format?: DataFormatSpec): Record<string, unknown>[] {
  const schema = format ?? {}
  const type = schema.type || 'json'
  // vega-loader.read always dispatches by format.type; the readers themselves
  // handle strings vs pre-parsed objects (the JSON reader passes arrays
  // through and wraps a single non-array value like vega's array()).
  const reader = dataFormatRegistry.get(type)
  if (!reader) {
    throw new Error(`[aster] this spec reads "${type}" data; load the addon first: await import("@aster/core/load")`)
  }
  // Pre-parsed row arrays (inline values, or values inlined by loadSpecData
  // after a URL fetch) pass through; only raw strings/objects hit the reader.
  const preParsed = Array.isArray(data) && (type === 'json' || schema.type === undefined)
  let rows: Record<string, unknown>[]
  if (preParsed) {
    rows = data as Record<string, unknown>[]
  } else if (typeof data === 'string' || (data != null && typeof data === 'object')) {
    rows = reader(data, schema as Record<string, unknown>)
  } else {
    rows = []
  }
  // vega-loader.read deletes the d3-dsv `columns` annotation before returning
  if (Object.hasOwn(rows, 'columns')) delete (rows as { columns?: unknown }).columns
  if (schema.parse) rows = coerceRows(rows, schema.parse)
  return ingestRows(rows)
}

/**
 * vega-dataflow `ingest`: a datum that is not an object is wrapped as `{data: datum}` (`[12, 23]` is two rows
 * `{data: 12}`, `{data: 23}`). Returns the input array when every row is already an object, so the common case
 * costs one scan and no copy.
 */
export function ingestRows<T>(rows: readonly T[]): Record<string, unknown>[] {
  const n = rows.length
  for (let i = 0; i < n; ++i) {
    const v = rows[i]
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) {
      const out: Record<string, unknown>[] = new Array(n)
      for (let j = 0; j < n; ++j) {
        const r = rows[j]
        out[j] = r !== null && (typeof r === 'object' || typeof r === 'function') ? (r as Record<string, unknown>) : { data: r }
      }
      return out
    }
  }
  return rows as unknown as Record<string, unknown>[]
}

// Built-in JSON reader (no dependencies; `property` is a dotted path).
dataFormatRegistry.set('json', (data, format) => {
  let parsed: unknown
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data)
    } catch (e) {
      throw new Error(`[aster] invalid JSON data: ${(e as Error).message}`)
    }
  } else {
    parsed = data
  }
  const prop = format.property as string | undefined
  if (prop) {
    let v: unknown = parsed
    for (const seg of String(prop).split('.')) {
      if (v == null) return []
      v = safeGet(v, seg)
    }
    parsed = v
  }
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[]
  // vega wraps a single non-array value (e.g. an inline Topology) into [value]
  return parsed != null && typeof parsed === 'object' ? [parsed as Record<string, unknown>] : []
})
