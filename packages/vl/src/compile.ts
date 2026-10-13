/**
 * A from-scratch Vega-Lite compiler: Vega-Lite -> Vega.
 *
 * Coverage grows mark/channel by mark/channel, each step verified by rendering
 * parity against the pinned vega-lite oracle (the conformance harness renders
 * both and compares canonicalized SVG). Spec names may differ from the
 * oracle's; the rendered output must not.
 */

// --- spec types (structural, loose) ------------------------------------------

export type VLSpec = Record<string, unknown>

export interface ChannelDef {
  field?: string
  type?: string
  aggregate?: string
  bin?: boolean | Record<string, unknown>
  timeUnit?: string
  sort?: unknown
  stack?: unknown
  axis?: unknown
  scale?: Record<string, unknown>
  legend?: unknown
  value?: unknown
  title?: unknown
  format?: unknown
  condition?: unknown
  datum?: unknown
  expr?: unknown
  [k: string]: unknown
}

export interface FieldDef {
  channel: string
  field: string
  type: string
  aggregate?: string
  bin?: boolean | Record<string, unknown>
  timeUnit?: string
  sort?: unknown
  stack?: unknown
  axis?: Record<string, unknown> | null
  scale?: Record<string, unknown>
  legend?: Record<string, unknown> | null
  title?: unknown
  raw: ChannelDef
}

const POSITIONAL = new Set(['x', 'y', 'x2', 'y2', 'xError', 'xError2', 'yError', 'yError2'])
const C = {
  blue: '#4c78a8',
  barPaddingInner: 0.1,
  pointPadding: 0.5,
  pointOpacity: 0.7,
  bandSize: 5,
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function array(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v == null ? [] : [v]
}

// --- entry -------------------------------------------------------------------

export function compile(input: VLSpec): VLSpec {
  const spec = input
  if (isObject(spec.layer) || Array.isArray(spec.layer)) return compileLayered(spec)
  if (isObject(spec.facet) || isObject(spec.spec)) throw new Error('[aster/vl] facet composition not supported yet')
  if (spec.concat || spec.hconcat || spec.vconcat) throw new Error('[aster/vl] concat composition not supported yet')
  return compileUnit(spec)
}

// --- layer composition -------------------------------------------------------

/** Compile a multi-layer spec: shared source + casts, per-layer pipelines,
 * unioned positional scales, one mark group per layer. */
function compileLayered(spec: VLSpec): VLSpec {
  const layers = (Array.isArray(spec.layer) ? spec.layer : [spec.layer]) as VLSpec[]
  const width = spec.width ?? 200
  const height = spec.height ?? 200

  interface ParsedLayer {
    l: VLSpec
    mark: string
    markRaw: unknown
    markSize?: number
    fields: FieldDef[]
    orient: string
    pipeline: Record<string, unknown>[]
    seriesFields: FieldDef[]
    dataName: string
  }
  const parsed: ParsedLayer[] = layers.map((l) => {
    const markRaw = l.mark
    const mark = typeof markRaw === 'string' ? markRaw : isObject(markRaw) ? (markRaw.type as string) : 'point'
    const encoding = {
      ...(isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}),
      ...(isObject(l.encoding) ? (l.encoding as Record<string, unknown>) : {}),
    }
    const fields: FieldDef[] = []
    for (const [channel, def] of Object.entries(encoding)) {
      const f = parseChannel(channel, def)
      if (f) fields.push(f)
    }
    let orient = 'vertical'
    if (mark === 'bar' || mark === 'area' || mark === 'rule' || mark === 'tick') {
      const xDef = fields.find((f) => f.channel === 'x')
      const yDef = fields.find((f) => f.channel === 'y')
      const markOrient = isObject(markRaw) ? (markRaw.orient as string | undefined) : undefined
      if (markOrient) orient = markOrient
      else if (yDef && isDiscreteType(yDef.type) && (!xDef || !isDiscreteType(xDef.type))) orient = 'horizontal'
    }
    return { l, mark, markRaw, markSize: isObject(markRaw) ? (markRaw.size as number | undefined) : undefined, fields, orient, pipeline: [], seriesFields: [], dataName: 'data_0' }
  })

  const out: Record<string, unknown> = {}
  if (spec.$schema) out.$schema = 'https://vega.github.io/schema/vega/v6.json'
  out.autosize = spec.autosize ?? 'pad'
  out.background = spec.background ?? 'white'
  out.padding = spec.padding ?? 5
  out.width = width
  out.height = height
  out.style = 'cell'

  // data: shared source + casts (data_0), then one derived dataset per layer
  // that needs a pipeline; layers without transforms read data_0 directly
  const castDone = new Set<string>()
  const castTransforms: Record<string, unknown>[] = []
  for (const p of parsed) {
    const d = buildData(p.l, p.fields, p.mark, p.orient, castDone)
    castTransforms.push(...d.casts)
    p.pipeline = d.pipeline
    p.seriesFields = d.seriesFields
  }
  const data: Record<string, unknown>[] = [{ ...(isObject(spec.data) ? spec.data : {}), name: 'source_0' }]
  const castsName = castTransforms.length ? 'data_0' : 'source_0'
  if (castTransforms.length) data.push({ name: 'data_0', source: 'source_0', transform: castTransforms })
  let nextData = castTransforms.length ? 1 : 0
  const perLayerScales: ScaleSpec[][] = []
  const marks: Record<string, unknown>[] = []
  parsed.forEach((p, i) => {
    if (p.pipeline.length) {
      const dataName = `data_${++nextData}`
      data.push({ name: dataName, source: castsName, transform: p.pipeline })
      p.dataName = dataName
    } else {
      p.dataName = castsName
    }
    const builtMarks = buildMarks(p.l, p.fields, p.mark, p.orient, p.dataName, p.markSize) as Record<string, unknown>[] & { overlayData?: Record<string, unknown> }
    for (const m of builtMarks) if ((m as { name?: string }).name === 'marks') (m as { name?: string }).name = `layer_${i}_marks`
    marks.push(...builtMarks)
    if (builtMarks.overlayData) data.push(builtMarks.overlayData)
    perLayerScales.push(buildScales(p.l, p.fields, p.mark, p.orient, p.dataName, width, height, p.seriesFields))
  })
  out.data = data
  out.marks = marks

  const scales = mergeLayerScales(perLayerScales)
  out.scales = scales

  // axes: one per positional channel, from the first layer that encodes it,
  // with the axis title unioned across layers (vega-lite joins ', ')
  const axes: Record<string, unknown>[] = []
  for (const ch of ['x', 'y'] as const) {
    const layersWith = parsed.filter((p) => p.fields.some((f) => f.channel === ch && f.axis !== null))
    if (!layersWith.length) continue
    const base = layersWith[0]!
    const titles = layersWith
      .map((p) => {
        const f = p.fields.find((q) => q.channel === ch)!
        return ((f.axis as Record<string, unknown> | null | undefined)?.title as string) ?? (channelTitle(f) as string)
      })
      .filter(Boolean)
    const uniq = Array.from(new Set(titles))
    const axisFields = base.fields.filter((f) => f.channel === ch).map((f) =>
      uniq.length > 1 ? ({ ...f, title: uniq.join(', ') } as FieldDef) : f,
    )
    for (const a of buildAxes(axisFields, base.mark, base.orient, scales as ScaleSpec[])) axes.push(a)
  }
  if (axes.length) out.axes = axes
  const legends: Record<string, unknown>[] = []
  for (const p of parsed) {
    for (const lg of buildLegends(p.fields, p.mark, isObject(p.markRaw) ? (p.markRaw.opacity as number | undefined) : undefined, isObject(p.markRaw) && p.markRaw.filled === true)) {
      if (!legends.some((x) => JSON.stringify(x) === JSON.stringify(lg))) legends.push(lg)
    }
  }
  if (legends.length) out.legends = legends
  if (spec.title) out.title = spec.title
  if (spec.description) out.description = spec.description
  return out
}

/** Union per-layer positional scale domains into a single scale per name. */
function mergeLayerScales(perLayer: ScaleSpec[][]): ScaleSpec[] {
  const byName = new Map<string, ScaleSpec[]>()
  for (const ls of perLayer) {
    for (const s of ls) {
      const list = byName.get(s.name)
      if (list) list.push(s)
      else byName.set(s.name, [s])
    }
  }
  const out: ScaleSpec[] = []
  for (const [name, list] of byName) {
    const first = list[0]!
    if (list.length === 1 || list.every((s) => JSON.stringify(s) === JSON.stringify(first))) {
      out.push(first)
      continue
    }
    if (name === 'x' || name === 'y') {
      // union domain: collect the per-layer domain field entries
      const entries: Array<{ data: string; field: string }> = []
      const collect = (domain: unknown): void => {
        if (domain == null || typeof domain !== 'object') return
        const d = domain as { data?: string; field?: string; fields?: unknown }
        if (typeof d.data === 'string' && typeof d.field === 'string') {
          entries.push({ data: d.data, field: d.field })
        } else if (Array.isArray(d.fields)) {
          for (const f of d.fields) collect(f)
        }
      }
      for (const s of list) collect(s.domain)
      const sameData = entries.length > 0 && entries.every((e) => e.data === entries[0]!.data)
      out.push({
        ...first,
        domain: sameData
          ? { data: entries[0]!.data, fields: Array.from(new Set(entries.map((e) => e.field))) }
          : { fields: entries },
      })
    } else {
      out.push(first)
    }
  }
  return out
}

