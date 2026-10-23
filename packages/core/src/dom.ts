/**
 * DOM scene renderer + patcher: the incremental update path aster was
 * missing. Instead of re-serializing + re-parsing the whole SVG string on
 * every data update (which makes the browser rebuild the entire node tree),
 * `patchSceneDom` walks the existing DOM and writes only the attributes that
 * actually changed — the same strategy vega-scenegraph's SVG renderer uses.
 *
 * Descriptors take every element's attributes from the per-element attribute
 * lists in render.ts (`*Attrs`, written into an `AttrSink`); the string renderer
 * writes the same lists into escaped markup. There is ONE list per element, so
 * the two renderers cannot drift (audit C43, T2) - `dom-string-parity.test.ts`
 * checks it over the whole conformance corpus. The one deliberate exception is
 * `denseMarks`, which batches symbols into chunked paths.
 */
import { SYMBOL_DEFAULT_SIZE, pushAll } from './util.js'
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'
import { ClipCollector } from './svg-defs.js'
import {
  PairAttrSink,
  areaMarkAttrs,
  arcItemAttrs,
  backgroundRectAttrs,
  circleAttrs,
  clipIdAttrs,
  clipRefAttrs,
  clipShapeAttrs,
  computeAreaPath,
  computeLinePath,
  frameAttrs,
  gradientAttrs,
  groupClipId,
  imageAttrs,
  clippedRoundedRectEntries,
  isClippedRoundedRectGroup,
  leafClipId,
  leafLineEnds,
  leafPathAttrs,
  leafSymbolPath,
  lineElementAttrs,
  lineMarkAttrs,
  markContainerAttrs,
  markGroupAttrs,
  paintAttrs,
  pathItemAttrs,
  rectIsPainted,
  rectItemPath,
  rectPathAttrs,
  ruleEnds,
  samePaint,
  scenePlotSize,
  stopAttrs,
  svgRootAttrs,
  symbolElementAttrs,
  symbolMarkPath,
  symbolPath,
  textAttrs,
  trailAttrs,
  trailPath,
  viewGroupAttrs,
  itemDatumAttr,
  itemHref,
  linkAttrs,
  type AttrSink,
  num,
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

function symbolAttrs(it: SceneItem): Array<[string, string]> {
  const w = new PairAttrSink()
  paintAttrs(it, w)
  return w.out
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
      out.push(symbolItemDesc(first))
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
      if (!batchableSymbol(cand) || !samePaint(first, cand)) break
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
    const w = new PairAttrSink()
    symbolElementAttrs(it, symbolMarkPath(it), w)
    return linked(it, { tag: 'path', attrs: w.out, clean: isClean(it) })
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
    // A null position renders at the origin (like the string renderer).
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
  it.__domDesc = desc
  return desc
}

function g(tag: string, attrs: Array<[string, string]>, children: DomDesc[]): DomDesc {
  return { tag, attrs, children }
}

/** A hyperlinked item's element sits in `<a xlink:href>` (the string renderer's `linkOpen`). */
function linked(it: SceneItem, desc: DomDesc): DomDesc {
  const href = itemHref(it)
  if (href == null) return desc
  const w = new PairAttrSink()
  linkAttrs(href, w)
  return { tag: 'a', attrs: w.out, children: [desc], clean: desc.clean }
}

// ---------------------------------------------------------------------------
// Scene -> descriptor tree (mirrors renderSceneToSvg structure exactly)
// ---------------------------------------------------------------------------

type Pairs = Array<[string, string]>

/** Attribute pairs from one of render.ts's `*Attrs` lists. */
function pairs(fill: (w: AttrSink) => void): Pairs {
  const w = new PairAttrSink()
  fill(w)
  return w.out
}

const FOREGROUND: Pairs = [['class', 'foreground'], ['aria-hidden', 'true'], ['d', ''], ['display', 'none']]

function leafDesc(it: SceneItem): DomDesc {
  const w = new PairAttrSink()
  if (it.path != null) {
    leafPathAttrs(it, w)
    return { tag: 'path', attrs: w.out, clean: isClean(it) }
  }
  if (it.shape != null && it.radius != null) {
    symbolElementAttrs(it, leafSymbolPath(it), w)
    return { tag: 'path', attrs: w.out, clean: isClean(it) }
  }
  if (it.text != null) {
    const d = textDesc(it)
    if (d) return d
  }
  const [x1, y1, x2, y2] = leafLineEnds(it)
  itemDatumAttr(it, w)
  lineElementAttrs(x1, y1, x2, y2, it, w)
  return { tag: 'line', attrs: w.out, clean: isClean(it) }
}

/** A text element's descriptor (the renderer's `textElement`): attributes, then the text or one tspan per line. */
function textDesc(it: SceneItem): DomDesc | null {
  const w = new PairAttrSink()
  const d = textAttrs(it, w)
  if (d == null) return null
  if (d.lines.length === 1) return { tag: 'text', attrs: w.out, text: d.text, clean: isClean(it) }
  return {
    tag: 'text',
    attrs: w.out,
    clean: isClean(it),
    children: d.lines.map((line, i) => ({
      tag: 'tspan',
      attrs: i === 0 ? [] : ([['x', '0'], ['dy', num(d.lineHeight)]] as Pairs),
      text: line,
    })),
  }
}

/** Bars with corner radii inside a clipped scope: vega's per-bar clipped scopes (see render.ts). */
function clippedRoundedRectDescs(group: SceneGroup, clips: ClipCollector): DomDesc[] {
  const out: DomDesc[] = []
  for (const e of clippedRoundedRectEntries(group)) {
    if (e.kind === 'plain') {
      out.push(linked(e.item, { tag: 'path', attrs: pairs((w) => rectPathAttrs(e.item, e.d, w, false)) }))
      continue
    }
    const clipId = clips.id({ d: e.round })
    const background = (d: string): DomDesc => ({ tag: 'path', attrs: [['class', 'background'], ['aria-hidden', 'true'], ['d', d]] })
    const foreground = (): DomDesc => ({ tag: 'path', attrs: FOREGROUND.map((p) => [p[0], p[1]] as [string, string]) })
    out.push(g('g', [['transform', `translate(${num(e.g.x)},${num(e.g.y)})`]], [
      background(e.round),
      g('g', pairs((w) => clipRefAttrs(clipId, w)), [
        g('g', [['class', 'mark-group role-scope'], ['role', 'graphics-object'], ['aria-roledescription', 'group mark container']], [
          g('g', [['transform', `translate(0,${num(-e.g.y)})`]], [
            background(`M0,0h${num(e.g.w)}v0h-${num(e.g.w)}Z`),
            g('g', [], [
              g('g', [['class', 'mark-rect role-mark marks'], ['role', 'graphics-object'], ['aria-roledescription', 'rect mark container']], [
                linked(e.item, { tag: 'path', attrs: pairs((w) => rectPathAttrs(e.item, e.plain, w)) }),
              ]),
            ]),
            foreground(),
          ]),
        ]),
      ]),
      foreground(),
    ]))
  }
  return out
}

/** A single-element mark (line/area) links through its first item. */
function linkedFirst(items: SceneItem[], desc: DomDesc): DomDesc {
  return items.length ? linked(items[0]!, desc) : desc
}

function markItems(group: SceneGroup, type: string, options?: DomRenderOptions): DomDesc[] {
  const items = group.items ?? []
  switch (type) {
    case 'line': {
      const info = computeLinePath(group)
      if (!info) return []
      return [linkedFirst(items, { tag: 'path', attrs: pairs((w) => lineMarkAttrs(info, w)) })]
    }
    case 'area': {
      const info = computeAreaPath(group)
      if (!info) return []
      return [linkedFirst(items, { tag: 'path', attrs: pairs((w) => areaMarkAttrs(info, w)) })]
    }
    case 'trail': {
      if (items.length <= 1) return []
      const d = trailPath(items)
      if (!d) return []
      return [linked(items[0]!, { tag: 'path', attrs: pairs((w) => trailAttrs(d, items[0]!, w)) })]
    }
    case 'symbol': {
      // a hyperlinked mark keeps one element (and <a>) per symbol
      const chunkSize = group.hasLinks === true ? 0 : denseSymbolsEnabled(options, items)
      if (chunkSize > 0) return denseSymbolItems(group, items, chunkSize)
      return symbolItems(group, items)
    }
    case 'rect': {
      // vega paints a rect only when it has a fill or stroke, in item order.
      const out: DomDesc[] = []
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!
        if (!rectIsPainted(it)) continue
        const d = rectItemPath(it)
        if (d == null) continue
        out.push(cachedDesc(it, () => linked(it, { tag: 'path', attrs: pairs((w) => rectPathAttrs(it, d, w)), clean: isClean(it) })))
      }
      return out
    }
    case 'circle': {
      const out: DomDesc[] = []
      for (const it of items) {
        if (it.x == null || it.y == null) continue
        out.push(cachedDesc(it, () => linked(it, { tag: 'circle', attrs: pairs((w) => circleAttrs(it, w)), clean: isClean(it) })))
      }
      return out
    }
    case 'rule':
      return items.map((it) => cachedDesc(it, () => {
        const [x, y, x2, y2] = ruleEnds(it)
        return linked(it, {
          tag: 'line',
          attrs: pairs((w) => { itemDatumAttr(it, w); lineElementAttrs(x, y, x2, y2, it, w) }),
          clean: isClean(it),
        })
      }))
    case 'text': {
      const out: DomDesc[] = []
      for (const it of items) {
        if (it.text == null) continue
        const d = cachedDesc(it, () => {
          const t = textDesc(it)!
          return linked(it, t)
        })
        out.push(d)
      }
      return out
    }
    case 'path':
    case 'shape':
    case 'geoshape': {
      const out: DomDesc[] = []
      for (const it of items) {
        if (!it.path) continue
        out.push(cachedDesc(it, () => linked(it, { tag: 'path', attrs: pairs((w) => pathItemAttrs(it, w)), clean: isClean(it) })))
      }
      return out
    }
    case 'image': {
      const out: DomDesc[] = []
      for (const it of items) {
        if (it.url == null || it.x == null || it.y == null) continue
        out.push(cachedDesc(it, () => linked(it, { tag: 'image', attrs: pairs((w) => imageAttrs(it, w)), clean: isClean(it) })))
      }
      return out
    }
    case 'arc':
      return items.map((it) => cachedDesc(it, () => linked(it, { tag: 'path', attrs: pairs((w) => arcItemAttrs(it, w)), clean: isClean(it) })))
    default:
      return []
  }
}

