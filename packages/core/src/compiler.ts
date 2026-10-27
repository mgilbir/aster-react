/**
 * vg-compiler: Vega spec JSON -> CompiledChart IR.
 * Consumes the Vega spec directly (the canonical IR); vega-lite compatibility is
 * achieved by running vega-lite.compile in the app build / dev (oracle).
 */
import { dict, ownGet } from './util.js'
import { checkDataReferences, normalizeSpecLists } from './spec-structure.js'
import { markShareable } from './guide-encode.js'
import { defaultMergedConfig, mergeVegaConfig, vegaDefaultConfig } from './config-defaults.js'
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

export function compileChart(givenSpec: VgSpec): CompiledChart {
  if (!givenSpec || typeof givenSpec !== 'object') {
    throw new Error('[aster] compileChart expects a Vega spec object')
  }
  // vega-parser reads every scope list through vega-util `array()` and refuses a spec that uses a data
  // set it never declared (`Undefined data set name`) before any view exists: same here, before anything runs.
  const rawSpec = normalizeSpecLists(givenSpec)
  // Vega parses a view with mergeConfig(defaultConfig(), spec.config): every
  // default below (mark, axis, legend, title, style, range...) is read from this
  // merged config, exactly as upstream does (see config-defaults.ts).
  const userConfig = rawSpec.config as Record<string, unknown> | undefined
  const mergedConfig = (userConfig == null || (typeof userConfig === 'object' && !Array.isArray(userConfig) && Object.keys(userConfig).length === 0)
    ? defaultMergedConfig()
    : mergeVegaConfig(vegaDefaultConfig(), userConfig)) as Record<string, unknown>
  checkDataReferences(rawSpec, mergedConfig)
  markSeq = 0
  const spec: VgSpec = { ...rawSpec, config: mergedConfig as VgSpec['config'] }

  const signalDefs = compileSignalDefs(spec.signals as Array<Record<string, unknown>> | undefined)
  const signals = resolveSignals(signalDefs)
  const cfg = (spec.config ?? {}) as Record<string, unknown>
  const cfgStyle = (cfg.style ?? {}) as Record<string, Record<string, unknown>>
  const background = (spec.background as string | null | undefined) ?? (cfg.background as string | null | undefined) ?? null
  const padding = normalizePadding(spec.padding as unknown)
  // Collect signal names before resolving them
  const sigNames = (spec.signals as Array<Record<string, unknown>> | undefined)?.map(s => (s as any)?.name || '').filter(Boolean) ?? []
  // We don't have the resolved signal values yet, so just use raw width/height
  // A view with a `layout` and no size of its own (a composition: vega-lite sizes only the
  // child groups) has vega's `width` / `height` signal value, 0 - unless a signal supplies it.
  const defaultSize = (name: 'width' | 'height'): SizeSpec =>
    spec.layout != null && !sigNames.includes(name) ? 0 : DEFAULT_SIZE
  const width = typeof spec.width === 'number' ? spec.width : (typeof spec.width === 'object' ? spec.width as SizeSpec : defaultSize('width'))
  const height = typeof spec.height === 'number' ? spec.height : (typeof spec.height === 'object' ? spec.height as SizeSpec : defaultSize('height'))
  const frameStroke = resolveFrameStroke(spec)
  const frameFill = resolveFrameFill(spec)
  const frameStrokeWidth = resolveFrameNumber(spec, 'strokeWidth')
  const frameFillOpacity = resolveFrameNumber(spec, 'fillOpacity')
  const frameOpacity = resolveFrameNumber(spec, 'opacity')
  const frameStrokeDash = resolveFrameDash(spec)
  const frameCornerRadius = resolveFrameNumber(spec, 'cornerRadius')
  const frameClip = frameStyleValue(spec, 'clip') === true
  const frameStrokeOpacity = resolveFrameNumber(spec, 'strokeOpacity')
  const frameStrokeMiterLimit = resolveFrameNumber(spec, 'strokeMiterLimit')
  const frameStrokeDashOffset = resolveFrameNumber(spec, 'strokeDashOffset')
  const frameStrokeCap = resolveFrameString(spec, 'strokeCap')
  const frameStrokeJoin = resolveFrameString(spec, 'strokeJoin')
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
    if (s === null || typeof s !== 'object' || Array.isArray(s)) throw new Error('[aster] a scale definition must be an object')
    scales.push(compileScale(s))
  }

  const axes = compileGuideAxes(spec.axes as Array<Record<string, unknown>> | undefined, cfg, scales)
  const legends = compileGuideLegends(spec.legends as Array<Record<string, unknown>> | undefined, cfg)

  const marks: CompiledMark[] = []
  for (const m of (spec.marks as Array<Record<string, unknown>>) ?? []) {
    marks.push(compileMark(m, cfgStyle, cfg as Record<string, Record<string, unknown>> | undefined, scales))
  }

  const title = compileTitle(spec.title, spec.config as Record<string, unknown> | undefined)

  const projections: CompiledProjection[] = []
  for (const pr of (spec.projections as Array<Record<string, unknown>>) ?? []) {
    projections.push(compileProjection(pr, (cfg as { projection?: Record<string, unknown> }).projection))
  }

  return {
    autosize,
    width,
    height,
    padding,
    background,
    frameStroke,
    frameFill,
    frameStrokeWidth,
    frameFillOpacity,
    frameOpacity,
    frameStrokeDash,
    frameCornerRadius,
    frameClip,
    frameStrokeOpacity,
    frameStrokeMiterLimit,
    frameStrokeDashOffset,
    frameStrokeCap,
    frameStrokeJoin,
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
    style: cfgStyle,
    ...(cfg.lineBreak != null ? { lineBreak: cfg.lineBreak } : {}),
    layout: (spec.layout as Record<string, unknown> | undefined) ?? undefined,
  }
}

