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
  bandPosition?: number
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
  continuousBandSize: 5,
  // vega-lite getViewConfigDiscreteStep default (20) minus 2
  defaultStep: 18,
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
  // facet forms: top-level {facet, spec}, encoding.facet {row?, column?}, or
  // the encoding shorthand row/column channels
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  const hasEncFacet = isObject(enc.facet) || enc.row != null || enc.column != null
  if (isObject(spec.facet) || (isObject(spec.spec) && hasTopFacet(spec))) return compileFaceted(spec)
  if (hasEncFacet && spec.spec == null) return compileFaceted(spec)
  if (isObject(spec.mark) && (spec.mark as Record<string, unknown>).type === 'boxplot') return compileBoxplot(spec)
  if (spec.repeat != null) return compileRepeat(spec)
  if (spec.concat || spec.hconcat || spec.vconcat) return compileConcat(spec)
  return compileUnit(spec)
}

function hasTopFacet(spec: VLSpec): boolean {
  return isObject(spec.facet) || (spec.encoding != null && isObject((spec.encoding as Record<string, unknown>).facet))
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
      else if (yDef && isDiscreteType(yDef.type) && !yDef.aggregate && (!xDef || !isDiscreteType(xDef.type))) orient = 'horizontal'
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
  // theta-only layered views (pie labels) use the unstyled 'view' frame
  const anyXY = parsed.some((p) => p.fields.some((f) => f.channel === 'x' || f.channel === 'y'))
  out.style = anyXY ? 'cell' : 'view'

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
  // vega-lite preserves a declared source dataset name (data: {name: 'table'})
  // — hosts key data overrides/changesets on it, so renaming to source_0 breaks
  // them. Keep the declared name; derived datasets stay data_0, data_1, ...
  const sourceName = isObject(spec.data) && typeof (spec.data as Record<string, unknown>).name === 'string'
    ? (spec.data as Record<string, unknown>).name as string
    : 'source_0'
  const data: Record<string, unknown>[] = [{ ...(isObject(spec.data) ? spec.data : {}), name: sourceName }]
  const castsName = castTransforms.length ? 'data_0' : sourceName
  if (castTransforms.length) data.push({ name: 'data_0', source: sourceName, transform: castTransforms })
  let nextData = castTransforms.length ? 1 : 0
  const perLayerScales: ScaleSpec[][] = []
  const perLayerMarks: Record<string, unknown>[][] = []
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
    perLayerMarks.push(builtMarks)
    if (builtMarks.overlayData) data.push(builtMarks.overlayData)
    perLayerScales.push(buildScales(p.l, p.fields, p.mark, p.orient, p.dataName, width, height, p.seriesFields))
  })
  out.data = data

  // y2/x2 endpoint fields extend the layer's positional scale domain
  parsed.forEach((p, i) => {
    for (const [main, second] of [['y', 'y2'], ['x', 'x2']] as const) {
      const d2 = p.fields.find((f) => f.channel === second && f.field)
      if (!d2) continue
      const sc = perLayerScales[i]?.find((s) => s.name === main)
      if (!sc) continue
      const d = sc.domain as { data?: string; field?: string; fields?: unknown } | undefined
      if (d && typeof d === 'object' && !Array.isArray(d) && typeof d.data === 'string') {
        const fieldList = Array.isArray(d.fields) ? [...d.fields as string[]] : [d.field as string]
        if (!fieldList.includes(d2.field)) fieldList.push(d2.field as string)
        sc.domain = { data: d.data, fields: fieldList }
      }
    }
  })

  // independent y resolution (dual-axis layers): each layer's y scale gets a
  // unique name; the first layer keeps the left axis with grid, subsequent
  // layers move to a right axis without grid
  const indepY = (isObject(spec.resolve) && isObject((spec.resolve as Record<string, unknown>).scale)
    ? ((spec.resolve as Record<string, Record<string, unknown>>).scale as Record<string, unknown>).y === 'independent'
    : false)
  if (indepY) {
    const firstY = parsed.findIndex((p) => p.fields.some((f) => f.channel === 'y'))
    parsed.forEach((p, i) => {
      const yScale = perLayerScales[i]?.find((s) => s.name === 'y')
      if (!yScale || !p.fields.some((f) => f.channel === 'y')) return
      yScale.name = `layer_${i}_y`
      const rewrite = (m: Record<string, unknown>): void => {
        const enc = (m.encode as { update?: Record<string, unknown> } | undefined)?.update
        if (enc) {
          for (const k of ['y', 'y2']) {
            const v = enc[k] as Record<string, unknown> | undefined
            if (v && v.scale === 'y') v.scale = `layer_${i}_y`
          }
        }
        for (const sub of (m.marks as Record<string, unknown>[] | undefined) ?? []) rewrite(sub)
      }
      for (const m of perLayerMarks[i] ?? []) rewrite(m)
    })
  }

  const marks: Record<string, unknown>[] = perLayerMarks.flat()
  out.marks = marks

  // with independent y, the y scales stay per-layer (renamed); the remaining
  // scales still merge across layers
  const scales = indepY
    ? [...mergeLayerScales(perLayerScales.map((ls) => ls.filter((s) => s.name !== 'y'))), ...perLayerScales.flat().filter((s) => s.name.endsWith('_y') && s.name.startsWith('layer_'))]
    : mergeLayerScales(perLayerScales)
  out.scales = scales

  // axes: one per positional channel, from the first layer that encodes it,
  // with the axis title unioned across layers (vega-lite joins ', ')
  const axes: Record<string, unknown>[] = []
  const firstYLayer = parsed.findIndex((p) => p.fields.some((f) => f.channel === 'y'))
  for (const ch of ['x', 'y'] as const) {
    if (ch === 'y' && indepY) {
      parsed.forEach((p, i) => {
        const yDef = p.fields.find((f) => f.channel === 'y' && f.axis !== null)
        if (!yDef || !perLayerScales[i]?.some((s) => s.name === `layer_${i}_y`)) return
        const isFirst = i === firstYLayer
        const axisDefs = buildAxes([yDef], p.mark, p.orient, perLayerScales[i]!, `layer_${i}_y`)
        for (const a of axisDefs) {
          ;(a as Record<string, unknown>).scale = `layer_${i}_y`
          const gridAxis = (a as Record<string, unknown>).gridScale != null
          if (!isFirst) {
            // subsequent independent y axes: right-orient, no grid
            ;(a as Record<string, unknown>).orient = (a as Record<string, unknown>).orient === 'left' ? 'right' : (a as Record<string, unknown>).orient
            if (gridAxis) continue
          }
          axes.push(a)
        }
      })
      continue
    }
    const layersWith = parsed.filter((p) => p.fields.some((f) => f.channel === ch && f.axis !== null))
    if (!layersWith.length) continue
    const base = layersWith[0]!
    const second = ch === 'y' ? 'y2' : 'x2'
    // per layer: the channel's title followed by its endpoint field
    const titles: string[] = []
    for (const p of layersWith) {
      const f = p.fields.find((q) => q.channel === ch)!
      const t = ((f.axis as Record<string, unknown> | null | undefined)?.title as string) ?? (channelTitle(f) as string)
      if (t) titles.push(t)
      const d2 = p.fields.find((q) => q.channel === second && q.field)
      if (d2) titles.push(d2.field as string)
    }
    const uniq = Array.from(new Set(titles))
    const axisFields = base.fields.filter((f) => f.channel === ch).map((f) =>
      uniq.length > 1 ? ({ ...f, title: uniq.join(', ') } as FieldDef) : f,
    )
    for (const a of buildAxes(axisFields, base.mark, base.orient, scales as ScaleSpec[], undefined, ch === 'x' && indepY ? `layer_${firstYLayer}_y` : undefined)) axes.push(a)
  }
  if (axes.length) out.axes = axes
  const legends: Record<string, unknown>[] = []
  for (const p of parsed) {
    for (const lg of buildLegends(
      p.fields,
      p.mark,
      isObject(p.markRaw) ? (p.markRaw.opacity as number | undefined) : undefined,
      isObject(p.markRaw) && p.markRaw.filled !== undefined ? p.markRaw.filled === true : undefined,
      isObject(p.markRaw) ? (p.markRaw.stroke as string | undefined) : undefined,
      isObject(p.markRaw) ? (p.markRaw.strokeWidth as number | undefined) : undefined,
    )) {
      // one legend per scale channel (vega resolves shared legends across layers)
      const ch = lg.fill ?? lg.stroke ?? lg.shape ?? lg.size ?? lg.opacity
      if (typeof ch === 'string' && legends.some((x) => (x.fill ?? x.stroke ?? x.shape ?? x.size ?? x.opacity) === ch)) continue
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
        } else if (typeof d.data === 'string' && Array.isArray(d.fields)) {
          for (const f of d.fields) if (typeof f === 'string') entries.push({ data: d.data, field: f })
        } else if (Array.isArray(d.fields)) {
          for (const f of d.fields) collect(f)
        }
      }
      for (const s of list) collect(s.domain)
      const sameData = entries.length > 0 && entries.every((e) => e.data === entries[0]!.data)
      const merged: ScaleSpec = {
        ...first,
        domain: sameData
          ? { data: entries[0]!.data, fields: Array.from(new Set(entries.map((e) => e.field))) }
          : { fields: entries },
      }
      // merge the boolean/numeric scale props across layers (a padding or
      // zero on any layer's scale applies to the union)
      for (const s of list) {
        if (s.padding != null) merged.padding = Math.max(merged.padding ?? 0, s.padding)
        if (s.nice === true) merged.nice = true
        if (s.zero === true) merged.zero = true
      }
      out.push(merged)
    } else {
      out.push(first)
    }
  }
  return out
}

// --- facet composition -------------------------------------------------------

/** Compile a faceted chart (encoding.facet / top-level facet + spec). */
function compileFaceted(spec: VLSpec): VLSpec {
  const facetDef = isObject(spec.facet) ? (spec.facet as Record<string, unknown>) : undefined
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}
  const encFacet = isObject(enc.facet) ? (enc.facet as Record<string, unknown>) : undefined
  const rowDef = (facetDef?.row ?? encFacet?.row ?? enc.row) as Record<string, unknown> | undefined
  const colDef = (facetDef?.column ?? encFacet?.column ?? enc.column) as Record<string, unknown> | undefined
  // header label formatting reads the channel def (type + format)
  const normalizeHeaderDef = (def: Record<string, unknown> | undefined): FieldDef | undefined =>
    def ? parseChannel('column', def) ?? undefined : undefined
  // the inner unit: top-level facet form uses spec.spec; the encoding form
  // strips the facet channel from the encoding
  let innerSpec: VLSpec
  if (isObject(spec.spec)) {
    innerSpec = { ...(spec.spec as VLSpec) }
    if (!isObject(innerSpec.data) && isObject(spec.data)) innerSpec.data = spec.data
  } else {
    const enc = { ...(isObject(spec.encoding) ? (spec.encoding as Record<string, unknown>) : {}) }
    delete enc.facet
    delete enc.row
    delete enc.column
    innerSpec = { ...spec, encoding: enc }
  }
  const inner = compileUnit(innerSpec)
  // The inner unit may carry a DECLARED source name (vega-lite preserves it);
  // facet references must target whatever the inner marks actually read.
  const innerDataName = (((inner.marks as Record<string, unknown>[])?.[0]?.from as { data?: string } | undefined)?.data) ?? 'data_0'

  // the facet fields: an aggregated facet def keys everything on the
  // aggregated name (probed: column {aggregate: 'average', field: 't'}
  // names the facet 'average_t', aggregates the child pipeline grouped by
  // the inner groupby, and titles the column 'Average of t')
  const rowFd = rowDef ? parseChannel('row', rowDef) : null
  const colFd = colDef ? parseChannel('column', colDef) : null
  const rowField = rowFd ? aggFieldName(rowFd) : undefined
  const colField = colFd ? aggFieldName(colFd) : undefined
  // vega-lite appends the facet fields to the inner pipeline's grouping
  // transforms (stack groupby, aggregate/joinaggregate groupby, window
  // partitionby, pivot groupby — see FacetModel.addDimensions) so that
  // stacking etc. restart within each facet cell rather than spanning them.
  const facetKeys = [rowField, colField].filter(Boolean) as string[]
  // a timeUnit facet field is computed in the child dataflow (cast + timeunit)
  // even though it is not part of the inner encoding
  const facetTimeUnits = [rowFd, colFd].filter((f): f is FieldDef => f != null && !!f.timeUnit)
  if (facetTimeUnits.length) {
    for (const d of (inner.data as Record<string, unknown>[]) ?? []) {
      const trs = d.transform as Record<string, unknown>[] | undefined
      if (!Array.isArray(trs)) continue
      if (trs.some((t) => t.type === 'timeunit' && Array.isArray(t.units))) continue
      const pre: Record<string, unknown>[] = []
      for (const fd of facetTimeUnits) {
        pre.push({ type: 'formula', expr: `toDate(datum[${JSON.stringify(fd.field)}])`, as: fd.field })
        pre.push({ field: fd.field, type: 'timeunit', units: timeUnitUnits(fd.timeUnit!), as: [timeUnitField(fd), `${timeUnitField(fd)}_end`] })
      }
      trs.unshift(...pre)
    }
  }
  if (facetKeys.length) {
    for (const d of (inner.data as Record<string, unknown>[]) ?? []) {
      for (const t of (d.transform as Record<string, unknown>[]) ?? []) {
        if (t.type === 'stack' || t.type === 'aggregate' || t.type === 'joinaggregate' || t.type === 'pivot') {
          if (Array.isArray(t.groupby)) t.groupby = [...t.groupby, ...facetKeys]
        } else if (t.type === 'window') {
          if (Array.isArray(t.partitionby)) t.partitionby = [...t.partitionby, ...facetKeys]
        }
      }
    }
  }
  // vega-lite sizes the children of a TOP-LEVEL facet spec ({facet, spec})
  // from the view defaults, NOT the facet's width/height: a discrete
  // positional scale gets step sizing (a `x_step`/`y_step` signal plus a
  // `child_width`/`child_height` bandspace update, and the scale's range
  // becomes `{step: {signal}}`), while a continuous one gets the
  // continuousWidth/Height default (300). The encoding-facet form inherits
  // the spec's width/height (calibrated against the oracle).
  const isTopLevelFacet = isObject(spec.facet)
  const facetChildSignals: Record<string, unknown>[] = []
  const stepSizeFor = (name: 'x' | 'y'): unknown => {
    const sc = (inner.scales as ScaleSpec[]).find((s) => s.name === name)
    if (sc && (sc.type === 'band' || sc.type === 'point')) {
      const stepName = `${name}_step`
      facetChildSignals.push({ name: stepName, value: 20 })
      const pi = sc.type === 'band' ? (sc.paddingInner ?? 0.1) : 1
      const po = sc.type === 'band' ? (sc.paddingOuter ?? (sc.paddingInner ?? 0.1) / 2) : (sc.padding ?? 0.5)
      sc.range = { step: { signal: stepName } }
      return { signal: `bandspace(domain('${name}').length, ${pi}, ${po}) * ${stepName}` }
    }
    return 300
  }
  let childWidth: unknown = typeof spec.width === 'number' ? spec.width : 300
  let childHeight: unknown = typeof spec.height === 'number' ? spec.height : 300
  if (isTopLevelFacet) {
    childWidth = stepSizeFor('x')
    childHeight = stepSizeFor('y')
  }

  // patch the inner scales' ranges onto the child size signals and rename the
  // tickCount size references
  const patchSizeRefs = (node: Record<string, unknown>): void => {
    const s = JSON.stringify(node).replace(/\bwidth\/40\)/g, 'child_width/40)').replace(/\bheight\/40\)/g, 'child_height/40)')
    return void s
  }
  const renameSizeSignals = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(/ceil\(width\/40\)/g, 'ceil(child_width/40)').replace(/ceil\(height\/40\)/g, 'ceil(child_height/40)')
        .replace(/ceil\(width\/10\)/g, 'ceil(child_width/10)').replace(/ceil\(height\/10\)/g, 'ceil(child_height/10)')
    }
    return v
  }
  const walkRename = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walkRename); return }
    if (node != null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === 'signal' && typeof v === 'string') {
          ;(node as Record<string, unknown>)[k] = renameSizeSignals(v)
        } else if (k === 'tickCount' && v != null && typeof v === 'object' && 'signal' in (v as object)) {
          ;(node as Record<string, unknown>)[k] = { signal: renameSizeSignals((v as { signal: string }).signal) }
        } else {
          walkRename(v)
        }
      }
    }
  }
  for (const sc of inner.scales as ScaleSpec[]) {
    if (sc.name === 'x') sc.range = [0, { signal: 'child_width' }]
    if (sc.name === 'y') sc.range = [{ signal: 'child_height' }, 0]
  }
  walkRename(inner.axes ?? [])
  walkRename(inner.marks)

  // split the inner axes: grid axes stay in the cell, label axes move to the
  // row header (y) / column footer (x)
  const gridAxes: Record<string, unknown>[] = []
  const yLabelAxes: Record<string, unknown>[] = []
  const xLabelAxes: Record<string, unknown>[] = []
  for (const a of (inner.axes ?? []) as Record<string, unknown>[]) {
    if (a.grid === true) gridAxes.push(a)
    else if (a.orient === 'left' || a.orient === 'right') yLabelAxes.push(a)
    else xLabelAxes.push(a)
  }

  // child marks read the facet dataset
  const childMarks = (inner.marks as Record<string, unknown>[]).map((m) => {
    const c = { ...m }
    const from = (c.from as { data?: string } | undefined) ?? {}
    if (from.data === innerDataName || from.data == null) c.from = { ...from, data: 'facet' }
    return c
  })

  const facetGroupby = [rowField, colField].filter(Boolean) as string[]
  const datumRef = (f: string): string => `datum[${JSON.stringify(f)}]`
  // header label signal: a header format formats the parent value (number
  // format for ordinal/nominal, timeFormat for temporal — probed). The
  // header def's label* props map onto the title def (labelColor→color,
  // labelFontSize→fontSize, labelPadding→offset, labelAngle→angle with
  // derived baseline/align).
  const parentTitle = (f: string, def?: FieldDef): unknown => {
    // config.header seeds the defaults; the channel's own header def wins
    const cfgHeader = (isObject(spec.config) ? (spec.config as Record<string, unknown>).header : undefined) as Record<string, unknown> | undefined
    const hdr = { ...(cfgHeader ?? {}), ...(def?.raw?.header as Record<string, unknown> | undefined ?? {}) }
    const fmt = hdr?.format as string | undefined
    let text: unknown
    if (fmt) {
      text = { signal: def?.type === 'temporal' ? `timeFormat(parent[${JSON.stringify(f)}], ${JSON.stringify(fmt)})` : `format(parent[${JSON.stringify(f)}], ${JSON.stringify(fmt)})` }
    } else if (def?.timeUnit) {
      text = { signal: `timeFormat(parent[${JSON.stringify(f)}], ${timeUnitFormatSignal(def.timeUnit)})` }
    } else if (def?.type === 'temporal') {
      text = { signal: `timeFormat(parent[${JSON.stringify(f)}], "%b %d, %Y")` }
    } else {
      text = { signal: `isValid(parent[${JSON.stringify(f)}]) ? parent[${JSON.stringify(f)}] : ""+parent[${JSON.stringify(f)}]` }
    }
    const t: Record<string, unknown> = {
      text,
      orient: 'left',
      style: 'guide-label',
      frame: 'group',
      offset: (hdr?.labelPadding as number | undefined) ?? 10,
    }
    if (hdr?.labelColor != null) t.color = hdr.labelColor
    if (hdr?.labelFontSize != null) t.fontSize = hdr.labelFontSize
    if (hdr?.labelFont != null) t.font = hdr.labelFont
    if (hdr?.labelFontWeight != null) t.fontWeight = hdr.labelFontWeight
    if (hdr?.labelLimit != null) t.limit = hdr.labelLimit
    if (hdr?.labelAlign != null) t.align = hdr.labelAlign
    if (hdr?.labelBaseline != null) t.baseline = hdr.labelBaseline
    if (hdr?.labelAnchor != null) t.labelAnchor = hdr.labelAnchor
    if (hdr?.titleAnchor != null) t.anchor = hdr.titleAnchor
    if (hdr?.labelAngle != null) {
      t.angle = hdr.labelAngle
      // vega derives baseline/align from the angle (guide-label default
      // middle/right for rotated labels — probed: angle 30 → bottom/right)
      if (hdr?.labelBaseline == null) t.baseline = 'bottom'
      if (hdr?.labelAlign == null) t.align = 'right'
    }
    return t
  }

  const marks: Record<string, unknown>[] = []
  if (rowField) {
    marks.push({ name: 'row-title', type: 'group', role: 'row-title', title: { text: rowFd ? channelTitle(rowFd) : rowField, orient: 'left', style: 'guide-title', offset: 10 } })
  }
  if (colField) {
    const cfgHeader = (isObject(spec.config) ? (spec.config as Record<string, unknown>).header : undefined) as Record<string, unknown> | undefined
    const hdrC = { ...(cfgHeader ?? {}), ...(colDef?.header as Record<string, unknown> | undefined ?? {}) }
    const ct: Record<string, unknown> = { text: colFd ? channelTitle(colFd) : colField, style: 'guide-title', offset: (hdrC.titlePadding as number | undefined) ?? 10 }
    if (hdrC.titleColor != null) ct.color = hdrC.titleColor
    if (hdrC.titleFontSize != null) ct.fontSize = hdrC.titleFontSize
    if (hdrC.titleFont != null) ct.font = hdrC.titleFont
    if (hdrC.titleFontWeight != null) ct.fontWeight = hdrC.titleFontWeight
    if (hdrC.titleLimit != null) ct.limit = hdrC.titleLimit
    if (hdrC.titleAngle != null) { ct.angle = hdrC.titleAngle; ct.baseline = 'bottom'; ct.align = 'right' }
    if (hdrC.titleOrient != null) ct.orient = hdrC.titleOrient
    if (hdrC.titleBaseline != null) ct.baseline = hdrC.titleBaseline
    if (hdrC.titleAnchor != null) {
      ct.anchor = hdrC.titleAnchor
      if (hdrC.titleAlign == null) ct.align = hdrC.titleAnchor === 'start' ? 'left' : hdrC.titleAnchor === 'end' ? 'right' : 'center'
    }
    if (hdrC.titleAlign != null) ct.align = hdrC.titleAlign
    marks.push({ name: 'column-title', type: 'group', role: 'column-title', title: ct })
  }
  // row header: carries the y label axis (+ per-row titles when row-faceted)
  marks.push({
    name: 'row_header',
    type: 'group',
    role: 'row-header',
    ...(rowField ? {
      from: { data: 'row_domain' },
      sort: { field: datumRef(rowField), order: 'ascending' },
      title: parentTitle(rowField, rowFd ?? normalizeHeaderDef(rowDef)),
    } : {}),
    encode: { update: { height: { signal: 'child_height' } } },
    ...(yLabelAxes.length ? { axes: yLabelAxes } : {}),
  })
  if (colField) {
    const hdrCLabelsDisabled = (() => {
      const cfgHeader = (isObject(spec.config) ? (spec.config as Record<string, unknown>).header : undefined) as Record<string, unknown> | undefined
      const hdr = { ...(cfgHeader ?? {}), ...(colDef?.header as Record<string, unknown> | undefined ?? {}) }
      return hdr.labels === false
    })()
    marks.push({
      name: 'column_header',
      type: 'group',
      role: 'column-header',
      from: { data: 'column_domain' },
      sort: { field: datumRef(colField), order: 'ascending' },
      ...(hdrCLabelsDisabled
        ? {}
        : { title: (() => { const t = parentTitle(colField, colFd ?? normalizeHeaderDef(colDef)) as Record<string, unknown>; delete t.orient; return t })() }),
      encode: { update: { width: { signal: 'child_width' } } },
    })
  }
  marks.push({
    name: 'column_footer',
    type: 'group',
    role: 'column-footer',
    ...(colField ? {
      from: { data: 'column_domain' },
      sort: { field: datumRef(colField), order: 'ascending' },
    } : {}),
    encode: { update: { width: { signal: 'child_width' } } },
    ...(xLabelAxes.length ? { axes: xLabelAxes } : {}),
  })
  marks.push({
    name: 'cell',
    type: 'group',
    style: 'cell',
    from: { facet: { name: 'facet', data: innerDataName, groupby: facetGroupby } },
    sort: { field: facetGroupby.map(datumRef), order: facetGroupby.map(() => 'ascending') },
    encode: { update: { width: { signal: 'child_width' }, height: { signal: 'child_height' } } },
    ...(gridAxes.length ? { axes: gridAxes } : {}),
    marks: childMarks,
  })

  // facet domain datasets
  const data = [...(inner.data as Record<string, unknown>[])]
  // probed: an aggregated facet def does NOT aggregate the child pipeline —
  // every facet reference (cell groupby, domain, stack series, header label)
  // keys on the aggregated name, which the pipeline never computes, so the
  // facet collapses to a single (undefined) group exactly like upstream
  if (colField) data.push({ name: 'column_domain', source: innerDataName, transform: [{ type: 'aggregate', groupby: [colField] }] })
  if (rowField) data.push({ name: 'row_domain', source: innerDataName, transform: [{ type: 'aggregate', groupby: [rowField] }] })

  const out: Record<string, unknown> = {}
  if (spec.$schema) out.$schema = 'https://vega.github.io/schema/vega/v6.json'
  out.autosize = spec.autosize
  out.background = spec.background ?? 'white'
  out.padding = spec.padding ?? 5
  out.data = data
  const sizeSignalDef = (name: string, v: unknown): Record<string, unknown> =>
    v != null && typeof v === 'object' && 'signal' in (v as object)
      ? { name, update: (v as { signal: string }).signal }
      : { name, value: v }
  out.signals = [
    ...facetChildSignals,
    sizeSignalDef('child_width', childWidth),
    sizeSignalDef('child_height', childHeight),
  ]
  const rowSpacing = typeof rowDef?.spacing === 'number' ? rowDef.spacing : undefined
  const colSpacing = typeof colDef?.spacing === 'number' ? colDef.spacing : undefined
  out.layout = {
    padding: rowSpacing != null || colSpacing != null
      ? { row: rowSpacing ?? 20, column: colSpacing ?? 20 }
      : 20,
    offset: {
      ...(rowField ? { rowTitle: 10 } : {}),
      ...(colField ? { columnTitle: 10 } : {}),
    },
    columns: colField ? { signal: "length(data('column_domain'))" } : 1,
    bounds: 'full',
    align: 'all',
  }
  out.marks = marks
  out.scales = inner.scales
  if (inner.axes == null) delete inner.axes
  if (inner.legends && (inner.legends as unknown[]).length) out.legends = inner.legends
  if (spec.title) out.title = spec.title
  void patchSizeRefs
  return out
}

