/**
 * Vega-Lite transform -> Vega transform translation (audit C36).
 *
 * Each translation follows vega-lite 6.4.3's assemble() for the matching
 * DataFlowNode (compile/data/*.ts). Output objects are always freshly built:
 * nothing from the (cloned) input spec is shared into the emitted Vega, so a
 * later in-place edit of the emitted transforms (e.g. facet group-by
 * injection) cannot reach back into the caller's spec or into a sibling.
 */
import { pushAll, genSignal, safeKey, splitAccessPath, VLCompileError, datumPathRef, guardedPathRef, replacePathInField } from './names.js'
import { predicateExpr, paramLeaves } from './predicate.js'
import { getTimeUnitParts, normalizeTimeUnit, timeUnitTransform } from './timeunit.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

export interface ParamTest {
  param: string
  empty?: boolean
}

export interface TransformContext {
  /** Register (or find) a Vega dataset for a lookup source; returns its name. */
  addLookupSource(def: Obj): string
  /** The expression testing `datum` against a param (a selection, or a variable parameter coerced to boolean). */
  selectionTest?(pred: ParamTest): string
  /** The time-unit transforms a selection over a time-unit field needs in the pipeline that tests it. */
  selectionTimeUnits?(param: string): Array<{ as: string; field: string; timeUnit: unknown }>
  /** The dataset a lookup `from: {param}` reads: the selection's unit data, filtered by the selection. */
  addSelectionLookup?(param: string): string
}

// --- bin ---------------------------------------------------------------------

export type BinParams = Record<string, unknown>

/** vega-lite `normalizeBin` for the bin default (maxbins 10 for x/y/transforms). */
export function normalizeBin(bin: unknown, maxbinsDefault = 10): BinParams {
  if (bin === true) return { maxbins: maxbinsDefault }
  if (isObj(bin)) {
    if (!bin.maxbins && !bin.step) return { ...bin, maxbins: maxbinsDefault }
    return { ...bin }
  }
  throw new VLCompileError(`invalid bin ${JSON.stringify(bin)}`)
}

/** vega-lite `binToString`: bin_<param>_<value>... */
export function binKey(bin: BinParams): string {
  const v = (s: string): string => (/^\d/.test(s) ? '_' : '') + s.replace(/\W/g, '_')
  return `bin${Object.keys(bin).map((p) => v(`_${p}_${String(bin[p])}`)).join('')}`
}

export interface BinNames {
  start: string
  end: string
  signal: string
  extentSignal: string
}

/** Generated field/signal names for a binned field (flat-safe, identifier-safe). */
export function binNames(bin: BinParams, fieldPath: string): BinNames {
  const key = binKey(bin)
  const start = safeKey(`${key}_${fieldPath}`)
  return {
    start,
    end: `${start}_end`,
    signal: `${genSignal(key, fieldPath)}_bins`,
    extentSignal: `${genSignal(key, fieldPath)}_extent`,
  }
}

/** The Vega `extent` + `bin` transforms for a normalized bin on `fieldPath`. */
export function binTransforms(bin: BinParams, fieldPath: string, names: BinNames): Obj[] {
  const { extent, ...params } = bin
  const out: Obj[] = []
  const t: Obj = { type: 'bin', field: fieldPath, as: [names.start, names.end], signal: names.signal }
  if (extent !== undefined) t.extent = [...(extent as number[])]
  else {
    out.push({ type: 'extent', field: fieldPath, signal: names.extentSignal })
    t.extent = { signal: names.extentSignal }
  }
  for (const [k, v] of Object.entries(params)) t[k] = Array.isArray(v) ? [...v] : v
  out.push(t)
  return out
}

// --- defaults ----------------------------------------------------------------

/** vega-lite default output name of an aggregate/window field def: op_field (or op). */
function defaultAs(def: Obj): string {
  const op = def.op as string
  if (typeof def.field !== 'string') return op
  return `${op}_${splitAccessPath(def.field).join('.')}`
}

