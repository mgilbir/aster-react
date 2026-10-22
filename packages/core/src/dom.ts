/**
 * DOM scene renderer + patcher: the incremental update path aster was
 * missing. Instead of re-serializing + re-parsing the whole SVG string on
 * every data update (which makes the browser rebuild the entire node tree),
 * `patchSceneDom` walks the existing DOM and writes only the attributes that
 * actually changed — the same strategy vega-scenegraph's SVG renderer uses.
 *
 * Descriptors are built from the shared geometry helpers in render.ts, so the
 * string renderer and this DOM renderer can never drift visually: both call
 * the exact same code to produce each `d`, each formatted number.
 */
import { SYMBOL_DEFAULT_SIZE } from './util.js'
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'
import { ClipCollector } from './svg-defs.js'
import {
  arcPath,
  computeAreaPath,
  computeLinePath,
  frameBackgroundPath,
  frameItem,
  num,
  imageDesc,
  paintAttrs,
  pathVectorEffect,
  rectItemPath,
  rotateItemTransform,
  transformItemTransform,
  samePaint,
  symbolPath,
  textItemDesc,
  trailPath,
} from './render.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

export interface DomDesc {
  tag: string
  attrs: Array<[string, string]>
  text?: string
  children?: DomDesc[]
  /** @internal True when the underlying scene item was not touched this eval, so
   * the patcher can skip this subtree (its DOM already reflects it). */
  clean?: boolean
  /** @internal True for a mark container whose children are batched paths; the
   * patcher rebuilds the container when switching between per-item and batched. */
  dense?: boolean
}

const str = (v: string | number | undefined): string => (typeof v === 'number' ? num(v) : String(v))

/**
 * Translate every absolute coordinate in an SVG path by (dx, dy). Relative
 * commands are deltas and need no change. Used by the dense-mark batcher to
 * bake a symbol's position into its `d` instead of emitting a per-item
 * `transform` (Chrome makes transformed SVG nodes ~3x more expensive to
 * mutate: 145ms vs 45ms per append in a 100k-node scene).
 */
function round3(v: number): string {
  const r = Math.round(v * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}

/** True for a letter (SVG path command); numbers never start with one. */
function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57
}

/**
 * Translate every absolute coordinate in an SVG path by (dx, dy). Relative
 * commands are deltas and need no change, and arguments that do not move
 * (arc radii/flags, relative deltas) are copied verbatim instead of being
 * parsed and reformatted — a 100k-symbol dense mount spends ~170ms here, so
 * this is a hand-written scanner rather than a regex tokenizer.
 */
export function translatePathData(d: string, dx: number, dy: number): string {
  if (!d || (dx === 0 && dy === 0)) return d
  let out = ''
  let cmd = '' // current command letter ('' before the first one)
  let argi = 0
  let afterCommand = true
  const n = d.length
  let i = 0
  while (i < n) {
    const c = d.charCodeAt(i)
    if (isLetter(c)) {
      cmd = d[i]!
      argi = 0
      afterCommand = true
      out += cmd
      i++
      continue
    }
    if (c === 44 || c === 32 || c === 9 || c === 10 || c === 13) { i++; continue } // , space 	 
 
    // A number token: [+-]? digits ('.' digits)? ([eE][+-]?digits)?
    const start = i
    if (c === 45 || c === 43) i++
    while (i < n && (isDigit(d.charCodeAt(i)) || d.charCodeAt(i) === 46)) i++
    if (i < n && (d.charCodeAt(i) === 101 || d.charCodeAt(i) === 69)) {
      i++
      if (i < n && (d.charCodeAt(i) === 43 || d.charCodeAt(i) === 45)) i++
      while (i < n && isDigit(d.charCodeAt(i))) i++
    }
    const relative = cmd !== '' && cmd === cmd.toLowerCase()
    // Which argument of which command moves?
    let moves = false
    let axisX = true
    if (!relative) {
      switch (cmd) {
        case 'A':
          // rx ry rotation large-arc sweep x y — only the endpoint moves.
          if (argi === 5) moves = true
          else if (argi === 6) { moves = true; axisX = false }
          break
        case 'H':
          if (argi === 0) moves = true
          break
        case 'V':
          if (argi === 0) { moves = true; axisX = false }
          break
        default:
          moves = true
          if (argi % 2 === 1) axisX = false
      }
    }
    if (moves) {
      const v = Number(d.slice(start, i))
      out += (afterCommand ? '' : ',') + round3(axisX ? v + dx : v + dy)
    } else {
      out += (afterCommand ? '' : ',') + d.slice(start, i)
    }
    afterCommand = false
    argi++
  }
  return out
}

