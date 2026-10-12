/**
 * Vega data-format semantics (port of vega-loader's `read`, `parse` and the
 * JSON reader — oracle-identical type coercion via the ported converters in
 * `./util.js`, replayed against the pinned oracle's vectors).
 *
 * Text formats that need real parsers (csv/tsv/dsv via d3-dsv, topojson via
 * topojson-client) and URL fetching live in the `@aster/core/load` addon,
 * which registers them into `dataFormatRegistry`.
 */
import { dataFormatRegistry } from './registry.js'
import { toBoolean, toDate, toNumber, toString } from './util.js'

/** vega-loader's typeParsers, backed by the ported converters (oracle-vector-tested). */
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

/**
 * Apply `format.parse` type coercion to parsed rows (vega-loader read.js).
 * Handles `parse: 'auto'` (type inference) and `date:`/`utc:` patterns are
 * delegated to the registered reader when the core cannot resolve them.
 */
export function coerceRows(rows: Record<string, unknown>[], parse: Record<string, string> | string): Record<string, unknown>[] {
  if (!rows.length) return rows
  let types: Record<string, string> = parse === 'auto'
    ? inferTypes(rows, Object.keys(rows[0]!))
    : (parse as Record<string, string>)
  const fields = Object.keys(types)
  const parsers = fields.map((field) => {
    const type = types[field] as string
    if (!typeParsers[type]) throw new Error(`[aster] illegal format pattern: ${field}:${type}`)
    return typeParsers[type]!
  })
  const out = rows.map((r) => ({ ...r }))
  for (let i = 0; i < out.length; ++i) {
    const datum = out[i]!
    for (let j = 0; j < fields.length; ++j) {
      const field = fields[j]!
      datum[field] = parsers[j]!(datum[field])
    }
  }
  return out
}

/** d3-array-free type inference (port of vega-loader type.js inferType). */
const isValid = (v: unknown) => v != null && v === v
const isBooleanStr = (v: unknown) => v === 'true' || v === 'false' || v === true || v === false
const isDateStr = (v: unknown) => !Number.isNaN(Date.parse(v as string))
const isNumberStr = (v: unknown) => !Number.isNaN(+(v as number)) && !(v instanceof Date)
const isIntegerStr = (v: unknown) => isNumberStr(v) && Number.isInteger(+(v as string))
const typeTests = [isBooleanStr, isIntegerStr, isNumberStr, isDateStr]
const typeList = ['boolean', 'integer', 'number', 'date']

export function inferType(values: unknown[], field?: string): string {
  if (!values || !values.length) return 'unknown'
  const n = values.length
  const m = typeTests.length
  const a = typeTests.map((_, i) => i + 1)
  for (let i = 0, t = 0, j = 0, value: unknown; i < n; ++i) {
    value = field ? (values[i] as Record<string, unknown>)?.[field] : values[i]
    for (j = 0; j < m; ++j) {
      if (a[j] && isValid(value) && !typeTests[j]!(value)) {
        a[j] = 0
        ++t
        if (t === typeTests.length) return 'string'
      }
    }
  }
  return typeList[a.reduce((u, v) => (u === 0 ? v : u), 0) - 1]!
}

export function inferTypes(data: unknown[], fields: string[]): Record<string, string> {
  return fields.reduce<Record<string, string>>((types, field) => {
    types[field] = inferType(data, field)
    return types
  }, {})
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
  return rows
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
      v = (v as Record<string, unknown>)[seg]
    }
    parsed = v
  }
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[]
  // vega wraps a single non-array value (e.g. an inline Topology) into [value]
  return parsed != null && typeof parsed === 'object' ? [parsed as Record<string, unknown>] : []
})
