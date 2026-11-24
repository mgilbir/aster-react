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
 * the two renderers cannot drift - `packages/conformance/scripts/dom-string-parity.test.mts`
 * checks it over the whole conformance corpus. The one deliberate exception is
 * `denseMarks`, which batches symbols into chunked paths.
 */
import { SYMBOL_DEFAULT_SIZE, pushAll } from './util.js'
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'
import { ClipCollector } from './svg-defs.js'
import { isEngineNode, keptInto } from './scene-registry.js'
import { getTextMetricsProvider } from './text-metrics.js'
import { formatEnvironmentKey } from './locale.js'
import { symbolGeometry, type PathData, type SymbolGeometry } from './geometry.js'
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
  failOnUnmeasured,
  leafSymbolPath,
  lineElementAttrs,
  lineMarkAttrs,
  markContainerAttrs,
  childNodes,
  type GuideScope,
  type SvgRun,
  type SvgNode,
  paintAttrs,
  pathItemAttrs,
  pathlessMarkAttrs,
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
  textAttrs,
  trailAttrs,
  trailPath,
  viewGroupAttrs,
  groupItemAttrs,
  itemDatumAttr,
  itemHref,
  linkAttrs,
  type AttrSink,
  num,
} from './render.js'

import './guide-caption.js' // (installs the guide captions the structure tree quotes in aria-label)

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

/**
 * The text with every absolute coordinate moved by (dx, dy) and rounded to 3 digits, the other arguments (radii, flags,
 * relative deltas) as written: what `translatePathData(d.text(), dx, dy)` makes of it. Requires `d.finite`.
 */
function dataTranslated(d: PathData, dx: number, dy: number): string {
  if (dx === 0 && dy === 0) return d.text()
  let out = ''
  let k = 0
  for (let c = 0; c < d.letters.length; c++) {
    const letter = d.letters[c]!
    out += letter
    const n = d.counts[c]!
    const relative = letter === 'h' || letter === 'v'
    for (let j = 0; j < n; j++, k++) {
      const value = d.values[k]!
      // (an arc's end point moves, its radii and flags do not; every other absolute argument alternates x, y)
      const axis = relative ? 0 : letter === 'A' ? (j === 5 ? 1 : j === 6 ? 2 : 0) : j % 2 === 0 ? 1 : 2
      const text = axis === 0 ? (d.odd?.get(k) ?? String(value)) : round3(axis === 1 ? value + dx : value + dy)
      out += j ? ',' + text : text
    }
  }
  return out
}

/** A symbol shape's 3-digit text moved to (dx, dy) (a dense batch's piece); `translateText` reads a text that is not finite. */
function symbolTranslated(g: SymbolGeometry, dx: number, dy: number, translateText: (d: string, dx: number, dy: number) => string): string {
  const d = g.rounded()
  return d.finite ? dataTranslated(d, dx, dy) : translateText(g.text(), dx, dy)
}

/** Opt-in DOM rendering options. */
export interface DomRenderOptions {
  /**
   * Batch dense symbol marks into chunked `<path>` elements instead of one
   * element per datum. Pixels are unchanged (positions are baked into `d`), but
   * the DOM intentionally stops mirroring Vega's per-item structure: 100k
   * symbols become a few hundred paths, which is what keeps large SVG streams
   * inside the frame budget. Tooltips and hit-testing resolve through the scene
   * hit index (`@aster-charts/core/hit`).
   */
  denseMarks?: boolean
  /** Maximum items per batched path (default 256). */
  denseChunkSize?: number
}

const DENSE_SYMBOL_MIN = 512
const DENSE_SYMBOL_CHUNK = 256

/**
 * `gen`: the scene generation it was built in; `stamped`: every item in it carried a generation then (an unstamped item is
 * never clean, see `isClean`); `d`: its path data; `open`: it ended at the end of the items, short of the size bound.
 */
interface DenseChunk { from: number; to: number; first: SceneItem; last: SceneItem; desc: DomDesc; gen: number | undefined; stamped: boolean; d: string; open: boolean }

/**
 * Whether every item of a chunk is clean (`isClean`), proved without reading them when the items array is one the engine
 * advances in place (it stamps `__editGen` on every in-place replacement): the chunk was built in an earlier generation from
 * this same array, every item carried a generation, and nothing in the array was replaced since -- so the items are the very
 * ones it was built from, all encoded at or before that generation, none at this one. Any other array is read item by item.
 */