// --- concat composition ------------------------------------------------------

/** Rename every data reference in a compiled unit (datasets, scale domains,
 * mark sources) per the mapping. */
function renameDataRefs(node: unknown, map: Map<string, string>): void {
  if (Array.isArray(node)) { node.forEach((n) => renameDataRefs(n, map)); return }
  if (node == null || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  if (typeof obj.data === 'string') {
    const r = map.get(obj.data)
    if (r) obj.data = r
  }
  for (const v of Object.values(obj)) {
    if (v != null && typeof v === 'object') renameDataRefs(v, map)
  }
}

const SCALE_CHANNELS = ['x', 'y', 'color', 'size', 'opacity', 'shape', 'theta', 'xOffset', 'yOffset']

/** Prefix a unit's scale names and rewrite all references. */
function prefixScaleRefs(node: unknown, prefix: string): void {
  if (Array.isArray(node)) { node.forEach((n) => prefixScaleRefs(n, prefix)); return }
  if (node == null || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  if (typeof obj.scale === 'string') obj.scale = prefix + obj.scale
  if (typeof obj.gridScale === 'string') obj.gridScale = prefix + obj.gridScale
  for (const v of Object.values(obj)) {
    if (v != null && typeof v === 'object') prefixScaleRefs(v, prefix)
  }
}

/** Compile a repeat spec: one nested child group per repeat value, each with
 * its own data pipeline (validity-filtered), prefixed scales and axes. The
 * children size to the view defaults (childWidth signal / the merged root
 * height), never to the repeat spec's width/height — calibrated against the
 * oracle. A plain `repeat` array lays out horizontally; `{row, column}`
 * arrays form a grid (columns = column cardinality). */
function compileRepeat(spec: VLSpec): VLSpec {
  const rep = spec.repeat as unknown
  const child = (spec.spec ?? {}) as VLSpec
  const isGrid = rep != null && !Array.isArray(rep)
  const rowFields = (isGrid ? ((rep as Record<string, unknown>).row as unknown[] | undefined) ?? [] : []) as unknown[]
  const colFields = (isGrid ? ((rep as Record<string, unknown>).column as unknown[] | undefined) ?? [] : (rep as unknown[])) as unknown[]
  const grid = isGrid && rowFields.length > 0 && colFields.length > 0
  // plain array: vega lays the repeats out horizontally (columns)
  const values: Array<{ value: unknown; rowValue?: unknown; which: 'repeat' | 'row' | 'column' }> = []
  if (isGrid) {
    for (const r of rowFields) for (const c of colFields) values.push({ value: c, rowValue: r, which: 'column' })
  } else {
    for (const v of colFields) values.push({ value: v, which: 'repeat' })
  }

  const sharedSource = isObject(spec.data) && (spec.data as Record<string, unknown>).name != null
    ? (spec.data as Record<string, unknown>).name as string
    : 'source_0'

  const data: Record<string, unknown>[] = []
  const emittedSources = new Set<string>()
  let nextData = 1
  const marks: Record<string, unknown>[] = []
  const scales: ScaleSpec[] = []
  const legends: Record<string, unknown>[] = []
  let childWidth: number | undefined
  let childHeight: number | undefined

  values.forEach(({ value, rowValue, which }, i) => {
    // substitute {repeat: 'repeat'|'row'|'column'} field refs with the value —
    // the parent's reference is replaced outright (a field ref IS the
    // {repeat} object). Grid cells resolve 'row' to the row value and
    // 'column' to the column value.
    const repMap: Record<string, unknown> = isGrid
      ? { row: rowValue, column: value }
      : { repeat: value }
    const subst = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(subst); return }
      if (node == null || typeof node !== 'object') return
      const obj = node as Record<string, unknown>
      for (const [k, v] of Object.entries(obj)) {
        if (v != null && typeof v === 'object') {
          const inner = v as Record<string, unknown>
          const marker = typeof inner.repeat === 'string' ? inner.repeat : undefined
          if (marker != null && repMap[marker] !== undefined && Object.keys(inner).length === 1) {
            obj[k] = repMap[marker]
          } else {
            subst(v)
          }
        }
      }
    }
    const unitSpec: VLSpec = JSON.parse(JSON.stringify(child))
    subst(unitSpec)
    if (!isObject(unitSpec.data) && isObject(spec.data)) unitSpec.data = spec.data
    const unit = compileUnit(unitSpec)
    const unitData = unit.data as Record<string, unknown>[]
    const map = new Map<string, string>()
    const srcEntry = unitData[0]!
    const srcName = srcEntry.name as string
    if (srcName === 'source_0') {
      map.set('source_0', sharedSource)
      if (!emittedSources.has(sharedSource)) {
        data.push({ ...srcEntry, name: sharedSource })
        emittedSources.add(sharedSource)
      }
    } else if (!emittedSources.has(srcName)) {
      data.push(srcEntry)
      emittedSources.add(srcName)
    }
    for (const d of unitData.slice(1)) {
      const newName = `data_${nextData++}`
      map.set(d.name as string, newName)
      data.push({ ...d, name: newName, source: (d.source as string) === 'source_0' ? map.get('source_0') ?? sharedSource : d.source })
    }
    renameDataRefs(unit.scales, map)
    renameDataRefs(unit.marks, map)
    renameDataRefs(unit.axes ?? [], map)

    const cellKey = isGrid && rowValue !== undefined ? `row_${String(rowValue)}column_${String(value)}` : String(value)
    const prefix = `child__${cellKey}_`
    for (const sc of unit.scales as ScaleSpec[]) {
      if (SCALE_CHANNELS.includes(sc.name)) sc.name = prefix + sc.name
      if (sc.name === `${prefix}x`) sc.range = [0, { signal: 'childWidth' }]
      if (sc.name === `${prefix}y`) sc.range = [{ signal: isGrid ? 'childHeight' : 'height' }, 0]
      scales.push(sc)
    }
    const renameWidth = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(renameWidth); return }
      if (node != null && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k === 'signal' && typeof v === 'string') {
            ;(node as Record<string, unknown>)[k] = v.replace(/ceil\(width\/40\)/g, 'ceil(childWidth/40)').replace(/ceil\(width\/10\)/g, 'ceil(childWidth/10)')
          } else if (v != null && typeof v === 'object') renameWidth(v)
        }
      }
    }
    renameWidth(unit.axes ?? [])
    if (grid) {
      // vega-lite renames the children's merged size signals: grid cells'
      // axis tickCounts reference childWidth/childHeight (plain repeats keep
      // `height`, which resolves to the merged root height)
      for (const a of (unit.axes ?? []) as Record<string, unknown>[]) {
        const tc = a.tickCount as { signal?: string } | undefined
        if (tc && typeof tc.signal === 'string') {
          tc.signal = tc.signal.replace(/\bwidth\b/g, 'childWidth').replace(/\bheight\b/g, 'childHeight')
        }
      }
    }
    prefixScaleRefs(unit.marks, prefix)
    prefixScaleRefs(unit.axes ?? [], prefix)
    prefixScaleRefs(unit.legends ?? [], prefix)
    for (const lg of (unit.legends ?? []) as Record<string, unknown>[]) legends.push(lg)

    if (childWidth === undefined) childWidth = 300
    if (childHeight === undefined) childHeight = 300
    marks.push({
      name: `child__${cellKey}_group`,
      type: 'group',
      style: 'cell',
      encode: {
        update: {
          width: { signal: 'childWidth' },
          height: { signal: isGrid ? 'childHeight' : 'height' },
        },
      },
      marks: unit.marks as Record<string, unknown>[],
      ...(unit.axes && (unit.axes as unknown[]).length ? { axes: unit.axes } : {}),
    })
  })

  const out: Record<string, unknown> = {}
  if (spec.$schema) out.$schema = 'https://vega.github.io/schema/vega/v6.json'
  out.autosize = spec.autosize
  out.background = spec.background ?? 'white'
  out.padding = spec.padding ?? 5
  out.data = data
  if (grid) {
    // the oracle emits NO root width/height for grid repeats — the view pins
    // to the default (10×10 under autosize none) exactly like 1d facets
    out.signals = [
      { name: 'childWidth', value: childWidth },
      { name: 'childHeight', value: childHeight },
    ]
    out.layout = { padding: 20, columns: colFields.length || 1, bounds: 'full', align: 'all' }
  } else {
    out.height = childHeight
    out.signals = [{ name: 'childWidth', value: childWidth }]
    out.layout = { padding: 20, bounds: 'full', align: 'all' }
  }
  out.marks = marks
  out.scales = scales
  if (legends.length) out.legends = legends
  if (spec.title) out.title = spec.title
  return out
}

/** Compile an hconcat/vconcat/concat spec: one group per child with its own
 * prefixed scales and axes, a shared source, and per-child pipelines. */
