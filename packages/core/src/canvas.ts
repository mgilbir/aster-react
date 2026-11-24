/**
 * Scene -> Canvas2D renderer. Both backends render the same scene, so
 * the engine stays single-sourced: the walk mirrors `render.ts` (same group
 * traversal, same shared geometry helpers) and only the final paint differs.
 *
 * The renderer accepts a minimal 2D-context interface (`CanvasLike`), so it
 * runs against a real `CanvasRenderingContext2D`, an OffscreenCanvas context,
 * or a recording mock in tests. Geometry comes from the marks' shared geometry (geometry.ts), computed once and drawn as
 * the segments of the path the SVG renderer writes (rects, symbols, trails: the same numbers as that text read back) or at
 * full precision (lines and areas, like vega's canvas; arcs, drawn by the generator's own calls). Only path strings that come
 * with the scene (a path mark's, a shape's, a legend leaf's, a group's clip) are parsed, once per distinct string.
 */
import { SYMBOL_DEFAULT_SIZE } from './util.js'
import type { SceneDef, SceneGroup, SceneItem, SceneRoot } from './types.js'
import { gradientDefOf, isGradientPaint as isGradientObject } from './svg-defs.js'
import { Bounds, boundLeaf, boundStroke, boundTypedMark } from './bounds.js'
import { imageBox, itemImage } from './image-box.js'
import { drawnPathCommands, parsePathData, renderSvgPath, tracePath, type PathSeg, type PathSink } from './path-data.js'

// Path-data parsing and replay live in path-data.ts (hit.ts needs them without the renderer); the public surface is unchanged.
export { parsePathData, tracePath, type PathSeg, type PathSink } from './path-data.js'
// The bitmaps of image marks: the renderer draws `item.image` and never fetches; a host that shows url images loads them with these.
export { IMAGE_CONCURRENCY, loadImages, sceneImageUrls, withSceneImages, type ImageLoadOptions } from './image-load.js'
export type { ItemImage } from './image-box.js'
// The canvas renderer's events for the signal event loop (which item an event is about, as vega's canvas handler resolves it).
export { createCanvasEvents, type CanvasEvents } from './canvas-events.js'

type SceneDefs = SceneDef
import {
  lineStrokeWidth,
  num,
  textItemDesc,
  frameBackgroundData,
  frameItem,
  itemArcGeometry,
} from './render.js'
import { areaGeometry, lineGeometry, rectData, symbolGeometry, trailGeometry } from './geometry.js'
import { arcSegs, curveExactSegs, drawCurveExact, segsOf, symbolExactSegs } from './geometry-read.js'

/** Minimal 2D context surface used by the renderer. */
export interface CanvasLike {
  save(): void
  restore(): void
  translate(x: number, y: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void
  closePath(): void
  rect(x: number, y: number, w: number, h: number): void
  rotate(angle: number): void
  clip(fillRule?: 'nonzero' | 'evenodd'): void
  fill(fillRule?: 'nonzero' | 'evenodd'): void
  /** (a real context only: a run of symbols is painted from a `Path2D`, see {@link runPath}) */
  fill(path: unknown, fillRule?: 'nonzero' | 'evenodd'): void
  stroke(path?: unknown): void
  fillRect(x: number, y: number, w: number, h: number): void
  setLineDash(dashes: number[]): void
  // The renderer never passes a maxWidth (the DOM overload is unused). The
  // optional fourth argument remains for recording mocks that flag multi-line
  // text; a real CanvasRenderingContext2D would coerce a boolean to 0.
  fillText(text: string, x: number, y: number, maxWidthOrMulti?: number | boolean): void
  drawImage?(image: unknown, dx: number, dy: number, dw?: number, dh?: number): void
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): GradientLike
  /** (absent on a minimal context: a radial gradient paint is then not drawn) */
  createRadialGradient?(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): GradientLike
  /** (absent on a minimal context: a linear gradient that is not axis aligned is then painted in absolute coordinates) */
  createPattern?(image: unknown, repetition: string): unknown
  scale(x: number, y: number): void
  fillStyle: unknown
  strokeStyle: unknown
  globalAlpha: number
  lineWidth: number
  lineCap: string
  lineJoin: string
  miterLimit: number
  lineDashOffset?: number
  imageSmoothingEnabled?: boolean
  globalCompositeOperation?: string
  strokeText?(text: string, x: number, y: number): void
  font: string
  textAlign: string
  textBaseline: string
}

export interface GradientLike {
  addColorStop(offset: number, color: string): void
}

/** The segments of a symbol shape at radius r, at full precision (what vega's canvas draws); cached per shape and radius. */
const symbolSegs = (shape: string | undefined, r: number): PathSeg[] => symbolExactSegs(symbolGeometry(shape, r))

/** Canonical form of parsed segments (shared by both parity sides). */
export function canonicalPath(segs: PathSeg[]): string {
  return segs.map((s) => {
    switch (s.cmd) {
      case 'M': case 'L': return `${s.cmd}${num(s.x)},${num(s.y)}`
      case 'H': return `H${num(s.x)}`
      case 'V': return `V${num(s.y)}`
      case 'C': return `C${num(s.c1x)},${num(s.c1y)},${num(s.c2x)},${num(s.c2y)},${num(s.x)},${num(s.y)}`
      case 'S': return `S${num(s.c2x)},${num(s.c2y)},${num(s.x)},${num(s.y)}`
      case 'Q': return `Q${num(s.cx)},${num(s.cy)},${num(s.x)},${num(s.y)}`
      case 'T': return `T${num(s.x)},${num(s.y)}`
      case 'A': return `A${num(s.rx)},${num(s.ry)},${num(s.rot)},${s.large},${s.sweep},${num(s.x)},${num(s.y)}`
      case 'Z': return 'Z'
    }
  }).join('')
}


// ---------------------------------------------------------------------------
// Scene walk (mirrors render.ts)
// ---------------------------------------------------------------------------

export interface RenderCanvasOptions {
  /** Device pixel ratio: scales the context transform. */
  dpr?: number
  /**
   * Batch large runs of identically-painted symbols into one fill/stroke (default
   * true). Set false in draw-record tests that compare per-item commands.
   */
  batchSymbols?: boolean
}

export function renderSceneToCanvas(scene: SceneRoot, ctx: CanvasLike, opts: RenderCanvasOptions = {}): void {
  const W = scene.width
  const H = scene.height
  const pad = scene.padding ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom

  ctx.save()
  if (opts.dpr != null && opts.dpr !== 1) {
    ctx.scale(opts.dpr, opts.dpr)
  }
  ctx.miterLimit = 4

  // View background
  if (scene.background) {
    ctx.fillStyle = scene.background
    ctx.fillRect(0, 0, W, H)
  }
  ctx.translate(pad.left + (scene.frameX ?? 0), pad.top + (scene.frameY ?? 0))

  // Root frame background path: fill, stroke, dash, opacity and rounded
  // corners, from the same path the SVG renderer emits.
  ctx.beginPath()
  const frameSegs = segsOf(frameBackgroundData(scene, plotW, plotH))
  tracePath(ctx, frameSegs)
  paintPath(ctx, frameSegs, frameItem(scene), scene.defs, 'auto')

  for (const node of scene.items) {
    renderGroup(node, ctx, scene, plotW, plotH, opts)
  }
  ctx.restore()
}

function isGroup(item: SceneItem): item is SceneGroup {
  return (item as SceneGroup).marktype !== undefined || Array.isArray((item as SceneGroup).items)
}

// ---------------------------------------------------------------------------
// Incremental append painting
// ---------------------------------------------------------------------------

export interface CanvasSceneSnapshot {
  scene: SceneRoot
  /** Top-level mark group -> item count at draw time (arrays may be mutated). */
  markLengths: Map<SceneGroup, number>
  /**
   * Top-level mark group -> its items array at draw time. An update that
   * appends/edits in place hands the SAME array to the next group, so identity
   * with this array proves "same lineage" without reading the superseded group
   * (whose `items` is a lazy snapshot: reading it would materialise a copy).
   */
  markArrays: Map<SceneGroup, SceneItem[]>
  /** Scene generation (item `__gen` values older than this are unchanged). */
  gen: number
}

export function snapshotCanvasScene(scene: SceneRoot): CanvasSceneSnapshot {
  const markLengths = new Map<SceneGroup, number>()
  const markArrays = new Map<SceneGroup, SceneItem[]>()
  for (const g of scene.items) {
    if (g.role !== 'mark') continue
    const items = (g.items as SceneItem[] | undefined) ?? []
    markLengths.set(g, items.length)
    markArrays.set(g, items)
  }
  return { scene, markLengths, markArrays, gen: (scene as unknown as { __itemGen?: number }).__itemGen ?? 0 }
}

