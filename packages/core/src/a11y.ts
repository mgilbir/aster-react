/**
 * Accessible scene tree.
 *
 * The rendered SVG is an implementation detail: assistive technology needs a
 * small, stable tree of positioned controls with captions, not thousands of
 * `<path>` nodes. This module walks the scene exactly once and emits one node
 * per mark item (or one dense-chart summary per mark), guide and title. The
 * React host projects these nodes into focusable, absolutely-positioned
 * elements and uses the keyboard contract in `react/src/interaction.ts` (`keyboardView`).
 *
 * Every box is in the rendered viewport: the top-left of the chart's SVG (or canvas) is (0, 0), and the view's padding and
 * the frame's offset inside it are part of the numbers. That is the space of a pointer event mapped into the chart and of
 * `buildHitIndex`, and a host overlays a node at its own (x, y) with no knowledge of the padding. A mark item's box is its
 * bounds as the hit index measures them (bounds.ts `boundItemOfKind`: a text's measured width, alignment, offsets and angle, a
 * symbol's shape, a rect's size); the item of a line, area or trail mark -- one point of the mark's one path -- is the point
 * it stands for. A box is never smaller than 2 x 2, nor anything but finite numbers (an item whose bounds are not, a NaN
 * width, stands at its position).
 *
 * The tree is bounded, whatever the data: above `summaryThreshold` mark items in the whole chart, every mark is one summary
 * node, and no more than `summaryThreshold` mark nodes are made in all (the marks past them are one last summary); a legend
 * gives no more than `summaryThreshold` entry nodes. Node ids are unique in a tree, and a mark item's id is its mark's and its
 * datum's (not its position), so a row inserted before it does not rename it.
 *
 * Captions deliberately follow vega-scenegraph's wording where it has one
 * ("X-axis titled '…' for a linear scale with values from … to …", "Symbol
 * legend titled '…' for color with N values: …") so a screen-reader user sees
 * the same description they would get from upstream Vega.
 */
import { Bounds as Box, boundItemOfKind } from './bounds.js'
import { hash53 } from './svg-defs.js'
import { withSceneOutput } from './scene-output.js'
import type { SceneGroup, SceneItem, SceneNode, SceneRoot } from './types.js'
import { axisLabel, guideTitleText, legendLabel, scalesFromSnapshots } from './guide-caption.js'
import { drawnOffset, pushAll } from './util.js'
import { isEngineNode, keptInto } from './scene-registry.js'

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
  /** Position of the box in the rendered viewport (padding included; see the module comment). */
  x: number
  y: number
  width: number
  height: number
  /** Continuous-axis adjustment metadata. */
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
   * The tree's bound (Aster's own option; vega-embed has no equivalent). Default 150. Above this many mark items in the whole
   * scene every mark collapses to one summary node; no more than this many mark nodes are made in all, nor legend entries per
   * legend (see the module comment).
   */
  summaryThreshold?: number
  /** IDs / predicates marked as selected (`aria-selected`). */
  isSelected?: (node: Omit<A11yNode, 'selected'>) => boolean
  /** Legend filter keys currently toggled off (aria-pressed=true). */
  isLegendEntryHidden?: (key: string) => boolean
}

interface Bounds { x1: number; y1: number; x2: number; y2: number }

/** The marks whose items are the points of one path: an item's node is the point it stands for. */
const PATH_MARKS = new Set(['line', 'area', 'trail'])

/**
 * The box of an item at (tx, ty) (see the module comment): its bounds as the hit index measures an item of a mark of `kind`
 * (`leaf` for a guide's part), the point of a path mark's item, never smaller than 2 x 2 and always finite.
 */
function itemBounds(it: SceneItem, tx: number, ty: number, kind: string): Bounds {
  const px = +(it.x as number) || 0
  const py = +(it.y as number) || 0
  let x1 = px, y1 = py, x2 = px, y2 = py
  if (!PATH_MARKS.has(kind)) {
    const b = new Box()
    // (a value the bounds reader refuses -- a pass vega stops at -- leaves the item at its position: the tree never throws)
    try { boundItemOfKind(b, it, kind) } catch { b.clear() }
    if (!b.empty() && Number.isFinite(b.x1) && Number.isFinite(b.y1) && Number.isFinite(b.x2) && Number.isFinite(b.y2)) {
      x1 = b.x1; y1 = b.y1; x2 = b.x2; y2 = b.y2
    }
  }
  // (at least 2 x 2, about its centre)
  if (x2 - x1 < 2) { const c = (x1 + x2) / 2; x1 = c - 1; x2 = c + 1 }
  if (y2 - y1 < 2) { const c = (y1 + y2) / 2; y1 = c - 1; y2 = c + 1 }
  return { x1: tx + x1, y1: ty + y1, x2: tx + x2, y2: ty + y2 }
}

