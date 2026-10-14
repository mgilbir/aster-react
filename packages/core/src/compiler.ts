/**
 * vg-compiler: Vega spec JSON -> CompiledChart IR.
 * Consumes the Vega spec directly (the canonical IR); vega-lite compatibility is
 * achieved by running vega-lite.compile in the app build / dev (oracle).
 */
import type {
  CompiledAxis,
  CompiledChart,
  CompiledData,
  CompiledLegend,
  CompiledMark,
  CompiledProjection,
  CompiledScale,
  CompiledSignalDef,
  SignalOnDef,
  CompiledTitle,
  CompiledTransform,
  EncodeValue,
  ScaleDomain,
  ScaleRange,
  SizeSpec,
  VgSpec,
} from './types.js'

export type { SizeSpec }

export function compileChart(spec: VgSpec): CompiledChart {
  if (!spec || typeof spec !== 'object') {
    throw new Error('[aster] compileChart expects a Vega spec object')
  }

  const signalDefs = compileSignalDefs(spec.signals as Array<Record<string, unknown>> | undefined)
  const signals = resolveSignals(signalDefs)
  const cfg = (spec.config ?? {}) as Record<string, unknown>
  const cfgStyle = (cfg.style ?? {}) as Record<string, Record<string, unknown>>
  const cfgAxis = (cfg.axis ?? {}) as Record<string, unknown>
  const cfgLegend = (cfg.legend ?? {}) as Record<string, unknown>
  const background = (spec.background as string | null | undefined) ?? (cfg.background as string | null | undefined) ?? null
  const padding = normalizePadding(spec.padding as unknown)
  // Collect signal names before resolving them
  const sigNames = (spec.signals as Array<Record<string, unknown>> | undefined)?.map(s => (s as any)?.name || '').filter(Boolean) ?? []
  // We don't have the resolved signal values yet, so just use raw width/height
  const width = typeof spec.width === 'number' ? spec.width : (typeof spec.width === 'object' ? spec.width as SizeSpec : DEFAULT_SIZE)
  const height = typeof spec.height === 'number' ? spec.height : (typeof spec.height === 'object' ? spec.height as SizeSpec : DEFAULT_SIZE)
  const frameStroke = resolveFrameStroke(spec)
  const autosize = resolveAutosize(spec.autosize)
  const configRange = (cfg as { range?: Record<string, unknown> }).range
  const autosizeContains = spec.autosize && typeof spec.autosize === 'object'
    ? ((spec.autosize as Record<string, unknown>).contains as string) || undefined
    : undefined

  const data: CompiledData[] = []
  for (const d of (spec.data as Array<Record<string, unknown>>) ?? []) {
    data.push(compileData(d))
  }

  const scales: CompiledScale[] = []
  for (const s of (spec.scales as Array<Record<string, unknown>>) ?? []) {
    scales.push(compileScale(s))
  }

  const axes: CompiledAxis[] = []
  for (const a of (spec.axes as Array<Record<string, unknown>>) ?? []) {
    axes.push(compileAxis(applyConfigDefaults(a, cfgAxis, scales)))
  }

  const legends: CompiledLegend[] = []
  for (const l of (spec.legends as Array<Record<string, unknown>>) ?? []) {
    legends.push(compileLegend(applyConfigDefaults(l, cfgLegend)))
  }

  const marks: CompiledMark[] = []
  for (const m of (spec.marks as Array<Record<string, unknown>>) ?? []) {
    marks.push(compileMark(m, cfgStyle, cfg as Record<string, Record<string, unknown>> | undefined))
  }

  const title = compileTitle(spec.title, spec.config as Record<string, unknown> | undefined)

  const projections: CompiledProjection[] = []
  for (const pr of (spec.projections as Array<Record<string, unknown>>) ?? []) {
    projections.push(compileProjection(pr))
  }

  return {
    autosize,
    width,
    height,
    padding,
    background,
    frameStroke,
    data,
    scales,
    axes,
    legends,
    marks,
    signals,
    signalDefs,
    title,
    projections,
    configRange,
    autosizeContains,
    layout: (spec.layout as Record<string, unknown> | undefined) ?? undefined,
  }
}