// Keys that never affect paint: engine bookkeeping (`__gen`, `__domDesc`, ...)
// and the source datum (the encoded channels already carry everything painted).
const NON_PAINT_KEYS = new Set(['datum', 'dataDatum', 'runtime', 'compiled'])

/**
 * Structural equality of two scene values over their painted fields, with a
 * visit budget. Replaces the per-frame `JSON.stringify` of whole item arrays. It allocates nothing, stops at the first difference, ignores
 * bookkeeping and the datum, and gives up (not equal) on a pathological graph.
 */
function samePaint(a: unknown, b: unknown, budget: { n: number }, depth = 0): boolean {
  if (Object.is(a, b)) return true
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false
  if (depth > 8 || --budget.n < 0) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!samePaint(a[i], b[i], budget, depth + 1)) return false
    return true
  }
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  let na = 0
  for (const k in ra) {
    if (!Object.hasOwn(ra, k) || k.startsWith('__') || NON_PAINT_KEYS.has(k) || typeof ra[k] === 'function') continue
    na++
    if (!samePaint(ra[k], rb[k], budget, depth + 1)) return false
  }
  let nb = 0
  for (const k in rb) {
    if (!Object.hasOwn(rb, k) || k.startsWith('__') || NON_PAINT_KEYS.has(k) || typeof rb[k] === 'function') continue
    nb++
  }
  return na === nb
}

/** True when two non-mark groups paint identically (a guide that was rebuilt but did not change). */
function samePaintedGroup(a: SceneGroup, b: SceneGroup): boolean {
  return samePaint(a, b, { n: 50_000 })
}

/** True when the engine re-encoded an existing item of this (shared) array after `gen`. */
function editedSince(items: SceneItem[], gen: number): boolean {
  const g = (items as SceneItem[] & { __editGen?: number }).__editGen
  return g != null && g > gen
}

const APPEND_SAFE = new Set(['symbol', 'text', 'rule', 'tick'])

interface Box { x1: number; y1: number; x2: number; y2: number }

/**
 * Conservative painted extent of a group: a dry run of the real renderer
 * against a context that only accumulates bounds (stroke widths and text
 * extents over-estimated, clips ignored). Used to decide whether appended marks
 * could land on paint that a full repaint draws ABOVE them.
 */
function paintExtent(group: SceneGroup, scene: SceneRoot, plotW: number, plotH: number, opts: RenderCanvasOptions): Box | null {
  const rec = new ExtentContext()
  renderGroup(group, rec, scene, plotW, plotH, { ...opts, batchSymbols: false })
  return rec.box
}

/** Records the bounding box of everything a renderer would paint. */
class ExtentContext implements CanvasLike {
  box: Box | null = null
  private m: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0]
  private stack: Array<{ m: [number, number, number, number, number, number]; lineWidth: number; font: string }> = []
  private pts: Array<[number, number]> = []
  fillStyle: unknown = '#000'
  strokeStyle: unknown = '#000'
  globalAlpha = 1
  lineWidth = 1
  lineCap = 'butt'
  lineJoin = 'miter'
  miterLimit = 10
  font = '10px sans-serif'
  textAlign = 'start'
  textBaseline = 'alphabetic'
  private tr(x: number, y: number): [number, number] {
    const m = this.m
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
  }
  private add(x: number, y: number): void { this.pts.push(this.tr(x, y)) }
  private merge(pts: Array<[number, number]>, grow: number): void {
    for (const [x, y] of pts) {
      if (!(Number.isFinite(x) && Number.isFinite(y))) continue
      const b = this.box ?? (this.box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity })
      if (x - grow < b.x1) b.x1 = x - grow
      if (y - grow < b.y1) b.y1 = y - grow
      if (x + grow > b.x2) b.x2 = x + grow
      if (y + grow > b.y2) b.y2 = y + grow
    }
  }
  save(): void { this.stack.push({ m: [...this.m] as ExtentContext['m'], lineWidth: this.lineWidth, font: this.font }) }
  restore(): void { const s = this.stack.pop(); if (s) { this.m = s.m; this.lineWidth = s.lineWidth; this.font = s.font } }
  translate(x: number, y: number): void { this.m = [this.m[0], this.m[1], this.m[2], this.m[3], this.m[0] * x + this.m[2] * y + this.m[4], this.m[1] * x + this.m[3] * y + this.m[5]] }
  scale(x: number, y: number): void { this.m = [this.m[0] * x, this.m[1] * x, this.m[2] * y, this.m[3] * y, this.m[4], this.m[5]] }
  rotate(a: number): void {
    const c = Math.cos(a), s = Math.sin(a), m = this.m
    this.m = [m[0] * c + m[2] * s, m[1] * c + m[3] * s, m[2] * c - m[0] * s, m[3] * c - m[1] * s, m[4], m[5]]
  }
  beginPath(): void { this.pts = [] }
  moveTo(x: number, y: number): void { this.add(x, y) }
  lineTo(x: number, y: number): void { this.add(x, y) }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void { this.add(a, b); this.add(c, d); this.add(x, y) }
  quadraticCurveTo(a: number, b: number, x: number, y: number): void { this.add(a, b); this.add(x, y) }
  arc(x: number, y: number, r: number): void { this.add(x - r, y - r); this.add(x + r, y + r); this.add(x - r, y + r); this.add(x + r, y - r) }
  closePath(): void {}
  rect(x: number, y: number, w: number, h: number): void { this.add(x, y); this.add(x + w, y + h); this.add(x + w, y); this.add(x, y + h) }
  clip(): void {}
  fill(): void { this.merge(this.pts, 1) }
  // A stroke reaches half a line width (times the miter limit at sharp corners) past the path.
  stroke(): void { this.merge(this.pts, Math.max(1, this.lineWidth * Math.hypot(this.m[0], this.m[1])) * 2 + 1) }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.merge([this.tr(x, y), this.tr(x + w, y + h), this.tr(x + w, y), this.tr(x, y + h)], 1)
  }
  setLineDash(): void {}
  fillText(text: string, x: number, y: number): void {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 11)
    // wide enough for any glyph run at this size and any alignment/baseline
    const w = text.length * size * 1.2 + size
    this.merge([this.tr(x - w, y - size * 1.5), this.tr(x + w, y + size * 1.5), this.tr(x - w, y + size * 1.5), this.tr(x + w, y - size * 1.5)], 2)
  }
  drawImage(_image: unknown, dx: number, dy: number, dw = 0, dh = 0): void {
    this.merge([this.tr(dx, dy), this.tr(dx + dw, dy + dh), this.tr(dx + dw, dy), this.tr(dx, dy + dh)], 1)
  }
  createLinearGradient(): GradientLike { return { addColorStop() {} } }
}

const boxesOverlap = (a: Box, b: Box): boolean => a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2

/**
 * Paint only the appended items of a streamed scene on top of the existing
 * canvas. Returns false when the result would not be exactly what a full
 * repaint draws, so the caller repaints in full:
 *
 * - anything but ONE mark group gained items at its end, and every existing
 *   item of every mark group is untouched (same lineage, no in-place re-encode);
 * - every guide/group is unchanged (a changed one cannot be painted in place
 *   without ghosting its old self; the context has no clear);
 * - nothing painted AFTER the appended group could be covered by the appended
 *   items (a full repaint draws those later groups above them: legend, title).
 */