/** Opt-in DOM rendering options. */
export interface DomRenderOptions {
  /**
   * Batch dense symbol marks into chunked `<path>` elements instead of one
   * element per datum. Pixels are unchanged (positions are baked into `d`), but
   * the DOM intentionally stops mirroring Vega's per-item structure: 100k
   * symbols become a few hundred paths, which is what keeps large SVG streams
   * inside the frame budget. Tooltips and hit-testing resolve through the scene
   * hit index (`@aster/core/hit`), and per-mark `data-datum`/signal bindings are
   * not emitted.
   */
  denseMarks?: boolean
  /** Maximum items per batched path (default 256). */
  denseChunkSize?: number
}

const DENSE_SYMBOL_MIN = 512
const DENSE_SYMBOL_CHUNK = 256

interface DenseChunk { from: number; to: number; first: SceneItem; desc: DomDesc }
interface DenseCache { items: SceneItem[]; chunkSize: number; chunks: Map<number, DenseChunk> }
// Keyed by scene group: the runtime reuses the group (and its items array) for
// incremental updates, so unchanged chunks keep their descriptor and their DOM.
// Keyed by the items ARRAY, not the group: an incremental update hands the same
// (in-place advanced) array to a NEW group object, so a group key would miss
// every frame and rebuild every descriptor.
const DENSE = new WeakMap<SceneItem[], DenseCache>()

function batchableSymbol(it: SceneItem): boolean {
  const x = it.x
  const y = it.y
  // Translucent marks cannot batch: one path composites once where per-item
  // elements composite each overlap, so alpha would visibly change.
  const rec = it as Record<string, unknown>
  const opaque = (it.opacity == null || it.opacity === 1)
    && (it.fillOpacity == null || it.fillOpacity === 1)
    && (it.strokeOpacity == null || it.strokeOpacity === 1)
    && rec.blend == null
  return opaque
    && x != null && y != null && Number.isFinite(x) && Number.isFinite(y)
    && Number.isFinite(Math.sqrt((it.size as number) ?? SYMBOL_DEFAULT_SIZE) / 2)
}

function sameSymbolPaint(a: SceneItem, b: SceneItem): boolean {
  return samePaint(a, b)
}

function symbolAttrs(it: SceneItem): Array<[string, string]> {
  return props(paintAttrs(it))
}

/**
 * Chunk consecutive same-paint symbols into one `<path>` each. Chunks are
 * bounded (so an append only re-serializes the last one) and cached per scene
 * group, so a streamed append rebuilds a single ~256-item path string instead
 * of every descriptor in the mark.
 */
function denseSymbolItems(group: SceneGroup, items: SceneItem[], chunkSize: number): DomDesc[] {
  const prev = DENSE.get(items)
  const cachedChunks = prev && prev.items === items && prev.chunkSize === chunkSize ? prev.chunks : null
  const chunks = new Map<number, DenseChunk>()
  const out: DomDesc[] = []
  let i = 0
  while (i < items.length) {
    const first = items[i]!
    if (!batchableSymbol(first)) {
      // Translucent or degenerate items keep their own element (batching would
      // change overlap compositing); never drop them.
      if (first.x != null && first.y != null) out.push(symbolItemDesc(first))
      i++
      continue
    }
    const angle = (first as Record<string, unknown>).angle as number | undefined
    if (angle != null && angle !== 0) {
      out.push(symbolItemDesc(first))
      i++
      continue
    }
    const from = i
    let to = i + 1
    while (to < items.length && to - from < chunkSize) {
      const cand = items[to]!
      if (!batchableSymbol(cand) || !sameSymbolPaint(first, cand)) break
      // Rotated symbols keep their own element (a baked `d` cannot rotate).
      const candAngle = (cand as Record<string, unknown>).angle as number | undefined
      if (candAngle != null && candAngle !== 0) break
      to++
    }
    const cached = cachedChunks?.get(from)
    if (cached && cached.to === to && cached.first === first) {
      let clean = true
      for (let j = from; j < to; j++) {
        if (!isClean(items[j]!)) { clean = false; break }
      }
      if (clean) {
        cached.desc.clean = true
        chunks.set(from, cached)
        out.push(cached.desc)
        i = to
        continue
      }
    }
    let d = ''
    for (let j = from; j < to; j++) {
      const it = items[j]!
      if (!batchableSymbol(it)) continue
      const r = Math.sqrt((it.size as number) ?? SYMBOL_DEFAULT_SIZE) / 2
      d += translatePathData(
        symbolPath((it as Record<string, unknown>).shape as string | undefined, r),
        it.x as number,
        it.y as number,
      )
    }
    // A fresh desc object (never mutate a cached one): the patcher compares
    // against the previous descriptor, so reusing the object would hide the write.
    const desc: DomDesc = { tag: 'path', attrs: [['d', d], ...symbolAttrs(first)] }
    const chunk: DenseChunk = { from, to, first, desc }
    chunks.set(from, chunk)
    out.push(desc)
    i = to
  }
  DENSE.set(items, { items, chunkSize, chunks })
  return out
}