function compileConcat(spec: VLSpec): VLSpec {
  const horizontal = spec.hconcat != null
  const children = ((spec.hconcat ?? spec.vconcat ?? spec.concat) as VLSpec[]) ?? []
  const sharedSource = isObject(spec.data) && (spec.data as Record<string, unknown>).name != null
    ? (spec.data as Record<string, unknown>).name as string
    : 'source_0'

  const data: Record<string, unknown>[] = []
  const emittedSources = new Set<string>()
  let nextData = 1
  const marks: Record<string, unknown>[] = []
  const scales: ScaleSpec[] = []
  const legends: Record<string, unknown>[] = []
  let childWidth: number | undefined
  let childHeight: number | undefined

  children.forEach((child, i) => {
    const unitSpec: VLSpec = { ...child }
    if (!isObject(unitSpec.data) && isObject(spec.data)) unitSpec.data = spec.data
    const unit = compileUnit(unitSpec)
    const unitData = unit.data as Record<string, unknown>[]
    const map = new Map<string, string>()
    // shared source
    const srcEntry = unitData[0]!
    const srcName = srcEntry.name as string
    if (srcName === 'source_0') {
      map.set('source_0', sharedSource)
      if (!emittedSources.has(sharedSource)) {
        data.push({ ...srcEntry, name: sharedSource })
        emittedSources.add(sharedSource)
      }
    } else if (!emittedSources.has(srcName)) {
      data.push(srcEntry)
      emittedSources.add(srcName)
    }
    // derived datasets
    for (const d of unitData.slice(1)) {
      const newName = `data_${nextData++}`
      map.set(d.name as string, newName)
      data.push({ ...d, name: newName, source: (d.source as string) === 'source_0' ? map.get('source_0') ?? sharedSource : d.source })
    }
    renameDataRefs(unit.scales, map)
    renameDataRefs(unit.marks, map)
    renameDataRefs(unit.axes ?? [], map)

    const prefix = `concat_${i}_`
    for (const sc of unit.scales as ScaleSpec[]) {
      if (SCALE_CHANNELS.includes(sc.name)) sc.name = prefix + sc.name
      // children size to the shared child dimension signal
      if (sc.name === `${prefix}x` && horizontal) sc.range = [0, { signal: 'childWidth' }]
      if (sc.name === `${prefix}y` && !horizontal) sc.range = [{ signal: 'childHeight' }, 0]
      scales.push(sc)
    }
    // tickCount expressions reference the child width
    const renameWidth = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(renameWidth); return }
      if (node != null && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k === 'signal' && typeof v === 'string') {
            ;(node as Record<string, unknown>)[k] = horizontal
              ? v.replace(/ceil\(width\/40\)/g, 'ceil(childWidth/40)').replace(/ceil\(width\/10\)/g, 'ceil(childWidth/10)')
              : v.replace(/ceil\(height\/40\)/g, 'ceil(childHeight/40)').replace(/ceil\(height\/10\)/g, 'ceil(childHeight/10)')
          } else if (v != null && typeof v === 'object') renameWidth(v)
        }
      }
    }
    renameWidth(unit.axes ?? [])
    prefixScaleRefs(unit.marks, prefix)
    prefixScaleRefs(unit.axes ?? [], prefix)
    prefixScaleRefs(unit.legends ?? [], prefix)
    for (const lg of (unit.legends ?? []) as Record<string, unknown>[]) legends.push(lg)

    const w = typeof child.width === 'number' ? child.width : undefined
    const h = typeof child.height === 'number' ? child.height : undefined
    if (childWidth === undefined) childWidth = w ?? 300
    if (childHeight === undefined) childHeight = h ?? 300
    marks.push({
      name: `concat_${i}_group`,
      type: 'group',
      style: 'cell',
      encode: {
        update: {
          width: w != null ? { value: w } : horizontal ? { signal: 'childWidth' } : { signal: 'width' },
          height: h != null ? { value: h } : horizontal ? { signal: 'height' } : { signal: 'childHeight' },
        },
      },
      marks: unit.marks as Record<string, unknown>[],
      ...(unit.axes && (unit.axes as unknown[]).length ? { axes: unit.axes } : {}),
    })
  })

  const out: Record<string, unknown> = {}
  if (spec.$schema) out.$schema = 'https://vega.github.io/schema/vega/v6.json'
  out.autosize = spec.autosize
  out.background = spec.background ?? 'white'
  out.padding = spec.padding ?? 5
  out.data = data
  if (horizontal) {
    out.height = childHeight
    out.signals = [{ name: 'childWidth', value: childWidth }]
  } else {
    out.width = childWidth
    out.signals = [{ name: 'childHeight', value: childHeight }]
  }
  out.layout = { padding: 20, bounds: 'full', align: 'each', ...(horizontal ? {} : { columns: 1 }) }
  out.marks = marks
  out.scales = scales
  if (legends.length) out.legends = legends
  if (spec.title) out.title = spec.title
  return out
}

// --- boxplot composite -------------------------------------------------------

/** Expand a boxplot composite mark into the layered aggregate structure
 * vega-lite compiles it to: outliers, whisker rules, the box and the median
 * bar (five marks over nine datasets). Vertical orientation only. */
function compileBoxplot(spec: VLSpec): VLSpec {
  const markDef = spec.mark as Record<string, unknown>
  const extent = (markDef.extent as number) ?? 1.5
  const enc = isObject(spec.encoding) ? (spec.encoding as Record<string, Record<string, unknown>>) : {}
  const xDef = enc.x
  const yDef = enc.y
  if (!xDef?.field || !yDef?.field) throw new Error('[aster/vl] boxplot requires x and y fields')
  const isDiscreteX = (xDef.type as string) === 'nominal' || (xDef.type as string) === 'ordinal'
  if (!isDiscreteX) throw new Error('[aster/vl] horizontal boxplot not supported yet')
  const dim = xDef.field as string
  const F = yDef.field as string
  const lowerBox = `lower_box_${F}`
  const upperBox = `upper_box_${F}`
  const midBox = `mid_box_${F}`
  const minF = `min_${F}`
  const maxF = `max_${F}`
  const lowerW = `lower_whisker_${F}`
  const upperW = `upper_whisker_${F}`
  const q = JSON.stringify(F)
  const outlierExpr =
    `(datum[${q}] < datum['${lowerBox}'] - ${extent} * (datum['${upperBox}'] - datum['${lowerBox}'])) || ` +
    `(datum[${q}] > datum['${upperBox}'] + ${extent} * (datum['${upperBox}'] - datum['${lowerBox}']))`
  const inlierExpr =
    `(datum['${lowerBox}'] - ${extent} * (datum['${upperBox}'] - datum['${lowerBox}']) <= datum[${q}]) && ` +
    `(datum[${q}] <= datum['${upperBox}'] + ${extent} * (datum['${upperBox}'] - datum['${lowerBox}']))`
  const validExpr = (f: string): string => `isValid(datum[${JSON.stringify(f)}]) && isFinite(+datum[${JSON.stringify(f)}])`

  const sourceName = isObject(spec.data) && (spec.data as Record<string, unknown>).name != null
    ? (spec.data as Record<string, unknown>).name as string
    : 'source_0'
  const source: Record<string, unknown> = { ...(isObject(spec.data) ? spec.data : {}), name: sourceName }

  const bandX = { scale: 'x', field: dim, band: 0.5 }
  const marks: Record<string, unknown>[] = [
    {
      name: 'layer_0_layer_0_marks',
      type: 'symbol',
      style: ['point'],
      from: { data: 'data_2' },
      encode: { update: {
        opacity: { value: 0.7 },
        fill: { value: 'transparent' },
        stroke: { value: '#4c78a8' },
        ariaRoleDescription: { value: 'point' },
        x: bandX,
        y: { scale: 'y', field: F },
      } },
    },
    {
      name: 'layer_0_layer_1_layer_0_marks',
      type: 'rule',
      style: ['rule'],
      from: { data: 'data_4' },
      encode: { update: {
        stroke: { value: 'black' },
        x: bandX,
        y: { scale: 'y', field: lowerW },
        y2: { scale: 'y', field: lowerBox },
      } },
    },
    {
      name: 'layer_0_layer_1_layer_1_marks',
      type: 'rule',
      style: ['rule'],
      from: { data: 'data_5' },
      encode: { update: {
        stroke: { value: 'black' },
        x: bandX,
        y: { scale: 'y', field: upperBox },
        y2: { scale: 'y', field: upperW },
      } },
    },
    {
      name: 'layer_1_layer_0_marks',
      type: 'rect',
      style: ['box'],
      from: { data: 'data_7' },
      encode: { update: {
        ariaRoleDescription: { value: 'box' },
        fill: { value: '#4c78a8' },
        xc: bandX,
        width: { value: 14 },
        y: { scale: 'y', field: lowerBox },
        y2: { scale: 'y', field: upperBox },
      } },
    },
    {
      name: 'layer_1_layer_1_marks',
      type: 'rect',
      style: ['box'],
      from: { data: 'data_8' },
      encode: { update: {
        opacity: { value: 0.7 },
        fill: [{ test: `datum['${lowerBox}'] >= datum['${upperBox}']`, value: '#4c78a8' }, { value: 'white' }],
        xc: bandX,
        width: { value: 14 },
        yc: { scale: 'y', field: midBox },
        height: { value: 1 },
      } },
    },
  ]

  const data: Record<string, unknown>[] = [
    source,
    { name: 'data_1', source: sourceName, transform: [{ type: 'joinaggregate', as: [lowerBox, upperBox], ops: ['q1', 'q3'], fields: [F, F], groupby: [dim] }] },
    { name: 'data_2', source: 'data_1', transform: [{ type: 'filter', expr: outlierExpr }, { type: 'filter', expr: validExpr(F) }] },
    {
      name: 'data_3',
      source: 'data_1',
      transform: [
        { type: 'filter', expr: inlierExpr },
        { type: 'aggregate', groupby: [dim], ops: ['min', 'max', 'min', 'max'], fields: [F, F, lowerBox, upperBox], as: [lowerW, upperW, lowerBox, upperBox] },
      ],
    },
    { name: 'data_4', source: 'data_3', transform: [{ type: 'filter', expr: validExpr(lowerW) }] },
    { name: 'data_5', source: 'data_3', transform: [{ type: 'filter', expr: validExpr(upperBox) }] },
    { name: 'data_6', source: sourceName, transform: [{ type: 'aggregate', groupby: [dim], ops: ['q1', 'q3', 'median', 'min', 'max'], fields: [F, F, F, F, F], as: [lowerBox, upperBox, midBox, minF, maxF] }] },
    { name: 'data_7', source: 'data_6', transform: [{ type: 'filter', expr: validExpr(lowerBox) }] },
    { name: 'data_8', source: 'data_6', transform: [{ type: 'filter', expr: validExpr(midBox) }] },
  ]

  const domainEntry = (data: string, field: string): unknown => ({ data, field })
  const scales: ScaleSpec[] = [
    {
      name: 'x',
      type: 'band',
      domain: { fields: ['data_2', 'data_4', 'data_5', 'data_7', 'data_8'].map((d) => domainEntry(d, dim)), sort: true },
      range: [0, { signal: 'width' }],
      paddingInner: 0,
      paddingOuter: 0,
    },
    {
      name: 'y',
      type: 'linear',
      domain: {
        fields: [
          domainEntry('data_2', F),
          domainEntry('data_4', lowerW),
          domainEntry('data_4', lowerBox),
          domainEntry('data_5', upperBox),
          domainEntry('data_5', upperW),
          domainEntry('data_7', lowerBox),
          domainEntry('data_7', upperBox),
          domainEntry('data_8', midBox),
        ],
      },
      range: [{ signal: 'height' }, 0],
      zero: true,
      nice: true,
    },
  ]

  const out: Record<string, unknown> = {}
  if (spec.$schema) out.$schema = 'https://vega.github.io/schema/vega/v6.json'
  out.autosize = spec.autosize
  out.background = spec.background ?? 'white'
  out.padding = spec.padding ?? 5
  out.width = spec.width ?? 200
  out.height = spec.height ?? 200
  out.style = 'cell'
  out.data = data
  out.marks = marks
  out.scales = scales
  out.axes = [
    { scale: 'y', orient: 'left', gridScale: 'x', grid: true, tickCount: { signal: 'ceil(height/40)' }, domain: false, labels: false, aria: false, maxExtent: 0, minExtent: 0, ticks: false, zindex: 0 },
    { scale: 'x', orient: 'bottom', grid: false, title: channelTitle(xDef as never), labelAlign: 'right', labelAngle: 270, labelBaseline: 'middle', zindex: 0 },
    { scale: 'y', orient: 'left', grid: false, title: channelTitle(yDef as never), labelOverlap: true, tickCount: { signal: 'ceil(height/40)' }, zindex: 0 },
  ]
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
    bandPosition: raw.bandPosition as number | undefined,
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

// --- config ------------------------------------------------------------------

/**
 * Vega-Lite resolves its config into Vega-level pieces (probed against
 * vl.compile): guide blocks (axis/axisX/axisY/axisBand/axisOrient, legend,
 * header, range) forward verbatim into the Vega config; config.mark forwards
 * as config.mark; per-mark-type blocks become config.style[type]; config.view
 * becomes the 'cell' style; config.title splits onto 'group-title' (color ->
 * fill) and 'group-subtitle' (align/baseline/limit); config.font seeds the
 * guide/title/text styles; config.scale applies straight to the scales; the
 * VL-only keys (invalid, filled, binSpacing, continuousBandSize, bandSize,
 * thickness, point, line, color, the view sizing props) are stripped.
 */
const VL_ONLY_MARK_KEYS = new Set(['invalid', 'filled', 'binSpacing', 'continuousBandSize', 'bandSize', 'thickness', 'point', 'line', 'color'])
const VIEW_DROPPED_KEYS = new Set(['discreteWidth', 'discreteHeight', 'continuousWidth', 'continuousHeight', 'step'])
const MARK_TYPE_BLOCKS = ['bar', 'point', 'line', 'area', 'text', 'tick', 'rect', 'arc', 'rule', 'trail', 'circle', 'square', 'geoshape', 'image']

export function assembleConfig(spec: VLSpec): Record<string, unknown> | undefined {
  const user = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  if (!user) return undefined
  const out: Record<string, unknown> = {}
  const style: Record<string, Record<string, unknown>> = {}
  const strip = (block: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(block).filter(([k]) => !VL_ONLY_MARK_KEYS.has(k)))
  for (const k of ['axis', 'axisX', 'axisY', 'axisBand', 'axisLeft', 'axisRight', 'axisTop', 'axisBottom', 'legend', 'header', 'headerRow', 'headerColumn', 'headerFacet', 'range']) {
    if (isObject(user[k])) out[k] = user[k]
  }
  if (isObject(user.mark)) out.mark = strip(user.mark)
  for (const t of MARK_TYPE_BLOCKS) {
    if (isObject(user[t])) style[t] = strip(user[t])
  }
  if (isObject(user.view)) {
    style.cell = Object.fromEntries(Object.entries(user.view).filter(([k]) => !VIEW_DROPPED_KEYS.has(k)))
  }
  if (isObject(user.title)) {
    const gt: Record<string, unknown> = {}
    const gs: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(user.title)) {
      if (k === 'anchor' || k === 'offset' || k === 'orient') continue
      if (k === 'color') gt.fill = v
      else gt[k] = v
      if (k === 'align' || k === 'baseline' || k === 'limit') gs[k] = v
    }
    if (Object.keys(gt).length) style['group-title'] = gt
    if (Object.keys(gs).length) style['group-subtitle'] = gs
  }
  if (typeof user.font === 'string') {
    for (const name of ['guide-label', 'guide-title', 'group-title', 'group-subtitle', 'text']) {
      style[name] = { ...style[name], font: user.font }
    }
  }
  if (Object.keys(style).length) out.style = style
  return Object.keys(out).length ? out : undefined
}

/** Apply config.scale to the compiled positional scales (round on x/y;
 * nice/zero on continuous quantitative ones — the color scale gets none). */
function applyScaleConfig(scales: ScaleSpec[], user: Record<string, unknown> | undefined): void {
  const sc = isObject(user?.scale) ? (user!.scale as Record<string, unknown>) : undefined
  if (!sc) return
  for (const s of scales) {
    if (s.name !== 'x' && s.name !== 'y') continue
    if (sc.round !== undefined) s.round = Boolean(sc.round)
    if (isContinuousScaleType(String(s.type)) && !isTimeScaleType(String(s.type))) {
      if (sc.nice !== undefined) s.nice = sc.nice
      if (sc.zero !== undefined) s.zero = Boolean(sc.zero)
    }
  }
}