/**
 * The element(s) a group renders to: usually one, several for clipped rounded
 * bars, none for an unknown mark type. `frameW`/`frameH` is the frame of the
 * group that contains this one (what a clipped mark clips to).
 */
function groupDescs(group: SceneGroup, frameW: number, frameH: number, clips: ClipCollector, options?: DomRenderOptions): DomDesc[] {
  const type = group.marktype
  const needsClip = group.clip === true
  if (!type || type === 'group') {
    // vega clips a group's content to the group's own width/height at (0,0) in
    // its own frame (group.js `content`), or to its explicit clip path.
    const gw = group.width ?? frameW
    const gh = group.height ?? frameH
    const attrs = pairs((w) => markGroupAttrs(group, w, needsClip ? clips : undefined, gw, gh))
    const children: DomDesc[] = []
    for (const item of group.items ?? []) {
      const isGroup = (item as SceneGroup).marktype !== undefined || Array.isArray((item as SceneGroup).items)
      if (isGroup) {
        pushAll(children, groupDescs(item as SceneGroup, gw, gh, clips, options))
        continue
      }
      let d = cachedDesc(item, () => leafDesc(item))
      // A clipped legend symbol hangs its clip-path on a `<g>` around the symbol,
      // never on the translated path itself (see `leafClipId`). The clip is
      // registered here, outside the item's cached descriptor, so a reused
      // descriptor still lands its clipPath in this render's defs.
      const clipId = leafClipId(item, clips)
      if (clipId) d = g('g', pairs((w) => clipRefAttrs(clipId, w)), [d])
      children.push(d)
    }
    const desc = linked(group, g('g', attrs, children))
    // vega's mark-level `clip`: clipped to the ENCLOSING group's frame, outside the item's own transform
    if (group.markClip === true) return [g('g', pairs((w) => clipRefAttrs(clips.id({ x: 0, y: 0, w: frameW, h: frameH }), w)), [desc])]
    return [desc]
  }

  // Vega-Lite rounds bars by wrapping each bar in a clipped scope.
  if (type === 'rect' && isClippedRoundedRectGroup(group)) return clippedRoundedRectDescs(group, clips)

  const containerAttrs = new PairAttrSink()
  if (!markContainerAttrs(type, containerAttrs)) return []
  const inner = g('g', containerAttrs.out, markItems(group, type, options))
  if (type === 'symbol' && group.hasLinks !== true && denseSymbolsEnabled(options, group.items ?? []) > 0) inner.dense = true
  // A mark's clip is the size of the group that contains it (vega: `clip(renderer, scene, scene.group)`).
  if (needsClip) return [g('g', pairs((w) => clipRefAttrs(groupClipId(group, clips, frameW, frameH), w)), [inner])]
  return [inner]
}