function chunkClean(items: SceneItem[], chunk: DenseChunk, from: number, to: number): boolean {
  const a = items as SceneItem[] & { __engineItems?: true; __editGen?: number }
  if (a.__engineItems === true && CURRENT_GEN != null && chunk.gen != null && chunk.gen < CURRENT_GEN && chunk.stamped
    && (a.__editGen === undefined || a.__editGen <= chunk.gen)) return true
  for (let j = from; j < to; j++) if (!isClean(items[j]!)) return false
  return true
}
interface DenseCache { items: SceneItem[]; chunkSize: number; chunks: Map<number, DenseChunk> }
// Cached per items array of a scene group: the runtime reuses the items array for
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
 * bounded (so an append only re-serializes the last one) and cached per items
 * array of a scene group, so a streamed append rebuilds a single ~256-item path string instead
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
    // A cached FULL chunk (it stopped at the size bound, not at a paint break)
    // whose first and last item are the same objects and whose items were all
    // reused unchanged is still exactly that chunk: its boundary and paint were
    // decided by those same unchanged items, so the per-item batchable/paint scan
    // is skipped. Only the growing tail chunk is ever re-scanned, which keeps an
    // append at one pass of cheap flag reads instead of two property-heavy ones.
    const full = cachedChunks?.get(from)
    if (full && full.first === first && full.to - from === chunkSize && full.to <= items.length
      && items[full.to - 1] === full.last) {
      if (chunkClean(items, full, from, full.to)) {
        full.desc.clean = true
        chunks.set(from, full)
        out.push(full.desc)
        i = full.to
        continue
      }
    }
    // An open tail chunk (it ended at the end of the items, short of the size bound) of unchanged items is resumed where it
    // ended: its own items need neither the batchable / paint scan nor translating again (see the full-chunk case above), so
    // an append costs the appended items, not the tail chunk.
    const open = cachedChunks?.get(from)
    const resume = open !== undefined && open.open && open.first === first && open.to <= items.length && items[open.to - 1] === open.last
      && chunkClean(items, open, from, open.to) ? open : null
    let to = resume !== null ? resume.to : i + 1
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
      if (resume === cached || chunkClean(items, cached, from, to)) {
        cached.desc.clean = true
        chunks.set(from, cached)
        out.push(cached.desc)
        i = to
        continue
      }
    }
    let d = resume !== null ? resume.d : ''
    let stamped = resume !== null ? resume.stamped : true
    for (let j = resume !== null ? resume.to : from; j < to; j++) {
      const it = items[j]!
      if (it.__gen == null) stamped = false
      if (!batchableSymbol(it)) continue
      const r = Math.sqrt((it.size as number) ?? SYMBOL_DEFAULT_SIZE) / 2
      d += symbolTranslated(symbolGeometry((it as Record<string, unknown>).shape as string | undefined, r), it.x as number, it.y as number, translatePathData)
    }
    // A fresh desc object (never mutate a cached one): the patcher compares
    // against the previous descriptor, so reusing the object would hide the write.
    const desc: DomDesc = { tag: 'path', attrs: [['d', d], ...symbolAttrs(first)] }
    const chunk: DenseChunk = { from, to, first, last: items[to - 1]!, desc, gen: CURRENT_GEN, stamped, d, open: to === items.length && to - from < chunkSize }
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

/**
 * `gen`: the generation it was last built in; `stamped`: every item then carried a generation; `dirty`: the indices whose
 * descriptor was built for an item of that generation (not clean then: clean from the next generation on); `out`: the array
 * handed out last.
 */
interface SymbolItemsCache { items: SceneItem[]; keys: SceneItem[]; descs: DomDesc[]; gen: number | undefined; stamped: boolean; dirty: number[]; out: DomDesc[] }
// Per items array; the runtime mutates the items array in place for incremental
// updates, so an unchanged item keeps its descriptor without rebuilding the
// 100k-entry array on every append.
const SYMBOL_ITEMS = new WeakMap<SceneItem[], SymbolItemsCache>()
/** A mark's children that only append to the ones handed out before (`symbolItems`): what the container's `appendFrom` says. */
const APPEND_OF = new WeakMap<DomDesc[], { prev: DomDesc[]; count: number }>()
/**
 * A container whose first `count` children are the very descriptors of `prev`, the children handed out for it last time: the
 * patcher appends the rest without walking them. (Beside the descriptor, not on it: a descriptor is plain data.)
 */