// --- channel parsing ---------------------------------------------------------

function parseChannel(channel: string, def: unknown): FieldDef | null {
  if (def == null) return null
  if (Array.isArray(def)) throw new Error(`[aster/vl] channel arrays not supported: ${channel}`)
  const raw = def as ChannelDef
  if (raw.field === undefined) {
    if (raw.aggregate === 'count') {
      // count has no field: synthesise one for the pipeline
      return {
        channel,
        field: '__count',
        type: normalizeType(raw.type, raw),
        aggregate: 'count',
        axis: raw.axis === null ? null : isObject(raw.axis) ? (raw.axis as Record<string, unknown>) : undefined,
        scale: isObject(raw.scale) ? (raw.scale as Record<string, unknown>) : undefined,
        legend: raw.legend === null ? null : isObject(raw.legend) ? (raw.legend as Record<string, unknown>) : undefined,
        title: raw.title,
        raw,
      }
    }
    return null
  }
  const type = normalizeType(raw.type, raw)
  return {
    channel,
    field: raw.field as string,
    type,
    aggregate: raw.aggregate as string | undefined,
    bin: raw.bin,
    timeUnit: raw.timeUnit as string | undefined,
    sort: raw.sort,
    stack: raw.stack,
    axis: raw.axis === null ? null : isObject(raw.axis) ? (raw.axis as Record<string, unknown>) : undefined,
    scale: isObject(raw.scale) ? (raw.scale as Record<string, unknown>) : undefined,
    legend: raw.legend === null ? null : isObject(raw.legend) ? (raw.legend as Record<string, unknown>) : undefined,
    title: raw.title,
    raw,
  }
}

function normalizeType(t: unknown, def: ChannelDef): string {
  if (typeof t === 'string') return t === 'quantitative' || t === 'nominal' || t === 'ordinal' || t === 'temporal' || t === 'geojson' ? t : t
  // infer: aggregate/bin/timeUnit imply quantitative unless temporal
  if (def.timeUnit) return 'temporal'
  if (def.bin) return 'quantitative'
  if (def.aggregate) return 'quantitative'
  return 'nominal'
}

const isDiscreteType = (t: string) => t === 'nominal' || t === 'ordinal'
const isContinuousScaleType = (t: string) => t === 'linear' || t === 'log' || t === 'pow' || t === 'sqrt' || t === 'symlog' || t === 'time' || t === 'utc'

// --- titles ------------------------------------------------------------------

export function channelTitle(def: FieldDef): unknown {
  if (def.title !== undefined) return def.title
  if (def.bin) return `${def.field} (binned)`
  if (def.timeUnit) return `${def.field} (${timeUnitShort(def.timeUnit)})`
  if (def.aggregate) {
    if (def.aggregate === 'count') return 'Count of Records'
    const op = def.aggregate
    const label = op.charAt(0).toUpperCase() + op.slice(1)
    return `${label} of ${def.field}`
  }
  return def.field
}

const TIME_UNIT_LABELS: Record<string, string> = {
  year: 'year', quarter: 'quarter', month: 'month', week: 'week', date: 'date',
  day: 'day', dayofyear: 'day of year', hours: 'hours', minutes: 'minutes',
  seconds: 'seconds', milliseconds: 'milliseconds',
  yearquarter: 'year-quarter', yearmonth: 'year-month', yearmonthdate: 'year-month-date',
  yearweek: 'year-week', yeardayofyear: 'year-day of year', quartermonth: 'quarter-month',
  monthdate: 'month-date', monthday: 'month-day', hoursminutes: 'hours-minutes',
  minutesseconds: 'minutes-seconds', secondsmilliseconds: 'seconds-milliseconds',
  datehours: 'date-hours', dayhours: 'day-hours', dayminutes: 'day-minutes',
  dateminutes: 'date-minutes', daysseconds: 'days-seconds', dateseconds: 'date-seconds',
}
function timeUnitShort(u: string): string {
  return TIME_UNIT_LABELS[u] ?? u
}

// --- data pipeline -----------------------------------------------------------

interface DataPipeline {
  sourceName: string
  transforms: Record<string, unknown>[]
  /** type-cast formulas only (shared across layers in layered compilation) */
  casts: Record<string, unknown>[]
  /** everything after the casts (bin/theta/user/aggregate/stack pipelines) */
  pipeline: Record<string, unknown>[]
  /** the name of the final derived dataset */
  dataName: string
  seriesFields: FieldDef[]
}