/**
 * Parse a projection definition. Numeric parameters may be literal, a
 * `{signal}` object (resolved at runtime), or an expression string (e.g.
 * `"[width / 2, height / 2]"`).
 */
function compileProjection(pr: Record<string, unknown>, config?: Record<string, unknown>): CompiledProjection {
  // vega-parser: every parameter is carried (a signal stays a signal; the runtime
  // resolves it per evaluation), then `config.projection` fills what the spec left out.
  const out = dict<unknown>({ name: pr.name, type: (pr.type as string) || 'mercator' })
  for (const [k, v] of Object.entries(pr)) {
    if (k === 'name' || k === 'type' || v == null) continue
    out[k] = v
  }
  for (const [k, v] of Object.entries(config ?? {})) {
    if (out[k] == null && v != null) out[k] = v
  }
  return out as unknown as CompiledProjection
}

function resolveAutosize(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') return value || undefined
  if (value && typeof value === 'object') {
    return ((value as Record<string, unknown>).type as string) || undefined
  }
  return undefined
}

/**
 * The root frame's style value for `prop`, resolved the way vega-parser's
 * `applyDefaults` does for the frame role: `config.group` first, then each
 * entry of the view's `style` list in order (later styles win). `config.view`
 * is NOT a Vega config key (Vega-Lite folds its view config into `style.cell`),
 * and a `cell` style only applies when the spec asks for it.
 */
function frameStyleValue(spec: VgSpec, prop: string): unknown {
  const config = spec.config as { group?: Record<string, unknown> | null; style?: Record<string, Record<string, unknown>> } | undefined
  const style = spec.style
  const names = Array.isArray(style) ? style : style ? [style] : []
  let v: unknown = config?.group?.[prop]
  for (const name of names) {
    const block = config?.style?.[String(name)]
    if (block && prop in block) v = block[prop]
  }
  return v
}

/** The cell background fill. */
function resolveFrameFill(spec: VgSpec): string | undefined {
  const fill = frameStyleValue(spec, 'fill')
  return typeof fill === 'string' && fill !== 'transparent' ? fill : undefined
}

function resolveFrameStroke(spec: VgSpec): string | undefined {
  const stroke = frameStyleValue(spec, 'stroke')
  // Vega serializes a 'transparent' frame stroke as no stroke at all.
  return typeof stroke === 'string' && stroke !== 'transparent' ? stroke : undefined
}

