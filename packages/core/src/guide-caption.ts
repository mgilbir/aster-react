/**
 * The captions vega-scenegraph writes as `aria-label` on a guide's SVG container (util/aria.js axisCaption,
 * legendCaption, titleCaption) and the accessible tree (a11y.ts) shows for the same guide: ONE implementation, so the
 * SVG and the tree can not say different things about an axis. `a11y-parity` checks it against vega.
 */
import { currentLocale } from './locale.js'
import { tickFormat } from './scale.js'

export type ScaleSnapshots = Array<{ name: string; type: string; domain: unknown[]; range: unknown[]; bandwidth?: number; labelValues?: unknown[] }>

const DISCRETE = new Set(['band', 'point', 'ordinal', 'bin-ordinal'])
const DISCRETIZING = new Set(['quantize', 'quantile', 'threshold', 'bin-ordinal'])
// read per call, not snapshotted at import (C70)
const loc = (): ReturnType<typeof currentLocale> => currentLocale()

/** vega-scale domainCaption, using the same locale/tick formatting as vega. */
export function scaleCaption(
  scales: Map<string, unknown>,
  name: string | undefined,
  format?: string,
  formatType?: string,
): string {
  if (!name) return ''
  const s = scales.get(name) as {
    domain?: () => unknown[]
    type?: string
    bins?: unknown[]
    labelValues?: unknown[]
  } | undefined
  if (!s || typeof s.domain !== 'function') return ''
  const domain = s.domain()
  const type = s.type ?? 'unknown'
  if (!domain.length) {
    return DISCRETE.has(type) ? '0 values: ' : 'values from NaN to NaN'
  }
  let spec = format
  // (vega-scale caption.js: the format type, when given, decides what kind of scale this is for the default)
  const effective = formatType || type
  const temporal = effective === 'time' || effective === 'utc'
  if (!spec && temporal) {
    spec = effective === 'utc' ? '%A, %d %B %Y, %X UTC' : '%A, %d %B %Y, %X'
  }
  // vega-scale expands abbreviated weekday/month specifiers for screen readers.
  if (temporal && typeof spec === 'string') spec = spec.replace(/%a/g, '%A').replace(/%b/g, '%B')
  let fmt = tickFormat(loc(), s as never, 5, spec, formatType, true)
  if (type === 'quantile' || type === 'quantize' || type === 'bin-ordinal') {
    // vega-scale's thresholdFormat: quantile formats from quantiles, quantize
    // from its domain; the minimum gap drives the shared precision.
    const src = type === 'quantile' || type === 'bin-ordinal' ? (s.labelValues ?? domain) : domain
    const nums = src.map(Number).filter((v) => Number.isFinite(v))
    let d = nums.length > 1 ? Math.abs(nums[1]! - nums[0]!) : (nums[0] ?? 0)
    for (let i = 1; i < nums.length; i++) d = Math.min(d, Math.abs(nums[i]! - nums[i - 1]!))
    fmt = loc().formatSpan(0, d, 30, spec) as unknown as (v: unknown) => string
  }
  const print = (v: unknown): string => {
    try { return fmt(v) } catch { return String(v) }
  }
  if (DISCRETIZING.has(type)) {
    // (a bin-ordinal scale's label values are its bins without the last edge: vega-scale binValues)
    const values = (type === 'bin-ordinal' ? (s.labelValues ?? domain).slice(0, -1) : s.labelValues ? [-Infinity, ...s.labelValues] : [domain[0], ...domain]) as unknown[]
    const v = values.slice(1).map(print)
    const n = v.length
    return `${n} boundar${n === 1 ? 'y' : 'ies'}: ${v.join(', ')}`
  }
  if (DISCRETE.has(type)) {
    const n = domain.length
    const max = 7
    const shown = n > max
      ? domain.slice(0, max - 2).map(print).join(', ') + ', ending with ' + print(domain[n - 1])
      : domain.map(print).join(', ')
    return `${n} value${n === 1 ? '' : 's'}: ${shown}`
  }
  return `values from ${print(domain[0])} to ${print(domain[domain.length - 1])}`
}


export function scalesFromSnapshots(snaps: Array<{ name: string; type: string; domain: unknown[]; range: unknown[]; bandwidth?: number; labelValues?: unknown[] }>): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const s of snaps) {
    const domain = s.domain.slice()
    const range = s.range.slice()
    const obj: Record<string, unknown> = {
      type: s.type,
      domain: () => domain,
      range: () => range,
      ...(s.labelValues != null ? { labelValues: s.labelValues.slice() } : {}),
      ...(s.bandwidth != null ? { bandwidth: () => s.bandwidth } : {}),
    }
    // Snapshot continuous scales need to answer vega-scale's span formatter;
    // discrete domains use plain value formatting.
    if (!DISCRETE.has(s.type)) {
      obj.tickFormat = (count?: unknown, specifier?: unknown) =>
        tickFormat(loc(), obj as never, count, specifier, undefined, true)
    }
    out.set(s.name, obj)
  }
  return out
}


/** `X-axis titled 'T' for a linear scale with values from 0 to 9` (vega-scenegraph axisCaption). */
export function axisLabel(
  g: { orient?: string; title?: string; scale?: string; format?: string; formatType?: string },
  scales: Map<string, unknown>,
): string {
  const type = (scales.get(g.scale ?? '') as { type?: string } | undefined)?.type ?? 'linear'
  const discrete = DISCRETE.has(type)
  const xy = g.orient === 'left' || g.orient === 'right' ? 'Y' : 'X'
  return `${xy}-axis${g.title ? ` titled '${g.title}'` : ''} for a ${discrete ? 'discrete' : type} scale with ${scaleCaption(scales, g.scale, g.format, g.formatType)}`
}

/** `Symbol legend titled 'K' for fill color with 2 values: a, b` (vega-scenegraph legendCaption). */
export function legendLabel(
  g: { title?: string; legendType?: string; legendChannels?: string[]; legendScale?: string; legendFormat?: string; legendFormatType?: string },
  scales: Map<string, unknown>,
  fallbackType = 'symbol',
): string {
  const chan = typeof g.legendType === 'string' ? g.legendType : fallbackType
  const channels = g.legendChannels?.length ? g.legendChannels : ['fill']
  const channel = channels.map((p) => p + (p === 'fill' || p === 'stroke' ? ' color' : ''))
    .reduce((a, b, i) => i === 0 ? b : i === channels.length - 1 ? `${a} and ${b}` : `${a}, ${b}`, '')
  return `${chan[0]!.toUpperCase()}${chan.slice(1)} legend${g.title ? ` titled '${g.title}'` : ''} for ${channel} with ${scaleCaption(scales, g.legendScale, g.legendFormat, g.legendFormatType)}`
}

/**
 * The title text a guide's caption quotes: the text of its title MARK as drawn (vega-scenegraph extractTitle: the last
 * child mark's first item, lines joined by a space), so an `encode.title` that replaces the text is what the caption
 * says; the resolved `title` of the guide when no title leaf is there.
 */
export function guideTitleText(group: { title?: string; items?: unknown[] }): string | undefined {
  const walk = (items: unknown[] | undefined): string | undefined => {
    for (const it of items ?? []) {
      const n = it as { _part?: string; text?: unknown; items?: unknown[] }
      if (n._part === 'title' && n.text != null) return Array.isArray(n.text) ? n.text.join(' ') : String(n.text)
      if (Array.isArray(n.items)) {
        const inner = walk(n.items)
        if (inner !== undefined) return inner
      }
    }
    return undefined
  }
  return walk(group.items) ?? group.title
}