function buildData(spec: VLSpec, fields: FieldDef[], mark: string, orient: string, castDoneIn?: Set<string>): DataPipeline {
  let seriesFields: FieldDef[] = []
  const source: Record<string, unknown> = isObject(spec.data) ? { ...spec.data } : {}
  const sourceName = (source.name as string) ?? 'source_0'
  source.name = sourceName
  const casts: Record<string, unknown>[] = []
  const pipeline: Record<string, unknown>[] = []
  const castDone = castDoneIn ?? new Set<string>()

  // type casts (formula) — the oracle emits them around impute/stack pipelines
  // (quantitative -> toNumber, temporal -> toDate)

  // binning: extent + bin transforms ahead of any aggregate
  const binFields = fields.filter((f) => f.bin)
  const binSignals = new Map<string, { startField: string; endField: string; binsSignal: string }>()
  for (const f of binFields) {
    const maxbins = isObject(f.bin) && (f.bin.maxbins as number | undefined) ? (f.bin.maxbins as number) : 10
    const base = `bin_maxbins_${maxbins}_${f.field}`
    const extentSignal = `${base}_extent`
    const startField = `${base}`
    const endField = `${base}_end`
    const binsSignal = `${base}_bins`
    pipeline.push({ type: 'extent', field: f.field, signal: extentSignal })
    pipeline.push({
      type: 'bin',
      field: f.field,
      as: [startField, endField],
      signal: binsSignal,
      extent: { signal: extentSignal },
      maxbins,
    })
    binSignals.set(f.field, { startField, endField, binsSignal })
  }

  // arc marks: theta stacking (pie layout). vega-lite stacks the theta
  // measure over the whole data (no groupby), sorted by the series field,
  // then filters invalid theta values.
  const thetaDef = fields.find((f) => f.channel === 'theta' && f.field)
  if (mark === 'arc' && thetaDef) {
    const colorF = fields.find((f) => f.channel === 'color' && f.field)
    pipeline.push({
      type: 'stack',
      groupby: [],
      field: thetaDef.field,
      sort: colorF ? { field: [colorF.field], order: ['ascending'] } : { field: [], order: [] },
      as: [`${thetaDef.field}_start`, `${thetaDef.field}_end`],
      offset: 'zero',
    })
    pipeline.push({ type: 'filter', expr: `isValid(datum[${JSON.stringify(thetaDef.field)}]) && isFinite(+datum[${JSON.stringify(thetaDef.field)}])` })
  }

  // channel roles shared by the pipeline stages below
  const yDef = fields.find((f) => f.channel === 'y')
  const xDef = fields.find((f) => f.channel === 'x')
  const stackable = mark === 'bar' || mark === 'area'
  const measureChannel = orient === 'vertical' ? 'y' : 'x'
  const dimensionChannel = orient === 'vertical' ? 'x' : 'y'
  const measure = orient === 'vertical' ? yDef : xDef
  const dimension = dimensionChannel === 'x' ? xDef : yDef
  const continuousDimension = dimension != null && !isDiscreteType(dimension.type)

  // the oracle skips casts only in the discrete-dimension stack+filter pipeline
  const skipCasts = binFields.length > 0 ||
    ((mark === 'bar' || mark === 'area') &&
    !fields.some((f) => f.aggregate) &&
    fields.some((f) => f.channel === (orient === 'vertical' ? 'y' : 'x') && f.type === 'quantitative') &&
    !continuousDimension)
  if (!skipCasts) {
    for (const f of fields) {
      if (castDone.has(f.field)) continue
      castDone.add(f.field)
      if (f.type === 'quantitative') {
        casts.push({ type: 'formula', expr: `toNumber(datum[${JSON.stringify(f.field)}])`, as: f.field })
      } else if (f.type === 'temporal') {
        casts.push({ type: 'formula', expr: `toDate(datum[${JSON.stringify(f.field)}])`, as: f.field })
      }
    }
  }
  // user transforms (calculate/filter/flatten/fold/window/...): they pass
  // through as vega transforms ahead of any encoding pipeline
  const userTransforms = Array.isArray(spec.transform) ? (spec.transform as Record<string, unknown>[]) : []
  for (const t0 of userTransforms) {
    let t = t0
    const type0 = t.type as string
    if (type0 === undefined && Array.isArray(t.window)) {
      // vega-lite window form: {window: [{op, as, params?}], sort, groupby}
      const winOps: unknown[] = []
      const winFields: unknown[] = []
      const winAs: unknown[] = []
      const winParams: unknown[] = []
      for (const w of t.window as Record<string, unknown>[]) {
        winOps.push(w.op)
        winFields.push(w.field ?? null)
        winAs.push(w.as ?? w.op)
        winParams.push(w.param ?? w.params ?? null)
      }
      t = {
        type: 'window',
        ops: winOps,
        fields: winFields,
        as: winAs,
        params: winParams,
        sort: (t.sort as { field?: string | string[]; order?: string | string[] }) ?? {},
        groupby: t.groupby ?? [],
      }
    }
    const type = t.type as string
    if (type === undefined) {
      // a bare VL transform object like {filter: expr} / {calculate: expr, as}
      if (t.filter != null) { pipeline.push({ type: 'filter', expr: t.filter }); continue }
      if (t.calculate != null) { pipeline.push({ type: 'formula', expr: t.calculate, as: t.as }); continue }
      if (t.fold != null) { pipeline.push({ type: 'fold', fields: t.fold, as: t.as ?? ['key', 'value'] }); continue }
      if (t.flatten != null) { pipeline.push({ type: 'flatten', fields: t.flatten, as: t.as }); continue }
      if (t.density != null) {
        pipeline.push({ type: 'kde', field: t.density, as: t.as ?? ['value', 'density'], resolve: 'shared' })
        continue
      }
      for (const k of ['flatten', 'collect', 'countpattern', 'cross', 'joinaggregate', 'kde', 'loess', 'lookup', 'pivot', 'quantile', 'regression', 'stack', 'window', 'impute', 'bin', 'timeunit', 'aggregate', 'sample', 'density']) {
        if ((t as Record<string, unknown>)[k] != null) {
          // bare-keyed VL transforms: {quantile: field} / {kde: field} etc.
          // compile to vega {type, field, ...} forms
          const fielded = new Set(['quantile', 'kde', 'regression', 'loess', 'bin', 'timeunit', 'countpattern', 'pivot'])
          const next: Record<string, unknown> = { ...t, type: k }
          if (fielded.has(k) && next.field == null) next.field = (t as Record<string, unknown>)[k]
          delete next[k]
          pipeline.push(next)
          break
        }
      }
      continue
    }
    if (type === 'calculate') {
      pipeline.push({ type: 'formula', expr: t.expr, as: t.as })
    } else {
      pipeline.push(t)
    }
  }

  // timeUnit: the timeunit transform floors each date to the unit
  const tuFields = fields.filter((f) => f.timeUnit && f.field)
  for (const f of tuFields) {
    pipeline.push({
      field: f.field,
      type: 'timeunit',
      units: timeUnitUnits(f.timeUnit!),
      as: [timeUnitField(f), `${timeUnitField(f)}_end`],
    })
  }

  const hasAggregate = fields.some((f) => f.aggregate)

  if (hasAggregate || binFields.length) {
    const groupby: string[] = []
    const fieldsOut: Record<string, unknown>[] = []
    let hasCount = false
    for (const f of fields) {
      if (f.bin) {
        const bin = binSignals.get(f.field)!
        groupby.push(bin.startField, bin.endField)
        continue
      }
      if (f.aggregate) {
        if (f.aggregate === 'count') {
          hasCount = true
        } else {
          fieldsOut.push({ op: f.aggregate, field: f.field, as: aggregateAs(f) })
        }
      } else if (!f.bin && (f.channel === dimensionChannel || f.channel === 'color' || f.channel === 'detail')) {
        groupby.push(aggFieldName(f))
      }
    }
    // a binned measure without an explicit aggregate counts records
    const measureBinned = measure?.bin
    if (fieldsOut.length === 0 && (hasCount || (measureBinned && !hasAggregate))) hasCount = true
    if (hasCount) fieldsOut.push({ op: 'count', as: '__count', field: null })
    if (fieldsOut.length || groupby.length) {
      pipeline.push({ type: 'aggregate', groupby, ops: fieldsOut.map((o) => o.op), fields: fieldsOut.map((o) => o.field ?? null), as: fieldsOut.map((o) => o.as) })
    }
    // binned pipelines filter invalid bins
    if (binFields.length) {
      const bf = binFields[0]!
      const bin = binSignals.get(bf.field)!
      pipeline.push({ type: 'filter', expr: `isValid(datum[${JSON.stringify(bin.startField)}]) && isFinite(+datum[${JSON.stringify(bin.startField)}])` })
    }
  } else if (stackable && measure && measure.type === 'quantitative' && !measure.bin) {
    // stacked bar/area: continuous dimensions impute gaps; discrete ones filter
    const dimField = dimensionChannel === 'x' ? xDef?.field : yDef?.field
    const colorDef = fields.find((f) => f.channel === 'color')
    const detailDefs = fields.filter((f) => f.channel === 'detail')
    seriesFields = [colorDef, ...detailDefs].filter(Boolean) as FieldDef[]
    const stackField = measure.field
    const startEnd = [`${stackField}_start`, `${stackField}_end`]
    if (continuousDimension) {
      pipeline.push({
        type: 'impute',
        field: stackField,
        groupby: seriesFields.map((f) => aggFieldName(f)),
        key: dimField!,
        method: 'value',
        value: 0,
      })
    }
    const xOffsetPresent = fields.some((f) => f.channel === 'xOffset' || f.channel === 'yOffset')
    pipeline.push({
      type: 'stack',
      groupby: xOffsetPresent ? [dimField, ...seriesFields.map((f) => aggFieldName(f))].filter(Boolean) : [dimField].filter(Boolean),
      field: stackField,
      sort: { field: seriesFields.map((f) => aggFieldName(f)), order: seriesFields.map(() => 'descending') },
      as: startEnd,
      offset: measureStackOffset(measure),
    })
    if (!continuousDimension) {
      const f = JSON.stringify(stackField)
      pipeline.push({ type: 'filter', expr: `isValid(datum[${f}]) && isFinite(+datum[${f}])` })
    }
  }

  // with user transforms, vl filters invalid values out of the measure fields
  if (userTransforms.length) {
    const quantFields = fields.filter((f) => f.type === 'quantitative' && f.field && f.field !== '__count')
    if (quantFields.length) {
      const parts = quantFields.map((f) => {
        const f2 = JSON.stringify(f.field)
        return `isValid(datum[${f2}]) && isFinite(+datum[${f2}])`
      })
      const last = pipeline[pipeline.length - 1]!
      if (last.type !== 'filter' || last.expr !== parts.join(' && ')) {
        pipeline.push({ type: 'filter', expr: parts.join(' && ') })
      }
    }
  }

  const transforms = [...casts, ...pipeline]
  const dataName = transforms.length ? 'data_0' : sourceName
  const data: Record<string, unknown>[] = [source]
  if (transforms.length) data.push({ name: 'data_0', source: sourceName, transform: transforms })
  return { sourceName, transforms, casts, pipeline, dataName, seriesFields }
}

function aggregateAs(f: FieldDef): string {
  return `${f.aggregate}_${f.field}`
}

function aggFieldName(f: FieldDef): string {
  if (f.bin) {
    const maxbins = isObject(f.bin) && (f.bin.maxbins as number | undefined) ? (f.bin.maxbins as number) : 10
    return `bin_maxbins_${maxbins}_${f.field}`
  }
  if (f.timeUnit) return timeUnitField(f)
  if (f.aggregate === 'count') return f.field === '__count' ? '__count' : '__count'
  if (f.aggregate) return aggregateAs(f)
  return f.field
}

const TU_UNITS: Record<string, [string, string]> = {
  year: ['year', '0'], quarter: ['quarter', '0'], month: ['month', '1'], week: ['week', '0'],
  date: ['date', '1'], day: ['day', '0'], dayofyear: ['dayofyear', '0'],
  hours: ['hours', '0'], minutes: ['minutes', '0'], seconds: ['seconds', '0'],
  milliseconds: ['milliseconds', '0'],
}