/**
 * Parse a projection definition. Numeric parameters may be literal, a
 * `{signal}` object (resolved at runtime), or an expression string (e.g.
 * `"[width / 2, height / 2]"`).
 */
function compileProjection(pr: Record<string, unknown>): CompiledProjection {
  const num = (v: unknown): number | { signal: string } | undefined =>
    typeof v === 'number' ? v : v && typeof v === 'object' && 'signal' in v ? { signal: String((v as { signal: unknown }).signal) } : undefined
  const tup = (v: unknown): [number, number] | [number, number, number] | { signal: string } | undefined => {
    // keep a third element: rotate's gamma component
    if (Array.isArray(v) && v.length > 2) return [Number(v[0]), Number(v[1]), Number(v[2])] as [number, number, number]
    if (Array.isArray(v)) return [Number(v[0]), Number(v[1])]
    if (typeof v === 'string') return { signal: v }
    if (v && typeof v === 'object' && 'signal' in v) return { signal: String((v as { signal: unknown }).signal) }
    return undefined
  }
  const out: CompiledProjection = { name: pr.name as string, type: (pr.type as string) ?? 'mercator' }
  if (pr.scale != null) out.scale = num(pr.scale)
  if (pr.translate != null) out.translate = tup(pr.translate) as [number, number] | { signal: string }
  if (pr.center != null) out.center = tup(pr.center) as [number, number] | { signal: string }
  if (pr.rotate != null) out.rotate = tup(pr.rotate) as [number, number] | [number, number, number] | { signal: string }
  if (pr.precision != null) out.precision = num(pr.precision)
  if (pr.clipAngle != null) out.clipAngle = num(pr.clipAngle)
  if (pr.reflectX != null) out.reflectX = !!pr.reflectX
  if (pr.reflectY != null) out.reflectY = !!pr.reflectY
  // Projection-specific parameters pass through (parallels, pointRadius,
  // clipExtent, extent, fit, and the exotic projection params). Signals are
  // kept in signal form so the runtime resolves them per evaluation.
  const known = new Set(['type', 'name', 'scale', 'translate', 'center', 'rotate', 'precision', 'clipAngle', 'reflectX', 'reflectY'])
  const params: Record<string, unknown> = {}
  let hasParams = false
  for (const [k, v] of Object.entries(pr)) {
    if (known.has(k) || v == null) continue
    // Nested arrays (clipExtent [[x0,y0],[x1,y1]]) pass through verbatim:
    // num/tup would coerce the inner arrays to NaN.
    params[k] =
      num(v) ??
      (Array.isArray(v) ? v.map((x) => (typeof x === 'number' ? Number(x) : x)) : undefined) ??
      tup(v) ??
      (typeof v === 'boolean' ? v : v)
    hasParams = true
  }
  if (hasParams) out.params = params
  return out
}

/** Parse autosize field: string like 'none'/'pad'/'fit' OR {type: 'none'} -> the type string or undefined. */
function resolveAutosize(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') return value || undefined
  if (value && typeof value === 'object') {
    return ((value as Record<string, unknown>).type as string) || undefined
  }
  return undefined
}

function resolveFrameStroke(spec: VgSpec): string | undefined {
  const style = spec.style
  const hasCell = Array.isArray(style) ? style.includes('cell') : style === 'cell'
  if (hasCell) return '#ddd'
  const config = spec.config as { view?: { stroke?: unknown }; style?: { cell?: { stroke?: unknown } } } | undefined
  const viewStroke = config?.view?.stroke
  const cellStroke = config?.style?.cell?.stroke
  const stroke = typeof viewStroke === 'string' ? viewStroke : typeof cellStroke === 'string' ? cellStroke : undefined
  // Vega serializes a 'transparent' frame stroke as no stroke at all.
  return stroke === 'transparent' ? undefined : stroke
}