function symbolItemDesc(it: SceneItem): DomDesc {
  return cachedDesc(it, () => {
    const size = (it.size as number) ?? SYMBOL_DEFAULT_SIZE
    const r = Math.sqrt(size) / 2
    const angle = (it as Record<string, unknown>).angle as number | undefined
    return {
      tag: 'path',
      attrs: [
        ['transform', `translate(${num(it.x || 0)},${num(it.y || 0)})${angle ? ` rotate(${num(angle)})` : ''}`],
        ['d', symbolPath((it as Record<string, unknown>).shape as string | undefined, r)],
        ...symbolAttrs(it),
      ],
      clean: isClean(it),
    }
  })
}

interface SymbolItemsCache { items: SceneItem[]; keys: SceneItem[]; descs: DomDesc[] }
// Per-group; the runtime mutates the items array in place for incremental
// updates, so an unchanged item keeps its descriptor without rebuilding the
// 100k-entry array on every append.
const SYMBOL_ITEMS = new WeakMap<SceneItem[], SymbolItemsCache>()

function symbolItems(group: SceneGroup, items: SceneItem[]): DomDesc[] {
  const prev = SYMBOL_ITEMS.get(items)
  const reuse = prev && prev.items === items ? prev : null
  const keys = reuse ? reuse.keys : []
  const descs = reuse ? reuse.descs : []
  let n = 0
  for (const it of items) {
    if (it.x == null || it.y == null) continue
    if (keys[n] === it && descs[n] != null) {
      if (isClean(it)) descs[n]!.clean = true
      else { keys[n] = it; descs[n] = symbolItemDesc(it) }
    } else {
      keys[n] = it
      descs[n] = symbolItemDesc(it)
    }
    n++
  }
  keys.length = n
  descs.length = n
  SYMBOL_ITEMS.set(items, { items, keys, descs })
  // The patcher compares against the previous descriptor *array*, so return a
  // snapshot: exposing the cached array would mean a later in-place append
  // mutates the patcher's "previous" state and every child gets re-walked.
  return descs.slice()
}

/**
 * True when a scene has a symbol mark large enough for `denseMarks` batching.
 * `<Chart>` uses this to decide whether hit-testing must go through the scene
 * index (batched marks carry no per-item `data-datum`).
 */
export function hasDenseSymbolMarks(scene: SceneRoot, minItems = DENSE_SYMBOL_MIN): boolean {
  const walk = (group: SceneGroup): boolean => {
    if (group.marktype === 'symbol' && (group.items?.length ?? 0) >= minItems) return true
    for (const item of group.items ?? []) {
      const kids = (item as SceneGroup).items
      if (Array.isArray(kids) && walk(item as SceneGroup)) return true
    }
    return false
  }
  return (scene.items ?? []).some((group) => walk(group))
}

function denseSymbolsEnabled(options: DomRenderOptions | undefined, items: SceneItem[]): number {
  if (!options?.denseMarks || items.length < DENSE_SYMBOL_MIN) return 0
  return Math.max(32, options.denseChunkSize ?? DENSE_SYMBOL_CHUNK)
}

// Differential-update generation stamped on scene items by evaluateChart. An
// item whose __gen differs from the current generation was reused (unchanged), so
// its DOM subtree can be skipped during the next patch.
let CURRENT_GEN: number | undefined
function isClean(it: SceneItem): boolean {
  return CURRENT_GEN != null && it.__gen != null && it.__gen !== CURRENT_GEN
}