export function renderSceneToCanvasAppend(
  prev: CanvasSceneSnapshot,
  next: SceneRoot,
  ctx: CanvasLike,
  opts: RenderCanvasOptions = {},
): boolean {
  const a = prev.scene
  if (a.width !== next.width || a.height !== next.height) return false
  if (a.background !== next.background) return false
  if (a.frameStroke !== next.frameStroke || a.frameFill !== next.frameFill
    || a.frameStrokeWidth !== next.frameStrokeWidth || a.frameClip !== next.frameClip) return false
  if ((a.defs?.length ?? 0) || (next.defs?.length ?? 0)) return false
  if (a.items.length !== next.items.length) return false
  const pa = a.padding ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const pb = next.padding ?? { top: 0, right: 0, bottom: 0, left: 0 }
  if (pa.top !== pb.top || pa.right !== pb.right || pa.bottom !== pb.bottom || pa.left !== pb.left) return false

  let appendIndex = -1
  let appendFrom = 0
  for (let i = 0; i < next.items.length; i++) {
    const ng = next.items[i]!
    const pg = a.items[i]!
    if (ng.role === 'mark' && pg.role === 'mark') {
      // Never read `pg.items`: a superseded group's items are a lazy snapshot
      // and reading them materialises an O(n) copy per frame. Everything the
      // append path needs about the previous scene is in the snapshot.
      const oldLen = prev.markLengths.get(pg)
      const snapArr = prev.markArrays.get(pg)
      if (oldLen === undefined || snapArr === undefined) return false
      if (ng.marktype !== pg.marktype || ng.clip !== pg.clip || ng.x !== pg.x || ng.y !== pg.y
        || ng.clipPathD !== pg.clipPathD || ng.width !== pg.width || ng.height !== pg.height) return false
      const nItems = (ng.items as SceneItem[] | undefined) ?? []
      // A different array is a structural rebuild (re-mapped or re-encoded
      // rows): not an append on top of what is painted.
      if (nItems !== snapArr) return false
      if (nItems.length < oldLen) return false
      // The very same group object is not a superseded one (its items are
      // live): an item re-encoded under it carries a newer `__gen`.
      // (an array the engine advances in place stamps every in-place re-encode: `editedSince` below sees it without the scan)
      if (ng === pg && (nItems as SceneItem[] & { __engineItems?: true }).__engineItems !== true) {
        for (let j = 0; j < oldLen; j++) {
          const gen = (nItems[j] as SceneItem & { __gen?: number }).__gen
          if (gen != null && gen > prev.gen) return false
        }
      }
      // The same array carries an in-place re-encode of an existing item
      // (stamped with that evaluation's generation), in ANY reused group, also
      // one that did not grow.
      if (editedSince(nItems, prev.gen)) return false
      if (nItems.length > oldLen) {
        if (appendIndex >= 0 || !APPEND_SAFE.has(String(ng.marktype)) || ng.clip === true) return false
        appendIndex = i
        appendFrom = oldLen
      }
      continue
    }
    if (ng === pg) continue
    // A changed guide cannot be painted in place: the old one stays underneath.
    if (!samePaintedGroup(pg, ng)) return false
  }
  if (appendIndex < 0) return false

  const plotW = next.plotWidth ?? next.width - pb.left - pb.right
  const plotH = next.plotHeight ?? next.height - pb.top - pb.bottom
  const g = next.items[appendIndex]!
  const nItems = (g.items as SceneItem[] | undefined) ?? []
  const slice: SceneGroup = { ...g, items: nItems.slice(appendFrom) }

  // Paint a full repaint draws above the appended group (legend, title, later
  // marks): appended items landing on it would be drawn over it instead.
  let appendedExtent: Box | null | undefined
  for (let i = appendIndex + 1; i < next.items.length; i++) {
    const later = next.items[i]!
    if (!(later.items?.length ?? 0)) continue
    appendedExtent ??= paintExtent(slice, next, plotW, plotH, opts)
    if (appendedExtent == null) break
    const ext = laterExtent(later, next, plotW, plotH, opts)
    if (ext != null && boxesOverlap(appendedExtent, ext)) return false
  }

  ctx.save()
  if (opts.dpr != null && opts.dpr !== 1) ctx.scale(opts.dpr, opts.dpr)
  ctx.miterLimit = 4 // the same graphics state a full repaint paints under
  ctx.translate(pb.left, pb.top)
  renderGroup(slice, ctx, next, plotW, plotH, opts)
  ctx.restore()
  return true
}

// ---------------------------------------------------------------------------
// Dirty-region repaint
// ---------------------------------------------------------------------------

/**
 * Keys of a scene item the canvas renderer never reads: what the item says to a pointer or a reader, not what it paints (its
 * tooltip, link, cursor, description and ARIA). Two items that differ only in these paint the same pixels.
 */
const UNPAINTED_KEYS = new Set(['tooltip', 'href', 'cursor', 'description', 'aria', 'ariaRole', 'ariaRoleDescription'])

/** `samePaint` over what the canvas renderer reads of two values (`UNPAINTED_KEYS` aside), with a visit budget. */
function samePixels(a: unknown, b: unknown, budget: { n: number }, depth = 0): boolean {
  if (Object.is(a, b)) return true
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false
  if (depth > 8 || --budget.n < 0) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!samePixels(a[i], b[i], budget, depth + 1)) return false
    return true
  }
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const counted = (r: Record<string, unknown>, k: string): boolean =>
    Object.hasOwn(r, k) && !k.startsWith('__') && !NON_PAINT_KEYS.has(k) && !UNPAINTED_KEYS.has(k) && typeof r[k] !== 'function'
  let na = 0
  for (const k in ra) {
    if (!counted(ra, k)) continue
    na++
    if (!samePixels(ra[k], rb[k], budget, depth + 1)) return false
  }
  let nb = 0
  for (const k in rb) if (counted(rb, k)) nb++
  return na === nb
}

/** The scene's own paint (size, background, padding, frame, gradient definitions): every key but its content and bookkeeping. */
const ROOT_CONTENT = new Set(['items', 'signalParams', 'runtime', 'compiled'])
function sameRootPaint(a: SceneRoot, b: SceneRoot): boolean {
  const ra = a as unknown as Record<string, unknown>
  const rb = b as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)])
  for (const k of keys) {
    if (ROOT_CONTENT.has(k) || k.startsWith('__')) continue
    if (!samePixels(ra[k], rb[k], { n: 10_000 })) return false
  }
  return true
}

/** A mark group's own paint: every key of the group but its items. */
function sameMarkFrame(a: SceneGroup, b: SceneGroup): boolean {
  const ra = a as unknown as Record<string, unknown>
  const rb = b as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)])
  for (const k of keys) {
    if (k === 'items' || k.startsWith('__') || NON_PAINT_KEYS.has(k) || UNPAINTED_KEYS.has(k)) continue
    if (!samePixels(ra[k], rb[k], { n: 10_000 })) return false
  }
  return true
}

/**
 * Whether the scene paints exactly the pixels of the frame on the canvas (`prev`, the snapshot of the scene painted last): every
 * top-level group the very one painted, or one that paints the same -- in a mark, item by item, what the canvas renderer reads of it
 * being the same (an item whose tooltip alone changed paints the same) -- with the same size, background, padding, frame and
 * gradient definitions. Such a scene needs no paint at all: the canvas already shows it.
 *
 * A scene that paints anything differently is repainted in full. A repaint of the changed region alone, clipped to it, is not
 * always what a full repaint draws: Chromium rasterises the anti-aliased edge of a path cut by the clip differently from the same
 * path uncut (a pixel or two along the clip's edges; the dirty-region oracle, browser-canvas-dirty.mts, found it in about half the
 * region repaints it tried), so the canvas never paints a region of its own.
 */
export function paintsSameAs(prev: CanvasSceneSnapshot, next: SceneRoot): boolean {
  const a = prev.scene
  if (a === next) return true
  if (a.items.length !== next.items.length || !sameRootPaint(a, next)) return false
  for (let i = 0; i < next.items.length; i++) {
    const ng = next.items[i]!
    const pg = a.items[i]!
    if (ng === pg) continue
    if (ng.role === 'mark' && pg.role === 'mark' && ng.marktype === pg.marktype && ng.marktype !== undefined && ng.marktype !== 'group' && sameMarkFrame(pg, ng)) {
      const ni = (ng.items as SceneItem[] | undefined) ?? []
      // (the array painted, which an append or an in-place edit of the engine's advances: never read the superseded group's items,
      // a lazy snapshot whose reading copies them; see renderSceneToCanvasAppend)
      if (ni === prev.markArrays.get(pg)) {
        if (ni.length !== prev.markLengths.get(pg) || editedSince(ni, prev.gen)) return false
        continue
      }
      const pi = (pg.items as SceneItem[] | undefined) ?? []
      if (ni.length !== pi.length) return false
      for (let j = 0; j < ni.length; j++) if (ni[j] !== pi[j] && !samePixels(pi[j], ni[j], { n: 10_000 })) return false
      continue
    }
    if (!samePixels(pg, ng, { n: 50_000 })) return false
  }
  return true
}

/** Painted extent of an unchanged group after the appended one, cached per group object. */
const LATER_EXTENT = new WeakMap<SceneGroup, Box | null>()
function laterExtent(group: SceneGroup, scene: SceneRoot, plotW: number, plotH: number, opts: RenderCanvasOptions): Box | null {
  if (LATER_EXTENT.has(group)) return LATER_EXTENT.get(group)!
  const box = paintExtent(group, scene, plotW, plotH, opts)
  LATER_EXTENT.set(group, box)
  return box
}

/**
 * A mark as vega's canvas draws it: without the items a pass that stopped in their mark's bounds never measured (`unmeasuredFrom`:
 * the item that failed and those after it; a line's or an area's, all of it). vega draws an item only where its bounds meet the view,
 * and an item never measured has none.
 */
function measured(group: SceneGroup): SceneGroup {
  const from = group.unmeasuredFrom
  if (from === undefined) return group
  return { ...group, items: (group.items ?? []).slice(0, from) } as SceneGroup
}