const APPEND_TO = new WeakMap<DomDesc, { prev: DomDesc[]; count: number }>()

/** The descriptor of a symbol item, noting it in `dirty` when its item is of this generation. */
function freshSymbolDesc(it: SceneItem, i: number, dirty: number[]): DomDesc {
  if (!isClean(it)) dirty.push(i)
  return symbolItemDesc(it)
}

function symbolItems(group: SceneGroup, items: SceneItem[]): { descs: DomDesc[]; appendFrom?: { prev: DomDesc[]; count: number } } {
  const prev = SYMBOL_ITEMS.get(items)
  const reuse = prev && prev.items === items ? prev : null
  // An append to an array the engine advances in place, nothing re-encoded since the last build (the dense chunks' proof,
  // `chunkClean`): the items there are the ones the descriptors were built for, all clean now. Only the appended items are
  // read; the descriptors built last time for items of that generation are clean from this one on, as the full walk below
  // would mark them.
  const a = items as SceneItem[] & { __engineItems?: true; __editGen?: number }
  if (reuse !== null && a.__engineItems === true && CURRENT_GEN != null && reuse.gen != null && reuse.gen < CURRENT_GEN && reuse.stamped
    && (a.__editGen === undefined || a.__editGen <= reuse.gen) && items.length >= reuse.keys.length) {
    const { keys, descs } = reuse
    for (const i of reuse.dirty) descs[i]!.clean = true
    const dirty: number[] = []
    let stamped = true
    const count = keys.length
    for (let n = count; n < items.length; n++) {
      const it = items[n]!
      if (it.__gen == null) stamped = false
      keys[n] = it
      descs[n] = freshSymbolDesc(it, n, dirty)
    }
    const out = descs.slice()
    const appendFrom = { prev: reuse.out, count }
    SYMBOL_ITEMS.set(items, { items, keys, descs, gen: CURRENT_GEN, stamped, dirty, out })
    return { descs: out, appendFrom }
  }
  const keys = reuse ? reuse.keys : []
  const descs = reuse ? reuse.descs : []
  const dirty: number[] = []
  let stamped = true
  let n = 0
  for (const it of items) {
    if (it.__gen == null) stamped = false
    // A null position renders at the origin (like the string renderer).
    if (keys[n] === it && descs[n] != null) {
      if (isClean(it)) descs[n]!.clean = true
      else { keys[n] = it; descs[n] = freshSymbolDesc(it, n, dirty) }
    } else {
      keys[n] = it
      descs[n] = freshSymbolDesc(it, n, dirty)
    }
    n++
  }
  keys.length = n
  descs.length = n
  // The patcher compares against the previous descriptor *array*, so return a
  // snapshot: exposing the cached array would mean a later in-place append
  // mutates the patcher's "previous" state and every child gets re-walked.
  const out = descs.slice()
  SYMBOL_ITEMS.set(items, { items, keys, descs, gen: CURRENT_GEN, stamped, dirty, out })
  return { descs: out }
}