/** d3/vl timeunit -> datetime(...) formula parts. Returns [expr, as] or null. */
function timeUnitFormula(u: string, field: string): [string, string] | null {
  const f = JSON.stringify(field)
  const unit = (name: string) => `${name}(datum[${f}])`
  const args: string[] = []
  let has = false
  for (const [unitName, argIdx] of [['year', 0], ['quarter', 1], ['month', 2], ['date', 3], ['day', 4], ['hours', 5], ['minutes', 6], ['seconds', 7], ['milliseconds', 8]] as const) {
    if (u.includes(unitName as string)) {
      args.push(unit(unitName as string))
      has = true
    } else {
      args.push(argIdx === 0 ? '0' : '0')
    }
  }
  if (!has) return null
  void TU_UNITS
  return [`datetime(${args.join(', ')})`, `${u}_${field}`]
}

function timeUnitField(f: FieldDef): string {
  return `${f.timeUnit}_${f.field}`
}

const TIME_UNIT_UNITS: Record<string, string[]> = {
  year: ['year'], quarter: ['quarter'], month: ['month'], week: ['year', 'week'],
  date: ['year', 'month', 'date'], day: ['year', 'month', 'date'], dayofyear: ['month', 'date'],
  hours: ['year', 'month', 'date', 'hours'], minutes: ['year', 'month', 'date', 'hours', 'minutes'],
  seconds: ['year', 'month', 'date', 'hours', 'minutes', 'seconds'],
  milliseconds: ['year', 'month', 'date', 'hours', 'minutes', 'seconds', 'milliseconds'],
  yearquarter: ['year', 'quarter'], yearmonth: ['year', 'month'],
  yearmonthdate: ['year', 'month', 'date'], yearweek: ['year', 'week'],
  yeardayofyear: ['year', 'dayofyear'], quartermonth: ['quarter', 'month'],
  monthdate: ['year', 'month', 'date'], monthday: ['month', 'date'],
  hoursminutes: ['hours', 'minutes'], minutesseconds: ['minutes', 'seconds'],
  secondsmilliseconds: ['seconds', 'milliseconds'], datehours: ['date', 'hours'],
  dayhours: ['day', 'hours'], dayminutes: ['day', 'minutes'],
  dateminutes: ['date', 'minutes'], daysseconds: ['day', 'seconds'],
  dateseconds: ['date', 'seconds'],
}
function timeUnitUnits(u: string): string[] {
  return TIME_UNIT_UNITS[u] ?? [u]
}

/** vega-lite's tickMinStep signal for a time unit: the duration of one unit. */
function timeUnitMinStepSignal(u: string): string | null {
  const dt = (y: number, mo: number) => `datetime(${y}, ${mo}, 1, 0, 0, 0, 0)`
  switch (u) {
    case 'year': case 'yearquarter': case 'yearmonth': case 'yearmonthdate':
    case 'yearweek': case 'yeardayofyear':
      return `${dt(2002, 0)} - ${dt(2001, 0)}`
    case 'quarter': case 'quartermonth':
      return `${dt(2001, 3)} - ${dt(2001, 0)}`
    case 'month': case 'monthdate': case 'monthday':
      return `${dt(2001, 1)} - ${dt(2001, 0)}`
    case 'week': case 'date': case 'day': case 'dayofyear':
      return null
    default:
      return null
  }
}

function measureStackOffset(measure: FieldDef): unknown {
  if (measure.stack === 'wiggle') return 'zero'
  if (measure.stack != null) return isObject(measure.stack) ? (measure.stack.offset ?? 'zero') : measure.stack
  return 'zero'
}

// --- scales ------------------------------------------------------------------

interface ScaleSpec {
  name: string
  type: string
  domain: unknown
  range?: unknown
  zero?: boolean
  nice?: unknown
  padding?: number
  paddingInner?: number
  reverse?: boolean
  [k: string]: unknown
}

function positionalScaleType(mark: string, def: FieldDef): string {
  if (def.scale?.type) return def.scale.type as string
  if (def.type === 'temporal') return 'time'
  if (def.type === 'nominal') return mark === 'bar' || mark === 'rect' || mark === 'tick' ? 'band' : 'point'
  if (def.type === 'ordinal') return mark === 'bar' || mark === 'rect' || mark === 'tick' ? 'band' : 'point'
  return 'linear'
}

function buildScales(spec: VLSpec, fields: FieldDef[], mark: string, orient: string, dataName: string, width: unknown, height: unknown, series: FieldDef[] = []): ScaleSpec[] {
  const scales: ScaleSpec[] = []
  const xDef = fields.find((f) => f.channel === 'x')
  const yDef = fields.find((f) => f.channel === 'y')
  const size = 1

  for (const [channel, def, range] of [
    ['x', xDef, [0, { signal: 'width' }]],
    ['y', yDef, [{ signal: 'height' }, 0]],
  ] as const) {
    if (!def) continue
    void size
    const type = positionalScaleType(mark, def)
    // discrete y scales run top-to-bottom; continuous y scales are reversed
    const effRange = channel === 'y' && (type === 'band' || type === 'point') ? [0, { signal: 'height' }] : range
    const sc: ScaleSpec = {
      name: channel,
      type,
      domain: positionalDomain(def, dataName, mark, orient),
      range: effRange,
    }
    if (type === 'linear' || type === 'log') {
      const zeroDefault = type === 'log' ? false : zeroDefaultFor(mark, channel, orient)
      if (type === 'linear' || def.scale?.zero != null) {
        sc.zero = (def.scale?.zero as boolean | undefined) ?? zeroDefault
      }
      sc.nice = (def.scale?.nice as unknown) ?? true
      if (def.bin) {
        const maxbins = isObject(def.bin) && (def.bin.maxbins as number | undefined) ? (def.bin.maxbins as number) : 10
        sc.bins = { signal: `bin_maxbins_${maxbins}_${def.field}_bins` }
      }
      const measureChannel = orient === 'vertical' ? 'y' : 'x'
      if ((mark === 'bar' || mark === 'rect') && channel !== measureChannel) sc.padding = 5
      // binned scales: no zero/nice; domain comes from bin start/end
      if (def.bin) {
        delete sc.zero
        delete sc.nice
        delete sc.padding
      }
    } else if (type === 'band') {
      const hasOffset = fields.some((f) => f.channel === 'xOffset' || f.channel === 'yOffset')
      const defaultInner = mark === 'tick' ? 0.25 : hasOffset ? 0.2 : C.barPaddingInner
      const defaultOuter = mark === 'tick' ? 0.125 : hasOffset ? 0.2 : C.barPaddingInner / 2
      sc.paddingInner = (def.scale?.paddingInner as number | undefined) ?? defaultInner
      sc.paddingOuter = (def.scale?.paddingOuter as number | undefined) ?? defaultOuter
      sc.padding = def.scale?.padding as number | undefined
    } else if (type === 'point') {
      sc.padding = (def.scale?.padding as number | undefined) ?? C.pointPadding
    }
    if (def.scale) {
      for (const [k, v] of Object.entries(def.scale)) {
        if (k === 'type' || k === 'zero' || k === 'nice' || k === 'padding' || k === 'paddingInner') continue
        sc[k] = v
      }
    }
    scales.push(sc)
  }

  // size scale
  const sizeDef = fields.find((f) => f.channel === 'size' && f.field)
  if (sizeDef) {
    if (isDiscreteType(sizeDef.type)) {
      scales.push({
        name: 'size',
        type: 'point',
        domain: sortedDomain(sizeDef, dataName),
        range: [4, 361],
      })
    } else {
      const sc: ScaleSpec = {
        name: 'size',
        type: 'linear',
        domain: sizeDef.scale?.domain ?? { data: dataName, field: aggFieldName(sizeDef) },
        range: sizeDef.scale?.range ?? [4, 361],
        zero: true,
      }
      if (sizeDef.scale) {
        for (const [k, v] of Object.entries(sizeDef.scale)) {
          if (k === 'type' || k === 'domain' || k === 'range') continue
          sc[k] = v
        }
      }
      scales.push(sc)
    }
  }
  // opacity scale
  const opacityDefS = fields.find((f) => f.channel === 'opacity' && f.field)
  if (opacityDefS) {
    scales.push({
      name: 'opacity',
      type: 'linear',
      domain: { data: dataName, field: aggFieldName(opacityDefS) },
      range: [0.3, 0.8],
      zero: false,
    })
  }
  // xOffset/yOffset band scales
  for (const ch of ['xOffset', 'yOffset'] as const) {
    const offDef = fields.find((f) => f.channel === ch && f.field)
    if (offDef) {
      // the offset scale spans the dimension band's inner width
      const dimChannel = ch === 'xOffset' ? 'x' : 'y'
      scales.push({
        name: ch,
        type: 'band',
        domain: sortedDomain(offDef, dataName),
        range: [0, { signal: `bandwidth('${dimChannel}')` }],
      })
    }
  }

  // shape scale
  const shapeDefS = fields.find((f) => f.channel === 'shape' && f.field)
  if (shapeDefS) {
    scales.push({
      name: 'shape',
      type: 'ordinal',
      domain: sortedDomain(shapeDefS, dataName),
      range: 'symbol',
    })
  }

  // theta scale (arc marks): the stacked start/end fields span [0, 2pi]
  const thetaDef = fields.find((f) => f.channel === 'theta' && f.field)
  if (mark === 'arc' && thetaDef) {
    scales.push({
      name: 'theta',
      type: 'linear',
      domain: { data: dataName, fields: [`${thetaDef.field}_start`, `${thetaDef.field}_end`] },
      range: [0, 6.283185307179586],
      zero: true,
    })
  }

  // color scale
  const colorDef = fields.find((f) => f.channel === 'color' && f.field)
  if (colorDef) {
    if (isDiscreteType(colorDef.type)) {
      scales.push({
        name: 'color',
        type: 'ordinal',
        domain: sortedDomain(colorDef, dataName),
        range: (colorDef.scale?.range as unknown) ?? colorDef.scale?.scheme ?? 'category',
      })
    } else {
      scales.push({
        name: 'color',
        type: 'linear',
        domain: { data: dataName, field: aggFieldName(colorDef) },
        range: 'ramp',
        zero: false,
      })
    }
  }

  void width
  void height
  return scales
}