export function sceneToDomDesc(scene: SceneRoot, options: DomRenderOptions = {}): DomDesc {
  CURRENT_GEN = (scene as unknown as { __itemGen?: number }).__itemGen
  const { plotW, plotH } = scenePlotSize(scene)
  // Clip regions are registered while building; ids are content-addressed (svg-defs.ts).
  const clips = new ClipCollector()
  const frameClipId = scene.frameClip ? clips.id({ x: 0, y: 0, w: plotW, h: plotH }) : null

  const children: DomDesc[] = []
  if (scene.background) children.push({ tag: 'rect', attrs: pairs((w) => backgroundRectAttrs(scene, w)) })
  const marks: DomDesc[] = []
  for (const n of scene.items ?? []) pushAll(marks, groupDescs(n, plotW, plotH, clips, options))
  children.push(g('g', pairs((w) => viewGroupAttrs(scene, w)), [
    g('g', [
      ['class', 'mark-group role-frame root'],
      ['role', 'graphics-object'],
      ['aria-roledescription', 'group mark container'],
    ], [
      g('g', [['transform', 'translate(0,0)']], [
        { tag: 'path', attrs: pairs((w) => frameAttrs(scene, w)) },
        g('g', frameClipId ? pairs((w) => clipRefAttrs(frameClipId, w)) : [], marks),
        { tag: 'path', attrs: FOREGROUND.map((p) => [p[0], p[1]] as [string, string]) },
      ]),
    ]),
  ]))

  if (scene.defs?.length || clips.size > 0) {
    const defsChildren: DomDesc[] = []
    for (const def of scene.defs ?? []) {
      defsChildren.push({
        tag: 'linearGradient',
        attrs: pairs((w) => gradientAttrs(def, w)),
        children: def.colorStops.map((stop) => ({ tag: 'stop', attrs: pairs((w) => stopAttrs(stop, w)) })),
      })
    }
    for (const [id, def] of clips.defs) {
      const w = new PairAttrSink()
      const kind = clipShapeAttrs(def, w)
      defsChildren.push({ tag: 'clipPath', attrs: pairs((cw) => clipIdAttrs(id, cw)), children: [{ tag: kind, attrs: w.out }] })
    }
    children.push(g('defs', [], defsChildren))
  }

  return { tag: 'svg', attrs: pairs((w) => svgRootAttrs(scene, w)), children }
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
  // we can avoid descending into it entirely. That holds only when THIS element
  // was last patched with THIS descriptor: children are matched by position, so
  // after a removal or reorder a reused item's cached descriptor lands on an
  // element that currently shows a different item (audit C3).
  if (desc.clean && last === desc) return

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