function renderGroup(group: SceneGroup, ctx: CanvasLike, scene: SceneRoot, plotW: number, plotH: number, opts: RenderCanvasOptions = {}): void {
  const type = group.marktype
  if (!type || type === 'group') {
    ctx.save()
    // vega's mark-level `clip`: the mark container is clipped to the ENCLOSING group's frame, or to the shape the clip is
    if (group.markClip === true) {
      ctx.beginPath()
      if (group.markClipPathD !== undefined) tracePath(ctx, parsePathData(group.markClipPathD), 0, 0)
      else ctx.rect(0, 0, plotW, plotH)
      ctx.clip()
    }
    if (group.x != null || group.y != null) ctx.translate(group.x ?? 0, group.y ?? 0)
    // a group's content frame is its own width x height (the root plot size for the guide groups that have none)
    const gw = group.width ?? plotW
    const gh = group.height ?? plotH
    if (group.clip === true) {
      ctx.beginPath()
      if (group.clipPathD !== undefined) tracePath(ctx, parsePathData(group.clipPathD), group.x ?? 0, group.y ?? 0)
      else ctx.rect(0, 0, gw, gh)
      ctx.clip()
    }
    // (a gradient on the group's own box is laid over the group's bounds -- the box, the stroke, what it holds -- as vega's canvas does;
    // a guide's box carries the bounds of its group item, see `leafGradientBox`)
    const bgBox = (group.items ?? []).some((it) => (it as { _bg?: boolean; _itemBounds?: unknown })._bg === true && (it as { _itemBounds?: unknown })._itemBounds === undefined && (isGradientPaint(it.fill) || isGradientPaint(it.stroke)))
      ? groupGradientBox(group)
      : undefined
    // (an axis's leaves hold the half-pixel shift its group item has in vega; vega draws them in the frame of its group item, which the
    // scene keeps as where the axis's box is)
    const axis = group.role === 'axis' ? (group as unknown as { axis?: { translate?: number } }).axis : undefined
    const bake = axis?.translate ?? 0
    const leafFrame = axis !== undefined && group.box !== undefined ? { x: group.box.x ?? 0, y: group.box.y ?? 0 } : undefined
    // (a guide's group item -- an axis's, a title's -- is held as its box: drawn before what the guide holds, its stroke in front
    // after; as vega draws a group item's box, only when it has a fill or a stroke)
    const box = group.box !== undefined && (group.box.fill || group.box.stroke) ? group.box : undefined
    const boxFg = group.boxFg !== undefined && group.boxFg.stroke ? group.boxFg : undefined
    const guideBox = box !== undefined && (box as { _itemBounds?: unknown })._itemBounds === undefined && (isGradientPaint(box.fill) || isGradientPaint(box.stroke) || (boxFg !== undefined && isGradientPaint(boxFg.stroke))) ? groupGradientBox(group) : undefined
    // (vega draws a group item's box in the frame of the group around it, which is where a gradient it paints as a pattern sits)
    const outer = { x: -(group.x ?? 0), y: -(group.y ?? 0) }
    if (box !== undefined) renderLeafItem(box, ctx, scene, guideBox, 0, outer)
    for (const item of group.items ?? []) {
      if (isGroup(item)) renderGroup(item, ctx, scene, gw, gh, opts)
      // (a leaf whose bounds the pass never measured: vega's canvas draws only what meets the view's bounds, see `_unmeasured`)
      else if ((item as { _unmeasured?: boolean })._unmeasured === true) continue
      else if ((item as { _bg?: boolean })._bg === true) renderLeafItem(item, ctx, scene, bgBox, bake, (item as { _frame?: Frame })._frame ?? (item === group.items![0] || item === group.items![group.items!.length - 1] ? outer : undefined))
      else renderLeafItem(item, ctx, scene, undefined, bake, (item as { _frame?: Frame })._frame ?? leafFrame)
    }
    if (boxFg !== undefined) renderLeafItem(boxFg, ctx, scene, guideBox, 0, outer)
    ctx.restore()
    return
  }
  if (group.clip === true) {
    ctx.save()
    ctx.beginPath()
    if (group.clipPathD !== undefined) tracePath(ctx, parsePathData(group.clipPathD), group.x ?? 0, group.y ?? 0)
    else ctx.rect(0, 0, plotW, plotH)
    ctx.clip()
    renderMark(type, measured(group), ctx, scene, opts)
    ctx.restore()
    return
  }
  renderMark(type, measured(group), ctx, scene, opts)
}