/** Build (or reuse, for a clean item) the DOM descriptor for a scene item. */
function cachedDesc(it: SceneItem, build: () => DomDesc): DomDesc {
  const cached = it.__domDesc as DomDesc | undefined
  if (isClean(it) && cached) {
    // Reuse the cached descriptor in place: the patcher compares it against
    // itself (all attributes equal, nothing written) and the clean flag lets
    // it skip the subtree. Mutating the flag is safe — a dirty item always
    // rebuilds and overwrites __domDesc below.
    cached.clean = true
    return cached
  }
  const desc = build()
  // Tooltips/events read the datum off the DOM element; carry it on the desc so
  // the incremental patch emits the same data-datum the string renderer does.
  const datum = (it as unknown as { dataDatum?: string }).dataDatum
  if (datum != null) desc.attrs.push(['data-datum', datum])
  it.__domDesc = desc
  return desc
}

/** Attribute pairs for presentation props, mirroring `attr()` semantics (null = absent). */
function props(pairs: Array<[string, unknown]>): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [k, v] of pairs) {
    if (v == null) continue
    // Same conventions as the string renderer's `attr`: a 'transparent' paint is
    // omitted; an invalid numeric paint renders black.
    if (v === 'transparent') continue
    if (Array.isArray(v)) out.push([k, v.join(',')])
    else if (typeof v === 'number') out.push([k, k === 'fill' || k === 'stroke' ? 'rgb(0, 0, 0)' : num(v)])
    else out.push([k, String(v)])
  }
  return out
}

function g(tag: string, attrs: Array<[string, string]>, children: DomDesc[]): DomDesc {
  return { tag, attrs, children }
}

// ---------------------------------------------------------------------------
// Scene -> descriptor tree (mirrors renderSceneToSvg structure exactly)
// ---------------------------------------------------------------------------

function leafDesc(it: SceneItem): DomDesc {
  if (it.path != null) {
    const tx = num(it.x || 0)
    const ty = num(it.y || 0)
    const angle = (it as Record<string, unknown>).angle as number | undefined
    const attrs: Array<[string, string]> = []
    if (tx !== '0' || ty !== '0' || angle) attrs.push(['transform', `translate(${tx},${ty})${angle ? ` rotate(${num(angle)})` : ''}`])
    attrs.push(['d', String(it.path)])
    attrs.push(...props(paintAttrs(it)))
    return { tag: 'path', attrs, clean: isClean(it) }
  }
  if (it.shape != null && it.radius != null) {
    const rNum = num(it.radius)
    const d = `M${rNum},0A${rNum},${rNum},0,1,1,${-rNum},0A${rNum},${rNum},0,1,1,${rNum},0`
    const angle = (it as Record<string, unknown>).angle as number | undefined
    return {
      tag: 'path',
      attrs: [
        ['transform', `translate(${num(it.x || 0)},${num(it.y || 0)})${angle ? ` rotate(${num(angle)})` : ''}`],
        ['d', d],
        ...props(paintAttrs(it)),
      ],
      clean: isClean(it),
    }
  }
  if (it.text != null) {
    // Guide labels share the text mark's descriptor (renderer's `textElement`).
    const d = textDesc(it)
    if (d) return d
  }
  const x2 = it.x2 ?? it.x ?? 0
  const y2 = it.y2 ?? it.y ?? 0
  return {
    tag: 'line',
    attrs: [
      ['x1', num(it.x || 0)],
      ['y1', num(it.y || 0)],
      ['x2', num(x2)],
      ['y2', num(y2)],
      ...props(paintAttrs(it)),
    ],
    clean: isClean(it),
  }
}

/** Text descriptor mirroring the renderer's `textElement` (transform, anchor, fonts, paint, tspans). */
function textDesc(it: SceneItem, cache = false): DomDesc | null {
  const d = textItemDesc(it)
  if (d == null) return null
  const attrs: Array<[string, string]> = [['transform', d.transform], ...props(d.attrs)]
  const build = (): DomDesc => d.lines.length === 1
    ? { tag: 'text', attrs, text: d.text, clean: isClean(it) }
    : {
        tag: 'text',
        attrs,
        clean: isClean(it),
        children: d.lines.map((line, i) => ({
          tag: 'tspan',
          attrs: i === 0 ? [] : ([['x', '0'], ['dy', num(d.lineHeight)]] as Array<[string, string]>),
          text: line,
        })),
      }
  return cache ? cachedDesc(it, build) : build()
}