function union(b: Bounds[]): Bounds | null {
  if (!b.length) return null
  return b.reduce((a, c) => ({
    x1: Math.min(a.x1, c.x1), y1: Math.min(a.y1, c.y1),
    x2: Math.max(a.x2, c.x2), y2: Math.max(a.y2, c.y2),
  }))
}

/**
 * The box of a node at (tx, ty), kept with the node when it is a node of a scene the engine returned: such a node holds what it held
 * (scene-registry.ts), so the box at the same offset is the same numbers, in a later scene that kept it (`keptInto`). The offset is compared as it is (`Object.is`), and the box
 * is computed afresh at another: the offset enters the arithmetic before the radii and the rounding do, so a box is not moved.
 */
function kept(cache: WeakMap<object, KeptBox>, node: object, tx: number, ty: number, make: () => Bounds): Bounds {
  if (!isEngineNode(node)) return make()
  const hit = cache.get(node)
  if (hit !== undefined && keptInto(hit.root, reading) && Object.is(hit.tx, tx) && Object.is(hit.ty, ty)) return hit.b
  const b = make()
  cache.set(node, { tx, ty, b, root: reading })
  return b
}
interface KeptBox { tx: number; ty: number; b: Bounds; root: object }
const GUIDE_BOXES = new WeakMap<object, KeptBox>()
const SUMMARY_BOXES = new WeakMap<object, KeptBox>()
/** The scene `buildA11yTree` is reading (see `keptInto`). */
let reading: object = {}

/** The box of a mark summarised as one node: the union of its items' boxes (kept with an engine node, see `kept`). */
function summaryBox(group: SceneGroup, items: SceneItem[], gx: number, gy: number): Bounds {
  const kind = String(group.marktype)
  return kept(SUMMARY_BOXES, group, gx, gy, () => union(items.map((it) => itemBounds(it, gx, gy, kind))) ?? { x1: gx, y1: gy, x2: gx + 2, y2: gy + 2 })
}

/**
 * The part of a mark item's id that is its datum's (see `markIds`): the datum's own primitive fields, hashed; nothing when it has
 * none (or cannot be read), in which case the item's position stands in.
 */
function datumKey(datum: unknown): string | undefined {
  if (datum == null || typeof datum !== 'object') return datum == null ? undefined : `v${hash53(typeof datum + ':' + String(datum))}`
  let text = ''
  for (const [k, v] of Object.entries(datum as Record<string, unknown>)) {
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) text += `${k.length}:${k}=${typeof v}:${String(v)};`
  }
  return text === '' ? undefined : `d${hash53(text)}`
}

/**
 * The ids of a mark's item nodes: `mark-<mark>-<datum key>`, a repeated key (two items of equal data) told apart by its
 * occurrence; an item with no datum key by its position (`mark-<mark>-i<index>`).
 */