/**
 * True when a scene has a symbol mark large enough for `denseMarks` batching.
 * `<Chart>` uses this to decide whether hit-testing must go through the scene
 * index (batched marks are not one element per item).
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
  failOnUnmeasured(it)
  const w = new PairAttrSink()
  if (it.path != null) {
    leafPathAttrs(it, w)
    return { tag: 'path', attrs: w.out, clean: isClean(it) }
  }
  if (it.shape != null && it.radius != null) {
    symbolElementAttrs(it, leafSymbolPath(it), w)
    return { tag: 'path', attrs: w.out, clean: isClean(it) }
  }
  if (it._kind === 'text' || (it._kind === undefined && it.text != null)) {
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
      if (!info) return items.length ? [{ tag: 'path', attrs: pairs((w) => pathlessMarkAttrs('line', items[0]!, w)) }] : []
      return [linkedFirst(items, { tag: 'path', attrs: pairs((w) => lineMarkAttrs(info, w)) })]
    }
    case 'area': {
      const info = computeAreaPath(group)
      if (!info) return items.length ? [{ tag: 'path', attrs: pairs((w) => pathlessMarkAttrs('area', items[0]!, w)) }] : []
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
      const { descs, appendFrom } = symbolItems(group, items)
      if (appendFrom) APPEND_OF.set(descs, appendFrom)
      return descs
    }
    case 'rect': {
      // vega paints a rect only when it has a fill or stroke, in item order.
      const out: DomDesc[] = []
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!
        if (!rectIsPainted(it)) continue
        // (the path is built only for an item whose descriptor is rebuilt: a clean item's is reused as it is)
        out.push(cachedDesc(it, () => linked(it, { tag: 'path', attrs: pairs((w) => rectPathAttrs(it, rectItemPath(it)!, w)), clean: isClean(it) })))
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
        out.push(cachedDesc(it, () => linked(it, { tag: 'path', attrs: pairs((w) => pathItemAttrs(it, w, type === 'geoshape' ? 'shape' : type)), clean: isClean(it) })))
      }
      return out
    }
    case 'image': {
      const out: DomDesc[] = []
      for (const it of items) {
        if ((it as { urlDenied?: boolean }).urlDenied) continue
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
 * The element(s) a data mark renders to: usually one, several for clipped rounded bars, none for an unknown mark type.
 * `frameW`/`frameH` is the frame of the group that contains the mark (what its `clip` clips to).
 */
function markDescs(group: SceneGroup, frameW: number, frameH: number, clips: ClipCollector, options: DomRenderOptions | undefined, scope: GuideScope): DomDesc[] {
  const type = group.marktype
  if (!type) return []
  // Vega-Lite rounds bars by wrapping each bar in a clipped scope.
  if (type === 'rect' && isClippedRoundedRectGroup(group)) return clippedRoundedRectDescs(group, clips)

  const containerAttrs = new PairAttrSink()
  // A mark's clip is the size of the group that contains it (vega: `clip(renderer, scene, scene.group)`), on its container.
  // (registered whether or not the descriptor is the one before: the clip joins this render's defs)
  const clipId = group.clip === true ? groupClipId(group, clips, frameW, frameH) : null
  const keep = keepsDesc(group, type)
  if (keep) {
    const kept = MARK_DESCS.get(group)
    if (kept !== undefined && keptInto(kept.root, describing) && kept.clipId === clipId) return [kept.desc]
  }
  if (!markContainerAttrs(group, containerAttrs, clipId, scope)) return []
  const children = markItems(group, type, options)
  const inner = g('g', containerAttrs.out, children)
  const appendFrom = APPEND_OF.get(children)
  if (appendFrom) APPEND_TO.set(inner, appendFrom)
  if (type === 'symbol' && group.hasLinks !== true && denseSymbolsEnabled(options, group.items ?? []) > 0) inner.dense = true
  if (keep) MARK_DESCS.set(group, { clipId, desc: inner, root: describing })
  return [inner]
}

/**
 * The descriptor of a data mark of a scene the engine returned, as it was made: such a mark holds what it held (scene-registry.ts),
 * so its container and items describe as before, given the same clip, in a later scene that kept it (`keptInto`). The descriptors
 * are the ones before: the patcher compares them with what it last wrote, and skips the clean items in them. Not kept: a text mark
 * (its descriptor reads the text metrics in use), a mark whose role is a guide's (its caption reads the scales around it), a symbol
 * mark (its descriptors follow an engine items array across groups, and batch by the options: see `symbolItems`).
 */
const MARK_DESCS = new WeakMap<SceneGroup, { clipId: string | null; desc: DomDesc; root: object }>()
/** The scene `sceneToDomDesc` is describing (see `keptInto`). */
let describing: object = {}
const GUIDE_ROLES = new Set(['axis', 'legend', 'title-text', 'title-subtitle'])
function keepsDesc(group: SceneGroup, type: string): boolean {
  return type !== 'text' && type !== 'symbol' && group.role === 'mark' && !GUIDE_ROLES.has(String(group.markRole)) && isEngineNode(group)
}