const isTimeScaleType = (t: string) => t === 'time' || t === 'utc'

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
  day: 'day', dayofyear: 'dayofyear', hours: 'hours', minutes: 'minutes',
  seconds: 'seconds', milliseconds: 'milliseconds',
  yearquarter: 'year-quarter', yearmonth: 'year-month', yearmonthdate: 'year-month-date',
  yearweek: 'year-week', yeardayofyear: 'year-dayofyear', quartermonth: 'quarter-month',
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
  const arcTheta = thetaStackInfo(mark, fields)
  const radiusDefP = fields.find((f) => f.channel === 'radius' && f.field)
  if (mark === 'arc' && thetaDef && arcTheta) {
    if (radiusDefP?.aggregate) {
      // an aggregated radius measure: aggregate it (grouped by the raw theta
      // field — the polar dimension), filtering both endpoints
      const groupby = fields.filter((f) => f.field && !f.aggregate && f.channel !== 'radius').map((f) => f.field)
      pipeline.push({ type: 'aggregate', groupby, ops: [radiusDefP.aggregate!], fields: [radiusDefP.field], as: [aggFieldName(radiusDefP)] })
      const filt = ['theta', 'radius'].map((ch) => {
        const f = fields.find((ff) => ff.channel === ch && ff.field)
        return f ? `isValid(datum[${JSON.stringify(aggFieldName(f))}]) && isFinite(+datum[${JSON.stringify(aggFieldName(f))}])` : null
      }).filter(Boolean).join(' && ')
      if (filt) pipeline.push({ type: 'filter', expr: filt })
    } else if (radiusDefP) {
      // radius stacking (radius.stack): the polar dimension (theta) groups,
      // the radius measure stacks into radius_start/end
      if (radiusDefP.stack != null && radiusDefP.stack !== false) {
        pipeline.push({
          type: 'stack',
          groupby: [thetaDef.field],
          field: radiusDefP.field,
          sort: { field: [], order: [] },
          as: [`${radiusDefP.field}_start`, `${radiusDefP.field}_end`],
          offset: radiusDefP.stack === true ? 'zero' : radiusDefP.stack,
        })
      }
      const filt = ['theta', 'radius'].map((ch) => {
        const f = fields.find((ff) => ff.channel === ch && ff.field)
        return f ? `isValid(datum[${JSON.stringify(aggFieldName(f))}]) && isFinite(+datum[${JSON.stringify(aggFieldName(f))}])` : null
      }).filter(Boolean).join(' && ')
      if (filt) pipeline.push({ type: 'filter', expr: filt })
    } else if (thetaDef.aggregate) {
      // aggregate the theta measure, grouped by the raw (non-aggregated)
      // field channels, then stack the aggregated field when there is a
      // series to stack by (probed against the oracle)
      const rawFields = fields.filter((f) => f.field && !f.aggregate && f.channel !== 'theta' && f.channel !== 'radius')
      const groupby = rawFields.map((f) => f.field)
      pipeline.push({ type: 'aggregate', groupby, ops: [thetaDef.aggregate!], fields: [thetaDef.field], as: [arcTheta.field] })
      if (groupby.length) {
        pipeline.push({
          type: 'stack',
          groupby: [],
          field: arcTheta.field,
          sort: { field: [groupby[0]!], order: ['ascending'] },
          as: [`${arcTheta.field}_start`, `${arcTheta.field}_end`],
          offset: 'zero',
        })
      }
      pipeline.push({ type: 'filter', expr: `isValid(datum[${JSON.stringify(arcTheta.field)}]) && isFinite(+datum[${JSON.stringify(arcTheta.field)}])` })
    } else if (arcTheta.stacked) {
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
  const userTransforms = Array.isArray(spec.transform) ? (spec.transform as Record<string, unknown>[]) : []
  const GENERATING = new Set(['regression', 'quantile', 'loess', 'kde', 'density'])
  const lastUser = userTransforms.length
    ? (userTransforms[userTransforms.length - 1] as Record<string, unknown>)
    : undefined
  const lastUserType = lastUser == null
    ? undefined
    : (lastUser.type as string | undefined) ?? GENERATING.has(Object.keys(lastUser)[0] ?? '') ? Object.keys(lastUser)[0] : undefined
  // a generating transform that ends the pipeline REPLACES the data feeding
  // the mark — vega-lite skips both the type casts and the invalid-value
  // filter in that case (e.g. {regression: y, on: x})
  const generatingEnd = lastUser != null && GENERATING.has(lastUserType ?? '')
    ? !(
        fields.some((f) => f.aggregate) ||
        (measure != null && isStacked(measure, mark, orient, fields)) ||
        (mark === 'arc' && thetaDef != null)
      )
    : false
  const skipCasts = binFields.length > 0 || generatingEnd ||
    ((mark === 'bar' || mark === 'area') &&
    !fields.some((f) => f.aggregate) &&
    !fields.some((f) => f.timeUnit) &&
    fields.some((f) => f.channel === (orient === 'vertical' ? 'y' : 'x') && f.type === 'quantitative') &&
    !continuousDimension)
  if (!skipCasts) {
    // a field carrying a timeUnit anywhere in the encoding casts as a date,
    // even if another channel declares it quantitative
    const timeUnitFields = new Set(fields.filter((f) => f.timeUnit).map((f) => f.field))
    for (const f of fields) {
      if (castDone.has(f.field)) continue
      castDone.add(f.field)
      if (timeUnitFields.has(f.field) || f.timeUnit || f.type === 'temporal') {
        // a timeUnit implies a temporal cast even when the declared type is
        // quantitative (probed: size/timeUnit-year casts the source toDate)
        casts.push({ type: 'formula', expr: `toDate(datum[${JSON.stringify(f.field)}])`, as: f.field })
      } else if (f.type === 'quantitative') {
        casts.push({ type: 'formula', expr: `toNumber(datum[${JSON.stringify(f.field)}])`, as: f.field })
      }
    }
  }
  // user transforms (calculate/filter/flatten/fold/window/...): they pass
  // through as vega transforms ahead of any encoding pipeline
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
          const fielded = new Set(['quantile', 'kde', 'bin', 'timeunit', 'countpattern', 'pivot'])
          const next: Record<string, unknown> = { ...t, type: k }
          if (fielded.has(k) && next.field == null) next.field = (t as Record<string, unknown>)[k]
          delete next[k]
          // vega-lite compiles {regression: y, on: x} and {loess: y, on: x} to
          // vega's x/y-parameter form
          if (k === 'regression' || k === 'loess') {
            next.y = (t as Record<string, unknown>)[k]
            next.x = next.on ?? next.x
            next.as = next.as ?? [next.x, next.y]
            delete next.field
            delete next.on
          }
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

  // arcs run their own aggregate+stack law (thetaStackInfo) — the generic
  // block would aggregate after the stack and mis-group
  if ((hasAggregate && mark !== 'arc') || binFields.length) {
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
      } else if (!f.bin && f.field) {
        // vega-lite groups by every non-aggregated field: the dimension,
        // color/detail, and any other channel's raw field (an aggregate on
        // one channel groups by the other channels — probed: x-aggregate
        // over a quantitative y groups by y)
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
  } else if (stackable && measure && measure.type === 'quantitative' && !measure.bin && isStacked(measure, mark, orient, fields)) {
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
  // (skipped when a generating transform replaces the data entirely)
  if (userTransforms.length && !generatingEnd) {
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

/** Arc theta layout (vega-lite stack.ts + mark/arc.ts + position-rect.ts):
 * - theta unaggregated, no radius channel → stacked (field_start/end)
 * - theta aggregated with a raw field to stack by (color/detail) → aggregate
 *   first, then stack the aggregated field (agg_start/end)
 * - theta aggregated with nothing to stack by, or a radius channel present
 *   (stacked or not) → not stacked: the arc spans startAngle = field,
 *   endAngle = scale zero; a radius channel adds a radius scale driving
 *   outerRadius/innerRadius. */
function thetaStackInfo(mark: string, fields: FieldDef[]): { stacked: boolean; field: string; offsettedRect?: boolean } | null {
  if (mark !== 'arc') return null
  const thetaDef = fields.find((f) => f.channel === 'theta' && f.field)
  if (!thetaDef) return null
  const radiusDef = fields.find((f) => f.channel === 'radius' && f.field)
  if (thetaDef.aggregate) {
    const stackBy = fields.some((f) => f.field && !f.aggregate && f.channel !== 'theta' && f.channel !== 'radius')
    return { stacked: stackBy, field: aggregateAs(thetaDef) }
  }
  if (thetaDef.timeUnit) {
    // timeUnit thetas are not stacked; the angles reference the (never
    // populated) offsetted-rect fields — an upstream quirk the sweep pins
    return { stacked: false, field: timeUnitField(thetaDef), offsettedRect: true }
  }
  return { stacked: radiusDef == null, field: thetaDef.field }
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

const TU_PRIMITIVE = new Set(['year', 'quarter', 'month', 'week', 'date', 'day', 'dayofyear', 'hours', 'minutes', 'seconds', 'milliseconds'])
/** The units list vega's timeUnitSpecifier consumes: primitive units only
 * (the transform list adds context units like year+week, but the specifier
 * formats just the requested unit — probed against vl.compile). */
function timeUnitSpecifierUnits(u: string): string[] {
  return TU_PRIMITIVE.has(u) ? [u] : timeUnitUnits(u)
}

/** vega's timeUnitSpecifier signal for a vega-lite timeUnit. */
function timeUnitFormatSignal(u: string): string {
  return `timeUnitSpecifier(${JSON.stringify(timeUnitSpecifierUnits(u))}, {"year-month":"%b %Y ","year-month-date":"%b %d, %Y "})`
}

/** Non-positional legends format timeUnit fields with timeFormat. */
function applyTimeUnitLegend(lg: Record<string, unknown>, def: FieldDef, userLegend?: Record<string, unknown>): void {
  if (!def.timeUnit) return
  if (userLegend && userLegend.format !== undefined) return
  lg.format = { signal: timeUnitFormatSignal(def.timeUnit) }
  lg.formatType = 'time'
}

const TIME_UNIT_UNITS: Record<string, string[]> = {
  year: ['year'], quarter: ['quarter'], month: ['month'], week: ['week'],
  date: ['date'], day: ['day'], dayofyear: ['dayofyear'],
  hours: ['hours'], minutes: ['minutes'], seconds: ['seconds'], milliseconds: ['milliseconds'],
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
  if (isDiscreteType(def.type)) {
    // a discrete positional channel only honors the two discrete positional
    // scale types; anything else falls back to the mark's natural type
    // (probed: nominal x + scale type linear/ordinal/threshold → band)
    const natural = mark === 'bar' || mark === 'rect' || mark === 'tick' || mark === 'rule' || mark === 'image' ? 'band' : 'point'
    const user = def.scale?.type as string | undefined
    return user === 'point' || user === 'band' ? user : natural
  }
  if (def.scale?.type) return def.scale.type as string
  if (def.type === 'temporal') return 'time'
  return 'linear'
}

function buildScales(spec: VLSpec, fields: FieldDef[], mark: string, orient: string, dataName: string, width: unknown, height: unknown, series: FieldDef[] = []): ScaleSpec[] {
  const scales: ScaleSpec[] = []
  const userScaleCfg = isObject(spec.config) && isObject((spec.config as Record<string, unknown>).scale)
    ? (spec.config as Record<string, unknown>).scale as Record<string, unknown>
    : undefined
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
    // a secondary range channel (x2/y2 field) extends the scale domain to the
    // union of both endpoints (vega-lite scale/assemble: fields union)
    const ch2 = channel === 'x' ? 'x2' : 'y2'
    const def2 = fields.find((f) => f.channel === ch2 && f.field)
    // discrete y scales run top-to-bottom; continuous y scales are reversed
    const effRange = channel === 'y' && (type === 'band' || type === 'point') ? [0, { signal: 'height' }] : range
    const sc: ScaleSpec = {
      name: channel,
      type,
      domain: def2 && !def2.bin && !def.stack
        ? { data: dataName, fields: [aggFieldName(def), aggFieldName(def2)] }
        : positionalDomain(def, dataName, mark, orient, fields),
      range: effRange,
    }
    const measureChannel = orient === 'vertical' ? 'y' : 'x'
    // rect marks with two discrete channels (heatmaps) use unpadded bands
    const otherChannel = channel === 'x' ? 'y' : 'x'
    const otherDef = fields.find((f) => f.channel === otherChannel)
    const bothDiscrete = mark === 'rect' && otherDef != null && isDiscreteType(otherDef.type)
    // bar/rect marks pad the dimension channel; timeUnit dimensions use the
    // offset-encoded band layout instead and stay unpadded
    if (
      (mark === 'bar' || (mark === 'rect' && !bothDiscrete)) && channel !== measureChannel &&
      !def.timeUnit
    ) sc.padding = 5
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
      // binned scales: no zero/nice; domain comes from bin start/end
      // (zero must be explicitly false — a missing key means the engine's
      // linear default kicks in and extends the domain to 0)
      if (def.bin) {
        sc.zero = false
        sc.nice = false
        delete sc.padding
      }
    } else if (type === 'band') {
      const hasOffset = fields.some((f) => f.channel === 'xOffset' || f.channel === 'yOffset')
      // vl scale/properties.ts: bar → barBandPaddingInner (0.1), tick → 0.25,
      // everything else (rect/rule/image) → rectBandPaddingInner (0); the
      // outer padding defaults to half the inner. An explicit `padding`
      // replaces both inner and outer; an explicit paddingInner carries its
      // half into the default outer.
      const cfgInner = (userScaleCfg?.bandPaddingInner as number | undefined)
        ?? (mark === 'bar' ? userScaleCfg?.barBandPaddingInner as number | undefined : undefined)
        ?? (mark === 'tick' ? userScaleCfg?.tickBandPaddingInner as number | undefined : undefined)
        ?? (mark === 'rect' ? userScaleCfg?.rectBandPaddingInner as number | undefined : undefined)
      const defaultInner = cfgInner ?? (mark === 'tick' ? 0.25 : hasOffset ? 0.2 : mark === 'bar' ? C.barPaddingInner : 0)
      const defaultOuter = (userScaleCfg?.bandPaddingOuter as number | undefined)
        ?? (cfgInner != null ? cfgInner / 2 : (mark === 'tick' ? 0.125 : hasOffset ? 0.2 : mark === 'bar' ? C.barPaddingInner / 2 : 0))
      const userPadding = def.scale?.padding as number | undefined
      if (userPadding != null) {
        sc.padding = userPadding
      } else {
        const userInner = def.scale?.paddingInner as number | undefined
        sc.paddingInner = userInner ?? defaultInner
        sc.paddingOuter = (def.scale?.paddingOuter as number | undefined) ?? (userInner != null ? userInner / 2 : defaultOuter)
      }
    } else if (type === 'point') {
      sc.padding = (def.scale?.padding as number | undefined) ?? C.pointPadding
    }
    if (def.scale) {
      const discretePos = type === 'band' || type === 'point' || type === 'ordinal' || type === 'bin-ordinal'
      for (const [k, v] of Object.entries(def.scale)) {
        if (k === 'type' || k === 'zero' || k === 'nice' || k === 'padding' || k === 'paddingInner') continue
        // discrete positional scales ignore continuous domain adjustments
        if (discretePos && (k === 'domain' || k === 'domainMin' || k === 'domainMax' || k === 'domainMid')) continue
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
        // line marks map size onto stroke width [1,4]; symbol marks onto area
        range: sizeDef.scale?.range ?? (mark === 'line' ? [1, 4] : [4, 361]),
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
  const arcThetaS = thetaStackInfo(mark, fields)
  if ((mark === 'arc' || mark === 'text') && thetaDef) {
    scales.push({
      name: 'theta',
      type: 'linear',
      // stacked arcs span the start/end fields; plain text layers and
      // unstacked arcs read the field directly
      domain: mark === 'arc' && arcThetaS?.stacked
        ? { data: dataName, fields: [`${arcThetaS.field}_start`, `${arcThetaS.field}_end`] }
        : { data: dataName, field: arcThetaS?.field ?? thetaDef.field },
      range: [0, 6.283185307179586],
      // the theta def's sort reverses the angular scale
      reverse: thetaDef.sort === 'descending' ? true : undefined,
      zero: true,
    })
  }
  // radius scale (arc marks): drives outerRadius/innerRadius
  const radiusDef = fields.find((f) => f.channel === 'radius' && f.field)
  if (mark === 'arc' && radiusDef) {
    const stackedR = radiusDef.stack != null && radiusDef.stack !== false
    scales.push({
      name: 'radius',
      type: 'linear',
      domain: stackedR
        ? { data: dataName, fields: [`${aggFieldName(radiusDef)}_start`, `${aggFieldName(radiusDef)}_end`] }
        : { data: dataName, field: aggFieldName(radiusDef) },
      range: [0, { signal: 'min(width,height)/2' }],
      reverse: radiusDef.sort === 'descending' ? true : undefined,
      zero: true,
    })
  }

  // color scale
  const colorDef = fields.find((f) => f.channel === 'color' && f.field)
  const numericAggregate = colorDef?.aggregate != null && ['count', 'distinct', 'valid', 'missing'].includes(colorDef.aggregate)
  if (colorDef) {
    if (isDiscreteType(colorDef.type) && !numericAggregate) {
      scales.push({
        name: 'color',
        type: 'ordinal',
        domain: sortedDomain(colorDef, dataName),
        range: (colorDef.scale?.range as unknown) ?? colorDef.scale?.scheme ?? 'category',
      })
    } else {
      const cs = colorDef.scale ?? {}
      const colorScaleType = ['linear', 'log', 'pow', 'sqrt', 'symlog', 'quantile', 'quantize', 'threshold'].includes(cs.type as string)
        ? cs.type as string
        : 'linear'
      scales.push({
        name: 'color',
        type: colorScaleType,
        domain: { data: dataName, field: aggFieldName(colorDef) },
        // vega-lite's quantitative color range: 'heatmap' scheme for
        // rect/geoshape marks, a ramp otherwise; a domainMid makes it
        // diverging; an explicit scheme replaces the range (probed)
        ...(cs.range != null
          ? { range: cs.range }
          : cs.scheme != null
            ? { range: { scheme: cs.scheme } }
            : { range: cs.domainMid != null ? 'diverging' : mark === 'rect' || mark === 'geoshape' ? 'heatmap' : 'ramp' }),
        // vega-lite sets the colorspace for continuous color scales (probed:
        // interpolate hcl on ramp/scheme/diverging alike)
        interpolate: 'hcl',
        ...(cs.reverse !== undefined ? { reverse: Boolean(cs.reverse) } : {}),
        ...(cs.domainMin !== undefined ? { domainMin: cs.domainMin } : {}),
        ...(cs.domainMax !== undefined ? { domainMax: cs.domainMax } : {}),
        ...(cs.domainMid !== undefined ? { domainMid: cs.domainMid } : {}),
        ...(cs.bins !== undefined ? { bins: cs.bins } : {}),
        ...(colorScaleType === 'quantile' || colorScaleType === 'threshold'
          ? {}
          : { zero: (cs.zero as boolean | undefined) ?? false }),
      })
    }
  }

  void width
  void height
  return scales
}

function zeroDefaultFor(mark: string, channel: string, orient: string): boolean {
  // vega-lite scale/properties.ts zero(): bar/area/line/trail opt out on their
  // dimension axis; everything else (including their measure axis) falls
  // through to config.zero (true) for continuous positional scales.
  if (mark === 'bar' || mark === 'area' || mark === 'line' || mark === 'trail') {
    if ((orient === 'horizontal' && channel === 'y') || (orient === 'vertical' && channel === 'x')) return false
  }
  return true
}

function positionalDomain(def: FieldDef, dataName: string, mark: string, orient: string, fields?: FieldDef[]): unknown {
  if (def.bin) {
    const maxbins = isObject(def.bin) && (def.bin.maxbins as number | undefined) ? (def.bin.maxbins as number) : 10
    return { signal: `[bin_maxbins_${maxbins}_${def.field}_bins.start, bin_maxbins_${maxbins}_${def.field}_bins.stop]` }
  }
  if (def.timeUnit && (mark === 'bar' || mark === 'rect') && !isDiscreteType(def.type)) {
    return { data: dataName, fields: [timeUnitField(def), `${timeUnitField(def)}_end`] }
  }
  if (def.stack === 'normalize') return [0, 1]
  if (isDiscreteType(def.type)) return sortedDomain(def, dataName)
  const measureChannel = orient === 'vertical' ? 'y' : 'x'
  const stacked = isStacked(def, mark, orient, fields)
  if (def.channel === measureChannel && stacked) {
    return { data: dataName, fields: [`${def.field}_start`, `${def.field}_end`] }
  }
  return { data: dataName, field: aggFieldName(def) }
}

function isStacked(def: FieldDef, mark: string, orient: string, allFields?: FieldDef[]): boolean {
  if (mark !== 'bar' && mark !== 'area') return false
  const measureChannel = orient === 'vertical' ? 'y' : 'x'
  if (def.channel !== measureChannel) return false
  if (def.type !== 'quantitative' || def.aggregate || def.bin) return false
  // explicit stack false/null opts out; 'wiggle' compiles to a plain
  // unstacked measure (vega's Stack transform only supports zero/center/
  // normalize)
  if (def.stack === false || def.stack === null || def.stack === 'wiggle') return false
  if (allFields) {
    // vega-lite's stack law (stack.ts): an aggregate anywhere in the
    // encoding with no *unaggregated* stack-by series disables stacking;
    // ranged marks never stack.
    const dimChannel = orient === 'vertical' ? 'x' : 'y'
    const groupFields = new Set(
      allFields
        .filter((f) => f.channel === dimChannel || f.channel === 'xOffset' || f.channel === 'yOffset')
        .map((f) => f.field),
    )
    const positional = new Set(['x', 'y', 'x2', 'y2', 'xOffset', 'yOffset', 'theta', 'radius', 'row', 'column', 'facet'])
    const stackBy = allFields.filter(
      (f) => f.field && !positional.has(f.channel) && !f.aggregate && !groupFields.has(f.field),
    )
    if (allFields.some((f) => f.aggregate) && stackBy.length === 0) return false
    if (allFields.some((f) => (f.channel === 'x2' || f.channel === 'y2') && f.field)) return false
  }
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

function buildAxes(fields: FieldDef[], mark: string, orient: string, scales: ScaleSpec[], scaleName?: string, gridScaleOverride?: string, config?: Record<string, unknown>): Record<string, unknown>[] {
  const axes: Record<string, unknown>[] = []
  const scaleByName = new Map(scales.map((s) => [s.name, s]))

  for (const def of fields) {
    if (!POSITIONAL.has(def.channel) || (def.channel !== 'x' && def.channel !== 'y')) continue
    if (def.axis === null) continue
    // config.axis seeds both channels; config.axisX/axisY override it; the
    // channel's own axis definition wins last (vega-lite axis config cascade).
    const cfgAxis = isObject(config?.axis) ? (config!.axis as Record<string, unknown>) : {}
    const cfgChannelAxis = isObject(config?.[def.channel === 'x' ? 'axisX' : 'axisY'])
      ? (config![def.channel === 'x' ? 'axisX' : 'axisY'] as Record<string, unknown>)
      : {}
    const userAxis: Record<string, unknown> | undefined = {
      ...cfgAxis,
      ...cfgChannelAxis,
      ...(def.axis ?? {}),
    }
    if (userAxis.disable === true) continue
    const sc = scaleByName.get(scaleName ?? def.channel)!
    // Vega's axisBand block is consulted before config.axis for band scales,
    // so a config tickOffset (axis/axisX/axisY) does not override it. An
    // explicit axis definition still wins.
    if (sc.type === 'band' && (def.axis == null || (def.axis as Record<string, unknown>).tickOffset === undefined)) {
      delete (userAxis as Record<string, unknown>).tickOffset
    }
    const grid = (userAxis?.grid as boolean | undefined) ?? (isContinuousScaleType(sc.type) && !def.bin)
    const tickCountSignal = def.channel === 'x' ? { signal: 'ceil(width/40)' } : { signal: 'ceil(height/40)' }
    const orientSide = def.channel === 'x' ? 'bottom' : 'left'
    const gridScale = def.channel === 'x'
      ? (gridScaleOverride ?? (scaleByName.get('y') ? 'y' : undefined))
      : scaleByName.get('x')
        ? 'x'
        : scaleByName.get('x') === undefined && scales.some((s) => s.name.endsWith('_y'))
          ? undefined
          : undefined

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
      // the user's grid-affecting props land on the grid axis too (upstream
      // merges grid+labels into one axis; ours splits them)
      if (userAxis) {
        for (const gk of ['gridColor', 'gridWidth', 'gridDash', 'gridOpacity', 'gridCap', 'tickOffset', 'translate', 'tickBand', 'tickExtra'] as const) {
          if ((userAxis as Record<string, unknown>)[gk] !== undefined) gridAxis[gk] = (userAxis as Record<string, unknown>)[gk]
        }
      }
      axes.push(gridAxis)
    }

    const title = axisTitle(def, userAxis, fields)
    const labelAxis: Record<string, unknown> = {
      scale: scaleName ?? def.channel,
      orient: orientSide,
      grid: false,
      zindex: 0,
    }
    if (title !== null) labelAxis.title = title
    // vega-lite merges config.axisBand into band-scale axis definitions
    // (probed: the def carries the block's properties, user def winning)
    const axisBand = isObject(config?.axisBand) ? (config!.axisBand as Record<string, unknown>) : undefined
    if (sc.type === 'band' && axisBand) {
      for (const [k, v] of Object.entries(axisBand)) {
        if (k === 'grid' || k === 'title' || k === 'orient' || k === 'scale') continue
        if (labelAxis[k] === undefined) labelAxis[k] = v
      }
    }
    if (isContinuousScaleType(sc.type)) {
      if (def.channel === 'x') labelAxis.labelFlush = true
      labelAxis.labelOverlap = sc.type === 'log' ? 'greedy' : true
      // log axes carry no explicit tickCount — vega's axis defaults to 10,
      // which drives the log label filter (3/30/300 stay visible)
      if (sc.type !== 'log') labelAxis.tickCount = def.bin
        ? { signal: def.channel === 'x' ? 'ceil(width/10)' : 'ceil(height/10)' }
        : tickCountSignal
      if (def.timeUnit) {
        const units = JSON.stringify(timeUnitUnits(def.timeUnit))
        labelAxis.format = {
          signal: `timeUnitSpecifier(${units}, {"year-month":"%b %Y ","year-month-date":"%b %d, %Y "})`,
        }
        labelAxis.formatType = 'time'
        // the minimum tick step is one unit: expressed as a datetime difference
        const stepExpr = timeUnitMinStepSignal(def.timeUnit)
        if (stepExpr) labelAxis.tickMinStep = { signal: stepExpr }
      } else if (def.stack === 'normalize') {
        labelAxis.format = '.0%'
      }
    } else if (def.channel === 'x' && (sc.type === 'band' || sc.type === 'point')) {
      // an explicit labelAngle replaces the default nominal-x rotation
      const userLabelAngle = (userAxis as Record<string, unknown> | null | undefined)?.labelAngle
      if (userLabelAngle !== undefined) {
        labelAxis.labelAngle = userLabelAngle
        if (userLabelAngle === 0) labelAxis.labelBaseline = 'top'
      } else {
        // vega-lite 6 rotates nominal x labels
        labelAxis.labelAlign = 'right'
        labelAxis.labelAngle = 270
        labelAxis.labelBaseline = 'middle'
      }
    }
    // a timeUnit on a discrete positional axis still formats with timeFormat
    if (def.timeUnit && !isContinuousScaleType(sc.type)) {
      const units = JSON.stringify(timeUnitUnits(def.timeUnit))
      labelAxis.format = {
        signal: `timeUnitSpecifier(${JSON.stringify(timeUnitSpecifierUnits(def.timeUnit))}, {"year-month":"%b %Y ","year-month-date":"%b %d, %Y "})`,
      }
      labelAxis.formatType = 'time'
      void units
    }
    if (userAxis) {
      const discretePos = sc.type === 'band' || sc.type === 'point' || sc.type === 'ordinal' || sc.type === 'bin-ordinal'
      for (const [k, v] of Object.entries(userAxis)) {
        if (k === 'grid' || k === 'title' || k === 'orient' || k === 'scale') continue
        // An explicit axis format on a discrete positional axis is inert, but
        // config.axis/axisX/axisY formats are inherited by the compiled axis.
        if (k === 'format' && discretePos && isObject(def.axis) && (def.axis as Record<string, unknown>).format !== undefined) continue
        labelAxis[k] = v
      }
      if (userAxis.orient) labelAxis.orient = userAxis.orient
    }
    axes.push(labelAxis)
  }
  return axes
}

function axisTitle(def: FieldDef, userAxis?: Record<string, unknown> | null, fields?: FieldDef[]): unknown {
  if (userAxis && 'title' in userAxis) return userAxis.title
  // ranged channels (x2/y2 fields) join their titles with ', ' (vega-lite
  // joins the field defs' titles for the shared axis)
  if (fields) {
    const ch2 = def.channel === 'x' ? 'x2' : def.channel === 'y' ? 'y2' : null
    const def2 = ch2 ? fields.find((f) => f.channel === ch2 && f.field) : undefined
    if (def2) {
      const t1 = channelTitle(def)
      const t2 = channelTitle(def2)
      if (typeof t1 === 'string' && typeof t2 === 'string') return `${t1}, ${t2}`
    }
  }
  return channelTitle(def)
}

// --- legends -----------------------------------------------------------------

function buildLegends(fields: FieldDef[], mark: string, markOpacity?: number, markFilled?: boolean, markStroke?: string, markStrokeWidth?: number, markFillOpacity?: number): Record<string, unknown>[] {
  const legends: Record<string, unknown>[] = []
  // vega-lite's reduced symbol opacity (init.ts opacity()) does not apply
  // when the encoding is aggregate — the mark legend follows the mark.
  const reducedOpacity = fields.some((f) => f.aggregate) ? undefined : C.pointOpacity
  // a field's legend is suppressed when ANY channel bound to the same field
  // disables it (vega-lite merges per-field legends)
  const legendSuppressed = (def: FieldDef): boolean =>
    fields.some((f) => f.field === def.field && f.legend === null)
  // vega-lite emits legends in a fixed channel order (color, size, shape,
  // opacity) regardless of the encoding's key order — verified by probing
  // vl.compile with permuted encodings.
  const legendsByKey: Record<string, Record<string, unknown>> = {}
  const order: string[] = []
  const push = (key: string, lg: Record<string, unknown>): void => {
    legendsByKey[key] = lg
    order.push(key)
  }
  const colorDef = fields.find((f) => f.channel === 'color' && f.field)
  if (colorDef && colorDef.legend !== null && !legendSuppressed(colorDef)) {
    const userLegend = colorDef.legend ?? {}
    const lg: Record<string, unknown> = { title: legendTitle(colorDef, userLegend) }
    const filled = mark === 'circle' || mark === 'square'
      || (mark === 'point' && markFilled === true)
      || (mark === 'arc' && markFilled !== false)
    const colorTimeUnitSymbol = colorDef.timeUnit != null && colorDef.timeUnit !== 'year'
    const colorDiscreteScale = ['quantile', 'quantize', 'threshold'].includes(colorDef.scale?.type as string)
    const colorContinuous = (!isDiscreteType(colorDef.type)
      || (colorDef.aggregate != null && ['count', 'distinct', 'valid', 'missing'].includes(colorDef.aggregate)))
      && !colorTimeUnitSymbol && !colorDiscreteScale
    if (colorTimeUnitSymbol) lg.type = 'symbol'
    if (colorDef.scale?.type === 'quantile' || colorDef.scale?.type === 'threshold') lg.labelOverlap = 'greedy'
    const m = mark as string
    if (filled) {
      lg.fill = 'color'
      lg.symbolType = m === 'bar' || m === 'rect' ? 'square' : 'circle'
      if (m === 'arc') {
        // arc legends carry the mark's stroke/opacity/width but no reduced-opacity
        // default (unlike point/circle/square)
        const symUpdate: Record<string, unknown> = {}
        if (markStroke) symUpdate.stroke = { value: markStroke }
        if (markStrokeWidth != null) symUpdate.strokeWidth = { value: markStrokeWidth }
        if (markFillOpacity != null) symUpdate.fillOpacity = { value: markFillOpacity }
        if (markOpacity != null) symUpdate.opacity = { value: markOpacity }
        if (Object.keys(symUpdate).length) lg.encode = { symbols: { update: symUpdate } }
      } else if (m !== 'bar' && m !== 'rect') {
        const symUpdate: Record<string, unknown> = { opacity: { value: markOpacity ?? reducedOpacity ?? 1 } }
        // the mark's stroke/fill-opacity propagates onto the legend symbols
        if (markStroke) symUpdate.stroke = { value: markStroke }
        if (markFillOpacity != null) symUpdate.fillOpacity = { value: markFillOpacity }
        lg.encode = { symbols: { update: symUpdate } }
      }
    } else if (m === 'arc') {
      // an unfilled arc paints by stroke: the legend is a stroke legend
      lg.stroke = 'color'
      if (!colorContinuous) lg.symbolType = 'circle'
      else lg.gradientLength = { signal: 'clamp(height, 64, 200)' }
    } else if (m === 'point' || m === 'line' || m === 'text') {
      lg.stroke = 'color'
      if (!colorContinuous) {
        lg.symbolType = mark === 'line' ? 'stroke' : 'circle'
        lg.encode = { symbols: { update: { fill: { value: 'transparent' }, opacity: { value: reducedOpacity ?? 1 } } } }
      } else {
        lg.gradientLength = { signal: 'clamp(height, 64, 200)' }
        lg.encode = { gradient: { update: { opacity: { value: reducedOpacity ?? 1 } } } }
      }
    } else {
      lg.fill = 'color'
      if (mark === 'bar' || mark === 'rect') lg.symbolType = 'square'
      if (colorContinuous) {
        lg.gradientLength = { signal: 'clamp(height, 64, 200)' }
        if (markOpacity != null) lg.encode = { gradient: { update: { opacity: { value: markOpacity } } } }
      } else {
        // the mark's stroke/opacity propagate onto a symbol legend's entries
        // (probed: bar/rect/arc with markDef.stroke emit symbols.stroke)
        const symUpdate: Record<string, unknown> = {}
        if (markStroke) symUpdate.stroke = { value: markStroke }
        if (markOpacity != null) symUpdate.opacity = { value: markOpacity }
        if (Object.keys(symUpdate).length) lg.encode = { symbols: { update: symUpdate } }
      }
    }
    applyTimeUnitLegend(lg, colorDef, userLegend)
    for (const [k, v] of Object.entries(userLegend)) {
      if (k === 'title') continue
      lg[k] = v
    }
    // top/bottom gradients measure along the chart width
    if ((lg.orient === 'top' || lg.orient === 'bottom' || lg.direction === 'horizontal')
      && userLegend.gradientLength == null && !('gradientLength' in userLegend)) {
      lg.gradientLength = { signal: 'clamp(width, 100, 200)' }
    }
    // strip the VL-only keys and the other type's keys (upstream parity): a
    // gradient legend drops symbol*, a symbol legend drops gradient*
    const isGradient = 'gradientLength' in lg
    for (const k of Object.keys(lg)) {
      if (k === 'title' || k === 'encode' || k === 'fill' || k === 'stroke' || k === 'shape' || k === 'size' || k === 'opacity') continue
      if (isGradient ? (k.startsWith('symbol') || k === 'gradientStroke') : k.startsWith('gradient')) delete lg[k]
    }
    // top/bottom legends lay their entries out horizontally
    if (lg.orient === 'bottom' || lg.orient === 'top') lg.direction = lg.direction ?? 'horizontal'
    push('color', lg)
  }
  const sizeDef = fields.find((f) => f.channel === 'size' && f.field)
  if (sizeDef && sizeDef.legend !== null && !legendSuppressed(sizeDef)) {
    // vega-lite gives a standalone size legend the default symbol stroke
    // (#4c78a8) but drops it when a color legend coexists.
    const sizeSymbolOpacity = (sizeDef.legend as Record<string, unknown> | undefined)?.symbolOpacity
    const sizeSymUpdate: Record<string, unknown> = { fill: { value: 'transparent' } }
    if (sizeSymbolOpacity == null) sizeSymUpdate.opacity = { value: markOpacity ?? reducedOpacity ?? 1 }
    if (!colorDef || colorDef.legend === null || legendSuppressed(colorDef)) sizeSymUpdate.stroke = { value: C.blue }
    const sizeLg: Record<string, unknown> = {
      size: 'size',
      symbolType: 'circle',
      title: legendTitle(sizeDef, sizeDef.legend ?? {}),
      encode: { symbols: { update: sizeSymUpdate } },
    }
    applyTimeUnitLegend(sizeLg, sizeDef, sizeDef.legend ?? {})
    forwardLegendProps(sizeDef.legend ?? {}, sizeLg, false)
    push('size', sizeLg)
  }
  const shapeDefL = fields.find((f) => f.channel === 'shape' && f.field)
  if (shapeDefL && shapeDefL.legend !== null && !legendSuppressed(shapeDefL)) {
    const shapeLg: Record<string, unknown> = {
      shape: 'shape',
      symbolType: 'circle',
      title: legendTitle(shapeDefL, shapeDefL.legend ?? {}),
      encode: { symbols: { update: { fill: { value: 'transparent' }, stroke: { value: C.blue }, opacity: { value: markOpacity ?? reducedOpacity ?? 1 } } } },
    }
    applyTimeUnitLegend(shapeLg, shapeDefL, shapeDefL.legend ?? {})
    forwardLegendProps(shapeDefL.legend ?? {}, shapeLg, false)
    push('shape', shapeLg)
  }
  const opacityLegendDef = fields.find((f) => f.channel === 'opacity' && f.field)
  if (opacityLegendDef && opacityLegendDef.legend !== null && !legendSuppressed(opacityLegendDef)) {
    const opLg: Record<string, unknown> = {
      opacity: 'opacity',
      symbolType: 'circle',
      title: legendTitle(opacityLegendDef, opacityLegendDef.legend ?? {}),
      encode: { symbols: { update: { fill: { value: 'transparent' }, stroke: { value: C.blue } } } },
    }
    applyTimeUnitLegend(opLg, opacityLegendDef, opacityLegendDef.legend ?? {})
    forwardLegendProps(opacityLegendDef.legend ?? {}, opLg, false)
    push('opacity', opLg)
  }
  for (const key of order) legends.push(legendsByKey[key]!)
  return legends
}

function legendTitle(def: FieldDef, userLegend: Record<string, unknown>): unknown {
  if ('title' in userLegend) return userLegend.title
  return channelTitle(def)
}

/**
 * Forward the user's legend properties onto the compiled legend (vega-lite
 * copies the legend definition through verbatim minus the VL-only keys and
 * the keys that belong to the other legend type — probed: a symbol legend
 * drops gradient*, a gradient legend drops symbol*; both drop disable, type,
 * symbolWidth).
 */
function forwardLegendProps(userLegend: Record<string, unknown>, lg: Record<string, unknown>, isGradient: boolean): void {
  for (const [k, v] of Object.entries(userLegend)) {
    if (k === 'title' || k === 'encode' || k === 'disable' || k === 'type' || k === 'symbolWidth') continue
    if (isGradient ? (k.startsWith('symbol') || k === 'gradientStroke') : k.startsWith('gradient')) continue
    lg[k] = v
  }
}

// --- marks -------------------------------------------------------------------

interface BuiltMarks extends Array<Record<string, unknown>> {
  overlayData?: Record<string, unknown>
  overlayFilled?: boolean
}
function buildMarks(spec: VLSpec, fields: FieldDef[], mark: string, orient: string, dataName: string, markSize?: number): BuiltMarks {  // vega-lite's DEFAULT_REDUCED_OPACITY (0.7) applies to point/tick/circle/
  // square only when the encoding is NOT aggregate (init.ts opacity())
  const isAggregateEnc = fields.some((f) => f.aggregate)
  const hasFillOpacity = isObject(spec.mark) && (spec.mark as Record<string, unknown>).fillOpacity !== undefined
  let pointOpacityDefault = isAggregateEnc || hasFillOpacity ? undefined : C.pointOpacity

  const markColor = isObject(spec.mark) ? (spec.mark.color as string | undefined) : undefined
  const markFill = isObject(spec.mark) ? (spec.mark.fill as string | undefined) : undefined
  let markOpacity = isObject(spec.mark) ? (spec.mark.opacity as number | undefined) : undefined
  const xDef = fields.find((f) => f.channel === 'x')
  const yDef = fields.find((f) => f.channel === 'y')
  const colorDef = fields.find((f) => f.channel === 'color' && f.field)
  const sizeDef = fields.find((f) => f.channel === 'size' && f.field)
  const shapeDef = fields.find((f) => f.channel === 'shape' && f.field)
  const opacityDef = fields.find((f) => f.channel === 'opacity' && f.field)
  const update: Record<string, unknown> = {}
  const xOffsetPresent = fields.some((f) => f.channel === 'xOffset' && f.field)
  const yOffsetPresent = fields.some((f) => f.channel === 'yOffset' && f.field)
  // config resolution (getMarkPropOrConfig): the mark def first, then the
  // mark-type config block, then the generic config.mark block
  const userConfig = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  const cfgType = isObject(userConfig?.[mark]) ? (userConfig![mark] as Record<string, unknown>) : undefined
  const cfgMark = isObject(userConfig?.mark) ? (userConfig!.mark as Record<string, unknown>) : undefined
  const cfgColor = (cfgType?.color ?? cfgMark?.color) as string | undefined
  const cfgFill = (cfgType?.fill ?? cfgMark?.fill) as string | undefined
  const cfgStroke = (cfgType?.stroke ?? cfgMark?.stroke) as string | undefined
  // markDef.opacity ?? config[type].opacity ?? config.mark.opacity
  markOpacity = markOpacity ?? (cfgType?.opacity as number | undefined) ?? (cfgMark?.opacity as number | undefined)
  // any fillOpacity (definition or config) suppresses the reduced-opacity default
  const cfgFillOpacity = cfgType?.fillOpacity ?? cfgMark?.fillOpacity
  pointOpacityDefault = isAggregateEnc || (hasFillOpacity || cfgFillOpacity !== undefined) ? undefined : C.pointOpacity

  if (mark === 'bar' || mark === 'rect') {
    // getMarkPropOrConfig precedence (probed): markDef.fill overrides the
    // color channel; the channel beats config fill; config beats markDef.color;
    // filled:false moves the colour onto stroke (bar fills transparent, rect
    // drops fill entirely) and markDef.fill is ignored.
    const markDef = isObject(spec.mark) ? spec.mark : undefined
    const filledSetting = markDef?.filled ?? cfgType?.filled ?? cfgMark?.filled
    const filled = filledSetting !== false
    const cfgPaint = (p: string): unknown => markDef?.[p] ?? cfgType?.[p] ?? cfgMark?.[p]
    if (!filled) {
      if (mark === 'bar') update.fill = { value: 'transparent' }
      update.stroke = colorDef
        ? { scale: 'color', field: aggFieldName(colorDef) }
        : { value: (markDef?.stroke as string | undefined) ?? (cfgType?.stroke as string | undefined) ?? (cfgMark?.stroke as string | undefined) ?? markColor ?? C.blue }
    } else {
      update.fill = markDef?.fill != null
        ? { value: markDef.fill }
        : colorDef
          ? { scale: 'color', field: aggFieldName(colorDef) }
          : { value: (cfgType?.fill as string | undefined) ?? (cfgMark?.fill as string | undefined) ?? (cfgType?.color as string | undefined) ?? (cfgMark?.color as string | undefined) ?? markColor ?? C.blue }
      const stroke = markDef?.stroke ?? cfgType?.stroke ?? cfgMark?.stroke
      if (stroke != null) update.stroke = { value: stroke }
    }
    if (markOpacity != null) update.opacity = { value: markOpacity }
    // pass-through mark-def paint props (getMarkPropOrConfig reads each
    // straight off the definition; vega renders the ones it knows)
    for (const p of ['strokeWidth', 'strokeDash', 'strokeCap', 'strokeJoin', 'fillOpacity', 'cornerRadius', 'angle', 'cursor', 'blend'] as const) {
      if (markDef?.[p] !== undefined) update[p] = { value: markDef[p] }
    }
    // bar rounds its ends with a clip (rect's cornerRadius needs no clip);
    // cornerRadiusEnd rounds the leading edge per orientation
    const cornerRadius = markDef?.cornerRadius ?? cfgType?.cornerRadius ?? cfgMark?.cornerRadius
    const cornerRadiusEnd = markDef?.cornerRadiusEnd ?? cfgType?.cornerRadiusEnd ?? cfgMark?.cornerRadiusEnd
    if (mark === 'bar' && ((cornerRadius != null && cornerRadius !== 0) || (cornerRadiusEnd != null && cornerRadiusEnd !== 0))) {
      update.clip = { value: true }
    }
    if (cornerRadius != null && update.cornerRadius === undefined) update.cornerRadius = { value: cornerRadius }
    if (cornerRadiusEnd != null && mark === 'bar') {
      const [a, b] = orient === 'horizontal' ? ['TopRight', 'BottomRight'] : ['TopLeft', 'TopRight']
      update[`cornerRadius${a}`] = { value: cornerRadiusEnd }
      update[`cornerRadius${b}`] = { value: cornerRadiusEnd }
    }
    if (mark === 'bar') update.ariaRoleDescription = { value: 'bar' }
    const stacked = yDef && isStacked(yDef, mark, orient, fields)
    if (orient === 'vertical') {
      if (xDef) {
        const sc = positionalScaleType(mark, xDef)
        if (xDef.timeUnit == null && !xDef.bin && xDef.type === 'temporal') {
          // a plain temporal dimension centers the bar with the continuous
          // band size (vega-lite's continuousBandSize)
          update.xc = { scale: 'x', field: aggFieldName(xDef) }
          update.width = { value: (cfgType?.continuousBandSize as number | undefined) ?? C.continuousBandSize }
        } else if (xDef.timeUnit && sc !== 'band') {
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
          // BarConfig band alignment/size (probed): align 'right' anchors
          // the bar with x2 at the band position; a size/discreteBandSize
          // centers a fixed-width bar in the band; otherwise the bar spans
          // the band
          const barAlign = (markDef?.align ?? cfgType?.align ?? cfgMark?.align) as string | undefined
          const barSizeRaw = ((markDef?.size
            ?? markDef?.width
            ?? (mark === 'bar' ? (cfgType?.size as number | undefined) : undefined)
            ?? (cfgType?.discreteBandSize as number | undefined)
            ?? (cfgType?.width as number | undefined)
            ?? (cfgMark?.width as number | undefined)) as number | undefined)
          // a zero band size falls back to vega-lite's default discrete step
          // (getViewConfigDiscreteStep 20 − 2) rather than a zero-width bar
          const barSize = barSizeRaw === 0 ? C.defaultStep : barSizeRaw
          if (barAlign === 'right' && !xOffsetPresent) {
            update.x2 = { scale: 'x', field: aggFieldName(xDef) }
            update.width = { signal: `max(0.25, bandwidth('x'))` }
          } else if (barAlign === 'center' && !xOffsetPresent) {
            update.xc = { scale: 'x', field: aggFieldName(xDef), band: 0.5 }
            update.width = { signal: `max(0.25, bandwidth('x'))` }
          } else if (barSize != null && !xOffsetPresent) {
            update.xc = { scale: 'x', field: aggFieldName(xDef), band: 0.5 }
            update.width = { value: barSize }
          } else {
            update.x = { scale: 'x', field: aggFieldName(xDef) }
            if (xOffsetPresent) {
              update.x = { scale: 'x', field: aggFieldName(xDef), offset: { scale: 'xOffset', field: aggFieldName(fields.find((f) => f.channel === 'xOffset')!) } }
            }
            update.width = { signal: `max(0.25, bandwidth('${xOffsetPresent ? 'xOffset' : 'x'}'))` }
          }
        } else {
          update.xc = { scale: 'x', field: aggFieldName(xDef) }
          update.width = { value: C.bandSize }
        }
      }
      const y2DefB = fields.find((f) => f.channel === 'y2' && f.field)
      if (yDef) {
        if (y2DefB) {
          update.y = { scale: 'y', field: aggFieldName(yDef) }
          update.y2 = { scale: 'y', field: y2DefB.field }
        } else if (stacked) {
          update.y = { scale: 'y', field: `${yDef.field}_end` }
          update.y2 = { scale: 'y', field: `${yDef.field}_start` }
        } else if (positionalScaleType(mark, yDef) === 'band') {
          // nominal/ordinal y (heatmap-style rect marks): band cell height.
          // baseline aligns the cell within the band (top/undefined left,
          // bottom pins y2, middle centers via yc band 0.5).
          const yAlign = (markDef?.baseline ?? cfgType?.baseline ?? cfgMark?.baseline) as string | undefined
          const ySizeRaw = ((markDef?.height
            ?? (cfgType?.height as number | undefined)
            ?? (cfgType?.discreteBandSize as number | undefined)
            ?? (cfgMark?.height as number | undefined)) as number | undefined)
          const ySize = ySizeRaw === 0 ? C.defaultStep : ySizeRaw
          if (ySize != null) {
            update.yc = { scale: 'y', field: aggFieldName(yDef), band: 0.5 }
            update.height = { value: ySize }
          } else {
            if (yAlign === 'bottom') update.y2 = { scale: 'y', field: aggFieldName(yDef) }
            else if (yAlign === 'middle') update.yc = { scale: 'y', field: aggFieldName(yDef), band: 0.5 }
            else update.y = { scale: 'y', field: aggFieldName(yDef) }
            update.height = { signal: `max(0.25, bandwidth('y'))` }
          }
        } else {
          update.y = { scale: 'y', field: aggFieldName(yDef) }
          if (mark === 'bar') update.y2 = { scale: 'y', value: 0 }
        }
      }
    } else {
      if (yDef) {
        const sc = positionalScaleType(mark, yDef)
        if (yDef.timeUnit == null && !yDef.bin && yDef.type === 'temporal') {
          update.yc = { scale: 'y', field: aggFieldName(yDef) }
          update.height = { value: (cfgType?.continuousBandSize as number | undefined) ?? C.continuousBandSize }
        } else if (yDef.timeUnit && sc !== 'band') {
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
          const yAlignH = (markDef?.baseline ?? cfgType?.baseline ?? cfgMark?.baseline) as string | undefined
          const hSizeRaw = ((markDef?.size
            ?? markDef?.height
            ?? (cfgType?.size as number | undefined)
            ?? (cfgType?.discreteBandSize as number | undefined)
            ?? (cfgType?.height as number | undefined)
            ?? (cfgMark?.height as number | undefined)) as number | undefined)
          const hSize = hSizeRaw === 0 ? C.defaultStep : hSizeRaw
          if (hSize != null && !yOffsetPresent) {
            update.yc = { scale: 'y', field: aggFieldName(yDef), band: 0.5 }
            update.height = { value: hSize }
          } else {
            if (yAlignH === 'bottom') update.y2 = { scale: 'y', field: aggFieldName(yDef) }
            else if (yAlignH === 'middle') update.yc = { scale: 'y', field: aggFieldName(yDef), band: 0.5 }
            else update.y = { scale: 'y', field: aggFieldName(yDef) }
            if (yOffsetPresent) {
              const ych = yAlignH === 'bottom' ? 'y2' : yAlignH === 'middle' ? 'yc' : 'y'
              update[ych] = { scale: 'y', field: aggFieldName(yDef), offset: { scale: 'yOffset', field: aggFieldName(fields.find((f) => f.channel === 'yOffset')!) } }
            }
            update.height = { signal: `max(0.25, bandwidth('${yOffsetPresent ? 'yOffset' : 'y'}'))` }
          }
        } else {
          update.yc = { scale: 'y', field: aggFieldName(yDef) }
          update.height = { value: C.bandSize }
        }
      }
      if (xDef) {
        const x2Field = fields.find((f) => f.channel === 'x2' && f.field)
        const stackedX = !x2Field && isStacked(xDef, mark, orient, fields)
        if (x2Field) {
          // an explicit x2 field: the bar spans x → x2 (ranged bar)
          update.x = { scale: 'x', field: aggFieldName(xDef) }
          update.x2 = { scale: 'x', field: aggFieldName(x2Field) }
        } else if (stackedX) {
          update.x = { scale: 'x', field: `${xDef.field}_end` }
          update.x2 = { scale: 'x', field: `${xDef.field}_start` }
        } else if (!stackedX && positionalScaleType(mark, xDef) === 'band' && !xOffsetPresent) {
          update.x = { scale: 'x', field: aggFieldName(xDef) }
          update.width = { signal: `max(0.25, bandwidth('x'))` }
        } else {
          update.x = { scale: 'x', field: aggFieldName(xDef) }
          if (mark === 'bar') update.x2 = { scale: 'x', value: 0 }
        }
      }
    }
  } else if (mark === 'point' || mark === 'circle' || mark === 'square') {
    const filledSetting = isObject(spec.mark) && spec.mark.filled !== undefined
      ? spec.mark.filled
      : (cfgType?.filled ?? cfgMark?.filled)
    const filled = mark === 'point' ? filledSetting === true : filledSetting !== false
    const markStroke = isObject(spec.mark) ? (spec.mark.stroke as string | undefined) : undefined
    const markStrokeWidth = isObject(spec.mark) ? (spec.mark.strokeWidth as number | undefined) : undefined
    if (filled) {
      update.fill = colorDef
        ? { scale: 'color', field: aggFieldName(colorDef) }
        : { value: markColor ?? markFill ?? cfgFill ?? cfgColor ?? C.blue }
      const st = markStroke ?? cfgStroke
      if (st != null) update.stroke = { value: st }
      if (markStrokeWidth) update.strokeWidth = { value: markStrokeWidth }
      if (markOpacity != null || pointOpacityDefault != null) update.opacity = { value: markOpacity ?? pointOpacityDefault }
      update.shape = { value: mark }
      if (markSize != null) update.size = { value: markSize }
    } else {
      update.opacity = opacityDef
        ? { scale: 'opacity', field: aggFieldName(opacityDef) }
        : (markOpacity != null || pointOpacityDefault != null ? { value: markOpacity ?? pointOpacityDefault } : undefined)
      if (update.opacity === undefined) delete update.opacity
      // an unfilled point keeps its stroke-mode defaults; a config fill
      // (point.fill / mark.fill) still fills it (probed). filled:false on a
      // circle/square also moves the paint onto the stroke.
      const ptFill = (isObject(spec.mark) ? (spec.mark.fill as string | undefined) : undefined) ?? cfgFill
      update.fill = ptFill != null ? { value: ptFill } : { value: 'transparent' }
      const ptStroke = (isObject(spec.mark) ? (spec.mark.stroke as string | undefined) : undefined) ?? markColor ?? cfgStroke ?? cfgColor ?? C.blue
      update.stroke = colorDef
        ? { scale: 'color', field: aggFieldName(colorDef) }
        : { value: ptStroke }
    }
    update.ariaRoleDescription = { value: mark }
    update.shape = { value: mark }
    if (markSize != null) update.size = { value: markSize }
    if (xDef) update.x = { scale: 'x', field: aggFieldName(xDef) }
    if (yDef) update.y = { scale: 'y', field: aggFieldName(yDef) }
    if (sizeDef) update.size = { scale: 'size', field: aggFieldName(sizeDef) }
    if (shapeDef && !filled) update.shape = { scale: 'shape', field: aggFieldName(shapeDef) }
    void 0
  } else if (mark === 'line') {
    const markStroke = isObject(spec.mark) ? (spec.mark.stroke as string | undefined) : undefined
    const markStrokeWidth = isObject(spec.mark) ? (spec.mark.strokeWidth as number | undefined) : undefined
    update.stroke = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: markStroke ?? cfgStroke ?? cfgColor ?? markColor ?? C.blue }
    if (markStrokeWidth != null) update.strokeWidth = { value: markStrokeWidth }
    const lineSizeCfg = (cfgType?.size as number | undefined) ?? (cfgMark?.size as number | undefined)
    if (markSize != null) update.strokeWidth = { value: markSize }
    else if (lineSizeCfg != null) update.strokeWidth = { value: lineSizeCfg }
    // the size channel maps to line width
    if (sizeDef) update.strokeWidth = { scale: 'size', field: aggFieldName(sizeDef) }
    const markInterpolate = isObject(spec.mark) ? (spec.mark.interpolate as string | undefined) : undefined
    if (markInterpolate) update.interpolate = { value: markInterpolate }
    // a line's markDef.fill fills the line's area (vega paints line marks);
    // the stroke default stays. markDef.filled:true paints the area instead
    // of the stroke, like a filled rule.
    const lineFill = isObject(spec.mark) ? (spec.mark.fill as string | undefined) : undefined
    if (isObject(spec.mark) && spec.mark.filled === true) {
      update.fill = colorDef
        ? { scale: 'color', field: aggFieldName(colorDef) }
        : { value: lineFill ?? markColor ?? cfgFill ?? cfgColor ?? C.blue }
      delete update.stroke
    } else if (lineFill != null) update.fill = { value: lineFill }
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
    const areaFill = isObject(spec.mark) ? (spec.mark.fill as string | undefined) : undefined
    const areaColor = colorDef
      ? { scale: 'color', field: aggFieldName(colorDef) }
      : { value: areaFill ?? markColor ?? cfgFill ?? cfgColor ?? C.blue }
    if (isObject(spec.mark) && spec.mark.filled === false) {
      update.stroke = areaColor
      update.fill = { value: 'transparent' }
    } else {
      update.fill = areaColor
    }
    if (xDef) update.x = { scale: 'x', field: aggFieldName(xDef) }
    if (yDef) {
      const stacked = isStacked(yDef, mark, orient, fields)
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
      const stackedX = isStacked(xDef, mark, orient, fields)
      if (stackedX) {
        update.x = { scale: 'x', field: `${xDef.field}_end` }
        update.x2 = { scale: 'x', field: `${xDef.field}_start` }
      } else if (yDef == null || !isStacked(yDef, mark, orient, fields)) {
        // vertical baselines anchor through the scale as well
        update.x2 = { scale: 'x', value: 0 }
      }
    }
    update.defined = definedSignal(xDef, yDef)
  } else if (mark === 'tick') {
    if (markOpacity != null || pointOpacityDefault != null) update.opacity = { value: markOpacity ?? pointOpacityDefault }
    update.fill = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: markColor ?? markFill ?? cfgFill ?? cfgColor ?? C.blue }
    const tickDef = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : undefined
    const tickStroke = tickDef?.stroke as string | undefined
    if (tickStroke != null || cfgStroke != null) update.stroke = { value: tickStroke ?? cfgStroke }
    const tickFilled = tickDef?.filled !== undefined ? tickDef.filled : (cfgType?.filled ?? cfgMark?.filled)
    if (tickFilled === false) {
      const tf = update.fill
      delete update.fill
      update.stroke = tf
    }
    update.ariaRoleDescription = { value: 'tick' }
    // Tick orientation is the opposite of bar/line/area's measure inference
    // (vega-lite mark/init.ts): a quantitative x over a discrete y is a
    // VERTICAL tick (its size axis is y and its thickness axis is x).
    const xIsMeasure = xDef != null && xDef.type === 'quantitative' && !xDef.bin
    const yIsMeasure = yDef != null && yDef.type === 'quantitative' && !yDef.bin
    const tickOrient = ((tickDef?.orient as string | undefined) ?? (cfgType?.orient as string | undefined) ?? (cfgMark?.orient as string | undefined))
      ?? (xIsMeasure && !yIsMeasure ? 'vertical'
        : !xIsMeasure && yIsMeasure ? 'horizontal'
        : xIsMeasure && yIsMeasure ? 'vertical'
        : xDef?.type === 'temporal' && yDef?.type !== 'temporal' ? 'vertical'
        : yDef?.type === 'temporal' && xDef?.type !== 'temporal' ? 'horizontal'
        : 'vertical')
    const sizeAxis = tickOrient === 'horizontal' ? 'x' : 'y'
    const sizeField = sizeAxis === 'x' ? xDef : yDef
    const sizeVg = sizeAxis === 'x' ? 'width' : 'height'
    const thickAxis = sizeAxis === 'x' ? 'y' : 'x'
    const thickField = thickAxis === 'x' ? xDef : yDef
    const thickVg = thickAxis === 'x' ? 'width' : 'height'
    const thickVal = (tickDef?.thickness ?? (cfgType?.thickness as number | undefined) ?? 1) as number
    const sizeRaw = (tickDef?.size
      ?? (cfgType?.size as number | undefined)
      ?? (cfgType?.discreteBandSize as number | undefined)
      ?? (cfgType?.height as number | undefined)) as number | undefined
    // thickness axis: centered on the point/band (pointPosition default mid);
    // a band thickness axis honors baseline (bottom pins y2, middle centers)
    if (thickField) {
      const isBand = positionalScaleType(mark, thickField) === 'band'
      const base = (tickDef?.baseline ?? cfgType?.baseline) as string | undefined
      if (isBand && thickAxis === 'y' && base === 'bottom') {
        update.y2 = { scale: 'y', field: aggFieldName(thickField) }
      } else {
        const key = `${thickAxis}c`
        update[key] = { scale: thickAxis, field: aggFieldName(thickField), ...(isBand ? { band: 0.5 } : {}) }
      }
    }
    if (sizeField) {
      const isBand = positionalScaleType(mark, sizeField) === 'band'
      if (sizeRaw !== undefined) {
        // a zero size opts into vega-lite's default discrete step
        const sizeVal = sizeRaw === 0 ? C.defaultStep : sizeRaw
        update[`${sizeAxis}c`] = { scale: sizeAxis, field: aggFieldName(sizeField), ...(isBand ? { band: 0.5 } : {}) }
        update[sizeVg] = { value: sizeVal }
      } else if (isBand) {
        update[sizeAxis] = { scale: sizeAxis, field: aggFieldName(sizeField) }
        update[sizeVg] = { signal: `max(0.25, bandwidth('${sizeAxis}'))` }
      } else {
        update[`${sizeAxis}c`] = { scale: sizeAxis, field: aggFieldName(sizeField) }
        update[sizeVg] = { value: (cfgType?.continuousBandSize as number | undefined) ?? C.continuousBandSize }
      }
    }
    update[thickVg] = { value: thickVal }
  } else if (mark === 'rule') {
    const ruleDef = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : {}
    update.stroke = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: (ruleDef.stroke as string | undefined) ?? markColor ?? cfgStroke ?? cfgColor ?? 'black' }
    const ruleFill = ruleDef.fill as string | undefined
    if (ruleFill != null) update.fill = { value: ruleFill }
    // vega-lite rule orientation (compile/mark/init.ts, falling through the
    // BAR/TEXT and LINE/TICK cases): ranged rules by their y2/x2 presence,
    // single-channel rules by the present channel, then by measure-ness —
    // rules default vertical whenever the y is a measure or x is not.
    const xIsMeasure = xDef != null && xDef.type === 'quantitative'
    const yIsMeasure = yDef != null && yDef.type === 'quantitative'
    const x2Def = fields.find((f) => f.channel === 'x2' && f.field)
    const y2Def = fields.find((f) => f.channel === 'y2' && f.field)
    const hasX2Enc = x2Def != null || fields.some((f) => f.channel === 'x2')
    const hasY2Enc = y2Def != null || fields.some((f) => f.channel === 'y2')
    const specOrient = isObject(spec.mark) ? (spec.mark.orient as string | undefined) : undefined
    const ruleOrient = specOrient
      ?? (hasX2Enc && hasY2Enc ? undefined
        : hasY2Enc ? 'vertical'
        : hasX2Enc ? 'horizontal'
        : (xDef != null && yDef == null) ? 'vertical'
        : (yDef != null && xDef == null) ? 'horizontal'
        : (xIsMeasure && !yIsMeasure) ? 'horizontal'
        : (!xIsMeasure && yIsMeasure) ? 'vertical'
        : (xIsMeasure && yIsMeasure) ? 'vertical'
        : (xDef?.type === 'temporal' && yDef?.type !== 'temporal') ? 'vertical'
        : (yDef?.type === 'temporal' && xDef?.type !== 'temporal') ? 'horizontal'
        : undefined)
    // pointPosition mid: band scales anchor at band 0.5 (both axes — the
    // band term keys on the scale type, not the orientation)
    const ruleXOff = ruleDef.xOffset as number | undefined
    const ruleYOff = ruleDef.yOffset as number | undefined
    if (xDef) update.x = { scale: 'x', field: aggFieldName(xDef), ...(positionalScaleType(mark, xDef) === 'band' ? { band: 0.5 } : {}), ...(ruleXOff !== undefined ? { offset: ruleXOff } : {}) }
    if (yDef) update.y = { scale: 'y', field: aggFieldName(yDef), ...(positionalScaleType(mark, yDef) === 'band' ? { band: 0.5 } : {}), ...(ruleYOff !== undefined ? { offset: ruleYOff } : {}) }
    if (x2Def) update.x2 = { scale: 'x', field: x2Def.field }
    if (y2Def) update.y2 = { scale: 'y', field: y2Def.field }
    // pointPosition2OrSize zeroOrMin (scaledZeroOrMinOrMax): with no explicit
    // x2/y2 (and no width/height encode), the rule spans to scale zero —
    // {value: 0} when the domain definitely contains zero, otherwise the
    // inrange(0, domain) probe signal (nominal/band scales, zero:false)
    const zeroOrMin = (ch: 'x' | 'y', quantZero: boolean): unknown =>
      quantZero ? { scale: ch, value: 0 } : { signal: `scale('${ch}', inrange(0, domain('${ch}')) ? 0 : domain('${ch}')[0])` }
    const xBand = xDef != null && positionalScaleType(mark, xDef) === 'band'
    const yBand = yDef != null && positionalScaleType(mark, yDef) === 'band'
    const xQuantZero = !xBand && xDef?.scale?.zero !== false
    const yQuantZero = !yBand && yDef?.scale?.zero !== false
    if (!x2Def && ruleOrient !== 'vertical' && xDef) update.x2 = zeroOrMin('x', xQuantZero)
    if (!y2Def && ruleOrient !== 'horizontal' && yDef) update.y2 = zeroOrMin('y', yQuantZero)
    // rule paint plumbing: size maps to strokeWidth (rule.ts nonPosition);
    // filled rules paint with fill and drop the stroke; the rest pass through
    const ruleSize = markSize
    if (ruleSize != null) update.strokeWidth = { value: ruleSize }
    if (ruleDef.strokeWidth !== undefined && update.strokeWidth === undefined) update.strokeWidth = { value: ruleDef.strokeWidth }
    if (ruleDef.strokeDash !== undefined) update.strokeDash = { value: ruleDef.strokeDash }
    if (ruleDef.fillOpacity !== undefined) update.fillOpacity = { value: ruleDef.fillOpacity }
    if (markOpacity != null) update.opacity = { value: markOpacity }
    if (ruleDef.filled === true) {
      update.fill = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: markColor ?? ruleFill ?? cfgFill ?? cfgColor ?? 'black' }
      delete update.stroke
    }
  } else if (mark === 'text') {
    update.fill = colorDef ? { scale: 'color', field: aggFieldName(colorDef) } : { value: markColor ?? markFill ?? cfgFill ?? cfgColor ?? 'black' }
    const textStroke = isObject(spec.mark) ? (spec.mark.stroke as string | undefined) : undefined
    const tStroke = textStroke ?? cfgStroke
    if (tStroke != null) update.stroke = { value: tStroke }
    const thetaDefT = fields.find((f) => f.channel === 'theta' && f.field)
    if (thetaDefT) {
      // polar text (pie labels): anchored at the view center, offset by
      // radius along theta
      update.x = { signal: 'width', mult: 0.5 }
      update.y = { signal: 'height', mult: 0.5 }
      update.theta = { scale: 'theta', field: thetaDefT.field }
      const mRadius = isObject(spec.mark) ? (spec.mark.radius as number | undefined) : undefined
      if (mRadius != null) update.radius = { value: mRadius }
    } else {
      if (xDef) update.x = { scale: 'x', field: aggFieldName(xDef) }
      if (yDef) update.y = { scale: 'y', field: aggFieldName(yDef) }
    }
    const textDef = fields.find((f) => f.channel === 'text')
    if (textDef?.field) {
      const fieldName = textDef.timeUnit ? timeUnitField(textDef) : (textDef.aggregate ? aggFieldName(textDef) : textDef.field)
      const f = JSON.stringify(fieldName)
      const rawFmt = (textDef.raw as { format?: unknown }).format
      if (textDef.timeUnit) {
        update.text = { signal: `timeFormat(datum[${f}], ${timeUnitFormatSignal(textDef.timeUnit)})` }
      } else if (textDef.aggregate || rawFmt !== undefined) {
        update.text = { signal: `format(datum[${f}], ${JSON.stringify(rawFmt ?? '')})` }
      } else {
        update.text = { signal: `isValid(datum[${f}]) ? datum[${f}] : ""+datum[${f}]` }
      }
    } else if (textDef && (textDef.raw as { value?: unknown }).value !== undefined) {
      update.text = { value: String((textDef.raw as { value?: unknown }).value) }
    }
    update.align = { value: 'center' }
    update.baseline = { value: 'middle' }
    const mFontSize = isObject(spec.mark) ? (spec.mark.fontSize as number | undefined) : undefined
    if (mFontSize != null) update.fontSize = { value: mFontSize }
    const mFontWeight = isObject(spec.mark) ? (spec.mark.fontWeight as unknown) : undefined
    if (mFontWeight != null) update.fontWeight = { value: mFontWeight }
    // pass-through text mark props (probed: size maps to fontSize, radius to
    // the polar radius; the paint/offset props go straight through)
    const markPaint = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : undefined
    const textCfgSize = (cfgType?.size as number | undefined) ?? (cfgMark?.size as number | undefined)
    if (markPaint?.size != null) update.fontSize = { value: markPaint.size }
    else if (textCfgSize != null) update.fontSize = { value: textCfgSize }
    for (const p of ['strokeWidth', 'dx', 'dy', 'fillOpacity', 'opacity', 'angle', 'baseline', 'align', 'limit', 'fontStyle', 'lineHeight'] as const) {
      if (markPaint?.[p] !== undefined) update[p] = { value: markPaint[p] }
    }
    if (markPaint?.filled === false) {
      const tf = update.fill
      update.fill = { value: 'transparent' }
      update.stroke = tf
    } else if (markPaint?.filled === true) {
      const ts = update.stroke
      if (ts != null) { delete update.stroke; update.fill = ts }
    }
    if (markPaint?.outerRadius != null) update.radius = { value: markPaint.outerRadius }
  } else if (mark === 'arc') {
    const thetaDefA = fields.find((f) => f.channel === 'theta' && f.field)
    const thetaF = thetaDefA!.field
    update.fill = markFill != null
      ? { value: markFill }
      : colorDef
        ? { scale: 'color', field: aggFieldName(colorDef) }
        : { value: markColor ?? cfgFill ?? cfgColor ?? C.blue }
    const arcStroke = isObject(spec.mark) ? (spec.mark.stroke as string | undefined) : undefined
    const aStroke = arcStroke ?? cfgStroke
    if (aStroke != null) update.stroke = { value: aStroke }
    const arcFilled = isObject(spec.mark) && spec.mark.filled !== undefined
      ? spec.mark.filled
      : (cfgType?.filled ?? cfgMark?.filled)
    if (arcFilled === false) {
      const ac = update.fill
      delete update.fill
      update.stroke = ac
    }
    if (markOpacity != null) update.opacity = { value: markOpacity }
    const cfgArcX = (cfgType?.x as number | undefined) ?? (cfgMark?.x as number | undefined)
    const cfgArcY = (cfgType?.y as number | undefined) ?? (cfgMark?.y as number | undefined)
    update.x = cfgArcX != null ? { value: cfgArcX } : { signal: 'width', mult: 0.5 }
    update.y = cfgArcY != null ? { value: cfgArcY } : { signal: 'height', mult: 0.5 }
    const arcMark = spec.mark
    const mOuter = isObject(arcMark) ? ((arcMark.outerRadius as number | undefined) ?? (arcMark.radius as number | undefined)) : undefined
    const mInner = (isObject(arcMark) ? (arcMark.innerRadius as number | undefined) : undefined)
      ?? (cfgType?.innerRadius as number | undefined)
      ?? (cfgType?.radius2 as number | undefined)
      ?? (cfgMark?.innerRadius as number | undefined)
    // outerRadius resolves markDef.outerRadius ?? markDef.radius ??
    // config.arc.outerRadius ?? config.arc.radius ?? the half-extent signal
    update.outerRadius = mOuter != null
      ? { value: mOuter }
      : ((cfgType?.outerRadius as number | undefined) ?? (cfgType?.radius as number | undefined)) != null
        ? { value: (cfgType?.outerRadius as number | undefined) ?? (cfgType?.radius as number | undefined) }
        : { signal: 'min(width,height)/2' }
    update.innerRadius = { value: mInner ?? (cfgType?.innerRadius as number | undefined) ?? 0 }
    // stacked arcs close at the series' stacked END angle (startAngle runs
    // from value_end to value_start); unstacked arcs span field → scale zero.
    // A channel bandPosition p aligns the start angle within the stacked
    // band: p=0 pins it to the band start, otherwise a lerp signal; the end
    // angle pins to the band start either way (probed).
    const arcThetaE = thetaStackInfo(mark, fields)
    const thetaBP = thetaDefA?.bandPosition as number | undefined
    if (arcThetaE?.stacked && thetaBP !== undefined) {
      update.startAngle = thetaBP === 0
        ? { scale: 'theta', field: `${arcThetaE.field}_start` }
        : { signal: `scale("theta", ${thetaBP} * datum["${arcThetaE.field}_start"] + ${1 - thetaBP} * datum["${arcThetaE.field}_end"])` }
      update.endAngle = { scale: 'theta', field: `${arcThetaE.field}_start` }
    } else if (arcThetaE?.stacked) {
      update.startAngle = { scale: 'theta', field: `${arcThetaE.field}_end` }
      update.endAngle = { scale: 'theta', field: `${arcThetaE.field}_start` }
    } else if (arcThetaE?.offsettedRect) {
      update.startAngle = { scale: 'theta', field: `${arcThetaE.field}_offsetted_rect_end` }
      update.endAngle = { scale: 'theta', field: `${arcThetaE.field}_offsetted_rect_start` }
    } else if (arcThetaE) {
      update.startAngle = { scale: 'theta', field: arcThetaE.field }
      update.endAngle = { scale: 'theta', value: 0 }
    }
    // a radius channel drives the radii through its scale (replacing the
    // mark/config/extent defaults)
    const radiusDefE = fields.find((f) => f.channel === 'radius' && f.field)
    if (radiusDefE) {
      if (radiusDefE.stack != null && radiusDefE.stack !== false) {
        update.innerRadius = { scale: 'radius', field: `${aggFieldName(radiusDefE)}_start` }
        update.outerRadius = { scale: 'radius', field: `${aggFieldName(radiusDefE)}_end` }
      } else {
        update.outerRadius = { scale: 'radius', field: aggFieldName(radiusDefE) }
        update.innerRadius = { scale: 'radius', value: 0 }
      }
    }
  } else if (mark === 'trail') {
    // trail: a stroked-by-size line — fill default, size channel/def, sorted
    // along the dimension (probed)
    update.fill = colorDef
      ? { scale: 'color', field: aggFieldName(colorDef) }
      : { value: markColor ?? markFill ?? cfgFill ?? cfgColor ?? C.blue }
    if (markOpacity != null) update.opacity = { value: markOpacity }
    for (const p of ['strokeWidth', 'strokeDash', 'strokeCap', 'fillOpacity', 'blend'] as const) {
      if (isObject(spec.mark) && (spec.mark as Record<string, unknown>)[p] !== undefined) update[p] = { value: (spec.mark as Record<string, unknown>)[p] }
    }
    const trailStroke = isObject(spec.mark) ? (spec.mark.stroke as string | undefined) : undefined
    if (trailStroke != null) update.stroke = { value: trailStroke }
    if (isObject(spec.mark) && spec.mark.filled === false) {
      update.stroke = { value: trailStroke ?? markColor ?? cfgStroke ?? cfgColor ?? C.blue }
      update.fill = { value: 'transparent' }
    }
    if (markSize != null) update.size = { value: markSize }
    if (sizeDef) update.size = { scale: 'size', field: aggFieldName(sizeDef) }
    if (xDef) update.x = { scale: 'x', field: aggFieldName(xDef) }
    if (yDef) update.y = { scale: 'y', field: aggFieldName(yDef) }
    update.defined = definedSignal(xDef, yDef)
  } else {
    throw new Error(`[aster/vl] mark type not supported yet: ${mark}`)
  }

  // interval selections: the static brush marks (empty initial extent).
  // The interactive signal apparatus is interactive-only; the static render
  // shows the zero-size brush background clipped to the plot.
  const intervalParams = Array.isArray(spec.params)
    ? (spec.params as Record<string, unknown>[]).filter((p) => isObject(p.select) && (p.select as Record<string, unknown>).type === 'interval')
    : []
  void intervalParams

  // conditional encodings and value-only channels (both skipped by
  // parseChannel — e.g. color: {condition: {...}, value: 'steelblue'} or
  // fill: {value: 'steelblue'}) materialise onto the built update here, ahead
  // of the pathgroup/overlay expansions so copies pick them up
  const markFilled = isObject(spec.mark) && spec.mark.filled === true
  const styleChannels = new Set(['color', 'fill', 'fillOpacity', 'stroke', 'strokeWidth', 'opacity', 'strokeDash', 'size', 'shape'])
  for (const [channel, def] of Object.entries(spec.encoding as Record<string, Record<string, unknown>> ?? {})) {
    if (!def || typeof def !== 'object' || def.field != null || def.aggregate === 'count') continue
    if (!styleChannels.has(channel)) continue
    if (def.condition && typeof def.condition === 'object') continue
    if (def.value === undefined) continue
    const ch = channel === 'color' ? ((mark === 'point' || mark === 'line') && !markFilled ? 'stroke' : 'fill') : channel
    update[ch] = { value: def.value }
  }
  const conditionalChannels: { channel: string; cond: Record<string, unknown>; fallback: unknown }[] = []
  for (const [channel, def] of Object.entries(spec.encoding as Record<string, Record<string, unknown>> ?? {})) {
    if (def && typeof def === 'object' && def.condition && typeof def.condition === 'object') {
      conditionalChannels.push({ channel, cond: def.condition as Record<string, unknown>, fallback: def.value })
    }
  }
  applyCondition(update, conditionalChannels, mark, markFilled)

  // mark-def paint/geometry properties pass straight through to the mark
  // encode (vega-lite's getMarkPropOrConfig resolution): the definition wins
  // over the mark-type config block, which wins over the generic mark block.
  // Explicit per-mark handling above takes precedence.
  const markDefP = isObject(spec.mark) ? (spec.mark as Record<string, unknown>) : undefined
  const passProp = (p: string): unknown => markDefP?.[p] ?? cfgType?.[p] ?? cfgMark?.[p]
  for (const p of [
    'strokeWidth', 'strokeDash', 'strokeCap', 'strokeJoin', 'strokeMiterLimit',
    'strokeOpacity', 'fillOpacity', 'opacity', 'angle', 'blend', 'cursor',
    'cornerRadius', 'cornerRadiusTopLeft', 'cornerRadiusTopRight',
    'cornerRadiusBottomLeft', 'cornerRadiusBottomRight', 'padAngle',
  ]) {
    const v = passProp(p)
    if (v !== undefined && update[p] === undefined) update[p] = { value: v }
  }
  if (mark === 'bar' && update.clip === undefined) {
    const corners = ['cornerRadius', 'cornerRadiusTopLeft', 'cornerRadiusTopRight', 'cornerRadiusBottomLeft', 'cornerRadiusBottomRight']
    if (corners.some((k) => {
      const v = update[k]
      return v != null && typeof v === 'object' && 'value' in v && typeof (v as { value: unknown }).value === 'number' && (v as { value: number }).value !== 0
    })) update.clip = { value: true }
  }
  // markDef.xOffset/yOffset shift the corresponding positional channels
  // (including their secondary endpoint and centered forms) — probed.
  const xOff = markDefP?.xOffset as number | undefined
  const yOff = markDefP?.yOffset as number | undefined
  const withOffset = (ch: string, off: number): void => {
    const enc = update[ch] as Record<string, unknown> | undefined
    if (enc && typeof enc === 'object' && enc.offset === undefined) enc.offset = off
  }
  if (xOff !== undefined) for (const ch of ['x', 'x2', 'xc']) withOffset(ch, xOff)
  // a rule's baseline endpoint stays at zero; only its value endpoint shifts
  if (yOff !== undefined) for (const ch of mark === 'rule' ? ['y', 'yc'] : ['y', 'y2', 'yc']) withOffset(ch, yOff)
  // arc polar offsets apply to the angles/radius channels
  const thetaOff = markDefP?.thetaOffset as number | undefined
  if (thetaOff !== undefined) {
    for (const ch of ['startAngle', 'endAngle']) {
      const enc = update[ch] as Record<string, unknown> | undefined
      if (enc && typeof enc === 'object' && enc.offset === undefined) enc.offset = thetaOff
    }
  }
  const radiusOff = markDefP?.radiusOffset as number | undefined
  if (radiusOff !== undefined) {
    const enc = update.outerRadius as Record<string, unknown> | undefined
    if (enc && typeof enc === 'object' && enc.offset === undefined) enc.offset = radiusOff
    const enc2 = update.innerRadius as Record<string, unknown> | undefined
    if (enc2 && typeof enc2 === 'object' && enc2.offset === undefined && typeof enc2.value === 'number' && enc2.value > 0) enc2.offset = radiusOff
  }

  const markSpec: Record<string, unknown> = {
    name: 'marks',
    type: mark === 'bar' || mark === 'tick' ? 'rect' : mark === 'point' || mark === 'circle' || mark === 'square' ? 'symbol' : mark,
    style: [mark],
    from: { data: dataName },
    encode: { update },
  }
  // order: an explicit order channel wins; otherwise line/area sort by the
  // dimension field. Trail sorts by x (probed).
  const orderDef = fields.find((f) => f.channel === 'order' && f.field)
  const dimSortDef = orient === 'vertical' ? xDef : yDef
  const lineSortFields = orderDef
    ? [aggFieldName(orderDef)]
    : dimSortDef && !dimSortDef.timeUnit ? [aggFieldName(dimSortDef)] : []
  const lineSortOrders = [orderDef?.sort === 'descending' ? 'descending' : 'ascending']
  if ((mark === 'line' || mark === 'area') && lineSortFields.length) {
    markSpec.sort = { field: lineSortFields, order: lineSortOrders }
  }
  if (mark === 'trail') {
    markSpec.sort = { field: orient === 'horizontal' ? 'y' : 'x' }
  }

  const out: BuiltMarks = [markSpec]

  // area with a series channel: one faceted area per series (pathgroup) —
  // vega-lite emits this for stacked and unstacked areas alike
  const colorDefSeries = fields.find((f) => f.channel === 'color' && f.field)
  const detailDefSeries = fields.find((f) => f.channel === 'detail' && f.field)
  const seriesForFacet = [colorDefSeries, detailDefSeries].find((f) => f != null && !f.aggregate)
  const stackedNow = (yDef != null && isStacked(yDef, mark, orient, fields)) || (xDef != null && isStacked(xDef, mark, orient, fields))
  if (mark === 'area' && seriesForFacet) {
    markSpec.name = 'layer_0_marks'
    const group: Record<string, unknown> = {
      name: 'pathgroup',
      type: 'group',
      from: {
        facet: {
          name: 'faceted_path_main',
          data: dataName,
          groupby: [aggFieldName(seriesForFacet)],
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
        sort: { field: lineSortFields.length ? lineSortFields : [aggFieldName(xDef ?? yDef!)], order: lineSortOrders },
        from: { data: 'faceted_path_main' },
        encode: { update },
      }],
    }
    out[0] = group
  }

  // line marks split by a series channel (color or detail): one line per group
  const pointOverlay = isObject(spec.mark) ? spec.mark.point : undefined
  const lineSeries = [colorDefSeries, detailDefSeries, sizeDef].filter((f): f is FieldDef => f != null && !f.aggregate)
  if (mark === 'line' && lineSeries.length) {
    markSpec.name = 'layer_0_marks'
    const innerUpdate = { ...update }
    if (colorDefSeries && !colorDefSeries.aggregate) innerUpdate.stroke = { scale: 'color', field: aggFieldName(colorDefSeries) }
    const group: Record<string, unknown> = {
      name: 'pathgroup',
      type: 'group',
      from: {
        facet: {
          name: 'faceted_path_main',
          data: dataName,
          groupby: lineSeries.map((f) => aggFieldName(f)),
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
        sort: { field: lineSortFields.length ? lineSortFields : [aggFieldName(xDef ?? yDef!)], order: lineSortOrders },
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
      fill: { value: markColor ?? cfgFill ?? cfgColor ?? C.blue },
      x: xDef ? { scale: 'x', field: aggFieldName(xDef) } : undefined,
      y: yDef ? { scale: 'y', field: aggFieldName(yDef) } : undefined,
      shape: { value: ptType },
    }
    if (sizeDef) overlayUpdate.size = { scale: 'size', field: aggFieldName(sizeDef) }
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
    const channel = ch === 'color' ? ((mark === 'point' || mark === 'line') && !markFilled ? 'stroke' : 'fill') : ch
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
    const f = JSON.stringify(aggFieldName(d))
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
    else if (yDef && isDiscreteType(yDef.type) && !yDef.aggregate && (!xDef || !isDiscreteType(xDef.type))) orient = 'horizontal'
  }

  const data = buildData(spec, fields, mark, orient)
  // vega-lite's default sizing: continuous dimensions get 300, discrete
  // dimensions size from the band step (bandspace(domain length) * step)
  const xDefS = fields.find((f) => f.channel === 'x')
  const yDefS = fields.find((f) => f.channel === 'y')
  const xStepForm = xDefS != null && ['band', 'point'].includes(positionalScaleType(mark, xDefS))
  const yStepForm = yDefS != null && ['band', 'point'].includes(positionalScaleType(mark, yDefS))
  const width = (spec.width as unknown) ?? (xStepForm ? 0 : 300)
  const height = (spec.height as unknown) ?? (yStepForm ? 0 : 300)

  const out: Record<string, unknown> = {}
  const userConfig = isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined
  if (spec.$schema) out.$schema = 'https://vega.github.io/schema/vega/v6.json'
  out.autosize = spec.autosize ?? 'pad'
  out.background = spec.background ?? (userConfig?.background as string | undefined) ?? 'white'
  out.padding = spec.padding ?? (userConfig?.padding as unknown) ?? 5
  const assembledConfig = assembleConfig(spec)
  if (assembledConfig) out.config = assembledConfig
  out.width = spec.width ?? (xStepForm ? undefined : width)
  out.height = spec.height ?? (yStepForm ? undefined : height)
  // theta-only views (pie/donut) get vega-lite's unstyled 'view' frame — no
  // cell stroke, no half-pixel inset
  out.style = mark === 'arc' ? 'view' : 'cell'
  // Preserve a declared source dataset name (see compileLayered) — hosts key
  // data overrides/changesets on it.
  const unitSourceName = isObject(spec.data) && typeof (spec.data as Record<string, unknown>).name === 'string'
    ? (spec.data as Record<string, unknown>).name as string
    : 'source_0'
  out.data = data.transforms.length
    ? [
        { ...(isObject(spec.data) ? spec.data : {}), name: unitSourceName },
        { name: 'data_0', source: unitSourceName, transform: data.transforms },
      ]
    : [{ ...(isObject(spec.data) ? spec.data : {}), name: unitSourceName }]
  const builtMarks = buildMarks(spec, fields, mark, orient, data.dataName, markSize) as Record<string, unknown>[] & { overlayData?: Record<string, unknown> }
  // VL params with a static value become vega signals (expression refs like
  // `datum.y + shift` resolve against them). Interactive binds are ignored —
  // the value acts as the initial (and only) state.
  if (Array.isArray(spec.params) && spec.params.length) {
    const signals = (spec.params as Record<string, unknown>[])
      .filter((p) => p.name && p.value !== undefined)
      .map((p) => ({ name: p.name, value: p.value }))
    if (signals.length) out.signals = signals
  }
  out.marks = builtMarks
  // interval-selection brush marks (vega-lite emits them around the unit's
  // marks: the shaded background first, the interactive brush frame after)
  if (Array.isArray(spec.params)) {
    const brushMarks: Record<string, unknown>[] = []
    for (const p of spec.params as Record<string, unknown>[]) {
      if (!isObject(p.select) || (p.select as Record<string, unknown>).type !== 'interval') continue
      const name = p.name as string
      const zero = { value: 0 }
      brushMarks.push(
        {
          name: `${name}_brush_bg`,
          type: 'rect',
          style: [`${name}_brush_bg`],
          clip: true,
          encode: { update: { x: zero, y: zero, x2: zero, y2: zero, fill: { value: '#333' }, fillOpacity: { value: 0.125 } } },
        },
        {
          name: `${name}_brush`,
          type: 'rect',
          style: [`${name}_brush`],
          clip: true,
          encode: { update: { x: zero, y: zero, x2: zero, y2: zero, stroke: { value: null } } },
        },
      )
    }
    if (brushMarks.length && builtMarks.length) {
      // order: brush bg, unit marks, brush frame
      out.marks = [brushMarks[0]!, ...builtMarks, ...brushMarks.slice(1)]
    }
  }
  if (builtMarks.overlayData) {
    ;(out.data as Record<string, unknown>[]).push(builtMarks.overlayData)
  }
  out.scales = buildScales(spec, fields, mark, orient, data.dataName, width, height, data.seriesFields)
  applyScaleConfig(out.scales as ScaleSpec[], isObject(spec.config) ? (spec.config as Record<string, unknown>) : undefined)
  // discrete-dimension sizing: the scale spans steps and the view size is a
  // signal over the domain cardinality
  const sizeSignals: Record<string, unknown>[] = []
  const applyStepForm = (channel: 'x' | 'y', defS: FieldDef | undefined, stepForm: boolean): void => {
    if (!stepForm || !defS) return
    const sc = (out.scales as ScaleSpec[]).find((s) => s.name === channel)
    if (!sc) return
    const stepName = `${channel}_step`
    sc.range = { step: { signal: stepName } }
    const pi = (sc.paddingInner as number) ?? (sc.padding as number) ?? 0
    const po = (sc.paddingOuter as number) ?? (sc.padding as number) ?? 0
    sizeSignals.push({ name: stepName, value: 20 })
    sizeSignals.push({
      name: channel === 'x' ? 'width' : 'height',
      update: `bandspace(domain('${channel}').length, ${pi}, ${po}) * ${stepName}`,
    })
  }
  applyStepForm('x', xDefS, xStepForm && spec.width == null)
  applyStepForm('y', yDefS, yStepForm && spec.height == null)
  if (sizeSignals.length) out.signals = [...(out.signals as Record<string, unknown>[] ?? []), ...sizeSignals]
  // the point overlay's dataset joins the size domain union
  if (builtMarks.overlayData) {
    const sizeDefU = fields.find((f) => f.channel === 'size' && f.field)
    if (sizeDefU) {
      const sc = (out.scales as ScaleSpec[]).find((s) => s.name === 'size')
      if (sc && !sizeDefU.scale?.domain) {
        sc.domain = {
          fields: [
            { data: data.dataName, field: aggFieldName(sizeDefU) },
            { data: (builtMarks.overlayData as { name: string }).name, field: aggFieldName(sizeDefU) },
          ],
        }
      }
    }
  }
  const axes = buildAxes(fields, mark, orient, out.scales as ScaleSpec[], undefined, undefined, userConfig)
  if (axes.length) out.axes = axes
  // the legend symbols' stroke resolves through getMarkPropOrConfig
  // (markDef.stroke ?? config[type].stroke ?? config.mark.stroke — probed:
  // config.arc.stroke propagates onto the arc legend's symbols)
  const lgStroke = (isObject(markRaw) ? (markRaw.stroke as string | undefined) : undefined)
    ?? (isObject(userConfig?.[mark]) ? ((userConfig![mark] as Record<string, unknown>).stroke as string | undefined) : undefined)
    ?? (isObject(userConfig?.mark) ? ((userConfig!.mark as Record<string, unknown>).stroke as string | undefined) : undefined)
  const cfgMarkBlock = isObject(userConfig?.[mark]) ? (userConfig![mark] as Record<string, unknown>) : undefined
  const cfgGenericMark = isObject(userConfig?.mark) ? (userConfig!.mark as Record<string, unknown>) : undefined
  const legendFilled = isObject(markRaw) && markRaw.filled !== undefined
    ? markRaw.filled === true
    : cfgMarkBlock?.filled !== undefined
      ? cfgMarkBlock.filled === true
      : cfgGenericMark?.filled !== undefined
        ? cfgGenericMark.filled === true
        : undefined
  const legendStrokeWidth = (cfgMarkBlock?.strokeWidth as number | undefined)
    ?? (cfgGenericMark?.strokeWidth as number | undefined)
  const legendFillOpacity = (isObject(markRaw) ? markRaw.fillOpacity as number | undefined : undefined)
    ?? (cfgMarkBlock?.fillOpacity as number | undefined)
    ?? (cfgGenericMark?.fillOpacity as number | undefined)
  const legends = buildLegends(
    fields,
    mark,
    markOpacity,
    legendFilled,
    lgStroke,
    legendStrokeWidth,
    legendFillOpacity,
  )
  if (legends.length) out.legends = legends
  if (spec.title) out.title = spec.title
  if (spec.description) out.description = spec.description
  return out
}
