/**
 * Runtime: evaluate a CompiledChart against runtime inputs (data, size) into a
 * renderer-neutral SceneRoot. Static execution mode: everything is evaluated
 * eagerly per call; the caller re-evaluates when inputs change.
 */
import { compileExpr, type ExpressionRuntime } from './expression.js'
import { applyTransforms, sortRows, type Row } from './transform.js'
import { buildScale, scaleTicks, type Scale } from './scales.js'
import { locale, defaultLocale } from 'vega-format'
import type {
  CompiledAxis,
  CompiledChart,
  CompiledLegend,
  CompiledMark,
  EncodeValue,
  RuntimeInput,
  SceneGroup,
  SceneItem,
  SceneRoot,
  SizeSpec,
} from './types.js'
import { tickFormat } from 'vega-scale'

const DEFAULT_SIZE = 500

interface EvalContext {
  chart: CompiledChart
  signalParams: Record<string, unknown>
  width: number
  height: number
  datasets: Map<string, Row[]>
  scales: Map<string, Scale>
  scaleTypes: Map<string, string>
  runtime: ExpressionRuntime
}

export function evaluateChart(chart: CompiledChart, input: RuntimeInput = {}): SceneRoot {
  const signals = { ...chart.signals, ...input.signals }
  const width = resolveSize(chart.width, input.width, signals)
  const height = resolveSize(chart.height, input.height, signals)
  const signalParams = { width, height, ...signals }

  const datasets = new Map<string, Row[]>()
  const scales = new Map<string, Scale>()
  const scaleTypes = new Map<string, string>()
  const runtime: ExpressionRuntime = {
    scale: (name) => scales.get(name),
    data: (name) => datasets.get(name),
    expr: (expr) => compileExpr(expr, runtime),
  }

  const ctx: EvalContext = { chart, signalParams, width, height, datasets, scales, scaleTypes, runtime }

  buildDatasets(ctx, input.data ?? {})
  // Remap Vega-Lite "category" range (unhandled by vega-scale) to tableau10
  for (const s of ctx.chart.scales) {
    if (s.range === 'category') { ; (s as unknown as Record<string, unknown>).range = 'tableau10' }
  }
  buildScales(ctx)

  const items: SceneGroup[] = []
  for (const mark of chart.marks) {
    const group = evaluateMark(mark, ctx)
    if (group) items.push(group)
  }
  for (const axis of chart.axes) {
    const group = buildAxis(axis, ctx)
    if (group) items.push(group)
  }
  for (const legend of chart.legends) {
    const group = buildLegend(legend, ctx)
    if (group) items.push(group)
  }

  const scene = {
    width: width + chart.padding.left + chart.padding.right,
    height: height + chart.padding.top + chart.padding.bottom,
    background: chart.background,
    frameStroke: chart.frameStroke,
    padding: chart.padding,
    items,
  }
  return scene as SceneRoot
}

function resolveSize(size: SizeSpec, override: number | undefined, signals: Record<string, unknown>): number {
  if (typeof size === 'number') return size
  if (size && typeof size === 'object') {
    if ('signal' in size) {
      const v = signals[size.signal]
      return override ?? (typeof v === 'number' ? v : DEFAULT_SIZE)
    }
    if ('step' in size) {
      throw new Error('[aster] width/height {step} sizing is not supported yet')
    }
  }
  return override ?? DEFAULT_SIZE
}

function buildDatasets(ctx: EvalContext, inputData: Record<string, unknown[]>): void {
  const sources = new Map<string, CompiledChart['data'][number]>()
  for (const d of ctx.chart.data) sources.set(d.name, d)

  const build = (name: string, seen: Set<string>): Row[] => {
    if (ctx.datasets.has(name)) return ctx.datasets.get(name)!
    const d = sources.get(name)
    if (!d) {
      const rows = (inputData[name] as Row[]) ?? []
      ctx.datasets.set(name, rows)
      return rows
    }
    if (seen.has(name)) throw new Error(`[aster] circular data reference: ${name}`)
    seen.add(name)

    let rows: Row[]
    if ('source' in d && (d as CompiledChart['data'][number] & { source: string }).source) {
      const src = (d as CompiledChart['data'][number] & { source: string }).source
      rows = build(src, seen).map((r) => ({ ...r }))
    } else if (d.values) {
      rows = (inputData[name] as Row[]) ?? (d.values as Row[]).map((r) => ({ ...r }))
    } else {
      rows = ((inputData[name] as Row[]) ?? []).map((r) => ({ ...r }))
    }
    if (d.transform.length) {
      rows = applyTransforms(rows, d.transform, {
        runtime: ctx.runtime,
        signals: ctx.signalParams,
      })
    }
    ctx.datasets.set(name, rows)
    return rows
  }

  for (const d of ctx.chart.data) {
    build(d.name, new Set())
  }
}

