/**
 * Accessible scene tree (R10.6).
 *
 * The rendered SVG is an implementation detail: assistive technology needs a
 * small, stable tree of positioned controls with captions, not thousands of
 * `<path>` nodes. This module walks the scene exactly once and emits one node
 * per mark item (or one dense-chart summary per mark), guide and title. The
 * React host projects these nodes into focusable, absolutely-positioned
 * elements and uses the keyboard contract in `react/src/a11y.ts`.
 *
 * Captions deliberately follow vega-scenegraph's wording where it has one
 * ("X-axis titled '…' for a linear scale with values from … to …", "Symbol
 * legend titled '…' for color with N values: …") so a screen-reader user sees
 * the same description they would get from upstream Vega.
 */
import { SYMBOL_DEFAULT_SIZE } from './util.js'
import type { SceneGroup, SceneItem, SceneNode, SceneRoot } from './types.js'
import { currentLocale } from './locale.js'
import { tickFormat } from './scale.js'
import { pushAll } from './util.js'

export type A11yKind = 'mark' | 'axis' | 'legend' | 'legend-entry' | 'title' | 'group'

export interface A11yNode {
  id: string
  kind: A11yKind
  marktype: string
  /** ARIA role (`graphics-symbol` for marks, `slider` for adjustable axes). */
  role: string
  /** `aria-roledescription`, e.g. "symbol mark". */
  roleDescription: string
  label: string
  description?: string
  selected?: boolean
  /** Absolute position in the rendered viewport. */
  x: number
  y: number
  width: number
  height: number
  /** Continuous-axis adjustment metadata (R10.7). */
  scale?: string
  orient?: string
  domain?: [number, number]
  /** Source item count represented by this node (dense summaries). */
  count?: number
  /** The source datum (mark nodes only), for keyboard point selection. */
  datum?: unknown
  /** Legend entries: stable filter key, source value and painted symbol. */
  legendKey?: string
  legendValue?: string
  legendColor?: string
  legendShape?: string
  /** True when the corresponding legend entry is toggled off. */
  pressed?: boolean
}

export interface A11yTree {
  label: string
  description?: string
  nodes: A11yNode[]
  /** Present when the scene exceeded `summaryThreshold`: one aggregate caption. */
  summary?: string
  /** Number of focusable mark items before summarisation. */
  totalItems: number
}

export interface A11yOptions {
  label?: string
  description?: string
  /**
   * Above this many mark items the tree collapses to one summary node per mark
   * (the threshold vega-embed exposes as `aria` density control). Default 150.
   */
  summaryThreshold?: number
  /** IDs / predicates marked as selected (`aria-selected`). */
  isSelected?: (node: Omit<A11yNode, 'selected'>) => boolean
  /** Legend filter keys currently toggled off (aria-pressed=true). */
  isLegendEntryHidden?: (key: string) => boolean
}

interface Bounds { x1: number; y1: number; x2: number; y2: number }

function isGroup(n: SceneNode): n is SceneGroup {
  return (n as SceneGroup).marktype !== undefined || Array.isArray((n as SceneGroup).items)
}

function itemBounds(it: SceneItem, tx: number, ty: number): Bounds {
  const x = tx + (it.x ?? 0)
  const y = ty + (it.y ?? 0)
  const x2 = tx + (it.x2 ?? it.x ?? 0)
  const y2 = ty + (it.y2 ?? it.y ?? 0)
  let x1 = Math.min(x, x2)
  let y1 = Math.min(y, y2)
  let x2b = Math.max(x, x2)
  let y2b = Math.max(y, y2)
  if (it.width != null) x2b = x1 + Math.abs(it.width)
  if (it.height != null) y2b = y1 + Math.abs(it.height)
  if (it.radius != null) {
    x1 -= it.radius
    y1 -= it.radius
    x2b += it.radius
    y2b += it.radius
  }
  const r = it.outerRadius ?? Math.sqrt((it.size as number) ?? SYMBOL_DEFAULT_SIZE) / 2
  if (it.size != null || it.outerRadius != null || it.shape != null) {
    x1 -= r
    y1 -= r
    x2b += r
    y2b += r
  }
  if (it.text != null) {
    const fs = it.fontSize ?? 11
    const w = String(it.text).length * fs * 0.6
    const align = it.align ?? 'center'
    x1 = align === 'left' ? x : align === 'right' ? x - w : x - w / 2
    x2b = x1 + w
    y1 = y - fs
    y2b = y + fs * 0.3
  }
  if (x2b - x1 < 2) x2b = x1 + 2
  if (y2b - y1 < 2) y2b = y1 + 2
  return { x1, y1, x2: x2b, y2: y2b }
}