/**
 * The descriptor of the group items of one mark, or of a guide (an axis, a legend, a title), or the one made of the same groups for
 * an earlier scene that kept them (`keptInto`). A group the engine returned holds what it held, what is inside it included
 * (scene-registry.ts), so the groups describe as before but for what describing them reads besides the groups: the frame of the
 * group that holds them (a mark's `clip` and a group's default size), the scale snapshots their captions read (`snaps`, the scene's
 * own array, which the engine hands on from the scene before only when every scale is the one before), the text measurer set for
 * every chart (a label's `limit` is measured when it is described), the default locale and the time zone (a caption formats numbers
 * and dates), and the options (batching). A descriptor that asked for a clip is not kept: a clip it asked for joins the defs of the
 * render that asks for it.
 */
const RUN_DESCS = new WeakMap<SceneGroup, {
  run: readonly SceneGroup[]; desc: DomDesc; root: object; frameW: number; frameH: number; snaps: unknown; measurer: unknown; format: string; dense: unknown; chunk: unknown
}>()
function runDesc(n: SvgRun, clips: ClipCollector, options: DomRenderOptions | undefined): DomDesc {
  const measurer = getTextMetricsProvider()
  // (a caption formats numbers and dates: under the default locale, in the host's time zone)
  const format = formatEnvironmentKey()
  const first = n.run[0]!
  const kept = RUN_DESCS.get(first)
  if (kept !== undefined && keptInto(kept.root, describing) && sameRun(kept.run, n.run) && Object.is(kept.frameW, n.frameW) && Object.is(kept.frameH, n.frameH)
    && kept.snaps === n.snaps && kept.measurer === measurer && kept.format === format && kept.dense === options?.denseMarks && kept.chunk === options?.denseChunkSize) {
    // (the patcher compares it with what it last wrote, and skips it whole when that is it)
    kept.desc.clean = true
    return kept.desc
  }
  const asked = clips.asked
  const desc = nodeDescs([n.make()], clips, options)[0]!
  if (clips.asked === asked && n.run.every(isEngineNode)) {
    RUN_DESCS.set(first, { run: n.run, desc, root: describing, frameW: n.frameW, frameH: n.frameH, snaps: n.snaps, measurer, format, dense: options?.denseMarks, chunk: options?.denseChunkSize })
  }
  return desc
}