function zeroDefaultFor(mark: string, channel: string, orient: string): boolean {
  const measureChannel = orient === 'vertical' ? 'y' : 'x'
  if (channel === measureChannel) return true
  // the base axis of rect/line/area/rule/tick marks is not zeroed
  if (mark === 'bar' || mark === 'area' || mark === 'line' || mark === 'rule' || mark === 'tick') return false
  return true
}

function positionalDomain(def: FieldDef, dataName: string, mark: string, orient: string): unknown {
  if (def.bin) {
    const maxbins = isObject(def.bin) && (def.bin.maxbins as number | undefined) ? (def.bin.maxbins as number) : 10
    return { signal: `[bin_maxbins_${maxbins}_${def.field}_bins.start, bin_maxbins_${maxbins}_${def.field}_bins.stop]` }
  }
  if (def.timeUnit && (mark === 'bar' || mark === 'rect')) {
    return { data: dataName, fields: [timeUnitField(def), `${timeUnitField(def)}_end`] }
  }
  if (def.stack === 'normalize') return [0, 1]
  if (isDiscreteType(def.type)) return sortedDomain(def, dataName)
  const measureChannel = orient === 'vertical' ? 'y' : 'x'
  const stacked = isStacked(def, mark, orient)
  if (def.channel === measureChannel && stacked) {
    return { data: dataName, fields: [`${def.field}_start`, `${def.field}_end`] }
  }
  return { data: dataName, field: aggFieldName(def) }
}

function isStacked(def: FieldDef, mark: string, orient: string): boolean {
  if (mark !== 'bar' && mark !== 'area') return false
  const measureChannel = orient === 'vertical' ? 'y' : 'x'
  if (def.channel !== measureChannel) return false
  if (def.type !== 'quantitative' || def.aggregate || def.bin) return false
  // vega-lite v6 compiles the 'wiggle' stack offset to a plain unstacked
  // measure (vega's Stack transform only supports zero/center/normalize)
  if (def.stack === 'wiggle') return false
  return true
}

function sortedDomain(def: FieldDef, dataName: string): unknown {
  const base: Record<string, unknown> = { data: dataName, field: aggFieldName(def) }
  if (def.sort === false || def.sort === 'none') return base
  if (def.sort === 'descending') return { ...base, sort: { order: 'descending' } }
  if (isObject(def.sort) && def.sort.field != null) {
    return { ...base, sort: { op: 'sum', field: def.sort.field as string, order: (def.sort.order as string) ?? 'ascending' } }
  }
  if (isObject(def.sort) && def.sort.order === 'descending') return { ...base, sort: { order: 'descending' } }
  // default: sorted by the (possibly aggregated) field ascending
  return { ...base, sort: true }
}

// --- axes --------------------------------------------------------------------

function buildAxes(fields: FieldDef[], mark: string, orient: string, scales: ScaleSpec[]): Record<string, unknown>[] {
  const axes: Record<string, unknown>[] = []
  const scaleByName = new Map(scales.map((s) => [s.name, s]))

  for (const def of fields) {
    if (!POSITIONAL.has(def.channel) || (def.channel !== 'x' && def.channel !== 'y')) continue
    const userAxis = def.axis
    if (userAxis === null) continue
    const sc = scaleByName.get(def.channel)!
    const grid = (userAxis?.grid as boolean | undefined) ?? (isContinuousScaleType(sc.type) && !def.bin)
    const tickCountSignal = def.channel === 'x' ? { signal: 'ceil(width/40)' } : { signal: 'ceil(height/40)' }
    const orientSide = def.channel === 'x' ? 'bottom' : 'left'
    const gridScale = def.channel === 'x' ? (scaleByName.get('y') ? 'y' : undefined) : scaleByName.get('x') ? 'x' : undefined

    if (grid && gridScale) {
      const gridAxis: Record<string, unknown> = {
        scale: def.channel,
        orient: orientSide,
        gridScale,
        grid: true,
        tickCount: tickCountSignal,
        domain: false,
        labels: false,
        aria: false,
        maxExtent: 0,
        minExtent: 0,
        ticks: false,
        zindex: 0,
      }
      if (def.timeUnit) {
        const stepExpr = timeUnitMinStepSignal(def.timeUnit)
        if (stepExpr) gridAxis.tickMinStep = { signal: stepExpr }
      }
      axes.push(gridAxis)
    }

    const title = axisTitle(def, userAxis)
    const labelAxis: Record<string, unknown> = {
      scale: def.channel,
      orient: orientSide,
      grid: false,
      zindex: 0,
    }
    if (title !== null) labelAxis.title = title
    if (isContinuousScaleType(sc.type)) {
      if (def.channel === 'x') labelAxis.labelFlush = true
      labelAxis.labelOverlap = sc.type === 'log' ? 'greedy' : true
      labelAxis.tickCount = def.bin
        ? { signal: def.channel === 'x' ? 'ceil(width/10)' : 'ceil(height/10)' }
        : tickCountSignal
      if (def.timeUnit) {
        const units = JSON.stringify(timeUnitUnits(def.timeUnit))
        labelAxis.format = {
          signal: `timeUnitSpecifier(${units}, {"year-month":"%b %Y ","year-month-date":"%b %d, %Y "})`,
        }
        // the minimum tick step is one unit: expressed as a datetime difference
        const stepExpr = timeUnitMinStepSignal(def.timeUnit)
        if (stepExpr) labelAxis.tickMinStep = { signal: stepExpr }
      } else if (def.stack === 'normalize') {
        labelAxis.format = '.0%'
      }
    } else if (def.channel === 'x' && (sc.type === 'band' || sc.type === 'point')) {
      // vega-lite 6 rotates nominal x labels
      labelAxis.labelAlign = 'right'
      labelAxis.labelAngle = 270
      labelAxis.labelBaseline = 'middle'
    }
    if (userAxis) {
      for (const [k, v] of Object.entries(userAxis)) {
        if (k === 'grid' || k === 'title' || k === 'orient' || k === 'scale') continue
        labelAxis[k] = v
      }
      if (userAxis.orient) labelAxis.orient = userAxis.orient
    }
    axes.push(labelAxis)
  }
  return axes
}

function axisTitle(def: FieldDef, userAxis?: Record<string, unknown> | null): unknown {
  if (userAxis && 'title' in userAxis) return userAxis.title
  return channelTitle(def)
}

// --- legends -----------------------------------------------------------------