/** Resolve a paint value; `{gradient: id}` resolves through scene defs. */
function resolvePaint(
  paint: string | { gradient: string } | object | undefined,
  ctx: CanvasLike,
  defs: SceneDefs[] | undefined,
  bbox: { x1: number; y1: number; x2: number; y2: number } | null,
): unknown {
  if (paint == null) return undefined
  let def: SceneDef | undefined
  let id: string | undefined
  if (isGradientObject(paint)) {
    // a gradient object (vega's own paint): its definition is a function of it
    def = gradientDefOf(paint)
    id = def.id
  } else {
    if (typeof paint === 'string') {
      // Scene items reference gradients as `url(#gradient_N)` (matching the SVG
      // serialization); resolve through the scene defs.
      const mm = /^url\(#(?:p_)?([^)]+)\)$/.exec(paint)
      if (!mm) return paint
      id = mm[1]!
    } else {
      id = (paint as { gradient: string }).gradient
    }
    def = defs?.find((d) => d.id === id)
  }
  if (!def || !bbox) {
    // Dangling gradient reference (no def): pass the reference through so the
    // record matches the SVG serialization.
    return typeof paint === 'string' ? paint : undefined
  }
  const w = bbox.x2 - bbox.x1
  const h = bbox.y2 - bbox.y1
  const p = (v: number | undefined, d: number): number => (v != null ? v : d)
  let g
  if (def.kind === 'radial') {
    if (!ctx.createRadialGradient) return undefined
    // vega-scenegraph canvas gradient(): coordinates are fractions of the item's box, radii of its larger side
    g = ctx.createRadialGradient(
      bbox.x1 + p(def.x1, 0.5) * w, bbox.y1 + p(def.y1, 0.5) * h, Math.max(w, h) * p(def.r1, 0),
      bbox.x1 + p(def.x2, 0.5) * w, bbox.y1 + p(def.y2, 0.5) * h, Math.max(w, h) * p(def.r2, 0.5),
    )
  } else if (def.x1 != null || def.y1 != null || def.x2 != null || def.y2 != null) {
    const x1 = p(def.x1, 0), y1 = p(def.y1, 0), x2 = p(def.x2, 1), y2 = p(def.y2, 0)
    if (!(x1 === x2 || y1 === y2 || w === h)) {
      // not axis aligned: vega's canvas renders the gradient into a w x h image in normalized box coordinates and paints with a
      // no-repeat pattern of it (#2365) -- a pattern sits at the origin of the context, not at the item
      const pattern = diagonalGradient(ctx, def.colorStops, x1, y1, x2, y2, w, h)
      if (pattern !== undefined) return pattern
    }
    g = ctx.createLinearGradient(
      bbox.x1 + x1 * w, bbox.y1 + y1 * h,
      bbox.x1 + x2 * w, bbox.y1 + y2 * h,
    )
  } else {
    const horiz = def.direction === 'horizontal'
    // SVG objectBoundingBox fractions applied to the element's bbox.
    const fx0 = horiz ? 0 : 0, fy0 = horiz ? 0 : 1
    const fx1 = horiz ? 1 : 0, fy1 = horiz ? 0 : 0
    g = ctx.createLinearGradient(
      bbox.x1 + fx0 * w, bbox.y1 + fy0 * h,
      bbox.x1 + fx1 * w, bbox.y1 + fy1 * h,
    )
  }
  for (const stop of def.colorStops) g.addColorStop(stop.offset, stop.color)
  // (the reference an svg paint writes for it: a radial gradient is reached through its pattern)
  ;(g as unknown as { __gradId?: string }).__gradId = (def.kind === 'radial' ? 'p_' : '') + id
  return g
}

interface Bbox { x1: number; y1: number; x2: number; y2: number }

/** vega-scenegraph util/canvas/gradient.js, the non-axis-aligned branch: the gradient in an image, as a no-repeat pattern. */
function diagonalGradient(ctx: CanvasLike, stops: ReadonlyArray<{ offset: number; color: string }>, x1: number, y1: number, x2: number, y2: number, w: number, h: number): unknown {
  if (!ctx.createPattern || !(w > 0) || !(h > 0)) return undefined
  const host = (ctx as unknown as { canvas?: { ownerDocument?: { createElement(tag: string): unknown } } }).canvas
  const g = globalThis as unknown as { document?: { createElement(tag: string): unknown }; OffscreenCanvas?: new (w: number, h: number) => unknown }
  const doc = host?.ownerDocument ?? g.document
  let image: { width: number; height: number; getContext(type: string): CanvasLike | null } | undefined
  if (doc) {
    image = doc.createElement('canvas') as typeof image
    if (image) { image.width = Math.ceil(w); image.height = Math.ceil(h) }
  } else if (g.OffscreenCanvas) {
    image = new g.OffscreenCanvas(Math.ceil(w), Math.ceil(h)) as typeof image
  }
  const ictx = image?.getContext('2d')
  if (!image || !ictx) return undefined
  ictx.scale(w, h)
  const gradient = ictx.createLinearGradient(x1, y1, x2, y2)
  for (const stop of stops) gradient.addColorStop(stop.offset, stop.color)
  ictx.fillStyle = gradient
  ictx.fillRect(0, 0, w, h)
  return ctx.createPattern(image, 'no-repeat') ?? undefined
}

/**
 * The box a gradient is laid over: vega's `item.bounds`, which is the item's bounds with its stroke (a miter join for arcs, symbols
 * and paths) -- or, for a line / area / trail, the bounds of the whole mark, held by its first item.
 */
function gradientBox(it: SceneItem, mark?: SceneGroup, miter = true): Bbox | undefined {
  if (!(isGradientPaint(it.fill) || isGradientPaint(it.stroke))) return undefined
  const b = mark ? boundTypedMark(new Bounds(), mark) : boundLeaf(new Bounds(), it, miter)
  return b.empty() ? undefined : { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }
}

/** The bounds of a group item in its own frame (its origin where its content starts): what a gradient on its box is laid over. */
function groupGradientBox(group: SceneGroup): Bbox | undefined {
  const b = boundLeaf(new Bounds(), { ...group, x: 0, y: 0 } as unknown as SceneItem, true)
  return b.empty() ? undefined : { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }
}

/**
 * The box a gradient on a guide's leaf is laid over: vega's `item.bounds` of the item the leaf stands for, in the frame the leaf is
 * drawn in. A group item's box carries its item's bounds (`_itemBounds`, in its own frame: a legend's, an entry's, an axis's); a
 * legend's strip or band is a rect item, a rule (an axis's tick, grid line or domain) a rule item, a symbol a symbol item (its
 * stroke's miter included). `bake` is the shift the scene baked into an axis's leaves, which vega's bounds do not hold: for a turned
 * leaf, whose gradient is laid in its turned frame, it comes back out.
 */
function leafGradientBox(it: SceneItem, bake = 0): Bbox | undefined {
  if (!(isGradientPaint(it.fill) || isGradientPaint(it.stroke))) return undefined
  const own = (it as unknown as Record<string, unknown>)._itemBounds as Bbox | undefined
  if (own !== undefined) {
    const x = it.x ?? 0
    const y = it.y ?? 0
    return { x1: own.x1 + x, y1: own.y1 + y, x2: own.x2 + x, y2: own.y2 + y }
  }
  const part = it._part
  const b = part === 'gradient' || part === 'band' ? stripBounds(it)
    : it.path == null && it.text == null && it.shape == null ? boundLeaf(new Bounds(), { ...it, _kind: 'rule' } as SceneItem, false, 'rule')
    : part === 'symbol' ? boundLeaf(new Bounds(), it, true, 'symbol')
    : boundLeaf(new Bounds(), it, true)
  if (b.empty()) return undefined
  if (bake && itemAngle(it)) b.translate(-bake, -bake)
  return { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }
}

/** A legend's strip or band, a rect item (drawn as the path of its box at its position): its box and its stroke, no miter. */
function stripBounds(it: SceneItem): Bounds {
  const x = it.x ?? 0
  const y = it.y ?? 0
  const w = Number(it.width) || 0
  const h = Number(it.height) || 0
  return boundStroke(new Bounds().set(Math.min(x, x + w), Math.min(y, y + h), Math.max(x, x + w), Math.max(y, y + h)), it)
}

/** Compute the bbox of parsed segments (for objectBoundingBox gradients). */
function segsBbox(segs: PathSeg[]): Bbox {
  const bb: Bbox = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
  const add = (x: number, y: number): void => {
    if (x < bb.x1) bb.x1 = x
    if (y < bb.y1) bb.y1 = y
    if (x > bb.x2) bb.x2 = x
    if (y > bb.y2) bb.y2 = y
  }
  let cx = 0, cy = 0
  for (const s of segs) {
    if ('x' in s && 'y' in s) { add(s.x, s.y); cx = s.x; cy = s.y }
    else if ('x' in s) { add(s.x, cy); cx = s.x }
    else if ('y' in s) { add(cx, s.y); cy = s.y }
    if ('c1x' in s) { add(s.c1x, s.c1y); add(s.c2x, s.c2y) }
    if ('c2x' in s && !('c1x' in s)) { add(s.c2x, s.c2y) }
    if ('cx' in s && !('c2x' in s) && !('c1x' in s)) { add(s.cx, s.cy) }
  }
  if (!Number.isFinite(bb.x1)) return { x1: 0, y1: 0, x2: 0, y2: 0 }
  return bb
}

/**
 * Paint a traced path exactly like vega-scenegraph's canvas `drawPath`
 * (util/canvas/draw.js + fill.js + stroke.js):
 *   - opacity 0 paints nothing;
 *   - fill: globalAlpha = opacity * fillOpacity (skipped when 0);
 *   - stroke: skipped for strokeWidth <= 0 (default 1); globalAlpha =
 *     opacity * strokeOpacity; lineCap/lineJoin/miterLimit/dash/dashOffset are
 *     ALWAYS (re)set from the item, so one item's cap never leaks into the next;
 *   - blend sets globalCompositeOperation.
 * `bbox` overrides the path bounds used to place objectBoundingBox gradients.
 */
function paintPath(
  ctx: CanvasLike,
  segs: PathSeg[] | (() => PathSeg[]),
  it: SceneItem,
  defs: SceneDefs[] | undefined,
  op: 'auto' | 'fill' | 'stroke',
  bbox?: Bbox,
  path?: unknown,
): void {
  const opacity = it.opacity == null ? 1 : (it.opacity as number)
  if (opacity === 0) return
  const fill = op === 'stroke' ? undefined : it.fill
  const stroke = op === 'fill' ? undefined : it.stroke
  const isGradient = (p: unknown): boolean =>
    (typeof p === 'string' && p.startsWith('url(#')) || (p != null && typeof p === 'object' && 'gradient' in (p as object))
  // Gradient resolution is the only consumer of the bbox; skip the segment walk
  // for the common solid-paint case (thousands of symbols per frame).
  const bb = bbox ?? (isGradient(fill) || isGradient(stroke) ? segsBbox(typeof segs === 'function' ? segs() : segs) : null)
  const rec = it as unknown as Record<string, unknown>
  if (rec.blend != null) ctx.globalCompositeOperation = String(rec.blend)
  // (vega's canvas draws a paint only when it is truthy: an empty string is none, while its SVG writes the attribute)
  if (fill != null && (fill as unknown) !== false && fill !== 'transparent' && fill !== '') {
    const a = opacity * (it.fillOpacity == null ? 1 : (it.fillOpacity as number))
    if (a > 0) {
      ctx.globalAlpha = a
      const paint = resolvePaint(fill, ctx, defs, bb)
      // Dangling references and non-string paints serialize as their string form.
      ctx.fillStyle = (paint !== undefined ? paint : String(fill)) as string
      if (path === undefined) ctx.fill()
      else ctx.fill(path)
    }
  }
  if (stroke != null && (stroke as unknown) !== false && stroke !== 'transparent' && stroke !== '') {
    const lw = it.strokeWidth != null ? (it.strokeWidth as number) : 1
    const a = opacity * (it.strokeOpacity == null ? 1 : (it.strokeOpacity as number))
    if (lw > 0 && a > 0) {
      ctx.globalAlpha = a
      const paint = resolvePaint(stroke, ctx, defs, bb)
      if (paint !== undefined) ctx.strokeStyle = paint
      ctx.lineWidth = lw
      ctx.lineCap = it.strokeCap || 'butt'
      ctx.lineJoin = it.strokeJoin || 'miter'
      ctx.miterLimit = it.strokeMiterLimit != null ? it.strokeMiterLimit : 4
      ctx.setLineDash((it.strokeDash as number[] | undefined) ?? [])
      if (ctx.lineDashOffset !== undefined || it.strokeDashOffset != null) ctx.lineDashOffset = it.strokeDashOffset || 0
      if (path === undefined) ctx.stroke()
      else ctx.stroke(path)
      ctx.setLineDash([])
    }
  }
  if (rec.blend != null) ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
}

function fontString(it: SceneItem): string {
  const fontSize = (it as Record<string, unknown>).fontSize as number | undefined ?? 11
  const fontWeight = (it as Record<string, unknown>).fontWeight as string | number | undefined
  const fontStyle = (it as Record<string, unknown>).fontStyle as string | undefined
  const fontVariant = (it as Record<string, unknown>).fontVariant as string | undefined
  const family = (it as Record<string, unknown>).font as string | undefined ?? 'sans-serif'
  // vega-scenegraph util/text.js `font()`: style variant weight size family
  const parts: string[] = []
  if (fontStyle) parts.push(String(fontStyle))
  if (fontVariant) parts.push(String(fontVariant))
  if (fontWeight) parts.push(String(fontWeight))
  parts.push(`${fontSize}px`)
  parts.push(family)
  return parts.join(' ')
}

const itemAngle = (it: SceneItem): number | undefined => (it as Record<string, unknown>).angle as number | undefined

/** The origin of the frame vega draws a leaf in, in the frame the scene holds the leaf in. */
interface Frame { x: number; y: number }

/**
 * Whether a paint is a gradient vega's canvas draws as a pattern (a linear one that is not axis aligned): a pattern sits at the origin
 * of the frame it is painted in, so such a leaf is painted in the frame vega paints it in.
 */
function paintsPattern(p: unknown, defs: SceneDefs[] | undefined): boolean {
  if (p == null || (typeof p !== 'object' && typeof p !== 'string')) return false
  let def: SceneDef | undefined
  if (isGradientObject(p)) def = gradientDefOf(p)
  else if (typeof p === 'string') {
    const m = /^url\(#(?:p_)?([^)]+)\)$/.exec(p)
    if (m === null) return false
    def = defs?.find((d) => d.id === m[1])
  }
  if (def === undefined || def.kind === 'radial' || (def.x1 == null && def.y1 == null && def.x2 == null && def.y2 == null)) return false
  return (def.x1 ?? 0) !== (def.x2 ?? 1) && (def.y1 ?? 0) !== (def.y2 ?? 0)
}

/**
 * Build the path of a symbol of `shape` and radius `r` at (x, y), turned by `angle` degrees, at full precision, as vega's canvas draws a
 * symbol: a circle as one full-turn arc about the item's origin (the same curve as two half turns, rasterized a pixel or two
 * differently by WebKit), any other shape from its own segments. Returns the segments the paint reads.
 */
function traceSymbol(ctx: CanvasLike, shape: string | undefined, r: number, x: number, y: number, angle: number): PathSeg[] {
  const segs = symbolSegs(shape, r)
  if (shape == null || shape === 'circle') buildInItemFrame(ctx, x, y, angle, 1, 1, () => { ctx.moveTo(r, 0); ctx.arc(0, 0, r, 0, 2 * Math.PI, false) })
  else if (angle) buildInItemFrame(ctx, x, y, angle, 1, 1, () => tracePath(ctx, segs))
  else { ctx.beginPath(); tracePath(ctx, segs, x, y) }
  return segs
}

function renderLeafItem(it: SceneItem, ctx: CanvasLike, scene: SceneRoot, box?: Bbox, bake = 0, frame?: Frame): void {
  const defs = scene.defs
  if (frame !== undefined && (frame.x !== 0 || frame.y !== 0) && (paintsPattern(it.fill, defs) || paintsPattern(it.stroke, defs))) {
    // the same leaf, at the same place, in vega's frame
    const fx = frame.x
    const fy = frame.y
    const moved = { ...it, x: (it.x ?? 0) - fx, y: (it.y ?? 0) - fy, ...(it.x2 != null ? { x2: it.x2 - fx } : {}), ...(it.y2 != null ? { y2: it.y2 - fy } : {}) } as SceneItem
    const clip = (it as unknown as Record<string, unknown>)._clip as { x?: number; y?: number } | undefined
    if (clip) (moved as unknown as Record<string, unknown>)._clip = { ...clip, x: (clip.x ?? 0) - fx, y: (clip.y ?? 0) - fy }
    // (the box of a group it stands for, as given, is in the scene's frame; its own bounds move with it)
    const bbox = box ?? leafGradientBox(it, bake)
    ctx.save()
    ctx.translate(fx, fy)
    renderLeafItem(moved, ctx, scene, bbox && { x1: bbox.x1 - fx, y1: bbox.y1 - fy, x2: bbox.x2 - fx, y2: bbox.y2 - fy }, bake)
    ctx.restore()
    return
  }
  // Path items (legend entries, tick labels' misc paths)
  if (it.path != null) {
    const tx = it.x ?? 0
    const ty = it.y ?? 0
    ctx.beginPath()
    // (a group item's box stroked in front is filled where the stroked box is: see `_canvasPath`)
    const rec = it as unknown as Record<string, unknown>
    // a guide's symbol (a legend's): drawn from its shape and radius, as vega's canvas draws it, not from the rounded SVG text
    const symbolRadius = rec._symbolRadius as number | undefined
    const segs = symbolRadius !== undefined ? symbolSegs(rec._symbolShape as string | undefined, symbolRadius)
      : parsePathData((rec._canvasPath as string | undefined) ?? it.path)
    // A clipped legend symbol (clipHeight): clip to the entry's laid-out
    // rect (0,0,w,h) in the item's local frame, matching the SVG renderer's
    // clipPath defs.
    const clip = (it as unknown as Record<string, unknown>)._clip as { x?: number; y?: number; w: number; h: number } | undefined
    if (clip) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(clip.x ?? 0, clip.y ?? 0, clip.w, clip.h)
      ctx.clip()
    }
    if (symbolRadius !== undefined) {
      traceSymbol(ctx, rec._symbolShape as string | undefined, symbolRadius, tx, ty, itemAngle(it) ?? 0)
    } else if (itemAngle(it)) {
      // the SVG element carries translate(x,y) rotate(angle): build in that frame
      buildInItemFrame(ctx, tx, ty, itemAngle(it)!, 1, 1, () => tracePath(ctx, segs))
    } else {
      ctx.beginPath()
      tracePath(ctx, segs, tx, ty)
    }
    paintPath(ctx, segs, it, defs, 'auto', box ?? leafGradientBox(it))
    if (clip) ctx.restore()
    return
  }
  // Symbol items (circle arc path): the SVG leaf renderer draws
  // `M{r},0A{r},{r}…` translated by (x, y) — trace the same path so records
  // match exactly (including gradient bboxes).
  if (it.shape != null && it.radius != null) {
    const segs = leafCircleSegs(it.radius)
    if (itemAngle(it)) {
      buildInItemFrame(ctx, it.x ?? 0, it.y ?? 0, itemAngle(it)!, 1, 1, () => tracePath(ctx, segs))
      paintPath(ctx, segs, it, defs, 'auto')
      return
    }
    ctx.beginPath()
    const moved = segs.map((s) => {
      if (s.cmd === 'Z') return s
      const o = { ...s } as unknown as Record<string, number>
      if (typeof o.x === 'number') o.x += it.x ?? 0
      if (typeof o.y === 'number') o.y += it.y ?? 0
      return o as unknown as typeof s
    })
    tracePath(ctx, moved)
    paintPath(ctx, moved, it, defs, 'auto', leafGradientBox(it))
    return
  }
  if (it._kind === 'text' || (it._kind === undefined && it.text != null)) {
    renderTextItem(it, ctx, defs, bake)
    return
  }
  // Line items (rules)
  const x = it.x ?? 0
  const y = it.y ?? 0
  const x2 = it.x2 ?? x
  const y2 = it.y2 ?? y
  if (it.stroke == null) return
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x2, y2)
  paintPath(ctx, [{ cmd: 'M', x, y }, { cmd: 'L', x: x2, y: y2 }] as PathSeg[], it, defs, 'stroke', leafGradientBox(it))
}