function resolveFrameNumber(spec: VgSpec, prop: string): number | undefined {
  const v = frameStyleValue(spec, prop)
  return typeof v === 'number' ? v : undefined
}

function resolveFrameString(spec: VgSpec, prop: string): string | undefined {
  const v = frameStyleValue(spec, prop)
  return typeof v === 'string' ? v : undefined
}

function resolveFrameDash(spec: VgSpec): number[] | undefined {
  const v = frameStyleValue(spec, 'strokeDash')
  return Array.isArray(v) ? v.map(Number) : undefined
}

const DEFAULT_SIZE = 500

function compileSignalDefs(signals?: Array<Record<string, unknown>>): CompiledSignalDef[] {
  const out: CompiledSignalDef[] = []
  for (const s of signals ?? []) {
    if (!s || typeof s !== 'object') continue
    const def: CompiledSignalDef = { name: s.name as string }
    // a null value is a value (`??` would fall through to `init` for it)
    if (s.value !== undefined) def.value = s.value
    // `init` is an expression (vega signal-updates: `op.initonly`), not a value.
    if (typeof s.init === 'string' && s.update === undefined) def.init = s.init
    if (typeof s.update === 'string') def.update = s.update
    if (s.bind != null && (typeof s.bind === 'string' || typeof s.bind === 'object')) {
      def.bind = s.bind as Record<string, unknown> | string
    }
    if (s.push === 'outer') def.push = 'outer'
    if (Array.isArray(s.on)) {
      // An event handler's `update` runs when its event fires; it is NOT a static
      // initial value. (Promoting the first handler to `def.update` made a signal
      // such as `(count||0)+1` tick on every evaluation with no event — C17;
      // vega leaves such a signal undefined until the event.)
      // Keep the full event-stream spec: the host binds these via
      // bindSignalEvents (signals.ts) to drive the event loop.
      // Entries are kept whole (and copied, so the compiled chart never aliases the
      // spec): the event loop interprets `events` (string | object | array) itself.
      const on = (s.on as SignalOnDef[]).filter((o) => o != null && typeof o === 'object').map((o) => ({ ...o })) as SignalOnDef[]
      def.on = on
    }
    out.push(def)
  }
  return out
}

function resolveSignals(defs: CompiledSignalDef[]): Record<string, unknown> {
  const out = dict<unknown>()
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
  const out = dict<unknown>({ type }) // prototype-less: spec keys such as `__proto__` stay plain data
  for (const key of Object.keys(t)) {
    if (key === 'type') continue
    out[key] = t[key]
  }
  return out as CompiledTransform
}

function compileScale(s: Record<string, unknown>): CompiledScale {
  // prototype-less: scale keys are spec data (`__proto__` stays a plain key)
  const out = dict<unknown>({ name: s.name, type: s.type, domain: s.domain, range: s.range })
  // vega-parser copies every other scale key through to the Scale transform
  // (interpolateGamma, schemeExtent, domainImplicit, ...): a whitelist silently
  // dropped whatever it forgot. buildScale ignores keys the scale has no setter for.
  for (const key of Object.keys(s)) {
    if (key === 'name' || key === 'type' || key === 'domain' || key === 'range') continue
    if (s[key] !== undefined) out[key] = s[key]
  }
  return out as unknown as CompiledScale
}

/**
 * The axes of one scope (the view or a group mark) with their config defaults.
 * vega applies the same lookup at every level - the config is the view's, the
 * scales are those the scope can see - so a nested group's axes follow
 * `config.axis` exactly as the top-level ones do (C51).
 */
/** the axis config blocks of the default config, by orient and band: four orients, two kinds of scale at most */
const DEFAULT_AXIS_BLOCKS = new Map<string, Record<string, unknown>>()