function buildScales(ctx: EvalContext): void {
  const scaleSignals = ctx.signalParams
  for (const s of ctx.chart.scales) {
    const scale = buildScale(s, {
      width: ctx.width,
      height: ctx.height,
      signals: scaleSignals,
      dataField: (dataName, field) => {
        const rows = ctx.datasets.get(dataName) ?? []
        const out: unknown[] = []
        for (const r of rows) out.push(r[field])
        return out
      },
    })
    ctx.scales.set(s.name, scale)
    ctx.scaleTypes.set(s.name, s.type)
  }
}

function evaluateMark(mark: CompiledMark, ctx: EvalContext): SceneGroup | null {
  if (mark.type === 'group') {
    throw new Error('[aster] nested group marks (facet/concat/layer) not supported yet')
  }
  const source = mark.from?.data
  if (!source) return null
  let rows = (ctx.datasets.get(source) ?? []).map((r) => ({ ...r }))
  if (mark.sort) rows = sortRows(rows, mark.sort)

  // Sort rect marks by their scale y field so rendering order matches vega:
  // bars with smaller y-value render first (appear at the front).
  if (mark.type === 'rect') {
    const enc = mark.encode?.update
    if (enc) {
      for (const key of ['y', 'yc'] as const) {
        const val = enc[key]
        if (val && typeof val === 'object' && 'field' in val) {
          const f = (val as { field: string }).field
          rows = [...rows].sort((a: Row, b: Row) => {
            const av = a[f]
            const bv = b[f]
            return (typeof bv === 'number' ? bv : 0) - (typeof av === 'number' ? av : 0)
          })
          break
        }
      }
    }
  }

  const update = mark.encode?.update ?? mark.encode?.enter ?? {}
  const items: SceneItem[] = []
  for (const row of rows) {
    const item = resolveEncodeSet(update, row, ctx, mark.type)
    item.datum = row
    items.push(item)
  }

  return {
    marktype: mark.type,
    name: mark.name,
    role: 'mark',
    items,
  }
}

function resolveEncodeSet(encode: Record<string, EncodeValue | EncodeValue[]>, datum: Row, ctx: EvalContext, marktype: string): SceneItem {
  // Pass 1: resolve all non-signal values and accumulate them.
  const ctxItem: Record<string, unknown> = {}
  const signalSpecs: Array<{ key: string; spec: EncodeValue | EncodeValue[] }> = []

  for (const key of Object.keys(encode)) {
    const spec = encode[key]
    if (typeof spec === 'object' && spec != null && 'signal' in spec) {
      signalSpecs.push({ key, spec })
      continue
    }
    const resolved = resolveEncodeProperty(spec, datum, ctx)
    if (resolved !== undefined) {
      ctxItem[key] = resolved
    }
  }

  // Pass 2: resolve signal-value pairs. datum gets the resolved values appended.
  const item: SceneItem = {}
  for (const k in ctxItem) {
    datum[k as keyof Row] = ctxItem[k] as unknown
    ;(item as unknown as Record<string, unknown>)[k] = ctxItem[k]
  }
  for (const { key, spec } of signalSpecs) {
    const resolved = resolveEncodeProperty(spec, datum, ctx)
    if (resolved !== undefined) {
      ;(item as unknown as Record<string, unknown>)[key] = resolved
    }
  }
  // Post-process: handle yc (center-y) by computing y and y2 from height.
  const rec = item as unknown as Record<string, unknown>
  const ycVal = rec['yc']
  if (ycVal != null && typeof ycVal === 'number') {
    const h = rec['height']
    if (h != null && typeof h === 'number' && h > 0) {
      rec['y'] = ycVal - h / 2
      rec['y2'] = ycVal + h / 2
    } else {
      rec['y'] = ycVal
    }
  }

  return item
}

function resolveEncodeProperty(
  spec: EncodeValue | EncodeValue[] | undefined,
  datum: Row,
  ctx: EvalContext,
): unknown {
  if (spec == null) return undefined
  if (Array.isArray(spec)) {
    for (const cond of spec) {
      if (cond && typeof cond === 'object' && 'test' in cond && typeof cond.test === 'string') {
        const test = ctx.runtime.expr(cond.test)
        if (test(datum, ctx.signalParams)) {
          return resolveEncodeValueInternal(cond, datum, ctx)
        }
      }
    }
    return undefined
  }
  return resolveEncodeValueInternal(spec, datum, ctx)
}