/**
 * A guide leaf symbol's outline, as the SVG leaf renderer writes it about the origin: `M r,0 A r,r,0,1,1,-r,0 A r,r,0,1,1,r,0`
 * with r printed whole when it is an integer and to 3 digits otherwise; these are the segments that text reads back as. (A
 * radius that does not print as a number is read from the text, as it always was.)
 */
function leafCircleSegs(r: number): PathSeg[] {
  const rNum = Number.isInteger(r) ? r : Math.round(r * 1000) / 1000
  if (!Number.isFinite(rNum)) {
    const t = String(rNum)
    return parsePathData(`M${t},0A${t},${t},0,1,1,${-t},0A${t},${t},0,1,1,${t},0`)
  }
  const v = rNum + 0
  return [
    { cmd: 'M', x: v, y: 0 },
    { cmd: 'A', rx: v, ry: v, rot: 0, large: 1, sweep: 1, x: -v + 0, y: 0 },
    { cmd: 'A', rx: v, ry: v, rot: 0, large: 1, sweep: 1, x: v, y: 0 },
  ]
}

/** Paint for arc-drawn symbols (bbox computed analytically). */
function paintPathArc(ctx: CanvasLike, it: SceneItem, defs: SceneDefs[] | undefined): void {
  const cx = it.x ?? 0
  const cy = it.y ?? 0
  const r = it.radius ?? 0
  paintPath(ctx, [], it, defs, 'auto', { x1: cx - r, y1: cy - r, x2: cx + r, y2: cy + r })
}