function compileGuideAxes(raw: Array<Record<string, unknown>> | undefined, cfg: Record<string, unknown>, scales: CompiledScale[]): CompiledAxis[] {
  const cfgAxis = (cfg.axis ?? {}) as Record<string, unknown>
  const cfgAxisX = (cfg.axisX ?? {}) as Record<string, unknown>
  const cfgAxisY = (cfg.axisY ?? {}) as Record<string, unknown>
  const cfgAxisBand = (cfg.axisBand ?? {}) as Record<string, unknown>
  const axes: CompiledAxis[] = []
  for (const a of raw ?? []) {
    // vega axisConfig precedence (vega-parser axisConfig): axis < axisX/axisY
    // (by orient) < axis<Orient> < axisBand (band scales) - later wins; the
    // axis def itself then wins over every block.
    const orientRaw = a.orient as unknown
    if (orientRaw && typeof orientRaw === 'object' && typeof (orientRaw as { signal?: unknown }).signal === 'string') {
      // `orient: {signal}`: vega-parser axis-config picks the config blocks by the signal at run time
      const variants: Record<string, CompiledAxis> = {}
      for (const o of ['top', 'bottom', 'left', 'right', '']) variants[o] = compileGuideAxes([{ ...a, orient: o }], cfg, scales)[0]!
      axes.push({ ...variants.left!, orientSignal: { signal: (orientRaw as { signal: string }).signal, variants } })
      continue
    }
    const orient = String(a.orient ?? '')
    // the innermost scale of that name wins (a group's own scale shadows the view's)
    const sc = [...scales].reverse().find((s) => s.name === a.scale)
    const band = sc?.type === 'band'
    // (the blocks of a config nobody can change are merged once: the guides' marks are kept against the result)
    const memo = cfg === defaultMergedConfig() ? DEFAULT_AXIS_BLOCKS : undefined
    const memoKey = `${orient}|${band}`
    let defaults = memo?.get(memoKey)
    if (defaults === undefined) {
      defaults = { ...cfgAxis }
      Object.assign(defaults, orient === 'top' || orient === 'bottom' ? cfgAxisX : cfgAxisY)
      const orientBlock = (cfg as Record<string, Record<string, unknown>>)[`axis${orient.charAt(0).toUpperCase()}${orient.slice(1)}`]
      if (orient && typeof orientBlock === 'object') Object.assign(defaults, orientBlock)
      if (band) Object.assign(defaults, cfgAxisBand)
      if (memo !== undefined) { Object.freeze(defaults); markShareable(defaults); memo.set(memoKey, defaults) }
    }
    axes.push(compileAxis(applyConfigDefaults(a, defaults, scales)))
  }
  return axes
}

/** The legends of one scope with `config.legend` defaults (see {@link compileGuideAxes}). */
function compileGuideLegends(raw: Array<Record<string, unknown>> | undefined, cfg: Record<string, unknown>): CompiledLegend[] {
  const cfgLegend = (cfg.legend ?? {}) as Record<string, unknown>
  if (cfg === defaultMergedConfig() && cfg.legend) markShareable(cfgLegend)
  return (raw ?? []).map((l) => compileLegend(applyConfigDefaults(l, cfgLegend, undefined, true)))
}