function union(b: Bounds[]): Bounds | null {
  if (!b.length) return null
  return b.reduce((a, c) => ({
    x1: Math.min(a.x1, c.x1), y1: Math.min(a.y1, c.y1),
    x2: Math.max(a.x2, c.x2), y2: Math.max(a.y2, c.y2),
  }))
}

function primitiveDatumLabel(datum: unknown): string | undefined {
  if (datum == null || typeof datum !== 'object') return undefined
  const parts: string[] = []
  for (const [k, v] of Object.entries(datum as Record<string, unknown>)) {
    if (k.startsWith('__') || v == null || typeof v === 'object') continue
    parts.push(`${k}: ${String(v)}`)
    if (parts.length >= 4) break
  }
  return parts.length ? parts.join(', ') : undefined
}

function textOf(items: SceneItem[] | undefined): string | undefined {
  if (!items?.length) return undefined
  const texts: string[] = []
  for (const it of items) {
    if (it.text != null && String(it.text).length) texts.push(String(it.text))
  }
  return texts.length ? texts.join(' ') : undefined
}

const DISCRETE = new Set(['band', 'point', 'ordinal', 'bin-ordinal'])
const DISCRETIZING = new Set(['quantize', 'quantile', 'threshold'])
// read per call, not snapshotted at import (C70)
const loc = (): ReturnType<typeof currentLocale> => currentLocale()