function resolveSizeSpec(value: unknown, signalNames: string[]): SizeSpec {
  if (typeof value === 'number') return value
  if (value && typeof value === 'object') return value as SizeSpec
  if (value === undefined && signalNames.length > 0) {
    // Try width/height signal names that Vega-Lite commonly uses
    for (const name of signalNames) {
      if (name.includes('width') || name.includes('height')) {
        // This is likely the chart dimension signal — return it so it can be resolved at runtime
        return { signal: name }
      }
    }
  }
  return DEFAULT_SIZE
}

const DEFAULT_SIZE = 500

function compileSignalDefs(signals?: Array<Record<string, unknown>>): CompiledSignalDef[] {
  const out: CompiledSignalDef[] = []
  for (const s of signals ?? []) {
    if (!s || typeof s !== 'object') continue
    const def: CompiledSignalDef = { name: s.name as string }
    const value = s.value ?? s.init
    if (value !== undefined) def.value = value
    if (typeof s.update === 'string') def.update = s.update
    if (Array.isArray(s.on)) {
      // A signal may set its value from events; the first event `update` acts as
      // the static initial value when there is no declared value.
      const first = (s.on as Array<Record<string, unknown>>).find((o) => typeof o?.update === 'string')
      if (value === undefined && first) def.update = first.update as string
      // Keep the full event-stream spec: the host binds these via
      // bindSignalEvents (signals.ts) to drive the event loop.
      const on = (s.on as SignalOnDef[]).map((o) => ({
        events: o.events,
        ...(typeof o.update === 'string' ? { update: o.update } : {}),
        ...(o.between != null ? { between: o.between } : {}),
        ...(o.throttle != null ? { throttle: o.throttle } : {}),
        ...(o.debounce != null ? { debounce: o.debounce } : {}),
        ...(o.consume != null ? { consume: o.consume } : {}),
      })) as SignalOnDef[]
      def.on = on
    }
    out.push(def)
  }
  return out
}

function resolveSignals(defs: CompiledSignalDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const s of defs) {
    if (s.value !== undefined) out[s.name] = s.value
  }
  return out
}

function normalizePadding(padding?: unknown): { top: number; right: number; bottom: number; left: number } {
  if (typeof padding === 'number') return { top: padding, right: padding, bottom: padding, left: padding }
  if (padding && typeof padding === 'object') {
    const p = padding as Record<string, number>
    return {
      top: p.top ?? 0,
      right: p.right ?? 0,
      bottom: p.bottom ?? 0,
      left: p.left ?? 0,
    }
  }
  return { top: 0, right: 0, bottom: 0, left: 0 }
}

function compileData(d: Record<string, unknown>): CompiledData {
  const compiled: CompiledData = {
    name: d.name as string,
    transform: [],
  }
  if (d.values !== undefined) compiled.values = d.values as unknown[]
  if (d.url !== undefined) compiled.url = d.url as string
  if (d.format !== undefined) compiled.format = d.format as Record<string, unknown>
  if (d.source !== undefined) {
    ;(compiled as CompiledData & { source: string }).source = d.source as string
  }
  for (const t of (d.transform as Array<Record<string, unknown>>) ?? []) {
    compiled.transform.push(compileTransform(t))
  }
  return compiled
}

function compileTransform(t: Record<string, unknown>): CompiledTransform {
  const type = t.type as string
  const out: Record<string, unknown> = { type }
  for (const key of Object.keys(t)) {
    if (key === 'type') continue
    out[key] = t[key]
  }
  return out as CompiledTransform
}