function resolveEncodeValueInternal(value: EncodeValue | undefined, datum: Row, ctx: EvalContext): unknown {
  if (value == null || typeof value !== 'object') return value
  // 1. Signal always takes priority - evaluate the expression
  if ('signal' in value && value.signal !== undefined) {
    return ctx.runtime.expr(value.signal as string)(datum, ctx.signalParams)
  }
  // 2. Scale resolution - maps a value (or datum field) through a scale
  if ('scale' in value) {
    const scale = ctx.scales.get(value.scale as string)
    const field = (value as { field?: unknown }).field
    const bandSpec = (value as { band?: boolean | number | { signal: string } }).band
    const offsetSpec = (value as { offset?: number | { signal: string } }).offset
    let s = scale as Scale | undefined
    if (!s) return undefined
    
    // If scale is band and no field/value, return bandwidth (for {scale, band} encoding)
    if (s.bandwidth && field == null) {
      const litValue = (value as { value?: unknown }).value
      let raw: unknown
      if (litValue !== undefined) {
        raw = litValue
      } else {
        // { scale: "x", band: 1 } - return bandwidth * band fraction
        let fraction = bandSpec === true ? 0.5 : (typeof bandSpec === 'number' ? bandSpec : 1)
        return s.bandwidth() * fraction
      }
    } else if (field != null) {
      // 3a. Use datum field as the value to scale
    } else {
      // 3b. Use literal value as input to scale
      const litValue = (value as { value?: unknown }).value
      if (litValue === undefined) return undefined
    }
    
    // Get the value to scale
    let raw: unknown
    if (field != null) {
      raw = datum[field as string]
    } else {
      raw = (value as { value?: unknown }).value
    }
    if (raw === undefined) return undefined
    
    const scaleType = ctx.scaleTypes.get(value.scale as string)
    if ((scaleType === 'time' || scaleType === 'utc') && typeof raw === 'string') {
      const dateObj = new Date(raw)
      if (dateObj instanceof Date && Number.isFinite(dateObj.getTime())) {
        raw = dateObj
      }
    }
    
    const scaled = s(raw) as number
    let position = scaled
    
    // 4. Band placement: position = scale(raw) + bandFraction * bandwidth
    if (bandSpec != null && s.bandwidth) {
      const bandwidth = s.bandwidth()
      let bandFraction: number
      if (bandSpec === true) {
        bandFraction = 0.5
      } else if (typeof bandSpec === 'number') {
        bandFraction = bandSpec
      } else if (bandSpec && typeof bandSpec === 'object' && 'signal' in bandSpec) {
        bandFraction = ctx.runtime.expr(bandSpec.signal as string)(datum, ctx.signalParams) as number
      } else {
        bandFraction = 0.5
      }
      position = scaled + bandFraction * bandwidth
    }
    
    // 5. Offset: add offset after band placement
    if (offsetSpec != null) {
      let offset: number
      if (typeof offsetSpec === 'number') {
        offset = offsetSpec
      } else if (offsetSpec && typeof offsetSpec === 'object' && 'signal' in offsetSpec) {
        offset = ctx.runtime.expr(offsetSpec.signal as string)(datum, ctx.signalParams) as number
      } else {
        offset = 0
      }
      position += offset
    }
    
    return position
  }
  if ('field' in value) {
    const v = datum[value.field as string]
    return formatValue(v, value)
  }
  if ('value' in value) {
    const v = value.value
    return typeof v === 'object' && v != null && 'signal' in v
      ? resolveEncodeValueInternal(v as EncodeValue, datum, ctx)
      : v
  }
  return undefined
}

function formatValue(v: unknown, spec: EncodeValue): unknown {
  const format = (spec as { format?: unknown }).format
  const formatType = (spec as { formatType?: unknown }).formatType
  if (format === undefined) return v
  const fmt = format as string
  const L = locale(defaultLocale)
  if (formatType === 'time' || v instanceof Date) return L.timeFormat(fmt)(v as Date)
  return L.format(fmt)(v as number)
}