/**
 * Draw one text item like vega-scenegraph's canvas text `draw` (marks/text.js):
 * opacity 0 / non-positive font size / empty text paint nothing; the anchor,
 * rotation, dx/dy and baseline offset come from `textItemDesc` (the same
 * geometry the SVG `transform` is built from); `textAlign` is the item's align
 * or `left`; fill AND stroke are painted (text can be outlined).
 */
function renderTextItem(it: SceneItem, ctx: CanvasLike, defs: SceneDefs[] | undefined, bake = 0): void {
  const opacity = it.opacity == null ? 1 : (it.opacity as number)
  if (opacity === 0 || (it as Record<string, unknown>).fontSize as number <= 0) return
  const d = textItemDesc(it)
  if (d == null || it.text == null || (typeof it.text === 'string' && it.text.length === 0)) return
  const rec = it as Record<string, unknown>
  ctx.save()
  ctx.font = fontString(it)
  ctx.textAlign = it.align || 'left'
  ctx.textBaseline = 'alphabetic'
  if (rec.blend != null) ctx.globalCompositeOperation = String(rec.blend)
  let x = d.px
  let y = d.py
  if (d.angle) {
    ctx.translate(d.px, d.py)
    ctx.rotate((d.angle * Math.PI) / 180)
    x = d.ox
    y = d.oy
  }
  const fillOk = it.fill != null && (it.fill as unknown) !== false && it.fill !== 'transparent'
  const strokeOk = it.stroke != null && (it.stroke as unknown) !== false && it.stroke !== 'transparent'
  // (a gradient is laid over the item's bounds, as vega's canvas does: the text's box)
  const box = leafGradientBox(it, bake) ?? null
  for (let i = 0; i < d.lines.length; i++) {
    const str = d.lines[i]!
    const ly = i === 0 ? y : y + i * d.lineHeight
    if (fillOk) {
      const a = opacity * (it.fillOpacity == null ? 1 : (it.fillOpacity as number))
      if (a > 0) {
        ctx.globalAlpha = a
        const paint = resolvePaint(it.fill, ctx, defs, box)
        ctx.fillStyle = (paint !== undefined ? paint : String(it.fill)) as string
        // No fourth (maxWidth) argument: a real CanvasRenderingContext2D coerces
        // `false` to 0 and can suppress the glyphs.
        ctx.fillText(str, x, ly)
      }
    }
    if (strokeOk && ctx.strokeText) {
      const lw = it.strokeWidth != null ? (it.strokeWidth as number) : 1
      const a = opacity * (it.strokeOpacity == null ? 1 : (it.strokeOpacity as number))
      if (lw > 0 && a > 0) {
        ctx.globalAlpha = a
        const paint = resolvePaint(it.stroke, ctx, defs, box)
        if (paint !== undefined) ctx.strokeStyle = paint
        ctx.lineWidth = lw
        ctx.lineCap = it.strokeCap || 'butt'
        ctx.lineJoin = it.strokeJoin || 'miter'
        ctx.miterLimit = it.strokeMiterLimit != null ? it.strokeMiterLimit : 4
        ctx.setLineDash((it.strokeDash as number[] | undefined) ?? [])
        if (ctx.lineDashOffset !== undefined || it.strokeDashOffset != null) ctx.lineDashOffset = it.strokeDashOffset || 0
        ctx.strokeText(str, x, ly)
      }
    }
  }
  ctx.restore()
}

function isGradientPaint(p: unknown): boolean {
  return (typeof p === 'string' && p.startsWith('url(#'))
    || (p != null && typeof p === 'object' && 'gradient' in (p as object))
}

/**
 * Build a path in an item's own frame the way vega's mark `draw` does: translate to
 * (x, y), rotate by `angle`, scale (path marks), build, and let the transform go
 * BEFORE the caller fills/strokes (a canvas path is stored in device space, so the
 * stroke width is not rotated or scaled).
 */
function buildInItemFrame(ctx: CanvasLike, x: number, y: number, angle: number, sx: number, sy: number, build: () => void): void {
  ctx.save()
  ctx.translate(x, y)
  if (angle) ctx.rotate((angle * Math.PI) / 180)
  if (sx !== 1 || sy !== 1) ctx.scale(sx, sy)
  ctx.beginPath()
  build()
  ctx.restore()
}

function symbolPaintKey(it: SceneItem): string {
  const rec = it as Record<string, unknown>
  return [
    rec.shape ?? 'circle', it.size, it.fill, it.stroke, it.strokeWidth,
    rec.angle, rec.opacity, rec.fillOpacity, rec.strokeOpacity, rec.strokeDash, it.strokeCap, it.strokeJoin, it.strokeDashOffset, it.strokeMiterLimit, rec.blend,
  ].map((v) => (v == null ? '' : Array.isArray(v) ? v.join(',') : String(v))).join('|')
}

/** A path object a run of symbols can be assembled in (`Path2D`). */
interface RunPath extends PathSink {
  addPath(path: RunPath): void
}

/**
 * A new empty `Path2D`, when the context is a browser's 2D context (a page's or an OffscreenCanvas's); null for any other
 * context (a recording, a test double, a node canvas), which gets the symbols on its own current path.
 *
 * Why it exists: Blink measures the whole path on every `closePath`, so closing N symbols one after another in a path that
 * keeps growing costs N squared (100k squares: 17 seconds, circles, which never close, 0.2). A closed symbol traced as a
 * `Path2D` of its own and then added to the run's path closes in constant time, with the same points, so the same pixels.
 */
function runPath(ctx: CanvasLike): RunPath | null {
  const g = globalThis as unknown as { Path2D?: new () => RunPath; CanvasRenderingContext2D?: abstract new () => unknown; OffscreenCanvasRenderingContext2D?: abstract new () => unknown }
  if (typeof g.Path2D !== 'function') return null
  const isPage = typeof g.CanvasRenderingContext2D === 'function' && ctx instanceof g.CanvasRenderingContext2D
  const isOffscreen = typeof g.OffscreenCanvasRenderingContext2D === 'function' && ctx instanceof g.OffscreenCanvasRenderingContext2D
  return isPage || isOffscreen ? new g.Path2D() : null
}

/**
 * Large symbol groups are almost always a dense scatter with a handful of
 * paints. Batch consecutive same-paint items into one path so a 100k-point
 * repaint is one fill/stroke per run instead of one per item.
 */
function renderSymbolRuns(items: SceneItem[], ctx: CanvasLike, defs: SceneDefs[] | undefined): void {
  let run: SceneItem[] = []
  let key = ''
  const flush = (): void => {
    if (!run.length) return
    if (run[0]!.angle || run.some((it) => isGradientPaint(it.fill) || isGradientPaint(it.stroke))) {
      for (const it of run) {
        const x = it.x || 0
        const y = it.y || 0
        const r = Math.sqrt((it.size as number) ?? SYMBOL_DEFAULT_SIZE) / 2
        const segs = symbolSegs((it as Record<string, unknown>).shape as string | undefined, r)
        buildInItemFrame(ctx, x, y, ((it as Record<string, unknown>).angle as number) || 0, 1, 1, () => tracePath(ctx, segs))
        paintPath(ctx, segs, it, defs, 'auto', gradientBox(it))
      }
      run = []
      return
    }
    const first = run[0]!
    const shape0 = (first as Record<string, unknown>).shape as string | undefined
    const radiusOf = (it: SceneItem): number => Math.sqrt((it.size as number) ?? SYMBOL_DEFAULT_SIZE) / 2
    const closed = shape0 != null && shape0 !== 'circle' && symbolSegs(shape0, radiusOf(first)).some((sg) => sg.cmd === 'Z' || sg.cmd === 'z')
    const whole = closed ? runPath(ctx) : null
    if (whole !== null) {
      for (const it of run) {
        const one = runPath(ctx)!
        tracePath(one, symbolSegs(shape0, radiusOf(it)), it.x || 0, it.y || 0)
        whole.addPath(one)
      }
      paintPath(ctx, [], first, defs, 'auto', undefined, whole)
      run = []
      return
    }
    ctx.beginPath()
    for (const it of run) {
      const x = it.x || 0
      const y = it.y || 0
      const r = radiusOf(it)
      const shape = (it as Record<string, unknown>).shape as string | undefined
      if (shape == null || shape === 'circle') {
        ctx.moveTo(x + r, y)
        ctx.arc(x, y, r, 0, 2 * Math.PI, false)
      } else {
        tracePath(ctx, symbolSegs(shape, r), x, y)
      }
    }
    paintPath(ctx, [], first, defs, 'auto')
    run = []
  }
  for (const it of items) {
    const k = symbolPaintKey(it)
    if (run.length && k !== key) flush()
    key = k
    run.push(it)
  }
  flush()
}