function compileAxis(a: Record<string, unknown>): CompiledAxis {
  const out: CompiledAxis = {
    scale: a.scale as string,
    orient: a.orient as CompiledAxis['orient'],
  }
  for (const key of ['grid', 'gridColor', 'gridWidth', 'gridDash', 'gridOpacity', 'gridCap', 'gridScale', 'domain', 'labels', 'ticks', 'tickCount', 'tickMinStep', 'tickSize', 'title', 'titlePadding', 'titleFontSize', 'titleFontWeight', 'titleOpacity', 'titleColor', 'titleAngle', 'titleAlign', 'titleBaseline', 'titleX', 'titleY', 'labelAlign', 'labelBaseline', 'labelFlush', 'labelFlushOffset', 'labelOverlap', 'labelSeparation', 'labelPadding', 'labelAngle', 'labelOffset', 'labelColor', 'labelOpacity', 'labelFontSize', 'labelFont', 'labelFontStyle', 'labelFontWeight', 'labelLimit', 'labelExpr', 'bandPosition', 'tickColor', 'tickWidth', 'tickDash', 'tickOffset', 'tickRound', 'tickExtra', 'domainColor', 'domainWidth', 'domainDash', 'domainOpacity', 'domainCap', 'maxExtent', 'minExtent', 'titleAnchor', 'titleLimit', 'titleFont', 'titleLineHeight', 'translate', 'position', 'offset', 'tickBand', 'format', 'formatType', 'zindex', 'values', 'aria', 'description'] as const) {
    if (a[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = a[key]
  }
  // Every other axis property vega defines (tickCap, tickOpacity, *DashOffset,
  // titleFontStyle, ...) is carried too: a whitelist silently dropped whatever
  // it forgot, and nothing reported it.
  for (const key of Object.keys(a)) {
    if (key === 'encode' || key === 'scale' || key === 'orient') continue
    if (a[key] !== undefined && !Object.hasOwn(out, key)) (out as unknown as Record<string, unknown>)[key] = a[key]
  }
  if (a.encode !== undefined) out.encode = a.encode as CompiledAxis['encode']
  return out
}

function compileLegend(l: Record<string, unknown>): CompiledLegend {
  const out: CompiledLegend = {}
  for (const key of ['fill', 'stroke', 'size', 'shape', 'opacity', 'strokeDash', 'disable', 'strokeWidth', 'orient', 'direction', 'columns', 'title', 'offset', 'padding', 'gradientLength', 'gradientThickness', 'gradientStrokeColor', 'gradientStrokeWidth', 'gradientOpacity', 'symbolSize', 'symbolType', 'zindex', 'type', 'tickCount', 'tickMinStep', 'symbolStrokeWidth', 'symbolOffset', 'symbolOpacity', 'symbolDash', 'symbolStrokeColor', 'labelAlign', 'labelBaseline', 'labelColor', 'labelOpacity', 'labelFontSize', 'labelFontWeight', 'labelFontStyle', 'labelFont', 'labelOffset', 'labelLimit', 'labelSeparation', 'rowPadding', 'columnPadding', 'titlePadding', 'titleFontSize', 'titleFontWeight', 'titleOpacity', 'titleColor', 'titleBaseline', 'titleAlign', 'titleAnchor', 'titleAngle', 'titleOrient', 'titleLimit', 'titleFont', 'titleLineHeight', 'gridAlign', 'clipHeight', 'cornerRadius', 'fillColor', 'strokeColor', 'labelOverlap', 'symbolLimit', 'legendX', 'legendY', 'format', 'formatType', 'labelExpr', 'values', 'aria', 'layout'] as const) {
    if (l[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = l[key]
  }
  // every other legend property vega defines is carried too (titleFontStyle, ...):
  // a whitelist silently dropped whatever it forgot
  for (const key of Object.keys(l)) {
    if (key === 'encode') continue
    if (l[key] !== undefined && !Object.hasOwn(out, key)) (out as unknown as Record<string, unknown>)[key] = l[key]
  }
  if (l.encode !== undefined) out.encode = l.encode as CompiledLegend['encode']
  return out
}

function compileTitle(value: unknown, config?: Record<string, unknown>): CompiledTitle | undefined {
  // vega's parser reads `if (spec.title)`: an empty-string (or otherwise falsy) title is no title, an object with empty text is one
  if (!value) return undefined
  const spec = typeof value === 'string' ? { text: value } : (value as Record<string, unknown>)
  const cfg = (config?.title ?? {}) as Record<string, unknown>
  // vega-parser title.js: the text mark's style is the spec's `style` (default
  // 'group-title'); a property the title spec and config.title leave unset
  // comes from that style's block of config.style.
  const cfgStyle = (config?.style ?? {}) as Record<string, Record<string, unknown>>
  const styleNames = ([] as unknown[]).concat(spec.style ?? 'group-title').map(String)
  const sty: Record<string, unknown> = {}
  for (const n of styleNames) Object.assign(sty, ownGet(cfgStyle, n))
  // Defaults mirror vega's config.title block (orient top, anchor middle,
  // offset 4, subtitlePadding 3).
  const rawText = spec.text
  const text: CompiledTitle['text'] = rawText && typeof rawText === 'object' && 'signal' in (rawText as Record<string, unknown>)
    ? { signal: String((rawText as { signal: unknown }).signal) }
    : typeof rawText === 'string' ? rawText : Array.isArray(rawText) ? rawText.map(String) : String(rawText ?? '')
  const fontSize = (spec.fontSize as number | undefined) ?? (cfg.fontSize as number | undefined) ?? (sty.fontSize as number | undefined) ?? 11
  return {
    text,
    subtitle: typeof spec.subtitle === 'string' ? spec.subtitle : spec.subtitle != null ? String(spec.subtitle) : undefined,
    orient: (spec.orient as CompiledTitle['orient']) ?? (cfg.orient as CompiledTitle['orient']) ?? 'top',
    anchor: (spec.anchor as CompiledTitle['anchor']) ?? (cfg.anchor as CompiledTitle['anchor']) ?? 'middle',
    offset: (spec.offset as number | undefined) ?? (cfg.offset as number | undefined) ?? 4,
    subtitlePadding: (spec.subtitlePadding as number | undefined) ?? (cfg.subtitlePadding as number | undefined) ?? 3,
    fontSize,
    fontWeight: (spec.fontWeight as CompiledTitle['fontWeight']) ?? (cfg.fontWeight as CompiledTitle['fontWeight']) ?? (sty.fontWeight as CompiledTitle['fontWeight']),
    font: (spec.font as string | undefined) ?? (cfg.font as string | undefined) ?? (sty.font as string | undefined),
    fontStyle: (spec.fontStyle as string | undefined) ?? (cfg.fontStyle as string | undefined) ?? (sty.fontStyle as string | undefined),
    color: (spec.color as string | undefined) ?? (cfg.color as string | undefined) ?? (sty.fill as string | undefined) ?? '#000',
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
    ...((spec.aria ?? cfg.aria) === false ? { aria: false } : {}),
    encode: spec.encode as CompiledTitle['encode'],
    own: spec,
    cfg,
  }
}

/** Fill properties from a config block (e.g. config.axis) for keys the spec omits. */
function applyConfigDefaults(o: Record<string, unknown>, defaults: Record<string, unknown>, scales?: CompiledScale[], isLegend = false): Record<string, unknown> {
  if (!defaults || typeof defaults !== 'object') return o
  const out: Record<string, unknown> = { ...defaults, ...o }
  // `position` is read as `spec.position` in vega's buildAxisEncode — never
  // through the `lookup(spec, config)` — so a config block's copy is dead
  // upstream.  Drop it too, or a config theme would reshift every axis.
  if ('position' in defaults && !('position' in o)) delete out.position
  // `tickCount`, `values`, `tickMinStep`, `format` and `formatType` are read as
  // `spec.tickCount` (and friends) in vega's guide operators — never through
  // the `lookup(spec, config)` every other property goes through — so a config
  // block's copy is dead upstream.  Drop it too, or a config theme would both
  // retick every axis and refuse interval strings the oracle never sees.
  if (!isLegend) {
    for (const k of ['tickCount', 'values', 'tickMinStep', 'format', 'formatType', 'title']) {
      if (k in defaults && !(k in o)) delete out[k]
    }
  }
  // Some vega guide properties are read from the guide's OWN spec rather than
  // through the config lookup (axis-grid reads `spec.offset` while the axis layout
  // reads the config-merged one; gradient legend labels read `spec.labelOffset`
  // with `config.gradientLabelOffset` as their fallback, not `config.labelOffset`).
  // Keep the guide's own properties apart from the config-merged ones.
  out.own = o
  out.cfg = defaults
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
  const enc = (m.encode ?? {}) as Record<string, Record<string, EncodeValue | EncodeValue[]>>
  const update = { ...(enc.enter ?? {}), ...(enc.update ?? {}) }
  m.encode = { ...enc, update }
  // vega-parser defaults.js applies sources in precedence order (config
  // blocks, then styles, last wins) with a per-source skip rule: the config
  // phase guards the solid paints — a config fill/stroke default is skipped
  // whenever EITHER paint is encoded (defaults.js: `(key === 'fill' || key
  // === 'stroke') && (has('fill', encode) || has('stroke', encode))`), while
  // style blocks only skip channels the mark itself encodes.
  const sources: Array<{ props: Record<string, unknown>; pairGuard: boolean }> = []
  const markProps: Record<string, unknown> = {}
  // vega's generic mark block (config.mark) seeds every mark's defaults;
  // the per-marktype block (config.arc etc.) then overrides.
  if (cfgMarktype) {
    const gm = cfgMarktype['mark']
    if (gm && typeof gm === 'object') Object.assign(markProps, gm)
  }
  if (m.type && cfgMarktype) {
    const st = ownGet(cfgMarktype, String(m.type))
    if (st && typeof st === 'object') Object.assign(markProps, st)
  }
  sources.push({ props: markProps, pairGuard: true })
  for (const name of names) {
    const st = ownGet(cfgStyle, name)
    if (st && typeof st === 'object') sources.push({ props: st, pairGuard: false })
  }
  // rule marks have no xc/yc semantics in vega: config/style channels for
  // them are silently ignored (only an explicit mark encode reaches them)
  const isRule = String(m.type) === 'rule'
  // A symbol mark has no rect/arc/text geometry channels: config blocks that
  // carry them (e.g. config.point.width / x2 / startAngle) are inert in vega.
  const isSymbol = String(m.type) === 'symbol'
  const isRectLike = String(m.type) === 'rect' || String(m.type) === 'bar' || String(m.type) === 'tick'
  // A rect understands x2/y2 (they override width/height) and the corner
  // radii; only the non-rect geometry and text channels are inert.
  const rectInert = new Set([
    'startAngle', 'endAngle', 'innerRadius', 'outerRadius', 'radius',
    'radius2', 'theta', 'theta2', 'padAngle', 'size', 'text', 'url',
    'align', 'baseline', 'dx', 'dy', 'limit', 'lineHeight', 'font',
    'fontSize', 'fontStyle', 'fontWeight',
  ])
  const symbolInert = new Set([
    'width', 'height', 'x2', 'y2', 'startAngle', 'endAngle', 'innerRadius',
    'outerRadius', 'radius', 'radius2', 'theta', 'theta2', 'padAngle',
    'cornerRadius', 'cornerRadiusTopLeft', 'cornerRadiusTopRight',
    'cornerRadiusBottomLeft', 'cornerRadiusBottomRight', 'text', 'url',
    'align', 'baseline', 'dx', 'dy', 'limit', 'lineHeight', 'font',
    'fontSize', 'fontStyle', 'fontWeight',
  ])
  // vega runs adjustSpatial on each encode block separately: a default that
  // lands in `enter` (style/config defaults are plain values) is resolved
  // against the enter positions only. An update-only mark therefore does not
  // see a style x2/y2/width/height (it has no enter x to pair with), while an
  // enter-encoded mark does — probed: config.style.rect.x2 affects a Vega
  // enter mark but not a Vega-Lite update mark.
  const updateOnly = enc.enter == null
  const spatialKeys = new Set(['x', 'y', 'x2', 'y2', 'xc', 'yc', 'width', 'height'])
  // Sources accumulate into `defaults` with increasing precedence (a later
  // style overrides an earlier source's value); only the mark's OWN encode
  // suppresses a default. Writing straight into `update` made the first source
  // that set a channel (e.g. config.symbol.size) shadow every later style
  // (style point's size), which vega's applyDefaults does not do.
  const own = new Set(Object.keys(update))
  const defaults: Record<string, EncodeValue | EncodeValue[]> = {}
  for (const { props, pairGuard } of sources) {
    for (const [k, v] of Object.entries(props)) {
      if (k === 'name' || k === 'interactive' || k === 'zindex' || k === 'style') continue
      if (updateOnly && spatialKeys.has(k)) continue
      if (isRule && (k === 'xc' || k === 'yc')) continue
      if (isSymbol && symbolInert.has(k)) continue
      if (isRectLike && rectInert.has(k)) continue
      let skip = own.has(k)
      if (!skip && pairGuard && (k === 'fill' || k === 'stroke')) {
        skip = own.has('fill') || own.has('stroke')
      }
      if (!skip) {
        defaults[k] = (v && typeof v === 'object' && ('value' in v || 'signal' in v || 'field' in v))
          ? (v as EncodeValue)
          : { value: v }
      }
    }
  }
  Object.assign(update, defaults)
}

/**
 * vega reads `from.facet.groupby` through `array(...)`: a bare field name is a one-field
 * groupby (`groupby: 'g'`), as in every transform's groupby. The runtime iterates arrays, so
 * normalise once here (the spec itself is never written).
 */
function normalizeFrom(from: CompiledMark['from']): CompiledMark['from'] {
  const facet = (from as { facet?: { groupby?: unknown } } | undefined)?.facet
  if (facet === undefined || facet === null || typeof facet !== 'object' || Array.isArray(facet.groupby)) return from
  const groupby = facet.groupby == null ? [] : [facet.groupby]
  return { ...from, facet: { ...facet, groupby } } as CompiledMark['from']
}

// (reset per chart: the same spec compiles to the same numbers, so scenes of equal charts are equal)
let markSeq = 0

function compileMark(m0: Record<string, unknown>, cfgStyle?: Record<string, Record<string, unknown>>, cfgMarktype?: Record<string, Record<string, unknown>>, scopeScales: CompiledScale[] = []): CompiledMark {
  const m = { ...m0 }
  if (cfgStyle || cfgMarktype) applyStyleDefaults(m, cfgStyle ?? {}, cfgMarktype)
  const out: CompiledMark = {
    type: m.type as string,
    name: (m.name as string) ?? 'marks',
    seq: markSeq++,
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
  // what the SVG container says about the mark (vega-scenegraph cssClass / ariaMarkAttributes): the name the SPEC gave it
  // (`name` above defaults to 'marks'; vega adds no class then), its description, `aria: false`
  if (m.name != null) out.userName = String(m.name)
  if (typeof m.description === 'string') out.description = m.description
  if (m.aria === false) out.aria = false
  if (m.style !== undefined) out.style = m.style as string | string[]
  if (m.from !== undefined) out.from = normalizeFrom(m.from as CompiledMark['from'])
  if (m.clip !== undefined) out.clip = m.clip as boolean
  if (m.interactive !== undefined) out.interactive = m.interactive as boolean
  if (m.zindex !== undefined) out.zindex = m.zindex as number
  if (m.key !== undefined) out.key = m.key as string
  if (m.sort !== undefined) out.sort = m.sort as CompiledMark['sort']
  if (m.title !== undefined) out.title = m.title as CompiledMark['title']
  // a group's title is a title like the view's, resolved against the same config (its text may read `parent`)
  if (m.type === 'group' && m.title !== undefined && m.title !== null) out.groupTitle = compileTitle(m.title, cfgMarktype as unknown as Record<string, unknown> | undefined)
  if (m.layout !== undefined) out.layout = m.layout as Record<string, unknown>
  // a group's own scales are visible to its axes and its children, after the enclosing scope's
  if ((m as any).scales !== undefined) out.scales = ((m as any).scales as Array<Record<string, unknown>>).map(compileScale)
  const inScope = out.scales ? [...scopeScales, ...out.scales] : scopeScales
  if (m.marks !== undefined) out.marks = (m.marks as Array<Record<string, unknown>>).map((nm) => compileMark(nm, cfgStyle, cfgMarktype, inScope))
  // a nested group's axes and legends are compiled like the view's: same config lookups (C51)
  const cfgAll = (cfgMarktype ?? {}) as unknown as Record<string, unknown>
  if ((m as any).axes !== undefined) out.axes = compileGuideAxes((m as any).axes as Array<Record<string, unknown>>, cfgAll, inScope)
  if ((m as any).legends !== undefined) out.legends = compileGuideLegends((m as any).legends as Array<Record<string, unknown>>, cfgAll)
  if ((m as any).data !== undefined) out.data = ((m as any).data as Array<Record<string, unknown>>).map(compileData)
  // a group's own signals (vega: one set per group item, see runtime buildGroupItem)
  if (m.type === 'group' && Array.isArray(m.signals) && m.signals.length) out.signalDefs = compileSignalDefs(m.signals as Array<Record<string, unknown>>)
  if (Array.isArray(m.transform)) {
    out.transform = (m.transform as Array<Record<string, unknown>>).map(compileTransform)
  }
  return out
}