function buildLegend(legend: CompiledLegend, ctx: EvalContext): SceneGroup | null {
  // Scope: right-only this milestone
  // Scope: orient right only (or undefined, default right for legend)
  if (legend.orient && legend.orient !== 'right') return null
  // Resolve the scale name
  const scaleName = legend.stroke ?? legend.fill
  if (!scaleName) return null
  const scale = ctx.scales.get(scaleName)
  if (!scale) return null
  // Domain values
  const domain = scale.domain() as unknown[]
  // Build items (legend-relative coordinates; group carries x offset)
  const items: SceneItem[] = []
  items.push({ path: 'M0,0h26v66h-26Z', x: 0, y: 0 } as SceneItem)
  items.push({ text: String(legend.title ?? ''), x: 0, y: 9, align: 'left', fill: '#000' } as SceneItem)
  for (let i = 0; i < domain.length; i++) {
    const value = domain[i]
    const off = 16 + i * 18
    items.push({ path: 'M0,0h24v14h-24Z', x: 0, y: off } as SceneItem)
    items.push({ shape: 'circle', radius: 5, x: 6, y: off + 6, stroke: String(scale(value)), strokeWidth: 1.5, opacity: 0.7 } as SceneItem)
    items.push({ text: String(value), x: 16, y: off + 9, align: 'left', fill: '#000' } as SceneItem)
  }
  return { marktype: 'group', role: 'legend', x: ctx.width + 18, y: 0, items } as SceneGroup
}


function scaleTickPosition(scale: Scale, t: unknown): number {
  return (scale(t) as number) + (scale.bandwidth ? scale.bandwidth() / 2 : 0)
}

function roundedPos(scale: Scale, t: unknown): number {
  const pos = scaleTickPosition(scale, t)
  if (scale.bandwidth) return Math.floor(pos)
  return Math.round(pos)
}

function buildAxis(axis: CompiledAxis, ctx: EvalContext): SceneGroup | null {
  const scale = ctx.scales.get(axis.scale)
  if (!scale) return null
  const orient = axis.orient
  const ticks = axisTicks(axis, scale, ctx)
  const items: SceneItem[] = []
  const pos = (t: unknown) => roundedPos(scale, t)

  if (axis.grid) {
    for (const t of ticks) {
      const v = pos(t)
      const item: SceneItem = { x: 0, y: 0, x2: 0, y2: 0 }
      if (orient === 'left' || orient === 'right') {
        item.x = 0.5; item.x2 = ctx.width + 0.5; item.y = v + 0.5; item.y2 = v + 0.5
      } else {
        item.x = v + 0.5; item.x2 = v + 0.5; item.y = 0.5; item.y2 = ctx.height + 0.5
      }
      item.stroke = '#ddd'; item.strokeWidth = 1
      items.push(item)
    }
  }

  const count = (typeof axis.tickCount === "number") ? axis.tickCount : (axis.tickCount && typeof axis.tickCount === "object" && axis.tickCount.signal) ? (ctx.runtime.expr(axis.tickCount.signal)({}, ctx.signalParams) as number) || 5 : 5
  const labelFormat = axisLabelFormat(axis, scale, count)
  const tickSize = axis.tickSize ?? 5
  const labelPadding = axis.labelPadding ?? 2

  for (const t of ticks) {
    const v = pos(t)
    if (axis.ticks !== false) {
      const tick: SceneItem = { x: 0, y: 0, x2: 0, y2: 0 }
      if (orient === 'left') { tick.x = 0.5; tick.x2 = -tickSize + 0.5; tick.y = v + 0.5; tick.y2 = v + 0.5 }
      else if (orient === 'right') { tick.x = ctx.width + 0.5; tick.x2 = ctx.width + tickSize + 0.5; tick.y = v + 0.5; tick.y2 = v + 0.5 }
      else if (orient === 'bottom') { tick.x = v + 0.5; tick.x2 = v + 0.5; tick.y = ctx.height + 0.5; tick.y2 = ctx.height + tickSize + 0.5 }
      else { tick.x = v + 0.5; tick.x2 = v + 0.5; tick.y = 0.5; tick.y2 = -tickSize + 0.5 }
      tick.stroke = '#888'; tick.strokeWidth = 1
      items.push(tick)
    }
    if (axis.labels !== false) {
      const rawV = Math.round(scale(t) as number * 1000) / 1000
      const label: SceneItem = { text: String(labelFormat(t)), x: 0, y: 0 }
      const align = axis.labelAlign ?? (orient === 'left' ? 'right' : orient === 'right' ? 'left' : 'center')
      const baseline = axis.labelBaseline ?? (orient === 'top' ? 'bottom' : orient === 'bottom' ? 'top' : 'middle')
      if (orient === 'left')   { label.x = -tickSize - labelPadding + 0.5; label.y = rawV + 3.5; label.align = align as SceneItem['align'] }
      else if (orient === 'right') { label.x = ctx.width + tickSize + labelPadding + 0.5; label.y = rawV + 3.5; label.align = align as SceneItem['align'] }
      else if (orient === 'bottom') { if (scale.bandwidth) { label.x = (scale(t) as number) + scale.bandwidth() / 2; label.y = ctx.height + 7 + 0.5 } else { label.x = rawV + 0.5; label.y = ctx.height + 15 + 0.5 } label.align = align as SceneItem['align'] }
      else { label.x = rawV + 0.5; label.y = -tickSize - 10 + 0.5; label.align = align as SceneItem['align'] }
      label.baseline = baseline as SceneItem['baseline']
      label.fill = '#000'
      items.push(label)
    }
  }

  if (axis.domain !== false) {
    const domainLine: SceneItem = { x: 0, y: 0, x2: 0, y2: 0 }
    if (orient === 'left') { domainLine.x = 0.5; domainLine.x2 = 0.5; domainLine.y = 0.5; domainLine.y2 = ctx.height + 0.5 }
    else if (orient === 'right') { domainLine.x = ctx.width + 0.5; domainLine.x2 = ctx.width + 0.5; domainLine.y = 0.5; domainLine.y2 = ctx.height + 0.5 }
    else if (orient === 'bottom') { domainLine.x = 0.5; domainLine.x2 = ctx.width + 0.5; domainLine.y = ctx.height + 0.5; domainLine.y2 = ctx.height + 0.5 }
    else { domainLine.x = 0.5; domainLine.x2 = ctx.width + 0.5; domainLine.y = 0.5; domainLine.y2 = 0.5 }
    domainLine.stroke = '#888'; domainLine.strokeWidth = 1
    items.push(domainLine)
  }

  const title = axis.title
  if (title !== undefined && title !== null && title !== '') {
    const text =
      typeof title === 'object' && 'signal' in title && title.signal !== undefined
        ? String(ctx.runtime.expr(title.signal)({}, ctx.signalParams))
        : String(title)
    const t: SceneItem = { text, x: 0, y: 0 }
    if (orient === 'bottom')  { t.x = ctx.width / 2 + 0.5; t.y = ctx.height + (scale.bandwidth ? 28 : 30) + 0.5; t.align = 'center'; t.baseline = 'top' }
    else if (orient === 'top') { t.x = ctx.width / 2 + 0.5; t.y = -tickSize - 10 + 0.5; t.align = 'center'; t.baseline = 'bottom' }
    else if (orient === 'left') { t.x = -tickSize - labelPadding - 28 + 0.5; t.y = ctx.height / 2 + 0.5; t.align = 'center' }
    else if (orient === 'right') { t.x = ctx.width + tickSize + labelPadding + 28 + 0.5; t.y = ctx.height / 2 + 0.5; t.align = 'center' }
    t.fill = '#000'
    items.push(t)
  }

  return {
    marktype: 'group',
    role: 'axis',
    items,
  }
}