function sameRun(a: readonly SceneGroup[], b: readonly SceneGroup[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** The descriptors of a structure tree (render.ts `childNodes`), attributes before children as the string renderer writes them. */
function nodeDescs(nodes: readonly SvgNode[], clips: ClipCollector, options: DomRenderOptions | undefined): DomDesc[] {
  const out: DomDesc[] = []
  for (const n of nodes) {
    if ('leaf' in n) {
      const item = n.leaf
      let d = cachedDesc(item, () => leafDesc(item))
      // A clipped legend symbol hangs its clip-path on a `<g>` around the symbol,
      // never on the translated path itself (see `leafClipId`). The clip is
      // registered here, outside the item's cached descriptor, so a reused
      // descriptor still lands its clipPath in this render's defs.
      const clipId = n.wrapClip ? leafClipId(item, clips) : null
      if (clipId) d = g('g', pairs((w) => clipRefAttrs(clipId, w)), [d])
      out.push(linked(item, d))
    } else if ('mark' in n) {
      pushAll(out, markDescs(n.mark, n.frameW, n.frameH, clips, options, n.scope))
    } else if ('run' in n) {
      out.push(runDesc(n, clips, options))
    } else {
      const attrs = pairs(n.attrs)
      const desc: DomDesc = n.children === undefined ? { tag: n.tag, attrs } : g(n.tag, attrs, nodeDescs(n.children, clips, options))
      out.push(n.link ? linked(n.link, desc) : desc)
    }
  }
  return out
}

export function sceneToDomDesc(scene: SceneRoot, options: DomRenderOptions = {}): DomDesc {
  CURRENT_GEN = (scene as unknown as { __itemGen?: number }).__itemGen
  describing = scene
  const { plotW, plotH } = scenePlotSize(scene)
  // Clip regions are registered while building; ids are content-addressed (svg-defs.ts).
  const clips = new ClipCollector()
  const frameClipId = scene.frameClip ? clips.id({ x: 0, y: 0, w: plotW, h: plotH }) : null

  const children: DomDesc[] = []
  if (scene.background) children.push({ tag: 'rect', attrs: pairs((w) => backgroundRectAttrs(scene, w)) })
  const marks: DomDesc[] = []
  pushAll(marks, nodeDescs(childNodes(scene.items, plotW, plotH, { snaps: scene.__scales }, clips), clips, options))
  children.push(g('g', pairs((w) => viewGroupAttrs(scene, w)), [
    g('g', [
      ['class', 'mark-group role-frame root'],
      ['role', 'graphics-object'],
      ['aria-roledescription', 'group mark container'],
    ], [
      g('g', pairs((w) => groupItemAttrs(scene.frameX ?? 0, scene.frameY ?? 0, w, scene.frameAria)), [
        { tag: 'path', attrs: pairs((w) => frameAttrs(scene, w)) },
        g('g', frameClipId ? pairs((w) => clipRefAttrs(frameClipId, w)) : [], marks),
        { tag: 'path', attrs: FOREGROUND.map((p) => [p[0], p[1]] as [string, string]) },
      ]),
    ]),
  ]))

  if (scene.defs?.length || clips.size > 0) {
    const defsChildren: DomDesc[] = []
    for (const def of scene.defs ?? []) {
      if (def.kind === 'radial') {
        defsChildren.push({
          tag: 'pattern',
          attrs: [['id', 'p_' + def.id], ['viewBox', '0,0,1,1'], ['width', '100%'], ['height', '100%'], ['preserveAspectRatio', 'xMidYMid slice']],
          children: [{ tag: 'rect', attrs: [['width', '1'], ['height', '1'], ['fill', `url(#${def.id})`]] }],
        })
      }
      defsChildren.push({
        tag: def.kind === 'radial' ? 'radialGradient' : 'linearGradient',
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
    // (the namespaced accessors take the LOCAL name: 'href', not the qualified 'xlink:href', which no attribute has)
    const cur = k === 'xlink:href' ? el.getAttributeNS(XLINK_NS, 'href') : el.getAttribute(k)
    if (cur !== v) writeAttr(el, k, v)
  }
  for (let i = el.attributes.length - 1; i >= 0; i--) {
    const a = el.attributes.item(i)!
    if (keep.has(a.name) || a.name === 'xmlns' || a.name === 'xmlns:xlink') continue
    if (a.name === 'xlink:href') el.removeAttributeNS(XLINK_NS, 'href')
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
  // element that currently shows a different item.
  if (desc.clean && last === desc) return

  // Attributes: fast path compares against the cached descriptor.
  if (last && sameAttrNames(last.attrs, desc.attrs)) {
    for (let i = 0; i < desc.attrs.length; i++) {
      const n = desc.attrs[i]!
      if (n[1] !== last.attrs[i]![1]) writeAttr(el, n[0], n[1])
    }
  } else {
    syncAttrsFromDom(el, desc)
  }

  // Switching a mark container between per-item elements and batched paths is a
  // structural change: rebuilding the (few hundred) chunk elements is much
  // cheaper than diffing it against tens of thousands of per-item nodes. (After
  // the attributes: the container itself may be another mark's, e.g. a `.mark-rect`
  // that now holds symbols, and its own class / role must follow.)
  if (desc.dense === true && (last == null || last.dense !== true) && desc.children) {
    el.replaceChildren(...desc.children.map((c) => createEl(c, el.ownerDocument)))
    return
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
  // The producer's own word that the first `count` children are the ones this element was last patched with (an append to an
  // engine array, see `symbolItems`): only the tail is new, and the prefix is not even compared.
  const hint = APPEND_TO.get(desc)
  if (hint !== undefined && lastChildren === hint.prev && have === hint.count && lastChildren.length === hint.count) {
    for (let j = hint.count; j < want.length; j++) el.appendChild(createEl(want[j]!, el.ownerDocument))
    return
  }
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
  for (let i = 0; i < n && cur != null; i++) {
    const w = want[i]!
    // the next sibling is read BEFORE a replacement detaches `cur` (a detached node has none, which would end the walk
    // after the first changed tag and leave every later child showing the previous scene)
    const next: Element | null = cur.nextElementSibling
    if (cur.tagName === w.tag) patchEl(cur, w)
    else el.replaceChild(createEl(w, el.ownerDocument), cur)
    cur = next
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
