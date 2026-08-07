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
  CompiledScale,
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

  const signals = resolveSignals(spec.signals as Array<Record<string, unknown>> | undefined)
  const background = (spec.background as string | null | undefined) ?? null
  const padding = normalizePadding(spec.padding as unknown)
  // Collect signal names before resolving them
  const sigNames = (spec.signals as Array<Record<string, unknown>> | undefined)?.map(s => (s as any)?.name || '').filter(Boolean) ?? []
  // We don't have the resolved signal values yet, so just use raw width/height
  const width = typeof spec.width === 'number' ? spec.width : (typeof spec.width === 'object' ? spec.width as SizeSpec : DEFAULT_SIZE)
  const height = typeof spec.height === 'number' ? spec.height : (typeof spec.height === 'object' ? spec.height as SizeSpec : DEFAULT_SIZE)
  const frameStroke = resolveFrameStroke(spec)
  const autosize = resolveAutosize(spec.autosize)

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
    axes.push(compileAxis(a))
  }

  const legends: CompiledLegend[] = []
  for (const l of (spec.legends as Array<Record<string, unknown>>) ?? []) {
    legends.push(compileLegend(l))
  }

  const marks: CompiledMark[] = []
  for (const m of (spec.marks as Array<Record<string, unknown>>) ?? []) {
    marks.push(compileMark(m))
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
  }
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
  return typeof viewStroke === 'string' ? viewStroke : typeof cellStroke === 'string' ? cellStroke : undefined
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

function resolveSignals(signals?: Array<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const s of signals ?? []) {
    if (!s || typeof s !== 'object') continue
    const name = s.name as string
    // Static mode: we ignore `on` event streams but keep declared default values.
    const value = s.value ?? s.init
    if (value !== undefined) out[name] = value
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
  for (const key of ['grid', 'gridScale', 'domain', 'labels', 'ticks', 'tickCount', 'tickMinStep', 'tickSize', 'title', 'titlePadding', 'labelAlign', 'labelBaseline', 'labelFlush', 'labelOverlap', 'labelPadding', 'labelAngle', 'tickBand', 'zindex'] as const) {
    if (a[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = a[key]
  }
  if (a.encode !== undefined) out.encode = a.encode as CompiledAxis['encode']
  return out
}

function compileLegend(l: Record<string, unknown>): CompiledLegend {
  const out: CompiledLegend = {}
  for (const key of ['fill', 'stroke', 'size', 'shape', 'opacity', 'strokeDash', 'orient', 'title', 'offset', 'padding', 'gradientLength', 'gradientThickness', 'symbolSize', 'symbolType', 'zindex', 'type'] as const) {
    if (l[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = l[key]
  }
  if (l.encode !== undefined) out.encode = l.encode as CompiledLegend['encode']
  return out
}

function compileMark(m: Record<string, unknown>): CompiledMark {
  const out: CompiledMark = {
    type: m.type as string,
    name: (m.name as string) ?? 'marks',
  }
  if (m.role !== undefined) out.role = m.role as string
  if (m.style !== undefined) out.style = m.style as string | string[]
  if (m.from !== undefined) out.from = m.from as CompiledMark['from']
  if (m.clip !== undefined) out.clip = m.clip as boolean
  if (m.interactive !== undefined) out.interactive = m.interactive as boolean
  if (m.zindex !== undefined) out.zindex = m.zindex as number
  if (m.key !== undefined) out.key = m.key as string
  if (m.sort !== undefined) out.sort = m.sort as CompiledMark['sort']
  if (m.encode !== undefined) out.encode = m.encode as CompiledMark['encode']
  if (m.title !== undefined) out.title = m.title as CompiledMark['title']
  if (m.marks !== undefined) out.marks = m.marks as CompiledMark['marks']
  if ((m as any).axes !== undefined) out.axes = (m as any).axes
  if (Array.isArray(m.transform)) {
    out.transform = (m.transform as Array<Record<string, unknown>>).map(compileTransform)
  }
  return out
}

/** Resolve a vega signal-typed value against known static signals. */
export function resolveEncodeValue(
  value: EncodeValue,
  signals: Record<string, unknown>,
): unknown {
  if (value && typeof value === 'object') {
    if ('signal' in value && value.signal !== undefined) {
      const name = value.signal as string
      const resolved = signals[name]
      if (resolved === undefined) {
        throw new Error(`[aster] unresolved signal "${name}" (reactive signals not yet supported)`)
      }
      return resolved
    }
    if ('value' in value) return value.value
  }
  return value
}