function axisTicks(axis: CompiledAxis, scale: Scale, ctx: EvalContext): unknown[] {
  let count: number | undefined
  if (typeof axis.tickCount === 'number') count = axis.tickCount
  else if (axis.tickCount && typeof axis.tickCount === 'object') {
    const expr = axis.tickCount.signal
    if (expr !== undefined) {
      const v = ctx.runtime.expr(expr)({}, ctx.signalParams)
      count = typeof v === 'number' ? v : undefined
    }
  }
  return scaleTicks(scale, count)
}

function axisLabelFormat(axis: CompiledAxis, scale: Scale, count: number): (v: unknown) => string {
  const specFmt = (axis.encode?.labels?.text as EncodeValue | undefined)
  if (specFmt && typeof specFmt === 'object' && 'signal' in specFmt && specFmt.signal) {
    return () => String(specFmt.signal)
  }
  const fmtType = (specFmt && typeof specFmt === 'object' && 'formatType' in specFmt && specFmt.formatType) ? String(specFmt.formatType) : undefined
  const fmt = (specFmt && typeof specFmt === 'object' && 'format' in specFmt && specFmt.format) ? String(specFmt.format) : undefined
  if (fmtType === 'time' || scale.type === 'time' || scale.type === 'utc') {
    const L = locale(defaultLocale)
    return fmt ? L.timeFormat(fmt) : L.timeFormat('%b %d')
  }
  if (scale.type !== 'linear' && scale.type !== 'log' && scale.type !== 'pow' && scale.type !== 'sqrt' && scale.type !== 'symlog') {
    return (v) => String(v)
  }
  const L = locale(defaultLocale)
  return tickFormat(L, scale, count, fmt)

}