const asPair = (as: unknown, d0: string, d1: string): [string, string] => {
  // vega-lite indexes `as` (string or array alike): a string `as` is read
  // character by character, exactly as upstream does.
  const a = as as ArrayLike<string> | undefined
  return [a?.[0] ?? d0, a?.[1] ?? d1]
}

const copyArr = <T>(v: T): T => (Array.isArray(v) ? ([...v] as unknown as T) : v)

// --- implicit parse (formatparse.ts getImplicitFromFilterTransform) -----------

type Parse = 'number' | 'string' | 'date'

function implicitFromFilter(filter: unknown, out: Map<string, Parse>): void {
  if (typeof filter === 'string' || !isObj(filter)) return
  if (filter.not !== undefined) return implicitFromFilter(filter.not, out)
  for (const k of ['and', 'or'] as const) {
    if (Array.isArray(filter[k])) {
      for (const f of filter[k] as unknown[]) implicitFromFilter(f, out)
      return
    }
  }
  if (typeof filter.field !== 'string') return
  let val: unknown
  if (filter.equal !== undefined) val = filter.equal
  else if (filter.lte !== undefined) val = filter.lte
  else if (filter.lt !== undefined) val = filter.lt
  else if (filter.gt !== undefined) val = filter.gt
  else if (filter.gte !== undefined) val = filter.gte
  else if (Array.isArray(filter.range)) val = filter.range[0]
  else if (Array.isArray(filter.oneOf)) val = filter.oneOf[0]
  if (val) {
    if (isObj(val) && ['year', 'quarter', 'month', 'week', 'day', 'dayofyear', 'date', 'hours', 'minutes', 'seconds', 'milliseconds'].some((p) => p in val)) out.set(filter.field, 'date')
    else if (typeof val === 'number') out.set(filter.field, 'number')
    else if (typeof val === 'string') out.set(filter.field, 'string')
  }
  if (filter.timeUnit !== undefined) out.set(filter.field, 'date')
}

const PARSE_FN: Record<Parse, string> = { number: 'toNumber', string: 'toString', date: 'toDate' }

// --- translation -------------------------------------------------------------

export interface TranslateState {
  /** field -> how it was parsed (or 'derived'); mirrors vega-lite's ancestorParse. */
  parsed: Map<string, Parse | 'derived'>
  /** the unit has a selection that projects `_vgsid_`: an aggregate is followed by an identifier transform */
  requiresSelectionId?: boolean
}

/** Translate one VL transform. Returns the Vega transforms it expands to. */
/** impute.ts processSequence: `{start, stop, step}` key values are the signal `sequence(start, stop[, step])`. */
function imputeKeyvals(kv: unknown): unknown {
  if (Array.isArray(kv)) return copyArr(kv)
  const { start = 0, stop, step } = kv as { start?: number; stop: number; step?: number }
  return { signal: `sequence(${[start, stop, ...(step ? [step] : [])].join(',')})` }
}

/**
 * compile/data/impute.ts assemble: the Vega impute of an `{impute, key, method, value, frame, keyvals, groupby}` (a transform, or
 * the channel-level impute with the same keys). A statistical method fills the gap in a following window + formula.
 */
export function imputeTransforms(t: Obj): Obj[] {
  const out: Obj[] = []
  const impute = t.impute as string
  const method = t.method as string | undefined
  const frame = (t.frame as [number | null, number | null] | undefined) ?? [null, null]
  const it: Obj = {
    type: 'impute',
    field: impute,
    key: t.key,
    method: 'value',
    value: !method || method === 'value' ? t.value : null,
  }
  if (t.keyvals !== undefined) it.keyvals = imputeKeyvals(t.keyvals)
  if (t.groupby !== undefined) it.groupby = copyArr(t.groupby)
  out.push(it)
  if (method && method !== 'value') {
    const tmp = `imputed_${safeKey(impute)}_value`
    out.push({
      type: 'window',
      as: [tmp],
      ops: [method],
      fields: [impute],
      frame: [...frame],
      ignorePeers: false,
      ...(t.groupby !== undefined ? { groupby: copyArr(t.groupby) } : {}),
    })
    const ref = datumPathRef(impute)
    out.push({ type: 'formula', expr: `${ref} === null ? ${datumPathRef(tmp)} : ${ref}`, as: impute })
  }
  return out
}