function markIds(markId: string, items: readonly SceneItem[]): string[] {
  const seen = new Map<string, number>()
  return items.map((it, i) => {
    const key = datumKey(it.datum)
    if (key === undefined) return `${markId}-i${i}`
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    return n === 0 ? `${markId}-${key}` : `${markId}-${key}_${n}`
  })
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

function markNode(it: SceneItem, group: SceneGroup, id: string, tx: number, ty: number, opts: A11yOptions): A11yNode | null {
  if (it.aria === false) return null
  const marktype = group.marktype ?? 'mark'
  const b = itemBounds(it, tx, ty, marktype)
  const datumLabel = it.description ?? (it.datum != null ? primitiveDatumLabel(it.datum) : undefined)
  const label = datumLabel ?? (it.text != null ? String(it.text) : `${marktype} mark`)
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

function guideNode(group: SceneGroup, id: string, tx: number, ty: number, scales: Map<string, unknown>, locale: SceneRoot['__locale']): A11yNode | null {
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
    absolute.push(itemBounds(node as SceneItem, ax, ay, 'leaf'))
  }
  // (the box of a node of a scene the engine returned, at the same place, is the box it had: see `kept`)
  const b = kept(GUIDE_BOXES, group, tx, ty, () => {
    collect(group, tx, ty)
    return union(absolute) ?? { x1: gx, y1: gy, x2: gx + (group.width ?? 2), y2: gy + (group.height ?? 2) }
  })
  const allText = textOf((group.items ?? []).flatMap((x) => (Array.isArray((x as SceneGroup).items) ? (x as SceneGroup).items as SceneItem[] : [x as SceneItem])))
  if (role === 'title') {
    const label = group.description ? String(group.description) : allText ?? 'Title'
    return {
      id, kind: 'title', marktype: 'group', role: 'heading', roleDescription: 'title',
      label, x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1,
    }
  }
  const datum = ((group.items?.[0] as SceneItem | undefined)?.datum ?? {}) as Record<string, unknown>
  // (the caption quotes the title as drawn, like the SVG's: a title replaced by the guide's encode is the replacement)
  const title = guideTitleText(group as { title?: string; items?: unknown[] }) ?? (typeof datum.title === 'string' ? datum.title : undefined)
  if (role === 'axis') {
    const orient = String(datum.orient ?? (group as unknown as { orient?: string }).orient ?? 'x')
    const scaleName = typeof datum.scale === 'string'
      ? datum.scale
      : typeof (group as unknown as { scale?: string }).scale === 'string'
        ? (group as unknown as { scale?: string }).scale
        : undefined
    const gm = group as unknown as { format?: unknown; formatType?: unknown }
    // (a caption vega cannot make -- the scale's label format refuses the axis's format -- leaves the node its role's name)
    const label = group.description ? String(group.description) : axisLabel({ orient, title, scale: scaleName, format: gm.format, formatType: gm.formatType }, scales, locale) ?? 'axis'
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
  const gm = group as unknown as { legendType?: string; legendScale?: string; legendChannels?: string[]; legendFormat?: unknown; legendFormatType?: unknown }
  const label = group.description ? String(group.description) : legendLabel({ ...gm, title }, scales, typeof datum.type === 'string' ? datum.type : 'symbol', locale) ?? 'legend'
  return {
    id, kind: 'legend', marktype: 'group', role: 'graphics-symbol', roleDescription: 'legend',
    label, x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1,
  }
}

function legendEntryNodes(
  group: SceneGroup,
  guideId: string,
  tx: number,
  ty: number,
  options: A11yOptions,
  limit: number,
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
      if (text && out.length < limit) {
        const value = String(text.it.text)
        const key = `${gm.legendScale ?? 'legend'}:${value}`
        const b = union(leaves.map((l) => itemBounds(l.it, l.x, l.y, 'leaf'))) ?? { x1: nx, y1: ny, x2: nx + 2, y2: ny + 2 }
        const fill = typeof symbol?.it.fill === 'string' && symbol.it.fill !== 'transparent' ? symbol.it.fill : undefined
        const stroke = typeof symbol?.it.stroke === 'string' ? symbol.it.stroke : undefined
        out.push({
          id: `${guideId}-entry-${seq++}`,
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
        if (!isTitle && symbol && out.length < limit) {
          const value = String(it.text)
          const key = `${gm.legendScale ?? 'legend'}:${value}`
          const fill = typeof symbol.it.fill === 'string' && symbol.it.fill !== 'transparent' ? symbol.it.fill : undefined
          const stroke = typeof symbol.it.stroke === 'string' ? symbol.it.stroke : undefined
          const b = union([itemBounds(symbol.it, symbol.x, symbol.y, 'leaf'), itemBounds(it, leaf.x, leaf.y, 'leaf')]) ?? { x1: leaf.x, y1: leaf.y, x2: leaf.x + 2, y2: leaf.y + 2 }
          out.push({
            id: `${guideId}-entry-${seq++}`, kind: 'legend-entry', marktype: 'group', role: 'button',
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

/**
 * Build the access tree for an evaluated scene. No DOM is required, so the
 * same tree can be serialized during SSR and re-used for hydration.
 */
export function buildA11yTree(
  scene: SceneRoot,
  scales: Map<string, unknown> = new Map(),
  options: A11yOptions = {},
): A11yTree {
  // (a text's box is measured with the measurer the scene was laid out with, as the hit index measures it: scene-output.ts)
  return withSceneOutput(scene, () => treeOf(scene, scales, options))
}

function treeOf(scene: SceneRoot, scales: Map<string, unknown>, options: A11yOptions): A11yTree {
  const threshold = Math.max(1, Math.floor(options.summaryThreshold ?? 150))
  reading = scene
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
  // the bound (module comment): over the threshold in all, every mark is one summary node; at most `threshold` mark nodes, the
  // marks past them folded into one last summary
  const summarise = total > threshold
  let markNodes = 0
  const rest: { count: number; marks: number; box: Bounds | null } = { count: 0, marks: 0, box: null }
  const walk = (node: SceneNode, tx: number, ty: number, scopeScales: Map<string, unknown>): void => {
    const group = node as SceneGroup
    // (where the renderers draw the group's content: a group item's position is the value its encode wrote, see `drawnOffset`)
    const [ox, oy] = drawnOffset(group)
    const gx = tx + ox
    const gy = ty + oy
    const role = group.role
    if (role === 'axis' || role === 'legend' || role === 'title') {
      const n = guideNode(group, `guide-${seq++}`, tx, ty, scopeScales, scene.__locale)
      if (n) nodes.push(n)
      if (role === 'legend' && n) pushAll(nodes, legendEntryNodes(group, n.id, tx, ty, options, threshold))
      return
    }
    const kids = group.items
    if (!Array.isArray(kids)) return
    const local = group.__scales ? new Map([...scopeScales, ...scalesFromSnapshots(group.__scales, scene.__locale)]) : scopeScales
    const marktype = group.marktype
    // vega-scenegraph: `aria: false` (the mark's, or a group item's own) puts `aria-hidden` on the element, which hides
    // everything inside it; a group item that carries a `description` is described by its own role and role description
    if (group.aria === false || group.itemAria?.aria === false) return
    const own = group.itemAria
    // (a described group item is a node like a mark's, under the same bound: facet cells are as many as the data makes)
    if (own && own.description != null && markNodes < threshold) {
      markNodes++
      const w = Math.max(2, group.width ?? 0)
      const h = Math.max(2, group.height ?? 0)
      nodes.push({
        id: `group-${seq++}`, kind: 'group', marktype: 'group',
        role: own.ariaRole || 'graphics-object',
        roleDescription: String(own.ariaRoleDescription || 'group mark'),
        label: String(own.description),
        x: gx, y: gy, width: w, height: h,
      })
    }
    if (role === 'mark' && marktype && marktype !== 'group') {
      // (the items a pass stopped at were never measured, nor drawn: none takes the pointer, none is a node -- as the hit index)
      const from = group.unmeasuredFrom
      const items = from === undefined ? kids as SceneItem[] : (kids as SceneItem[]).slice(0, from)
      const markId = `mark-${seq++}`
      if (summarise || items.length > threshold || markNodes + items.length > threshold) {
        const b = summaryBox(group, items, gx, gy)
        if (markNodes >= threshold) {
          // (past the bound: folded into the one last summary)
          rest.count += items.length
          rest.marks++
          rest.box = rest.box === null ? b : union([rest.box, b])
          return
        }
        markNodes++
        nodes.push({
          id: markId, kind: 'mark', marktype, role: 'graphics-symbol',
          roleDescription: `${marktype} mark container`,
          label: group.description ?? `${marktype} mark with ${items.length} items`,
          x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1, count: items.length,
        })
      } else {
        const ids = markIds(markId, items)
        for (let i = 0; i < items.length; i++) {
          const n = markNode(items[i]!, group, ids[i]!, gx, gy, options)
          if (n) { nodes.push(n); markNodes++ }
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
  const rootScales = scales.size ? scales : scene.__scales ? scalesFromSnapshots(scene.__scales, scene.__locale) : scales
  // where the root group is in the viewport: inside the padding, at the frame's offset (the origin the scene's items are in)
  const originX = (scene.padding?.left ?? 0) + (scene.frameX ?? 0)
  const originY = (scene.padding?.top ?? 0) + (scene.frameY ?? 0)
  // the root group item is an item like any group's: `aria: false` hides everything, a description makes it a node of its own
  const frame = scene.frameAria
  if (frame?.aria !== false) {
    if (frame && frame.description != null) {
      nodes.push({
        id: `group-${seq++}`, kind: 'group', marktype: 'group',
        role: frame.ariaRole || 'graphics-object',
        roleDescription: String(frame.ariaRoleDescription || 'group mark'),
        label: String(frame.description),
        x: originX, y: originY, width: Math.max(2, scene.plotWidth ?? scene.width), height: Math.max(2, scene.plotHeight ?? scene.height),
      })
    }
    for (const n of scene.items) walk(n, originX, originY, rootScales)
  }
  if (rest.marks > 0) {
    const b = rest.box ?? { x1: originX, y1: originY, x2: originX + 2, y2: originY + 2 }
    nodes.push({
      id: 'mark-rest', kind: 'mark', marktype: 'group', role: 'graphics-symbol', roleDescription: 'mark containers',
      label: `${rest.marks} more marks with ${rest.count} items`,
      x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1, count: rest.count,
    })
  }

  const summary = total > threshold ? `${total} marks in this chart. Zoom in or filter the data to explore individual marks.` : undefined
  return {
    // (vega-view writes the spec's `description` as the container's aria-label)
    label: options.label ?? scene.description ?? 'Vega visualization',
    description: options.description,
    nodes,
    summary,
    totalItems: total,
  }
}