function buildLegends(fields: FieldDef[], mark: string, markOpacity?: number, markFilled?: boolean): Record<string, unknown>[] {
  const legends: Record<string, unknown>[] = []
  const sizeDef = fields.find((f) => f.channel === 'size' && f.field)
  if (sizeDef && sizeDef.legend !== null) {
    legends.push({
      size: 'size',
      symbolType: 'circle',
      title: legendTitle(sizeDef, sizeDef.legend ?? {}),
      encode: { symbols: { update: { fill: { value: 'transparent' }, stroke: { value: C.blue }, opacity: { value: markOpacity ?? C.pointOpacity } } } },
    })
  }
  const opacityLegendDef = fields.find((f) => f.channel === 'opacity' && f.field)
  if (opacityLegendDef && opacityLegendDef.legend !== null) {
    legends.push({
      opacity: 'opacity',
      symbolType: 'circle',
      title: legendTitle(opacityLegendDef, opacityLegendDef.legend ?? {}),
      encode: { symbols: { update: { fill: { value: 'transparent' }, stroke: { value: C.blue } } } },
    })
  }
  const shapeDefL = fields.find((f) => f.channel === 'shape' && f.field)
  if (shapeDefL && shapeDefL.legend !== null) {
    legends.push({
      shape: 'shape',
      symbolType: 'circle',
      title: legendTitle(shapeDefL, shapeDefL.legend ?? {}),
      encode: { symbols: { update: { fill: { value: 'transparent' }, stroke: { value: C.blue }, opacity: { value: markOpacity ?? C.pointOpacity } } } },
    })
  }
  const colorDef = fields.find((f) => f.channel === 'color' && f.field)
  if (colorDef && colorDef.legend !== null) {
    const userLegend = colorDef.legend ?? {}
    const lg: Record<string, unknown> = { title: legendTitle(colorDef, userLegend) }
    const filled = mark === 'circle' || mark === 'square' || (mark === 'point' && markFilled === true)
    const m = mark as string
    if (filled) {
      lg.fill = 'color'
      lg.symbolType = m === 'bar' || m === 'rect' ? 'square' : 'circle'
      if (m !== 'bar' && m !== 'rect') {
        lg.encode = { symbols: { update: { opacity: { value: markOpacity ?? C.pointOpacity } } } }
      }
    } else if (m === 'point' || m === 'line' || m === 'text') {
      lg.stroke = 'color'
      if (isDiscreteType(colorDef.type)) {
        lg.symbolType = mark === 'line' ? 'stroke' : 'circle'
        lg.encode = { symbols: { update: { fill: { value: 'transparent' }, opacity: { value: C.pointOpacity } } } }
      } else {
        lg.gradientLength = { signal: 'clamp(height, 64, 200)' }
        lg.encode = { gradient: { update: { opacity: { value: C.pointOpacity } } } }
      }
    } else {
      lg.fill = 'color'
      if (mark === 'bar' || mark === 'rect') lg.symbolType = 'square'
      if (!isDiscreteType(colorDef.type)) lg.gradientLength = { signal: 'clamp(height, 64, 200)' }
    }
    for (const [k, v] of Object.entries(userLegend)) {
      if (k === 'title') continue
      lg[k] = v
    }
    legends.push(lg)
  }
  return legends
}

function legendTitle(def: FieldDef, userLegend: Record<string, unknown>): unknown {
  if ('title' in userLegend) return userLegend.title
  return channelTitle(def)
}

// --- marks -------------------------------------------------------------------