function compileScale(s: Record<string, unknown>): CompiledScale {
  const out: CompiledScale = {
    name: s.name as string,
    type: s.type as CompiledScale['type'],
    domain: s.domain as ScaleDomain,
    range: s.range as ScaleRange,
  }
  for (const key of ['zero', 'reverse', 'clamp', 'round', 'nice', 'padding', 'paddingInner', 'paddingOuter', 'base', 'exponent', 'constant', 'domainMin', 'domainMax', 'domainMid', 'bins', 'interpolate', 'scheme', 'align', 'domainRaw', 'unknown'] as const) {
    if (s[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = s[key]
  }
  return out
}

function compileAxis(a: Record<string, unknown>): CompiledAxis {
  const out: CompiledAxis = {
    scale: a.scale as string,
    orient: a.orient as CompiledAxis['orient'],
  }
  for (const key of ['grid', 'gridScale', 'domain', 'labels', 'ticks', 'tickCount', 'tickMinStep', 'tickSize', 'title', 'titlePadding', 'titleFontSize', 'titleFontWeight', 'titleOpacity', 'titleColor', 'titleAngle', 'titleAlign', 'titleBaseline', 'titleX', 'titleY', 'labelAlign', 'labelBaseline', 'labelFlush', 'labelOverlap', 'labelPadding', 'labelAngle', 'labelOffset', 'labelColor', 'labelOpacity', 'labelFontSize', 'labelLimit', 'bandPosition', 'tickColor', 'tickWidth', 'tickDash', 'tickOffset', 'tickRound', 'tickExtra', 'domainColor', 'domainWidth', 'domainDash', 'domainOpacity', 'maxExtent', 'minExtent', 'titleAnchor', 'titleLimit', 'translate', 'position', 'offset', 'tickBand', 'format', 'formatType', 'zindex', 'values'] as const) {
    if (a[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = a[key]
  }
  if (a.encode !== undefined) out.encode = a.encode as CompiledAxis['encode']
  return out
}

function compileLegend(l: Record<string, unknown>): CompiledLegend {
  const out: CompiledLegend = {}
  for (const key of ['fill', 'stroke', 'size', 'shape', 'opacity', 'strokeDash', 'orient', 'direction', 'columns', 'title', 'offset', 'padding', 'gradientLength', 'gradientThickness', 'symbolSize', 'symbolType', 'zindex', 'type', 'tickCount', 'symbolStrokeWidth', 'symbolOffset', 'symbolOpacity', 'symbolDash', 'symbolStrokeColor', 'labelAlign', 'labelBaseline', 'labelColor', 'labelOpacity', 'labelFontSize', 'labelFontWeight', 'labelFontStyle', 'labelOffset', 'labelLimit', 'rowPadding', 'columnPadding', 'titlePadding', 'titleFontSize', 'titleFontWeight', 'titleOpacity', 'titleColor', 'titleBaseline', 'titleAlign', 'titleAnchor', 'titleAngle', 'titleOrient', 'titleLimit', 'gridAlign', 'clipHeight', 'cornerRadius', 'fillColor', 'strokeColor', 'labelOverlap', 'symbolLimit'] as const) {
    if (l[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = l[key]
  }
  if (l.encode !== undefined) out.encode = l.encode as CompiledLegend['encode']
  return out
}

function compileTitle(value: unknown, config?: Record<string, unknown>): CompiledTitle | undefined {
  if (value == null) return undefined
  const spec = typeof value === 'string' ? { text: value } : (value as Record<string, unknown>)
  const cfg = (config?.title ?? {}) as Record<string, unknown>
  // Defaults mirror vega's config.title block (orient top, anchor middle,
  // offset 4, subtitlePadding 3) and the vega-theme title style
  // (fontSize 13, fontWeight bold).
  const text = typeof spec.text === 'string' ? spec.text : String(spec.text ?? '')
  const fontSize = (spec.fontSize as number | undefined) ?? (cfg.fontSize as number | undefined) ?? 13
  return {
    text,
    subtitle: typeof spec.subtitle === 'string' ? spec.subtitle : spec.subtitle != null ? String(spec.subtitle) : undefined,
    orient: (spec.orient as CompiledTitle['orient']) ?? (cfg.orient as CompiledTitle['orient']) ?? 'top',
    anchor: (spec.anchor as CompiledTitle['anchor']) ?? (cfg.anchor as CompiledTitle['anchor']) ?? 'middle',
    offset: (spec.offset as number | undefined) ?? (cfg.offset as number | undefined) ?? 4,
    subtitlePadding: (spec.subtitlePadding as number | undefined) ?? (cfg.subtitlePadding as number | undefined) ?? 3,
    fontSize,
    fontWeight: (spec.fontWeight as CompiledTitle['fontWeight']) ?? (cfg.fontWeight as CompiledTitle['fontWeight']) ?? 'bold',
    font: (spec.font as string | undefined) ?? (cfg.font as string | undefined),
    color: (spec.color as string | undefined) ?? (cfg.color as string | undefined) ?? '#000',
    baseline: (spec.baseline as string | undefined) ?? (cfg.baseline as string | undefined),
    align: (spec.align as string | undefined) ?? (cfg.align as string | undefined),
    angle: (spec.angle as number | undefined) ?? (cfg.angle as number | undefined),
    subtitleColor: (spec.subtitleColor as string | undefined) ?? (cfg.subtitleColor as string | undefined),
    subtitleFontSize: (spec.subtitleFontSize as number | undefined) ?? (cfg.subtitleFontSize as number | undefined),
    subtitleFontWeight: (spec.subtitleFontWeight as string | number | undefined) ?? (cfg.subtitleFontWeight as string | number | undefined),
    dx: (spec.dx as number | undefined) ?? (cfg.dx as number | undefined),
    dy: (spec.dy as number | undefined) ?? (cfg.dy as number | undefined),
    limit: (spec.limit as number | undefined) ?? (cfg.limit as number | undefined),
    lineBreak: (spec.lineBreak as string | undefined) ?? (cfg.lineBreak as string | undefined),
    frame: (spec.frame as string | undefined) ?? (cfg.frame as string | undefined),
    encode: spec.encode as CompiledTitle['encode'],
  }
}

/** Fill properties from a config block (e.g. config.axis) for keys the spec omits. */
function applyConfigDefaults(o: Record<string, unknown>, defaults: Record<string, unknown>, scales?: CompiledScale[]): Record<string, unknown> {
  if (!defaults || typeof defaults !== 'object') return o
  const out: Record<string, unknown> = { ...defaults, ...o }
  // vega's `axisBand` style (tickOffset -0.5) is consulted through the guide
  // fallback BEFORE config.axis on band-scale axes (axis-config.js: `band =
  // scaleType === 'band' && config.axisBand`), so a config.tickOffset cannot
  // override it there — but on every other scale the config value applies.
  // Drop the config value only for band-scale axes and let the runtime
  // default (the -0.5) apply.
  if ('tickOffset' in defaults && !('tickOffset' in o) && scales) {
    const sc = scales.find((s) => s.name === o.scale)
    if (sc && (sc.type === 'band')) delete out.tickOffset
  }
  // `position` is read as `spec.position` in vega's buildAxisEncode — never
  // through the `lookup(spec, config)` — so a config block's copy is dead
  // upstream.  Drop it too, or a config theme would reshift every axis.
  if ('position' in defaults && !('position' in o)) delete out.position
  // `tickCount`, `values`, `tickMinStep`, `format` and `formatType` are read as
  // `spec.tickCount` (and friends) in vega's guide operators — never through
  // the `lookup(spec, config)` every other property goes through — so a config
  // block's copy is dead upstream.  Drop it too, or a config theme would both
  // retick every axis and refuse interval strings the oracle never sees.
  for (const k of ['tickCount', 'values', 'tickMinStep', 'format', 'formatType']) {
    if (k in defaults && !(k in o)) delete out[k]
  }
  return out
}

/**
 * Apply config.style defaults (marktype style first, then named styles, last
 * wins) as encode channels the mark does not encode. This mirrors vega's style
 * lookup order (vega-parser/mark.js + vega-encode's style encoder).
 */
function applyStyleDefaults(m: Record<string, unknown>, cfgStyle: Record<string, Record<string, unknown>>, cfgMarktype?: Record<string, Record<string, unknown>>): void {
  const names = new Set<string>()
  if (m.type) names.add(String(m.type))
  const style = m.style
  if (typeof style === 'string') names.add(style)
  else if (Array.isArray(style)) for (const s of style) names.add(String(s))
  const props: Record<string, unknown> = {}
  // vega's generic mark block (config.mark) seeds every mark's defaults;
  // the per-marktype block (config.arc etc.) then overrides, and named
  // styles override both.
  if (cfgMarktype) {
    const gm = cfgMarktype['mark']
    if (gm && typeof gm === 'object') Object.assign(props, gm)
  }
  if (m.type && cfgMarktype) {
    const st = cfgMarktype[String(m.type)]
    if (st && typeof st === 'object') {
      // vega's per-marktype config block seeds every channel except the
      // solid paints (config.arc.stroke/fill are ignored — verified by sweep).
      for (const k of ['fill', 'stroke']) delete st[k]
      Object.assign(props, st)
    }
  }
  for (const name of names) {
    const st = cfgStyle[name]
    if (st && typeof st === 'object') Object.assign(props, st)
  }
  if (!Object.keys(props).length) return
  // rule marks have no xc/yc semantics in vega: config/style channels for
  // them are silently ignored (only an explicit mark encode reaches them)
  if (String(m.type) === 'rule') {
    delete props.xc
    delete props.yc
  }
  const enc = (m.encode ?? {}) as Record<string, Record<string, EncodeValue | EncodeValue[]>>
  const update = { ...(enc.enter ?? {}), ...(enc.update ?? {}) }
  m.encode = { ...enc, update }
  for (const [k, v] of Object.entries(props)) {
    if (k === 'name' || k === 'interactive' || k === 'zindex' || k === 'style') continue
    if (k in update) continue
    update[k] = (v && typeof v === 'object' && ('value' in v || 'signal' in v || 'field' in v))
      ? (v as EncodeValue)
      : { value: v }
  }
}

function compileMark(m0: Record<string, unknown>, cfgStyle?: Record<string, Record<string, unknown>>, cfgMarktype?: Record<string, Record<string, unknown>>): CompiledMark {
  const m = { ...m0 }
  if (cfgStyle || cfgMarktype) applyStyleDefaults(m, cfgStyle ?? {}, cfgMarktype)
  const out: CompiledMark = {
    type: m.type as string,
    name: (m.name as string) ?? 'marks',
  }
  // Vega evaluates `enter` when an item is created and `update` on every
  // pulse; in static rendering every item is created, so the effective set is
  // `enter` overridden per-channel by `update`.
  if (m.encode !== undefined) {
    const enc = m.encode as Record<string, Record<string, EncodeValue | EncodeValue[]>>
    const merged = { ...(enc.enter ?? {}), ...(enc.update ?? {}) }
    out.encode = { ...enc, update: merged }
  }
  if (m.role !== undefined) out.role = m.role as string
  if (m.style !== undefined) out.style = m.style as string | string[]
  if (m.from !== undefined) out.from = m.from as CompiledMark['from']
  if (m.clip !== undefined) out.clip = m.clip as boolean
  if (m.interactive !== undefined) out.interactive = m.interactive as boolean
  if (m.zindex !== undefined) out.zindex = m.zindex as number
  if (m.key !== undefined) out.key = m.key as string
  if (m.sort !== undefined) out.sort = m.sort as CompiledMark['sort']
  if (m.title !== undefined) out.title = m.title as CompiledMark['title']
  if (m.layout !== undefined) out.layout = m.layout as Record<string, unknown>
  if (m.marks !== undefined) out.marks = (m.marks as Array<Record<string, unknown>>).map((nm) => compileMark(nm, cfgStyle, cfgMarktype))
  if ((m as any).axes !== undefined) out.axes = ((m as any).axes as Array<Record<string, unknown>>).map(compileAxis)
  if ((m as any).scales !== undefined) out.scales = ((m as any).scales as Array<Record<string, unknown>>).map(compileScale)
  if ((m as any).data !== undefined) out.data = ((m as any).data as Array<Record<string, unknown>>).map(compileData)
  if (Array.isArray(m.transform)) {
    out.transform = (m.transform as Array<Record<string, unknown>>).map(compileTransform)
  }
  return out
}