function renderMark(type: string, group: SceneGroup, ctx: CanvasLike, scene: SceneRoot, opts: RenderCanvasOptions = {}): void {
  const defs = scene.defs
  switch (type) {
    case 'line': {
      const geometry = lineGeometry(group.items ?? [])
      if (geometry === null || geometry.empty) return
      ctx.beginPath()
      drawCurveExact(geometry, ctx)
      // vega draws a line mark from its first item with the full fill + stroke
      // paint (closed lines can be filled); stroke width defaults to 2 with a stroke.
      const first = { ...group.items![0]!, strokeWidth: lineStrokeWidth(group.items![0]!) ?? group.items![0]!.strokeWidth } as SceneItem
      paintPath(ctx, () => curveExactSegs(geometry), first, defs, 'auto', gradientBox(first, group))
      return
    }
    case 'area': {
      const geometry = areaGeometry(group.items ?? [])
      if (geometry === null || geometry.empty) return
      ctx.beginPath()
      drawCurveExact(geometry, ctx)
      paintPath(ctx, () => curveExactSegs(geometry), group.items![0]!, defs, 'auto', gradientBox(group.items![0]!, group))
      return
    }
    case 'symbol': {
      const items = group.items ?? []
      if (opts.batchSymbols !== false && items.length >= 256) {
        renderSymbolRuns(items, ctx, defs)
      } else {
        for (const it of items) {
          // vega's canvas draws a symbol at `item.x || 0`, `item.y || 0`: a NaN or missing position is 0
          const x = it.x || 0
          const y = it.y || 0
          const size = (it.size as number) ?? SYMBOL_DEFAULT_SIZE
          const r = Math.sqrt(size) / 2
          const shape = (it as Record<string, unknown>).shape as string | undefined
          const segs = traceSymbol(ctx, shape, r, x, y, ((it as Record<string, unknown>).angle as number) || 0)
          paintPath(ctx, segs, it, defs, 'auto', gradientBox(it))
        }
      }
      return
    }
    case 'circle': {
      for (const it of group.items ?? []) {
        if (it.x == null || it.y == null) continue
        const r = it.radius != null ? it.radius : Math.sqrt((it.size as number) ?? SYMBOL_DEFAULT_SIZE) / 2
        ctx.beginPath()
        ctx.arc(it.x, it.y, r, 0, 2 * Math.PI, false)
        paintPathArc(ctx, { ...it, radius: r }, defs)
      }
      return
    }
    case 'rect': {
      // vega paints rects in item (data) order and skips unpainted items
      for (const it of group.items ?? []) {
        if (it.fill == null && it.stroke == null) continue
        ctx.beginPath()
        const segs = segsOf(rectData(it))
        tracePath(ctx, segs)
        paintPath(ctx, segs, it, defs, 'auto', gradientBox(it, undefined, false))
      }
      return
    }
    case 'rule': {
      for (const it of group.items ?? []) {
        if (it.stroke == null) continue
        const x = it.x ?? 0
        const y = it.y ?? 0
        const x2 = it.x2 ?? x
        const y2 = it.y2 ?? y
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x2, y2)
        // (a gradient is laid over the item's bounds, the stroke width included, as vega's canvas does)
        paintPath(ctx, [{ cmd: 'M', x, y }, { cmd: 'L', x: x2, y: y2 }] as PathSeg[], it, defs, 'stroke', gradientBox(it))
      }
      return
    }
    case 'text': {
      for (const it of group.items ?? []) {
        renderTextItem(it, ctx, defs)
      }
      return
    }
    case 'trail': {
      const items = group.items ?? []
      if (items.length <= 1) return
      const geometry = trailGeometry(items)!
      if (!geometry.outline.drawn) return
      const first = items[0]!
      ctx.beginPath()
      const segs = arcSegs(geometry)
      tracePath(ctx, segs)
      // The trail polygon carries the FIRST item's full paint set, fill included
      // (Vega-Lite encodes a trail's colour as `fill`).
      paintPath(ctx, segs, first, defs, 'auto', gradientBox(first, group))
      return
    }
    case 'path': {
      // a path mark's text, as far as it reads, drawn as vega draws it (path-data.ts `renderSvgPath`): scaled by (scaleX||1,
      // scaleY||1) and moved to the item in the replay's numbers, or, turned, at the origin of the item's turned frame
      for (const it of group.items ?? []) {
        if (!it.path) continue
        const rec = it as Record<string, unknown>
        const angle = (rec.angle as number) || 0
        const sx = (rec.scaleX as number) || 1
        const sy = (rec.scaleY as number) || 1
        const commands = drawnPathCommands(it.path)
        if (angle) buildInItemFrame(ctx, it.x || 0, it.y || 0, angle, 1, 1, () => renderSvgPath(ctx, commands, 0, 0, sx, sy))
        else {
          ctx.beginPath()
          renderSvgPath(ctx, commands, it.x || 0, it.y || 0, sx, sy)
        }
        const path = it.path
        paintPath(ctx, () => parsePathData(path), it, defs, 'auto', gradientBox(it))
      }
      return
    }
    case 'shape': {
      // (a shape's geo path, the engine's own text, goes to the context as it is, its arcs as arcs)
      for (const it of group.items ?? []) {
        if (!it.path) continue
        const rec = it as Record<string, unknown>
        const angle = (rec.angle as number) || 0
        const sx = (rec.scaleX as number) || 1
        const sy = (rec.scaleY as number) || 1
        const segs = parsePathData(it.path)
        buildInItemFrame(ctx, it.x || 0, it.y || 0, angle, sx, sy, () => tracePath(ctx, segs))
        paintPath(ctx, segs, it, defs, 'auto', gradientBox(it))
      }
      return
    }
    case 'arc': {
      for (const it of group.items ?? []) {
        // The SVG renderer emits the arc path around (0,0) translated by the
        // item position; trace the same local path with the item offset.
        // vega's markItemPath draw: translate/rotate to the item, build the path
        // with the REAL context (d3-arc calls moveTo/arc/lineTo on it), restore
        // the transform, then fill/stroke. Re-deriving the circles from the SVG
        // path string (rounded to 3 decimals) moved near-semicircular arcs.
        const ax = it.x || 0
        const ay = it.y || 0
        const angle = ((it as Record<string, unknown>).angle as number | undefined) || 0
        ctx.translate(ax, ay)
        if (angle) ctx.rotate((angle * Math.PI) / 180)
        ctx.beginPath()
        itemArcGeometry(it).outline.replay(ctx)
        if (angle) ctx.rotate((-angle * Math.PI) / 180)
        ctx.translate(-ax, -ay)
        paintPath(ctx, [], it, defs, 'auto', gradientBox(it))
      }
      return
    }
    case 'image':
      // vega's canvas image draw (marks/image.js): the host supplies the loaded
      // bitmap as `item.image` (this renderer never fetches); an item whose
      // bitmap is absent or incomplete paints nothing, like vega before the
      // image loads. The box is offset by align/baseline; with `aspect` on (the
      // default) the bitmap is letterboxed to its own aspect ratio.
      for (const it of group.items ?? []) {
        const img = itemImage(it)
        if (img == null || img.complete === false) continue
        const opacity = it.opacity == null ? 1 : (it.opacity as number)
        // vega imageWidth/imageHeight: an explicit size, else the bitmap's own (scaled
        // to the other explicit dimension when aspect is on)
        const box = imageBox(it)
        let { x, y, w, h } = box
        if (w === 0 || h === 0) continue
        if (it.aspect !== false) {
          const ar0 = img.width / img.height
          const ar1 = (it.width as number) / (it.height as number)
          if (ar0 === ar0 && ar1 === ar1 && ar0 !== ar1) {
            if (ar1 < ar0) {
              const t = w / ar0
              y += (h - t) / 2
              h = t
            } else {
              const t = h * ar0
              x += (w - t) / 2
              w = t
            }
          }
        }
        const rec = it as unknown as Record<string, unknown>
        if (rec.blend != null) ctx.globalCompositeOperation = String(rec.blend)
        ctx.globalAlpha = opacity
        ctx.imageSmoothingEnabled = rec.smooth !== false
        // (a bitmap that holds its own pixels, a `heatmap`'s, hands the context the canvas it keeps them in)
        ctx.drawImage?.(img.toCanvasSource ? (img.toCanvasSource() ?? img) : img, x, y, w, h)
        ctx.globalAlpha = 1
        if (rec.blend != null) ctx.globalCompositeOperation = 'source-over'
      }
      return
    default:
      return
  }
}