/** vega-scale domainCaption, using the same locale/tick formatting as vega. */
function scaleCaption(
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
  const temporal = type === 'time' || type === 'utc' || formatType === 'time' || formatType === 'utc'
  if (!spec && temporal) {
    spec = (type === 'utc' || formatType === 'utc') ? '%A, %d %B %Y, %X UTC' : '%A, %d %B %Y, %X'
  }
  // vega-scale expands abbreviated weekday/month specifiers for screen readers.
  if (temporal && typeof spec === 'string') spec = spec.replace(/%a/g, '%A').replace(/%b/g, '%B')
  let fmt = tickFormat(loc(), s as never, 5, spec, formatType, true)
  if (type === 'quantile' || type === 'quantize') {
    // vega-scale's thresholdFormat: quantile formats from quantiles, quantize
    // from its domain; the minimum gap drives the shared precision.
    const src = type === 'quantile' ? (s.labelValues ?? domain) : domain
    const nums = src.map(Number).filter((v) => Number.isFinite(v))
    let d = nums.length > 1 ? Math.abs(nums[1]! - nums[0]!) : (nums[0] ?? 0)
    for (let i = 1; i < nums.length; i++) d = Math.min(d, Math.abs(nums[i]! - nums[i - 1]!))
    fmt = loc().formatSpan(0, d, 30, spec) as unknown as (v: unknown) => string
  }
  const print = (v: unknown): string => {
    try { return fmt(v) } catch { return String(v) }
  }
  if (DISCRETIZING.has(type)) {
    const values = (s.labelValues ? [-Infinity, ...s.labelValues] : [domain[0], ...domain]) as unknown[]
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

function markNode(it: SceneItem, group: SceneGroup, id: string, tx: number, ty: number, opts: A11yOptions): A11yNode | null {
  if (it.aria === false) return null
  const b = itemBounds(it, tx, ty)
  const marktype = group.marktype ?? 'mark'
  const datumLabel = it.description ?? (it.datum != null ? primitiveDatumLabel(it.datum) : undefined)
  const label = it.ariaLabel ?? datumLabel ?? (it.text != null ? String(it.text) : `${marktype} mark`)
  const node: Omit<A11yNode, 'selected'> = {
    id,
    kind: 'mark',
    marktype,
    role: it.ariaRole ?? 'graphics-symbol',
    roleDescription: (it as Record<string, unknown>).ariaRoleDescription as string | undefined ?? `${marktype} mark`,
    label,
    description: datumLabel,
    x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1,
    datum: it.datum,
  }
  return { ...node, selected: opts.isSelected?.(node) }
}

function guideNode(group: SceneGroup, id: string, tx: number, ty: number, scales: Map<string, unknown>): A11yNode | null {
  const role = group.role
  if ((group as unknown as { aria?: boolean }).aria === false) return null
  if (role !== 'axis' && role !== 'legend' && role !== 'title') return null
  const gx = tx + (group.x ?? 0)
  const gy = ty + (group.y ?? 0)
  // Guides often nest a local group holding the visible items.
  const absolute: Bounds[] = []
  const collect = (node: SceneNode, ax: number, ay: number): void => {
    const kids = (node as SceneGroup).items
    if (Array.isArray(kids)) {
      const n = node as SceneGroup
      for (const c of kids) collect(c, ax + (n.x ?? 0), ay + (n.y ?? 0))
      return
    }
    absolute.push(itemBounds(node as SceneItem, ax, ay))
  }
  collect(group, tx, ty)
  const b = union(absolute) ?? { x1: gx, y1: gy, x2: gx + (group.width ?? 2), y2: gy + (group.height ?? 2) }
  const allText = textOf((group.items ?? []).flatMap((x) => (Array.isArray((x as SceneGroup).items) ? (x as SceneGroup).items as SceneItem[] : [x as SceneItem])))
  if (role === 'title') {
    const label = group.description ?? allText ?? 'Title'
    return {
      id, kind: 'title', marktype: 'group', role: 'heading', roleDescription: 'title',
      label, x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1,
    }
  }
  const datum = ((group.items?.[0] as SceneItem | undefined)?.datum ?? {}) as Record<string, unknown>
  const title = typeof datum.title === 'string'
    ? datum.title
    : typeof (group as unknown as { title?: string }).title === 'string'
      ? (group as unknown as { title?: string }).title
      : undefined
  if (role === 'axis') {
    const orient = String(datum.orient ?? (group as unknown as { orient?: string }).orient ?? 'x')
    const scaleName = typeof datum.scale === 'string'
      ? datum.scale
      : typeof (group as unknown as { scale?: string }).scale === 'string'
        ? (group as unknown as { scale?: string }).scale
        : undefined
    const type = (scales.get(scaleName ?? '') as { type?: string } | undefined)?.type ?? 'linear'
    const discrete = ['band', 'point', 'ordinal', 'bin-ordinal'].includes(type)
    const xy = orient === 'left' || orient === 'right' ? 'Y' : 'X'
    const gm = group as unknown as { format?: string; formatType?: string }
    const label = group.description ?? `${xy}-axis${title ? ` titled '${title}'` : ''} for a ${discrete ? 'discrete' : type} scale with ${scaleCaption(scales, scaleName, gm.format, gm.formatType)}`
    const dom = (scales.get(scaleName ?? '') as { domain?: () => unknown[] } | undefined)?.domain?.()
    const numeric = dom && dom.length >= 2 && typeof dom[0] === 'number' && typeof dom[dom.length - 1] === 'number'
    return {
      id, kind: 'axis', marktype: 'group',
      role: numeric ? 'slider' : 'graphics-symbol',
      roleDescription: 'axis',
      label,
      x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1,
      scale: numeric ? scaleName : undefined,
      orient,
      domain: numeric ? [dom[0] as number, dom[dom.length - 1] as number] : undefined,
    }
  }
  const gm = group as unknown as { legendType?: string; legendScale?: string; legendChannels?: string[]; legendFormat?: string; legendFormatType?: string }
  const chan = typeof gm.legendType === 'string'
    ? gm.legendType
    : typeof datum.type === 'string'
      ? datum.type
      : 'symbol'
  const channels = gm.legendChannels?.length ? gm.legendChannels : ['fill']
  const channel = channels.map((p) => p + (p === 'fill' || p === 'stroke' ? ' color' : ''))
    .reduce((a, b, i) => i === 0 ? b : i === channels.length - 1 ? `${a} and ${b}` : `${a}, ${b}`, '')
  const label = group.description ?? `${chan[0]!.toUpperCase()}${chan.slice(1)} legend${title ? ` titled '${title}'` : ''} for ${channel} with ${scaleCaption(scales, gm.legendScale, gm.legendFormat, gm.legendFormatType)}`
  return {
    id, kind: 'legend', marktype: 'group', role: 'graphics-symbol', roleDescription: 'legend',
    label, x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1,
  }
}

function legendEntryNodes(
  group: SceneGroup,
  tx: number,
  ty: number,
  options: A11yOptions,
): A11yNode[] {
  const out: A11yNode[] = []
  const gm = group as unknown as { legendScale?: string; legendChannels?: string[] }
  const filterable = (gm.legendChannels ?? []).some((c) => c === 'fill' || c === 'stroke' || c === 'shape')
  if (!filterable) return out
  let seq = 0
  const collectLeaves = (node: SceneNode, ax: number, ay: number, leaves: Array<{ it: SceneItem; x: number; y: number }>): void => {
    const g = node as SceneGroup
    const kids = g.items
    if (Array.isArray(kids)) {
      const nx = ax + (g.x ?? 0)
      const ny = ay + (g.y ?? 0)
      for (const c of kids) collectLeaves(c, nx, ny, leaves)
      return
    }
    leaves.push({ it: node as SceneItem, x: ax, y: ay })
  }
  const walkEntry = (node: SceneNode, ax: number, ay: number): void => {
    const g = node as SceneGroup
    const kids = g.items
    if (!Array.isArray(kids)) return
    const nx = ax + (g.x ?? 0)
    const ny = ay + (g.y ?? 0)
    if (g.role === 'legend-entry') {
      const leaves: Array<{ it: SceneItem; x: number; y: number }> = []
      for (const c of kids) collectLeaves(c, nx, ny, leaves)
      const text = leaves.find((l) => l.it.text != null && String(l.it.text).length)
      const symbol = leaves.find((l) => l.it.shape != null || l.it.radius != null)
      if (text) {
        const value = String(text.it.text)
        const key = `${gm.legendScale ?? 'legend'}:${value}`
        const b = union(leaves.map((l) => itemBounds(l.it, l.x, l.y))) ?? { x1: nx, y1: ny, x2: nx + 2, y2: ny + 2 }
        const fill = typeof symbol?.it.fill === 'string' && symbol.it.fill !== 'transparent' ? symbol.it.fill : undefined
        const stroke = typeof symbol?.it.stroke === 'string' ? symbol.it.stroke : undefined
        out.push({
          id: `legend-entry-${gm.legendScale ?? 'legend'}-${seq++}`,
          kind: 'legend-entry',
          marktype: 'group',
          role: 'button',
          roleDescription: 'legend entry',
          label: value,
          x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1,
          legendKey: key,
          legendValue: value,
          ...(fill ? { legendColor: fill } : stroke ? { legendColor: stroke } : {}),
          ...(typeof symbol?.it.shape === 'string' ? { legendShape: symbol.it.shape } : {}),
          pressed: options.isLegendEntryHidden?.(key) ?? false,
        })
      }
      return
    }
    for (const c of kids) walkEntry(c, nx, ny)
  }
  walkEntry(group, tx, ty)
  // Some legend builders emit a flat item list (symbol/label pairs) rather than
  // nested legend-entry groups. Pair each label with the nearest preceding
  // painted symbol; skip the bold/top title.
  if (!out.length && (gm as unknown as { legendType?: string }).legendType === 'symbol') {
    const leaves: Array<{ it: SceneItem; x: number; y: number }> = []
    collectLeaves(group, tx, ty, leaves)
    let symbol: { it: SceneItem; x: number; y: number } | null = null
    for (const leaf of leaves) {
      const it = leaf.it
      if (it.text != null && String(it.text).length) {
        const isTitle = it.fontWeight === 'bold' || (leaf.x === tx && leaf.y === ty)
        if (!isTitle && symbol) {
          const value = String(it.text)
          const key = `${gm.legendScale ?? 'legend'}:${value}`
          const fill = typeof symbol.it.fill === 'string' && symbol.it.fill !== 'transparent' ? symbol.it.fill : undefined
          const stroke = typeof symbol.it.stroke === 'string' ? symbol.it.stroke : undefined
          const b = union([itemBounds(symbol.it, symbol.x, symbol.y), itemBounds(it, leaf.x, leaf.y)]) ?? { x1: leaf.x, y1: leaf.y, x2: leaf.x + 2, y2: leaf.y + 2 }
          out.push({
            id: `legend-entry-${gm.legendScale ?? 'legend'}-${seq++}`, kind: 'legend-entry', marktype: 'group', role: 'button',
            roleDescription: 'legend entry', label: value,
            x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1,
            legendKey: key, legendValue: value,
            ...(fill ? { legendColor: fill } : stroke ? { legendColor: stroke } : {}),
            ...(typeof symbol.it.shape === 'string' ? { legendShape: symbol.it.shape } : {}),
            pressed: options.isLegendEntryHidden?.(key) ?? false,
          })
        }
        symbol = null
      } else if (it.fill != null || it.stroke != null) {
        symbol = leaf
      }
    }
  }
  return out
}

function scalesFromSnapshots(snaps: Array<{ name: string; type: string; domain: unknown[]; range: unknown[]; bandwidth?: number; labelValues?: unknown[] }>): Map<string, unknown> {
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

/**
 * Build the access tree for an evaluated scene. No DOM is required, so the
 * same tree can be serialized during SSR and re-used for hydration.
 */
export function buildA11yTree(
  scene: SceneRoot,
  scales: Map<string, unknown> = new Map(),
  options: A11yOptions = {},
): A11yTree {
  const threshold = options.summaryThreshold ?? 150
  let total = 0
  const count = (node: SceneNode): void => {
    const kids = (node as SceneGroup).items
    if (Array.isArray(kids)) {
      const isMark = (node as SceneGroup).role === 'mark'
      if (isMark) total += kids.length
      else for (const c of kids) count(c)
    }
  }
  for (const n of scene.items) count(n)

  const nodes: A11yNode[] = []
  let seq = 0
  const walk = (node: SceneNode, tx: number, ty: number, scopeScales: Map<string, unknown>): void => {
    const group = node as SceneGroup
    const gx = tx + (group.x ?? 0)
    const gy = ty + (group.y ?? 0)
    const role = group.role
    if (role === 'axis' || role === 'legend' || role === 'title') {
      const n = guideNode(group, `guide-${seq++}`, tx, ty, scopeScales)
      if (n) nodes.push(n)
      if (role === 'legend') pushAll(nodes, legendEntryNodes(group, tx, ty, options))
      return
    }
    const kids = group.items
    if (!Array.isArray(kids)) return
    const local = group.__scales ? scalesFromSnapshots(group.__scales) : scopeScales
    const marktype = group.marktype
    if (role === 'mark' && marktype && marktype !== 'group') {
      const items = kids as SceneItem[]
      if (items.length > threshold) {
        const b = union(items.map((it) => itemBounds(it, gx, gy))) ?? { x1: gx, y1: gy, x2: gx + 2, y2: gy + 2 }
        nodes.push({
          id: `mark-${seq++}`, kind: 'mark', marktype, role: 'graphics-symbol',
          roleDescription: `${marktype} mark container`,
          label: group.description ?? `${marktype} mark with ${items.length} items`,
          x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1, count: items.length,
        })
      } else {
        for (const it of items) {
          const n = markNode(it, group, `mark-${seq++}`, gx, gy, options)
          if (n) nodes.push(n)
        }
      }
      return
    }
    for (const c of kids) walk(c, gx, gy, local)
  }
  if (scales.size && scene.__scales) {
    for (const snap of scene.__scales) {
      const live = scales.get(snap.name) as { labelValues?: unknown[] } | undefined
      if (live && snap.labelValues) live.labelValues = snap.labelValues
    }
  }
  const rootScales = scales.size ? scales : scene.__scales ? scalesFromSnapshots(scene.__scales) : scales
  for (const n of scene.items) walk(n, 0, 0, rootScales)

  const summary = total > threshold ? `${total} marks in this chart. Zoom in or filter the data to explore individual marks.` : undefined
  return {
    label: options.label ?? scene.ariaLabel ?? 'Data visualization',
    description: options.description ?? scene.ariaRole ?? undefined,
    nodes,
    summary,
    totalItems: total,
  }
}