interface BuiltMarks extends Array<Record<string, unknown>> {
  overlayData?: Record<string, unknown>
  overlayFilled?: boolean
}
function buildMarks(spec: VLSpec, fields: FieldDef[], mark: string, orient: string, dataName: string, markSize?: number): BuiltMarks {
  const markColor = isObject(spec.mark) ? (spec.mark.color as string | undefined) : undefined
  const markOpacity = isObject(spec.mark) ? (spec.mark.opacity as number | undefined) : undefined
  const xDef = fields.find((f) => f.channel === 'x')
  const yDef = fields.find((f) => f.channel === 'y')
  const colorDef = fields.find((f) => f.channel === 'color' && f.field)
  const sizeDef = fields.find((f) => f.channel === 'size' && f.field)
  const shapeDef = fields.find((f) => f.channel === 'shape' && f.field)
  const opacityDef = fields.find((f) => f.channel === 'opacity' && f.field)
  const update: Record<string, unknown> = {}
  const xOffsetPresent = fields.some((f) => f.channel === 'xOffset' && f.field)
  const yOffsetPresent = fields.some((f) => f.channel === 'yOffset' && f.field)

  if (mark === 'bar' || mark === 'rect') {
    update.fill = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: markColor ?? C.blue }
    if (markOpacity != null) update.opacity = { value: markOpacity }
    if (mark === 'bar') update.ariaRoleDescription = { value: 'bar' }
    const stacked = yDef && isStacked(yDef, mark, orient)
    if (orient === 'vertical') {
      if (xDef) {
        const sc = positionalScaleType(mark, xDef)
        if (xDef.timeUnit) {
          const endF = JSON.stringify(timeUnitField(xDef) + '_end')
          const startF = JSON.stringify(timeUnitField(xDef))
          const scName = 'x'
          const off = (sign: string) =>
            `0.5 + (abs(scale("${scName}", datum[${endF}]) - scale("${scName}", datum[${startF}])) < 0.25 ? ${sign}0.5 * (0.25 - (abs(scale("${scName}", datum[${endF}]) - scale("${scName}", datum[${startF}])))) : ${sign === '+' ? '-0.5' : '0.5'})`
          update.x = { scale: 'x', field: JSON.parse(endF), offset: { signal: off('+') } }
          update.x2 = { scale: 'x', field: JSON.parse(startF), offset: { signal: off('-') } }
        } else if (xDef.bin) {
          const bm = isObject(xDef.bin) && (xDef.bin.maxbins as number | undefined) ? (xDef.bin.maxbins as number) : 10
          const endF = JSON.stringify(`bin_maxbins_${bm}_${xDef.field}_end`)
          const startF = JSON.stringify(`bin_maxbins_${bm}_${xDef.field}`)
          const off = (sign: string) =>
            `0.5 + (abs(scale("x", datum[${endF}]) - scale("x", datum[${startF}])) < 0.25 ? ${sign}0.5 * (0.25 - (abs(scale("x", datum[${endF}]) - scale("x", datum[${startF}])))) : ${sign === '+' ? '-0.5' : '0.5'})`
          update.x = { scale: 'x', field: JSON.parse(endF), offset: { signal: off('+') } }
          update.x2 = { scale: 'x', field: JSON.parse(startF), offset: { signal: off('-') } }
        } else if (sc === 'band') {
          update.x = { scale: 'x', field: aggFieldName(xDef) }
          if (xOffsetPresent) {
            update.x = { scale: 'x', field: aggFieldName(xDef), offset: { scale: 'xOffset', field: aggFieldName(fields.find((f) => f.channel === 'xOffset')!) } }
          }
          update.width = { signal: `max(0.25, bandwidth('${xOffsetPresent ? 'xOffset' : 'x'}'))` }
        } else {
          update.xc = { scale: 'x', field: aggFieldName(xDef) }
          update.width = { value: C.bandSize }
        }
      }
      if (yDef) {
        if (stacked) {
          update.y = { scale: 'y', field: `${yDef.field}_end` }
          update.y2 = { scale: 'y', field: `${yDef.field}_start` }
        } else {
          update.y = { scale: 'y', field: aggFieldName(yDef) }
          if (mark === 'bar') update.y2 = { scale: 'y', value: 0 }
        }
      }
    } else {
      if (yDef) {
        const sc = positionalScaleType(mark, yDef)
        if (yDef.timeUnit) {
          const endF = JSON.stringify(timeUnitField(yDef) + '_end')
          const startF = JSON.stringify(timeUnitField(yDef))
          const off = (sign: string) =>
            `0.5 + (abs(scale("y", datum[${endF}]) - scale("y", datum[${startF}])) < 0.25 ? ${sign}0.5 * (0.25 - (abs(scale("y", datum[${endF}]) - scale("y", datum[${startF}])))) : ${sign === '+' ? '-0.5' : '0.5'})`
          update.y = { scale: 'y', field: JSON.parse(endF), offset: { signal: off('+') } }
          update.y2 = { scale: 'y', field: JSON.parse(startF), offset: { signal: off('-') } }
        } else if (yDef.bin) {
          const bm = isObject(yDef.bin) && (yDef.bin.maxbins as number | undefined) ? (yDef.bin.maxbins as number) : 10
          const endF = JSON.stringify(`bin_maxbins_${bm}_${yDef.field}_end`)
          const startF = JSON.stringify(`bin_maxbins_${bm}_${yDef.field}`)
          const off = (sign: string) =>
            `0.5 + (abs(scale("y", datum[${endF}]) - scale("y", datum[${startF}])) < 0.25 ? ${sign}0.5 * (0.25 - (abs(scale("y", datum[${endF}]) - scale("y", datum[${startF}])))) : ${sign === '+' ? '-0.5' : '0.5'})`
          update.y = { scale: 'y', field: JSON.parse(endF), offset: { signal: off('+') } }
          update.y2 = { scale: 'y', field: JSON.parse(startF), offset: { signal: off('-') } }
        } else if (sc === 'band') {
          update.y = { scale: 'y', field: aggFieldName(yDef) }
          if (yOffsetPresent) {
            update.y = { scale: 'y', field: aggFieldName(yDef), offset: { scale: 'yOffset', field: aggFieldName(fields.find((f) => f.channel === 'yOffset')!) } }
          }
          update.height = { signal: `max(0.25, bandwidth('${yOffsetPresent ? 'yOffset' : 'y'}'))` }
        } else {
          update.yc = { scale: 'y', field: aggFieldName(yDef) }
          update.height = { value: C.bandSize }
        }
      }
      if (xDef) {
        const stackedX = isStacked(xDef, mark, orient)
        if (stackedX) {
          update.x = { scale: 'x', field: `${xDef.field}_end` }
          update.x2 = { scale: 'x', field: `${xDef.field}_start` }
        } else {
          update.x = { scale: 'x', field: aggFieldName(xDef) }
          if (mark === 'bar') update.x2 = { scale: 'x', value: 0 }
        }
      }
    }
  } else if (mark === 'point' || mark === 'circle' || mark === 'square') {
    const filled = mark !== 'point' || (isObject(spec.mark) && spec.mark.filled === true)
    const markColor = isObject(spec.mark) ? (spec.mark.color as string | undefined) : undefined
    const markOpacity = isObject(spec.mark) ? (spec.mark.opacity as number | undefined) : undefined
    const markStroke = isObject(spec.mark) ? (spec.mark.stroke as string | undefined) : undefined
    const markStrokeWidth = isObject(spec.mark) ? (spec.mark.strokeWidth as number | undefined) : undefined
    if (filled) {
      update.fill = colorDef
        ? { scale: 'color', field: aggFieldName(colorDef) }
        : { value: markColor ?? C.blue }
      if (markStroke) update.stroke = { value: markStroke }
      if (markStrokeWidth) update.strokeWidth = { value: markStrokeWidth }
      update.opacity = { value: markOpacity ?? C.pointOpacity }
      update.shape = { value: mark }
      if (markSize) update.size = { value: markSize }
    } else {
      update.opacity = opacityDef
        ? { scale: 'opacity', field: aggFieldName(opacityDef) }
        : { value: markOpacity ?? C.pointOpacity }
      update.fill = { value: 'transparent' }
      update.stroke = colorDef
        ? { scale: 'color', field: aggFieldName(colorDef) }
        : { value: markColor ?? C.blue }
    }
    update.ariaRoleDescription = { value: mark }
    if (xDef) update.x = { scale: 'x', field: aggFieldName(xDef) }
    if (yDef) update.y = { scale: 'y', field: aggFieldName(yDef) }
    if (sizeDef) update.size = { scale: 'size', field: aggFieldName(sizeDef) }
    if (shapeDef && !filled) update.shape = { scale: 'shape', field: aggFieldName(shapeDef) }
    void 0
  } else if (mark === 'line') {
    const markStroke = isObject(spec.mark) ? (spec.mark.stroke as string | undefined) : undefined
    const markStrokeWidth = isObject(spec.mark) ? (spec.mark.strokeWidth as number | undefined) : undefined
    update.stroke = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: markStroke ?? markColor ?? C.blue }
    if (markStrokeWidth) update.strokeWidth = { value: markStrokeWidth }
    const markInterpolate = isObject(spec.mark) ? (spec.mark.interpolate as string | undefined) : undefined
    if (markInterpolate) update.interpolate = { value: markInterpolate }
    if (xDef) update.x = { scale: 'x', field: aggFieldName(xDef) }
    if (yDef) update.y = { scale: 'y', field: aggFieldName(yDef) }
    update.defined = definedSignal(xDef, yDef)
  } else if (mark === 'area') {
    update.orient = { value: orient }
    const areaStroke = isObject(spec.mark) ? (spec.mark.stroke as string | undefined) : undefined
    const areaInterpolate = isObject(spec.mark) ? (spec.mark.interpolate as string | undefined) : undefined
    if (areaInterpolate) update.interpolate = { value: areaInterpolate }
    const areaFillOpacity = isObject(spec.mark) ? (spec.mark.fillOpacity as number | undefined) : undefined
    if (areaFillOpacity != null) update.fillOpacity = { value: areaFillOpacity }
    if (areaStroke) update.stroke = { value: areaStroke }
    update.fill = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: markColor ?? C.blue }
    if (xDef) update.x = { scale: 'x', field: aggFieldName(xDef) }
    if (yDef) {
      const stacked = isStacked(yDef, mark, orient)
      if (stacked) {
        update.y = { scale: 'y', field: `${yDef.field}_end` }
        update.y2 = { scale: 'y', field: `${yDef.field}_start` }
      } else {
        update.y = { scale: 'y', field: aggFieldName(yDef) }
        // anchored through the scale so the baseline tracks scale(0), not the
        // group-local pixel origin (matters inside faceted pathgroups)
        update.y2 = { scale: 'y', value: 0 }
      }
    }
    if (xDef && orient === 'horizontal') {
      const stackedX = isStacked(xDef, mark, orient)
      if (stackedX) {
        update.x = { scale: 'x', field: `${xDef.field}_end` }
        update.x2 = { scale: 'x', field: `${xDef.field}_start` }
      } else if (yDef == null || !isStacked(yDef, mark, orient)) {
        // vertical baselines anchor through the scale as well
        update.x2 = { scale: 'x', value: 0 }
      }
    }
    update.defined = definedSignal(xDef, yDef)
  } else if (mark === 'tick') {
    update.opacity = { value: markOpacity ?? C.pointOpacity }
    update.fill = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: markColor ?? C.blue }
    update.ariaRoleDescription = { value: 'tick' }
    if (orient === 'vertical') {
      if (xDef) {
        if (positionalScaleType(mark, xDef) === 'band') {
          update.x = { scale: 'x', field: aggFieldName(xDef) }
          update.width = { signal: `max(0.25, bandwidth('x'))` }
        } else {
          update.xc = { scale: 'x', field: aggFieldName(xDef) }
          update.width = { value: C.bandSize }
        }
      }
      if (yDef) update.yc = { scale: 'y', field: aggFieldName(yDef) }
      update.height = { value: 1 }
    } else {
      if (yDef) {
        if (positionalScaleType(mark, yDef) === 'band') {
          update.y = { scale: 'y', field: aggFieldName(yDef) }
          update.height = { signal: `max(0.25, bandwidth('y'))` }
        } else {
          update.yc = { scale: 'y', field: aggFieldName(yDef) }
          update.height = { value: C.bandSize }
        }
      }
      if (xDef) update.xc = { scale: 'x', field: aggFieldName(xDef) }
      update.width = { value: 1 }
    }
  } else if (mark === 'rule') {
    update.stroke = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: markColor ?? C.blue }
    if (xDef) update.x = { scale: 'x', field: aggFieldName(xDef) }
    if (yDef) update.y = { scale: 'y', field: aggFieldName(yDef) }
  } else if (mark === 'text') {
    update.fill = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: markColor ?? 'black' }
    if (xDef) update.x = { scale: 'x', field: aggFieldName(xDef) }
    if (yDef) update.y = { scale: 'y', field: aggFieldName(yDef) }
    const textDef = fields.find((f) => f.channel === 'text')
    if (textDef?.field) {
      const f = JSON.stringify(textDef.field)
      update.text = { signal: `isValid(datum[${f}]) ? datum[${f}] : ""+datum[${f}]` }
    } else if (textDef && (textDef.raw as { value?: unknown }).value !== undefined) {
      update.text = { value: String((textDef.raw as { value?: unknown }).value) }
    }
    update.align = { value: 'center' }
    update.baseline = { value: 'middle' }
  } else if (mark === 'arc') {
    const thetaDefA = fields.find((f) => f.channel === 'theta' && f.field)
    const thetaF = thetaDefA!.field
    update.fill = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: markColor ?? C.blue }
    if (markOpacity != null) update.opacity = { value: markOpacity }
    update.x = { signal: 'width', mult: 0.5 }
    update.y = { signal: 'height', mult: 0.5 }
    const arcMark = spec.mark
    const mOuter = isObject(arcMark) ? (arcMark.outerRadius as number | undefined) : undefined
    const mInner = isObject(arcMark) ? (arcMark.innerRadius as number | undefined) : undefined
    update.outerRadius = mOuter != null ? { value: mOuter } : { signal: 'min(width,height)/2' }
    update.innerRadius = { value: mInner ?? 0 }
    // the outer arc closes at the series' stacked END angle; the sweep runs
    // from value_end (startAngle) to value_start (endAngle)
    update.startAngle = { scale: 'theta', field: `${thetaF}_end` }
    update.endAngle = { scale: 'theta', field: `${thetaF}_start` }
  } else {
    throw new Error(`[aster/vl] mark type not supported yet: ${mark}`)
  }

  const markSpec: Record<string, unknown> = {
    name: 'marks',
    type: mark === 'bar' || mark === 'tick' ? 'rect' : mark === 'point' || mark === 'circle' || mark === 'square' ? 'symbol' : mark,
    style: [mark],
    from: { data: dataName },
    encode: { update },
  }
  // order: line/area sort by the dimension field
  if (mark === 'line' || mark === 'area') {
    const dim = orient === 'vertical' ? xDef : yDef
    if (dim && !dim.timeUnit) markSpec.sort = { field: aggFieldName(dim) }
  }

  const out: BuiltMarks = [markSpec]

  // area with a series channel: one faceted area per series (pathgroup) —
  // vega-lite emits this for stacked and unstacked areas alike
  const colorDefSeries = fields.find((f) => f.channel === 'color' && f.field)
  const detailDefSeries = fields.find((f) => f.channel === 'detail' && f.field)
  const seriesForFacet = colorDefSeries ?? detailDefSeries
  const stackedNow = (yDef != null && isStacked(yDef, mark, orient)) || (xDef != null && isStacked(xDef, mark, orient))
  if (mark === 'area' && colorDefSeries) {
    markSpec.name = 'layer_0_marks'
    const group: Record<string, unknown> = {
      name: 'pathgroup',
      type: 'group',
      from: {
        facet: {
          name: 'faceted_path_main',
          data: dataName,
          groupby: [aggFieldName(colorDefSeries)],
        },
      },
      encode: {
        update: {
          width: { field: { group: 'width' } },
          height: { field: { group: 'height' } },
        },
      },
      marks: [{
        name: 'marks',
        type: 'area',
        style: ['area'],
        sort: { field: aggFieldName(xDef ?? yDef!) },
        from: { data: 'faceted_path_main' },
        encode: { update },
      }],
    }
    out[0] = group
  }

  // line marks split by a series channel (color or detail): one line per group
  const pointOverlay = isObject(spec.mark) ? spec.mark.point : undefined
  if (mark === 'line' && (colorDefSeries || detailDefSeries) && !pointOverlay) {
    markSpec.name = 'layer_0_marks'
    const innerUpdate = { ...update }
    if (colorDefSeries) innerUpdate.stroke = { scale: 'color', field: aggFieldName(colorDefSeries) }
    const group: Record<string, unknown> = {
      name: 'pathgroup',
      type: 'group',
      from: {
        facet: {
          name: 'faceted_path_main',
          data: dataName,
          groupby: [colorDefSeries, detailDefSeries].filter(Boolean).map((f) => aggFieldName(f as FieldDef)),
        },
      },
      encode: {
        update: {
          width: { field: { group: 'width' } },
          height: { field: { group: 'height' } },
        },
      },
      marks: [{
        name: 'marks',
        type: 'line',
        style: ['line'],
        sort: { field: aggFieldName(xDef ?? yDef!) },
        from: { data: 'faceted_path_main' },
        encode: { update: innerUpdate },
      }],
    }
    out[0] = group
  }

  // line/area with a point overlay: expand to a symbol mark over a filtered clone
  if ((mark === 'line' || mark === 'area') && pointOverlay) {
    const ptType = isObject(pointOverlay) ? ((pointOverlay.type as string) ?? 'circle') : 'circle'
    const ptFilled = isObject(pointOverlay) ? (pointOverlay.filled as boolean | undefined) : undefined
    const overlayUpdate: Record<string, unknown> = {
      opacity: { value: 1 },
      fill: { value: markColor ?? C.blue },
      x: xDef ? { scale: 'x', field: aggFieldName(xDef) } : undefined,
      y: yDef ? { scale: 'y', field: aggFieldName(yDef) } : undefined,
      shape: { value: ptType },
    }
    delete overlayUpdate.x2
    const overlayName = 'layer_1_marks'
    markSpec.name = 'layer_0_marks'
    out.push({
      name: overlayName,
      type: 'symbol',
      style: [ptType],
      from: { data: 'data_1' },
      encode: { update: overlayUpdate },
    })
    out.overlayData = {
      name: 'data_1',
      source: dataName,
      transform: [{ type: 'filter', expr: (definedSignal(xDef, yDef) as { signal: string }).signal }],
    }
    out.overlayFilled = ptFilled ?? ptType === 'circle'
  }
  // conditional encodings (including value-only channels, which parseChannel
  // skips — e.g. color: {condition: {...}, value: 'steelblue'})
  const conditionalChannels: { channel: string; cond: Record<string, unknown>; fallback: unknown }[] = []
  for (const [channel, def] of Object.entries(spec.encoding as Record<string, Record<string, unknown>> ?? {})) {
    if (def && typeof def === 'object' && def.condition && typeof def.condition === 'object') {
      conditionalChannels.push({ channel, cond: def.condition as Record<string, unknown>, fallback: def.value })
    }
  }
  applyCondition(update, conditionalChannels, mark, isObject(spec.mark) && spec.mark.filled === true)

  // user overrides: encoding.update-style custom encodings are out of scope here
  void spec
  return out
}

