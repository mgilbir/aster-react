/**
 * The captions vega-scenegraph writes as `aria-label` on a guide's SVG container (util/aria.js axisCaption,
 * legendCaption, titleCaption) and the accessible tree (a11y.ts) shows for the same guide: ONE implementation, so the
 * SVG and the tree can not say different things about an axis. `a11y-parity` checks it against vega.
 */
import { currentLocale } from './locale.js'
import { isDiscretizing, isTemporal, labelFormat, labelValues, tickFormat } from './scale.js'
import { installGuideCaptions } from './render.js'

export type ScaleSnapshots = Array<{ name: string; type: string; domain: unknown[]; range: unknown[]; bandwidth?: number; labelValues?: unknown[] }>

const DISCRETE = new Set(['band', 'point', 'ordinal', 'bin-ordinal'])
// read per call, not snapshotted at import (C70)
const loc = (): ReturnType<typeof currentLocale> => currentLocale()

/** vega-scale caption.js `format`: the labels the caption quotes are formatted as a legend would, with the temporal defaults of a screen reader. */
function captionFormat(locale: ReturnType<typeof currentLocale>, scale: Rec, specifier: unknown, formatType: string | undefined): (v: unknown) => string {
  const type = formatType || (scale.type as string)
  // replace abbreviated time specifiers to improve screen reader experience
  if (typeof specifier === 'string' && isTemporal(type)) specifier = specifier.replace(/%a/g, '%A').replace(/%b/g, '%B')
  return (!specifier && type === 'time' ? locale.timeFormat('%A, %d %B %Y, %X')
    : !specifier && type === 'utc' ? locale.utcFormat('%A, %d %B %Y, %X UTC')
    : labelFormat(locale, scale as never, 5, '', specifier, formatType, true)) as unknown as (v: unknown) => string
}

type Rec = Record<string, unknown>

/** vega-scale domainCaption, using the same locale/tick formatting as vega. */
export function scaleCaption(
  scales: Map<string, unknown>,
  name: string | undefined,
  format?: string,
  formatType?: string,
): string {
  if (!name) return ''
  const s = scales.get(name) as Rec & { domain?: () => unknown[]; type?: string } | undefined
  if (!s || typeof s.domain !== 'function') return ''
  const domain = s.domain()
  const type = s.type ?? 'unknown'
  if (!domain.length && !isDiscretizing(type)) {
    return DISCRETE.has(type) ? '0 values: ' : 'values from NaN to NaN'
  }
  const fmt = captionFormat(loc(), s, format, formatType)
  const print = (v: unknown): string => {
    try { return fmt(v) } catch { return String(v) }
  }
  // if scale breaks domain into bins, describe boundaries
  if (isDiscretizing(type)) {
    const v = labelValues(s as never, undefined).slice(1).map(print)
    const n = v.length
    return `${n} boundar${n === 1 ? 'y' : 'ies'}: ${v.join(', ')}`
  }
  // if scale domain is discrete, list values
  if (DISCRETE.has(type)) {
    const n = domain.length
    const max = 7
    const shown = n > max
      ? domain.slice(0, max - 2).map(print).join(', ') + ', ending with ' + print(domain[n - 1])
      : domain.map(print).join(', ')
    return `${n} value${n === 1 ? '' : 's'}: ${shown}`
  }
  // if scale domain is continuous, describe value range
  return `values from ${print(domain[0])} to ${print(domain[domain.length - 1])}`
}


/**
 * Pseudo scales for the captions, from the snapshots the scene carries: just what vega-scale's caption reads of a scale
 * (its type, domain and range, the breakpoints of a discretizing scale, a tick formatter where d3's scale has one).
 */
export function scalesFromSnapshots(snaps: Array<{ name: string; type: string; domain: unknown[]; range: unknown[]; bandwidth?: number; labelValues?: unknown[] }>): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const s of snaps) {
    const domain = s.domain.slice()
    const range = s.range.slice()
    const values = s.labelValues?.slice()
    const obj: Record<string, unknown> = {
      type: s.type,
      domain: () => domain,
      range: () => range,
      ...(values != null ? { labelValues: values } : {}),
      ...(s.bandwidth != null ? { bandwidth: () => s.bandwidth } : {}),
    }
    // the breakpoints vega-scale's labels.js asks a discretizing scale for, and the bins of a binned one
    if (s.type === 'quantile') obj.quantiles = () => values ?? []
    else if (s.type === 'quantize') obj.thresholds = () => values ?? []
    else if (s.type !== 'threshold' && values != null) obj.bins = values
    // d3's continuous scales (and quantize, which is built on one, and vega's bin-ordinal) have a tickFormat; the others do not
    if ((!DISCRETE.has(s.type) || s.type === 'bin-ordinal') && s.type !== 'quantile' && s.type !== 'threshold') {
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

installGuideCaptions({
  axis: (g, scales) => axisLabel(g, scales),
  legend: (g, scales) => legendLabel(g, scales),
  titleText: (g) => guideTitleText(g),
  scales: (snaps) => scalesFromSnapshots(snaps),
})