export function translateTransform(t: Obj, ctx: TransformContext, st: TranslateState): Obj[] {
  const out: Obj[] = []
  const derived = (names: Iterable<string>): void => {
    for (const n of names) st.parsed.set(n, 'derived')
  }
  const parseFirst = (field: string, type: Parse): void => {
    // (the parse writes the value back under the joined path, `o.v`; a predicate then reads that flat key)
    const key = splitAccessPath(field).join('.')
    const prev = st.parsed.get(key)
    if (prev !== undefined) return
    st.parsed.set(key, type)
    out.push({ type: 'formula', expr: `${PARSE_FN[type]}(${guardedPathRef(field)})`, as: key })
  }

  if (t.calculate !== undefined) {
    out.push({ type: 'formula', expr: t.calculate, as: t.as })
    derived([t.as as string])
  } else if (t.filter !== undefined) {
    const implicit = new Map<string, Parse>()
    implicitFromFilter(t.filter, implicit)
    for (const [f, type] of implicit) {
      const key = splitAccessPath(f).join('.')
      const prev = st.parsed.get(key)
      if (prev === undefined || (prev !== type && prev !== 'derived')) {
        st.parsed.set(key, type)
        out.push({ type: 'formula', expr: `${PARSE_FN[type]}(${guardedPathRef(f)})`, as: key })
      }
    }
    // a selection over a time-unit field filters rows by that unit: the unit's transform is put in front of the
    // filter unless this pipeline already derived it (vega-lite TimeUnitNode.insertAsParentOf + RemoveDuplicateTimeUnits)
    for (const leaf of paramLeaves(t.filter)) {
      for (const tu of ctx.selectionTimeUnits?.(leaf.param) ?? []) {
        if (st.parsed.get(tu.as) === 'derived') continue
        parseFirst(tu.field, 'date')
        out.push(timeUnitTransform(normalizeTimeUnit(tu.timeUnit), tu.field, tu.as))
        derived([tu.as, `${tu.as}_end`])
      }
    }
    out.push({ type: 'filter', expr: predicateExpr(t.filter, ctx.selectionTest) })
  } else if (t.bin !== undefined && t.field !== undefined) {
    const field = t.field as string
    const as = t.as as string | string[]
    const asArr: [string, string] = typeof as === 'string' ? [as, `${as}_end`] : [as[0]!, as[1]!]
    const bin = normalizeBin(t.bin)
    const names = binNames(bin, field)
    const { extent, ...params } = bin
    if (extent === undefined) out.push({ type: 'extent', field: replacePathInField(field), signal: names.extentSignal })
    const bt: Obj = { type: 'bin', field: replacePathInField(field), as: asArr, signal: names.signal, extent: extent !== undefined ? [...(extent as number[])] : { signal: names.extentSignal } }
    for (const [k, v] of Object.entries(params)) bt[k] = copyArr(v)
    out.push(bt)
    derived(asArr)
  } else if (t.timeUnit !== undefined && t.field !== undefined) {
    const field = t.field as string
    parseFirst(field, 'date')
    const tu = normalizeTimeUnit(t.timeUnit)
    out.push(timeUnitTransform(tu, field, t.as as string))
    derived([t.as as string, `${t.as as string}_end`])
  } else if (t.aggregate !== undefined) {
    const ops: string[] = []
    const fields: Array<string | null> = []
    const as: string[] = []
    for (const d of t.aggregate as Obj[]) {
      ops.push(d.op as string)
      fields.push(typeof d.field === 'string' ? replacePathInField(d.field) : null)
      as.push((d.as as string | undefined) ?? defaultAs(d))
    }
    out.push({ type: 'aggregate', groupby: ((t.groupby as string[] | undefined) ?? []).map(replacePathInField), ops, fields, as })
    if (st.requiresSelectionId) out.push({ type: 'identifier', as: '_vgsid_' })
    derived(as)
  } else if (t.joinaggregate !== undefined) {
    const ops: string[] = []
    const fields: Array<string | null> = []
    const as: string[] = []
    for (const d of t.joinaggregate as Obj[]) {
      ops.push(d.op as string)
      fields.push(typeof d.field === 'string' ? d.field : null)
      as.push((d.as as string | undefined) ?? defaultAs(d))
    }
    out.push({ type: 'joinaggregate', as, ops, fields, ...(t.groupby !== undefined ? { groupby: copyArr(t.groupby) } : {}) })
    derived(as)
  } else if (t.window !== undefined) {
    const ops: string[] = []
    const fields: Array<string | null> = []
    const as: string[] = []
    const params: Array<number | null> = []
    for (const d of t.window as Obj[]) {
      ops.push(d.op as string)
      as.push((d.as as string | undefined) ?? defaultAs(d))
      params.push(d.param === undefined ? null : (d.param as number))
      fields.push(typeof d.field === 'string' ? d.field : null)
    }
    const frame = t.frame as [number | null, number | null] | undefined
    const aggOps = new Set('average count distinct max mean median min missing product q1 q3 ci0 ci1 stderr stdev stdevp sum valid values variance variancep exponential exponentialb'.split(' '))
    if (frame && frame[0] === null && frame[1] === null && ops.every((o) => aggOps.has(o))) {
      out.push({ type: 'joinaggregate', as, ops, fields, ...(t.groupby !== undefined ? { groupby: copyArr(t.groupby) } : {}) })
    } else {
      const sortFields: string[] = []
      const sortOrder: string[] = []
      for (const s of (t.sort as Obj[] | undefined) ?? []) {
        sortFields.push(s.field as string)
        sortOrder.push((s.order as string | undefined) ?? 'ascending')
      }
      out.push({
        type: 'window',
        params,
        as,
        ops,
        fields,
        sort: { field: sortFields, order: sortOrder },
        ...(t.ignorePeers !== undefined ? { ignorePeers: t.ignorePeers } : {}),
        ...(t.groupby !== undefined ? { groupby: copyArr(t.groupby) } : {}),
        ...(frame !== undefined ? { frame: [...frame] } : {}),
      })
    }
    derived(as)
  } else if (t.stack !== undefined) {
    const sortFields: string[] = []
    const sortOrder: string[] = []
    for (const s of (t.sort as Obj[] | undefined) ?? []) {
      sortFields.push(s.field as string)
      sortOrder.push((s.order as string | undefined) ?? 'ascending')
    }
    const stack = t.stack as string
    const as = Array.isArray(t.as) ? [...(t.as as string[])] : typeof t.as === 'string' ? [t.as, `${t.as}_end`] : [`${stack}_start`, `${stack}_end`]
    out.push({
      type: 'stack',
      groupby: copyArr((t.groupby as string[] | undefined) ?? []),
      field: stack,
      sort: { field: sortFields, order: sortOrder },
      as,
      offset: (t.offset as string | undefined) ?? 'zero',
    })
    derived(as)
  } else if (t.fold !== undefined) {
    const as = asPair(t.as, 'key', 'value')
    out.push({ type: 'fold', fields: copyArr(t.fold), as })
    derived(as)
  } else if (t.flatten !== undefined) {
    const flatten = t.flatten as string[]
    const given = (t.as as string[] | undefined) ?? []
    const as = flatten.map((f, i) => given[i] ?? f)
    out.push({ type: 'flatten', fields: [...flatten], as })
    derived(as)
  } else if (t.pivot !== undefined) {
    out.push({
      type: 'pivot',
      field: t.pivot,
      value: t.value,
      ...(t.limit !== undefined ? { limit: t.limit } : {}),
      ...(t.op !== undefined ? { op: t.op } : {}),
      ...(t.groupby !== undefined ? { groupby: copyArr(t.groupby) } : {}),
    })
    // pivot produces data-dependent fields: nothing downstream may assume a parse
    st.parsed.clear()
  } else if (t.sample !== undefined) {
    out.push({ type: 'sample', size: t.sample })
  } else if (t.impute !== undefined) {
    out.push(...imputeTransforms(t))
    derived([t.impute as string])
  } else if (t.lookup !== undefined) {
    const from = t.from as Obj
    const isParam = typeof from.param === 'string'
    if (isParam && ctx.addSelectionLookup === undefined) throw new VLCompileError('a lookup from a selection is not available here')
    const source = isParam ? ctx.addSelectionLookup!(from.param as string) : ctx.addLookupSource(from.data as Obj)
    const lt: Obj = { type: 'lookup', from: source, key: from.key, fields: [t.lookup] }
    if (Array.isArray(from.fields)) {
      lt.values = [...(from.fields as string[])]
      if (t.as !== undefined) lt.as = Array.isArray(t.as) ? [...(t.as as string[])] : [t.as]
    } else {
      // no fields: the whole record is nested under `as`
      // (a lookup from a selection is named after the selection when `as` is absent)
      const asName = t.as ?? (isParam ? from.param : undefined)
      if (typeof asName !== 'string') throw new VLCompileError('a lookup without `from.fields` needs `as` (a string) to name the nested record')
      lt.as = [asName]
    }
    // vega-lite 6.4.3 forwards `default` only when truthy (a 0/''/false default is dropped upstream)
    if (t.default) lt.default = t.default
    out.push(lt)
    derived((lt.as as string[] | undefined) ?? ((from.fields as string[] | undefined) ?? []))
  } else if (t.density !== undefined) {
    const as = asPair(t.as, 'value', 'density')
    const { density, as: _as, resolve, ...rest } = t
    void _as
    const kde: Obj = { type: 'kde', field: density }
    for (const [k, v] of Object.entries(rest)) kde[k] = copyArr(v)
    kde.as = as
    kde.resolve = (resolve as string | undefined) ?? 'shared'
    out.push(kde)
    derived(as)
  } else if (t.loess !== undefined) {
    const as = asPair(t.as, t.on as string, t.loess as string)
    const { loess, on, as: _as, ...rest } = t
    void _as
    const lt: Obj = { type: 'loess', x: on, y: loess }
    for (const [k, v] of Object.entries(rest)) lt[k] = copyArr(v)
    lt.as = as
    out.push(lt)
    derived(as)
  } else if (t.regression !== undefined) {
    const as = asPair(t.as, t.on as string, t.regression as string)
    const { regression, on, as: _as, ...rest } = t
    void _as
    const rt: Obj = { type: 'regression', x: on, y: regression }
    for (const [k, v] of Object.entries(rest)) rt[k] = copyArr(v)
    rt.as = as
    out.push(rt)
    derived(as)
  } else if (t.quantile !== undefined) {
    const as = asPair(t.as, 'prob', 'value')
    const { quantile, as: _as, ...rest } = t
    void _as
    const qt: Obj = { type: 'quantile', field: quantile }
    for (const [k, v] of Object.entries(rest)) qt[k] = copyArr(v)
    qt.as = as
    out.push(qt)
    derived(as)
  } else if (t.extent !== undefined) {
    out.push({ type: 'extent', field: t.extent, signal: t.param })
  } else {
    throw new VLCompileError(`unsupported transform ${JSON.stringify(Object.keys(t))}`)
  }
  return out
}

/** Translate a whole VL transform list (each element validated beforehand). */
export function translateTransforms(list: Obj[], ctx: TransformContext, st: TranslateState): Obj[] {
  const out: Obj[] = []
  for (const t of list) pushAll(out, translateTransform(t, ctx, st))
  return out
}

export { getTimeUnitParts }