function markItems(group: SceneGroup, type: string, options?: DomRenderOptions): DomDesc[] {
  const items = group.items ?? []
  switch (type) {
    case 'line': {
      const info = computeLinePath(group)
      if (!info) return []
      return [{
        tag: 'path',
        attrs: [
          ['d', info.path],
          // Every paint attribute (line marks CAN carry a fill: closed
          // polygons, radar charts) — vega renders it, so the patcher must too.
          ...props(info.paint),
        ],
      }]
    }
    case 'area': {
      const info = computeAreaPath(group)
      if (!info) return []
      return [{
        tag: 'path',
        attrs: [
          ['d', info.path],
          ...props(info.paint),
        ],
      }]
    }
    case 'trail': {
      if (items.length <= 1) return []
      const d = trailPath(items)
      if (!d) return []
      const first = items[0]!
      return [{
        tag: 'path',
        attrs: [['d', d], ...props(paintAttrs(first))],
      }]
    }
    case 'symbol': {
      const chunkSize = denseSymbolsEnabled(options, items)
      if (chunkSize > 0) return denseSymbolItems(group, items, chunkSize)
      return symbolItems(group, items)
    }
    case 'rect':
      // vega paints a rect only when it has a fill or stroke, in item order.
      return ((): DomDesc[] => {
        const out: DomDesc[] = []
        for (let i = 0; i < items.length; i++) {
          const it = items[i]!
          if (it.fill == null && it.stroke == null) continue
          const d = rectItemPath(it)
          if (d == null) continue
          const attrs: Array<[string, string]> = [
            ['d', d],
            ...props(paintAttrs(it)),
          ]
          out.push(cachedDesc(it, () => ({ tag: 'path', attrs, clean: isClean(it) })))
        }
        return out
      })()
    case 'circle':
      return items
        .filter((it) => it.x != null && it.y != null)
        .map((it) => {
          const r = it.radius != null ? it.radius : Math.sqrt((it.size as number) ?? SYMBOL_DEFAULT_SIZE) / 2
          return cachedDesc(it, () => ({
            tag: 'circle',
            attrs: [
              ['cx', num(it.x || 0)],
              ['cy', num(it.y || 0)],
              ['r', num(r)],
              ...props(paintAttrs(it)),
            ],
            clean: isClean(it),
          }))
        })
    case 'rule':
      return items.map((it) => {
        const x = it.x ?? 0
        const y = it.y ?? 0
        return cachedDesc(it, () => ({
          tag: 'line',
          attrs: [
            ['x1', num(x)],
            ['y1', num(y)],
            ['x2', num(it.x2 ?? x)],
            ['y2', num(it.y2 ?? y)],
            ...props(paintAttrs(it)),
          ],
          clean: isClean(it),
        }))
      })
    case 'text':
      return items
        .map((it) => textDesc(it, true))
        .filter((d): d is NonNullable<typeof d> => d != null)
    case 'path':
    case 'shape':
    case 'geoshape':
      return items
        .filter((it) => it.path != null)
        .map((it) => {
          const attrs: Array<[string, string]> = []
          // same attribute list as the string renderer's renderPaths
          if (pathVectorEffect(it)) attrs.push(['vector-effect', 'non-scaling-stroke'])
          attrs.push(['transform', transformItemTransform(it)])
          attrs.push(['d', String(it.path)])
          attrs.push(...props(paintAttrs(it)))
          return cachedDesc(it, () => ({ tag: 'path', attrs, clean: isClean(it) }))
        })
    case 'image':
      return items
        .filter((it) => it.url != null && it.x != null && it.y != null)
        .map((it) => cachedDesc(it, () => {
          const d = imageDesc(it)
          return {
            tag: 'image',
            attrs: [
              ['xlink:href', String(it.url)],
              ['transform', `translate(${num(d.x)},${num(d.y)})`],
              ['width', num(d.w)],
              ['height', num(d.h)],
              ['preserveAspectRatio', it.aspect === false ? 'none' : 'xMidYMid'],
              ...props(paintAttrs(it, undefined, d.smooth ? undefined : ['image-rendering: optimizeSpeed;', 'image-rendering: pixelated;'])),
            ],
            clean: isClean(it),
          }
        }))
    case 'arc':
      return items.map((it) => {
        const r = (it.outerRadius as number) ?? (it.radius as number) ?? 0
        const r0 = (it.innerRadius as number) ?? 0
        const a0 = (it.startAngle as number) ?? 0
        const a1 = (it.endAngle as number) ?? 0
        // Mirror renderArcs exactly: the arc path is generated around (0,0)
        // with a per-item translate — baking the center into `d` (or omitting
        // the translate) places the arcs at the svg origin.
        const cr = (it as Record<string, unknown>).cornerRadius as number | undefined ?? 0
        const pa = (it as Record<string, unknown>).padAngle as number | undefined ?? 0
        return cachedDesc(it, () => ({
          tag: 'path',
          attrs: [
            ['transform', rotateItemTransform(it)],
            ['d', arcPath(0, 0, r, r0, a0, a1, cr, pa)],
            ...props(paintAttrs(it)),
          ],
          clean: isClean(it),
        }))
      })
    default:
      return []
  }
}