/**
 * Vega-Lite conditional encodings: for every channel whose def carries a
 * `condition`, emit the vega conditional array [{test, value|field...},
 * {value|field...}] over the (already built) unconditional encoding.
 */
function applyCondition(update: Record<string, unknown>, channels: { channel: string; cond: Record<string, unknown>; fallback: unknown }[], mark: string, markFilled?: boolean): void {
  for (const { channel: ch, cond, fallback } of channels) {
    // the color channel materialises as stroke or fill depending on the mark
    const channel = ch === 'color' ? (mark === 'point' && !markFilled ? 'stroke' : 'fill') : ch
    // the channel's own `value` is the fallback; the mark default only backs it up
    const base = fallback !== undefined ? { value: fallback } : update[channel]
    if (base == null) continue
    const entry: Record<string, unknown> = { test: cond.test as string }
    for (const k of ['value', 'field', 'datum', 'scale', 'signal'] as const) {
      if (cond[k] !== undefined) entry[k] = cond[k]
    }
    update[channel] = [entry, base]
  }
}

function definedSignal(xDef?: FieldDef | null, yDef?: FieldDef | null): unknown {
  const parts: string[] = []
  for (const d of [xDef, yDef]) {
    if (!d) continue
    const f = JSON.stringify(d.field)
    if (d.type === 'quantitative') {
      parts.push(`isValid(datum[${f}]) && isFinite(+datum[${f}])`)
    } else {
      parts.push(`isValid(datum[${f}]) && isFinite(+datum[${f}])`)
    }
  }
  if (!parts.length) return undefined
  return { signal: parts.join(' && ') }
}

// --- assembly ----------------------------------------------------------------

export function compileUnit(spec: VLSpec): VLSpec {
  const markRaw = spec.mark
  const mark = typeof markRaw === 'string' ? markRaw : isObject(markRaw) ? (markRaw.type as string) : 'point'
  const markSize = isObject(markRaw) ? (markRaw.size as number | undefined) : undefined
  const markOpacity = isObject(markRaw) ? (markRaw.opacity as number | undefined) : undefined
  const encoding = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  const fields: FieldDef[] = []
  for (const [channel, def] of Object.entries(encoding)) {
    const f = parseChannel(channel, def)
    if (f) fields.push(f)
  }

  // orientation (bar/area/rule/tick): vertical unless the y channel is discrete
  // and x is not, or the mark def says otherwise
  let orient = 'vertical'
  if (mark === 'bar' || mark === 'area' || mark === 'rule' || mark === 'tick') {
    const xDef = fields.find((f) => f.channel === 'x')
    const yDef = fields.find((f) => f.channel === 'y')
    const markOrient = isObject(markRaw) ? (markRaw.orient as string | undefined) : undefined
    if (markOrient) orient = markOrient
    else if (yDef && isDiscreteType(yDef.type) && (!xDef || !isDiscreteType(xDef.type))) orient = 'horizontal'
  }

  const data = buildData(spec, fields, mark, orient)
  const width = (spec.width as unknown) ?? 200
  const height = (spec.height as unknown) ?? 200

  const out: Record<string, unknown> = {}
  if (spec.$schema) out.$schema = 'https://vega.github.io/schema/vega/v6.json'
  out.autosize = spec.autosize ?? 'pad'
  out.background = spec.background ?? 'white'
  out.padding = spec.padding ?? 5
  out.width = width
  out.height = height
  // theta-only views (pie/donut) get vega-lite's unstyled 'view' frame — no
  // cell stroke, no half-pixel inset
  out.style = mark === 'arc' ? 'view' : 'cell'
  out.data = data.transforms.length
    ? [
        { ...(isObject(spec.data) ? spec.data : {}), name: 'source_0' },
        { name: 'data_0', source: 'source_0', transform: data.transforms },
      ]
    : [{ ...(isObject(spec.data) ? spec.data : {}), name: 'source_0' }]
  const builtMarks = buildMarks(spec, fields, mark, orient, data.dataName, markSize) as Record<string, unknown>[] & { overlayData?: Record<string, unknown> }
  out.marks = builtMarks
  if (builtMarks.overlayData) {
    ;(out.data as Record<string, unknown>[]).push(builtMarks.overlayData)
  }
  out.scales = buildScales(spec, fields, mark, orient, data.dataName, width, height, data.seriesFields)
  const axes = buildAxes(fields, mark, orient, out.scales as ScaleSpec[])
  if (axes.length) out.axes = axes
  const legends = buildLegends(fields, mark, markOpacity, isObject(markRaw) && markRaw.filled === true)
  if (legends.length) out.legends = legends
  if (spec.title) out.title = spec.title
  if (spec.description) out.description = spec.description
  return out
}