function markContainer(tag: string): Array<[string, string]> {
  switch (tag) {
    case 'line': return [['class', 'mark-line role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'line mark container']]
    case 'area': return [['class', 'mark-area role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'area mark container']]
    case 'trail': return [['class', 'mark-trail role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'trail mark container']]
    case 'symbol': return [['class', 'mark-symbol role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'symbol mark container']]
    case 'rect': return [['class', 'mark-rect role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'rect mark container']]
    case 'circle': return [['class', 'mark-circle role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'circle mark container']]
    case 'rule': return [['class', 'mark-rule role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'rule mark container']]
    case 'text': return [['class', 'mark-text role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'text mark container']]
    case 'path':
    case 'shape':
    case 'geoshape': return [['class', 'mark-path role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'path mark container']]
    case 'image': return [['class', 'mark-image role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'image mark container']]
    case 'arc': return [['class', 'mark-arc role-mark']]
    default: return []
  }
}

function groupDesc(group: SceneGroup, plotW: number, plotH: number, clips: ClipCollector, options?: DomRenderOptions): DomDesc | null {
  const type = group.marktype
  const needsClip = group.clip === true
  if (!type || type === 'group') {
    const attrs: Array<[string, string]> = [['class', 'mark-group']]
    if (group.role) attrs.push(['role', group.role])
    const gw = group.width ?? plotW
    const gh = group.height ?? plotH
    if (needsClip) {
      attrs.push(['clip-path', `url(#${clips.id(group.clipPathD ? { d: group.clipPathD } : { x: 0, y: 0, w: gw, h: gh })})`])
    }
    if (group.x != null || group.y != null) attrs.push(['transform', `translate(${num(group.x ?? 0)},${num(group.y ?? 0)})`])
    const children: DomDesc[] = []
    for (const item of group.items ?? []) {
      const isGroup = (item as SceneGroup).marktype !== undefined || Array.isArray((item as SceneGroup).items)
      let d = isGroup ? groupDesc(item as SceneGroup, gw, gh, clips, options) : cachedDesc(item, () => leafDesc(item))
      // a clipped legend symbol hangs its clip-path on a `<g>` around the symbol
      // (the renderer's renderLeaf), never on the translated path itself. The
      // clip is registered here, outside the item's cached descriptor, so a
      // reused descriptor still lands its clipPath in this render's defs.
      const clip = !isGroup && (item as SceneItem).path != null
        ? (item as unknown as Record<string, unknown>)._clip as { x?: number; y?: number; w: number; h: number } | undefined
        : undefined
      if (d && clip) {
        d = g('g', [['clip-path', `url(#${clips.id({ x: clip.x ?? 0, y: clip.y ?? 0, w: clip.w, h: clip.h })})`]], [d])
      }
      if (d) children.push(d)
    }
    return g('g', attrs, children)
  }

  const inner = g('g', markContainer(type), markItems(group, type, options))
  if (type === 'symbol' && denseSymbolsEnabled(options, group.items ?? []) > 0) inner.dense = true
  if (needsClip) {
    return g('g', [['clip-path', `url(#${clips.id(group.clipPathD ? { d: group.clipPathD } : { x: 0, y: 0, w: plotW, h: plotH })})`]], [inner])
  }
  return inner
}

export function sceneToDomDesc(scene: SceneRoot, options: DomRenderOptions = {}): DomDesc {
  CURRENT_GEN = (scene as unknown as { __itemGen?: number }).__itemGen
  const W = scene.width
  const H = scene.height
  const pad = scene.padding ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const plotW = scene.plotWidth ?? scene.width - pad.left - pad.right
  const plotH = scene.plotHeight ?? scene.height - pad.top - pad.bottom
  const clips = new ClipCollector()
  const frameClipId = scene.frameClip ? clips.id({ x: 0, y: 0, w: plotW, h: plotH }) : null

  const frameD = frameBackgroundPath(scene, plotW, plotH)
  const children: DomDesc[] = []
  if (scene.background) {
    children.push({ tag: 'rect', attrs: [['width', str(W)], ['height', str(H)], ['fill', String(scene.background)]] })
  }
  children.push(g('g', [['fill', 'none'], ['stroke-miterlimit', '4'], ['transform', `translate(${pad.left},${pad.top})`]], [
    g('g', [
      ['class', 'mark-group role-frame root'],
      ['role', 'graphics-object'],
      ['aria-roledescription', 'group mark container'],
    ], [
      g('g', [['transform', 'translate(0,0)']], [
        { tag: 'path', attrs: [['class', 'background'], ['aria-hidden', 'true'], ['d', frameD], ...props(paintAttrs(frameItem(scene)))] },
        g('g', frameClipId ? [['clip-path', `url(#${frameClipId})`]] : [], (scene.items ?? []).map((n) => groupDesc(n, plotW, plotH, clips, options)).filter((x): x is DomDesc => x != null)),
        { tag: 'path', attrs: [['class', 'foreground'], ['aria-hidden', 'true'], ['d', ''], ['display', 'none']] },
      ]),
    ]),
  ]))

  if (scene.defs?.length || clips.size > 0) {
    const defsChildren: DomDesc[] = []
    for (const def of scene.defs ?? []) {
      defsChildren.push({
        tag: 'linearGradient',
        attrs: [['id', def.id], ['x1', '0'], ['x2', '0'], ['y1', '1'], ['y2', '0']],
        children: def.colorStops.map((s) => ({ tag: 'stop', attrs: [['offset', str(s.offset)], ['stop-color', s.color]] })),
      })
    }
    for (const [id, def] of clips.defs) {
      defsChildren.push({
        tag: 'clipPath',
        attrs: [['id', id]],
        children: [
          'd' in def
            ? { tag: 'path', attrs: [['d', def.d]] }
            : { tag: 'rect', attrs: [['x', str(def.x)], ['y', str(def.y)], ['width', str(def.w)], ['height', str(def.h)]] },
        ],
      })
    }
    children.push(g('defs', [], defsChildren))
  }

  return {
    tag: 'svg',
    attrs: [
      ['xmlns', SVG_NS],
      ['xmlns:xlink', 'http://www.w3.org/1999/xlink'],
      ['version', '1.1'],
      ['class', 'marks'],
      ['width', str(W)],
      ['height', str(H)],
      ['viewBox', `0 0 ${W} ${H}`],
    ],
    children,
  }
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

function createEl(desc: DomDesc, doc: Document): Element {
  const el = doc.createElementNS(SVG_NS, desc.tag)
  for (const [k, v] of desc.attrs) {
    if (k === 'xlink:href') el.setAttributeNS(XLINK_NS, 'xlink:href', v)
    else el.setAttribute(k, v)
  }
  if (desc.text !== undefined) el.textContent = desc.text
  else for (const c of desc.children ?? []) el.appendChild(createEl(c, doc))
  LAST.set(el, desc)
  return el
}

/**
 * Descriptor of the last patch applied to each element. Steady-state updates
 * compare against this (pure JS string compares) instead of reading the DOM —
 * ~8k getAttribute + NamedNodeMap walks per large chart avoided.
 */
const LAST = new WeakMap<Element, DomDesc>()

function writeAttr(el: Element, k: string, v: string): void {
  if (k === 'xlink:href') el.setAttributeNS(XLINK_NS, 'xlink:href', v)
  else el.setAttribute(k, v)
}

function sameAttrNames(a: Array<[string, string]>, b: Array<[string, string]>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i]![0] !== b[i]![0]) return false
  return true
}

/** Generic path: reconcile attributes against whatever is in the DOM now. */
function syncAttrsFromDom(el: Element, desc: DomDesc): void {
  const keep = new Set<string>()
  for (const [k, v] of desc.attrs) {
    keep.add(k)
    const cur = k === 'xlink:href' ? el.getAttributeNS(XLINK_NS, 'xlink:href') : el.getAttribute(k)
    if (cur !== v) writeAttr(el, k, v)
  }
  for (let i = el.attributes.length - 1; i >= 0; i--) {
    const a = el.attributes.item(i)!
    if (keep.has(a.name) || a.name === 'xmlns' || a.name === 'xmlns:xlink') continue
    if (a.name === 'xlink:href') el.removeAttributeNS(XLINK_NS, 'xlink:href')
    else el.removeAttribute(a.name)
  }
}

function patchEl(el: Element, desc: DomDesc): void {
  const last = LAST.get(el)
  LAST.set(el, desc)

  // DOM-subtree skip: a desc node whose scene item was reused (unchanged this
  // eval) is identical to the previous patch, so the element already matches and
  // we can avoid descending into it entirely.
  if (desc.clean && last) return

  // Switching a mark container between per-item elements and batched paths is a
  // structural change: rebuilding the (few hundred) chunk elements is much
  // cheaper than diffing it against tens of thousands of per-item nodes.
  if (desc.dense === true && (last == null || last.dense !== true) && desc.children) {
    el.replaceChildren(...desc.children.map((c) => createEl(c, el.ownerDocument)))
    return
  }

  // Attributes: fast path compares against the cached descriptor.
  if (last && sameAttrNames(last.attrs, desc.attrs)) {
    for (let i = 0; i < desc.attrs.length; i++) {
      const n = desc.attrs[i]!
      if (n[1] !== last.attrs[i]![1]) writeAttr(el, n[0], n[1])
    }
  } else {
    syncAttrsFromDom(el, desc)
  }

  if (desc.text !== undefined) {
    if (last) {
      if (last.text !== desc.text) el.textContent = desc.text
    } else if (el.textContent !== desc.text) {
      el.textContent = desc.text
    }
    return
  }

  const want = desc.children ?? []
  if (last && last.text !== undefined) {
    el.textContent = ''
    for (const c of want) el.appendChild(createEl(c, el.ownerDocument))
    return
  }
  // Traverse children via sibling links, not index access: HTMLCollection
  // .item(i) is a linear scan in several DOM implementations (jsdom: ~19us per
  // access), which makes an index walk O(n^2) over a mark's children — enough
  // to dominate every large-chart update. Linked traversal is O(1) per step.
  const have = el.childElementCount
  // Append-only fast path: reused mark items keep their cached descriptors, so
  // when the previous patch's children are an exact identity prefix of the new
  // ones (and the DOM still has exactly those children) only the tail is new.
  // Without this, an append re-walks every sibling — O(n) per append, which is
  // what kept 100k-point SVG streams off the frame budget.
  const lastChildren = last?.children
  if (lastChildren != null && have === lastChildren.length && want.length > lastChildren.length) {
    let i = 0
    while (i < lastChildren.length && want[i] === lastChildren[i]) i++
    if (i === lastChildren.length) {
      for (let j = i; j < want.length; j++) el.appendChild(createEl(want[j]!, el.ownerDocument))
      return
    }
  }
  const n = Math.min(have, want.length)
  let cur = el.firstElementChild
  for (let i = 0; i < n && cur != null; i++, cur = cur.nextElementSibling) {
    const w = want[i]!
    if (cur.tagName === w.tag) patchEl(cur, w)
    else el.replaceChild(createEl(w, el.ownerDocument), cur)
  }
  // Removals (have > want) and appends (want > have) — walk the tail via links.
  if (have > want.length) {
    // Position cur at child index `want.length` (start of the tail to remove).
    let tail = el.firstElementChild
    for (let i = 0; i < want.length && tail != null; i++) tail = tail.nextElementSibling
    while (tail != null) {
      const next = tail.nextElementSibling
      el.removeChild(tail)
      tail = next
    }
  }
  for (let i = have; i < want.length; i++) el.appendChild(createEl(want[i]!, el.ownerDocument))
}

/**
 * Patch a previously-rendered (or parsed) <svg> element to match `scene`,
 * touching only changed attributes. First call vs. string-rendered DOM is
 * fine: the comparison is against live attribute values.
 */
export function patchSceneDom(svg: Element, scene: SceneRoot, options: DomRenderOptions = {}): void {
  const root = sceneToDomDesc(scene, options)
  // The root <svg> may legitimately be a different element (e.g. re-created);
  // patch assumes matching tag. Guard for callers wiring the wrong node.
  if (svg.tagName !== 'svg') throw new Error('[aster] patchSceneDom expects an <svg> element')
  patchEl(svg, root)
}

/** Build the full SVG element from a scene (mount path if you don't want the string). */
export function renderSceneToDomElement(
  scene: SceneRoot,
  doc: Document = globalThis.document,
  options: DomRenderOptions = {},
): Element {
  return createEl(sceneToDomDesc(scene, options), doc)
}
