/**
 * Scene -> Canvas2D renderer (R9.1). Both backends render the same scene, so
 * the engine stays single-sourced: the walk mirrors `render.ts` (same group
 * traversal, same shared geometry helpers) and only the final paint differs.
 *
 * The renderer accepts a minimal 2D-context interface (`CanvasLike`), so it
 * runs against a real `CanvasRenderingContext2D`, an OffscreenCanvas context,
 * or a recording mock in tests. Geometry is traced by replaying SVG path data
 * (`parsePathData` + `tracePath`), which keeps canvas output bit-identical to
 * the SVG path by construction (line and area marks excepted: they are traced
 * from full-precision coordinates like vega's canvas; see `computeLinePath(group, exact)`).
 */
import { SYMBOL_DEFAULT_SIZE } from './util.js'
import type { SceneDef, SceneGroup, SceneItem, SceneRoot } from './types.js'
import { gradientDefOf, isGradientPaint as isGradientObject } from './svg-defs.js'
import { Bounds, boundLeaf, boundTypedMark } from './bounds.js'
import { imageBox, itemImage } from './image-box.js'
import { parsePathData, tracePath, type PathSeg, type PathSink } from './path-data.js'

// Path-data parsing and replay live in path-data.ts (hit.ts needs them without the renderer); the public surface is unchanged.
export { parsePathData, tracePath, type PathSeg, type PathSink } from './path-data.js'

type SceneDefs = SceneDef
import {
  computeAreaPath,
  computeLinePath,
  num,
  rectItemPath,
  symbolPath,
  textItemDesc,
  trailPath,
  arcPath,
  frameBackgroundPath,
  frameItem,
  arcInto,
} from './render.js'

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
  stroke(): void
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

const SYMBOL_CACHE = new Map<string, string>()

function cachedSymbolPath(shape: string | undefined, r: number): string {
  const key = `${shape ?? 'circle'}|${r}`
  let d = SYMBOL_CACHE.get(key)
  if (d == null) {
    d = symbolPath(shape, r)
    if (SYMBOL_CACHE.size > 1024) SYMBOL_CACHE.clear()
    SYMBOL_CACHE.set(key, d)
  }
  return d
}

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
  /** Device pixel ratio: scales the context transform (R9.2 uses this). */
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
  const frameSegs = parsePathData(frameBackgroundPath(scene, plotW, plotH))
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
 * visit budget. Replaces the per-frame `JSON.stringify` of whole item arrays
 * (audit C96): no allocation, stops at the first difference, ignores
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
      if (ng === pg) {
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

/** Painted extent of an unchanged group after the appended one, cached per group object. */
const LATER_EXTENT = new WeakMap<SceneGroup, Box | null>()
function laterExtent(group: SceneGroup, scene: SceneRoot, plotW: number, plotH: number, opts: RenderCanvasOptions): Box | null {
  if (LATER_EXTENT.has(group)) return LATER_EXTENT.get(group)!
  const box = paintExtent(group, scene, plotW, plotH, opts)
  LATER_EXTENT.set(group, box)
  return box
}

function renderGroup(group: SceneGroup, ctx: CanvasLike, scene: SceneRoot, plotW: number, plotH: number, opts: RenderCanvasOptions = {}): void {
  const type = group.marktype
  if (!type || type === 'group') {
    ctx.save()
    // vega's mark-level `clip`: the mark container is clipped to the ENCLOSING group's frame
    if (group.markClip === true) {
      ctx.beginPath()
      ctx.rect(0, 0, plotW, plotH)
      ctx.clip()
    }
    if (group.x != null || group.y != null) ctx.translate(group.x ?? 0, group.y ?? 0)
    // a group's content frame is its own width x height (the root plot size for the guide groups that have none)
    const gw = group.width ?? plotW
    const gh = group.height ?? plotH
    if (group.clip === true) {
      ctx.beginPath()
      if (group.clipPathD) tracePath(ctx, parsePathData(group.clipPathD), group.x ?? 0, group.y ?? 0)
      else ctx.rect(0, 0, gw, gh)
      ctx.clip()
    }
    for (const item of group.items ?? []) {
      if (isGroup(item)) renderGroup(item, ctx, scene, gw, gh, opts)
      else renderLeafItem(item, ctx, scene)
    }
    ctx.restore()
    return
  }
  if (group.clip === true) {
    ctx.save()
    ctx.beginPath()
    if (group.clipPathD) tracePath(ctx, parsePathData(group.clipPathD), group.x ?? 0, group.y ?? 0)
    else ctx.rect(0, 0, plotW, plotH)
    ctx.clip()
    renderMark(type, group, ctx, scene, opts)
    ctx.restore()
    return
  }
  renderMark(type, group, ctx, scene, opts)
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
  segs: PathSeg[],
  it: SceneItem,
  defs: SceneDefs[] | undefined,
  op: 'auto' | 'fill' | 'stroke',
  bbox?: Bbox,
): void {
  const opacity = it.opacity == null ? 1 : (it.opacity as number)
  if (opacity === 0) return
  const fill = op === 'stroke' ? undefined : it.fill
  const stroke = op === 'fill' ? undefined : it.stroke
  const isGradient = (p: unknown): boolean =>
    (typeof p === 'string' && p.startsWith('url(#')) || (p != null && typeof p === 'object' && 'gradient' in (p as object))
  // Gradient resolution is the only consumer of the bbox; skip the segment walk
  // for the common solid-paint case (thousands of symbols per frame).
  const bb = bbox ?? (isGradient(fill) || isGradient(stroke) ? segsBbox(segs) : null)
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
      ctx.fill()
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
      ctx.stroke()
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

function renderLeafItem(it: SceneItem, ctx: CanvasLike, scene: SceneRoot): void {
  const defs = scene.defs
  // Path items (legend entries, tick labels' misc paths)
  if (it.path != null) {
    const tx = it.x ?? 0
    const ty = it.y ?? 0
    ctx.beginPath()
    const segs = parsePathData(it.path)
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
    if (itemAngle(it)) {
      // the SVG element carries translate(x,y) rotate(angle): build in that frame
      buildInItemFrame(ctx, tx, ty, itemAngle(it)!, 1, 1, () => tracePath(ctx, segs))
    } else {
      ctx.beginPath()
      tracePath(ctx, segs, tx, ty)
    }
    paintPath(ctx, segs, it, defs, 'auto')
    if (clip) ctx.restore()
    return
  }
  // Symbol items (circle arc path): the SVG leaf renderer draws
  // `M{r},0A{r},{r}…` translated by (x, y) — trace the same path so records
  // match exactly (including gradient bboxes).
  if (it.shape != null && it.radius != null) {
    const r = it.radius
    const rNum = Number.isInteger(r) ? String(r) : String(Math.round(r * 1000) / 1000)
    const d = `M${rNum},0A${rNum},${rNum},0,1,1,${-rNum},0A${rNum},${rNum},0,1,1,${rNum},0`
    if (itemAngle(it)) {
      const segs = parsePathData(d)
      buildInItemFrame(ctx, it.x ?? 0, it.y ?? 0, itemAngle(it)!, 1, 1, () => tracePath(ctx, segs))
      paintPath(ctx, segs, it, defs, 'auto')
      return
    }
    ctx.beginPath()
    const segs = parsePathData(d).map((s) => {
      if (s.cmd === 'Z') return s
      const o = { ...s } as unknown as Record<string, number>
      if (typeof o.x === 'number') o.x += it.x ?? 0
      if (typeof o.y === 'number') o.y += it.y ?? 0
      return o as unknown as typeof s
    })
    tracePath(ctx, segs)
    paintPath(ctx, segs, it, defs, 'auto')
    return
  }
  if (it._kind === 'text' || (it._kind === undefined && it.text != null)) {
    renderTextItem(it, ctx, defs)
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
  paintPath(ctx, [{ cmd: 'M', x, y }, { cmd: 'L', x: x2, y: y2 }] as PathSeg[], it, defs, 'stroke')
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
function renderTextItem(it: SceneItem, ctx: CanvasLike, defs: SceneDefs[] | undefined): void {
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
  for (let i = 0; i < d.lines.length; i++) {
    const str = d.lines[i]!
    const ly = i === 0 ? y : y + i * d.lineHeight
    if (fillOk) {
      const a = opacity * (it.fillOpacity == null ? 1 : (it.fillOpacity as number))
      if (a > 0) {
        ctx.globalAlpha = a
        const paint = resolvePaint(it.fill, ctx, defs, null)
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
        const paint = resolvePaint(it.stroke, ctx, defs, null)
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
        const d = cachedSymbolPath((it as Record<string, unknown>).shape as string | undefined, r)
        const segs = parsePathData(d)
        buildInItemFrame(ctx, x, y, ((it as Record<string, unknown>).angle as number) || 0, 1, 1, () => tracePath(ctx, segs))
        paintPath(ctx, segs, it, defs, 'auto', gradientBox(it))
      }
      run = []
      return
    }
    ctx.beginPath()
    for (const it of run) {
      const x = it.x || 0
      const y = it.y || 0
      const r = Math.sqrt((it.size as number) ?? SYMBOL_DEFAULT_SIZE) / 2
      const shape = (it as Record<string, unknown>).shape as string | undefined
      if (shape == null || shape === 'circle') {
        ctx.moveTo(x + r, y)
        ctx.arc(x, y, r, 0, 2 * Math.PI, false)
      } else {
        tracePath(ctx, parsePathData(cachedSymbolPath(shape, r)), x, y)
      }
    }
    paintPath(ctx, [], run[0]!, defs, 'auto')
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
      const info = computeLinePath(group, true)
      if (!info) return
      ctx.beginPath()
      const segs = parsePathData(info.path)
      tracePath(ctx, segs)
      // vega draws a line mark from its first item with the full fill + stroke
      // paint (closed lines can be filled); stroke width defaults to 2 with a stroke.
      const first = { ...group.items![0]!, strokeWidth: info.sw ?? group.items![0]!.strokeWidth } as SceneItem
      paintPath(ctx, segs, first, defs, 'auto', gradientBox(first, group))
      return
    }
    case 'area': {
      const info = computeAreaPath(group, true)
      if (!info) return
      ctx.beginPath()
      const segs = parsePathData(info.path)
      tracePath(ctx, segs)
      paintPath(ctx, segs, group.items![0]!, defs, 'auto', gradientBox(group.items![0]!, group))
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
          const d = cachedSymbolPath(shape, r)
          const segs = parsePathData(d)
          const angle = ((it as Record<string, unknown>).angle as number) || 0
          if (angle) buildInItemFrame(ctx, x, y, angle, 1, 1, () => tracePath(ctx, segs))
          else { ctx.beginPath(); tracePath(ctx, segs, x, y) }
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
        const d = rectItemPath(it)
        if (d == null) continue
        ctx.beginPath()
        const segs = parsePathData(d)
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
        paintPath(ctx, [{ cmd: 'M', x, y }, { cmd: 'L', x: x2, y: y2 }] as PathSeg[], it, defs, 'stroke')
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
      const d = trailPath(items)
      if (!d) return
      const first = items[0]!
      ctx.beginPath()
      const segs = parsePathData(d)
      tracePath(ctx, segs)
      // The trail polygon carries the FIRST item's full paint set, fill included
      // (Vega-Lite encodes a trail's colour as `fill`; audit C23).
      paintPath(ctx, segs, first, defs, 'auto', gradientBox(first, group))
      return
    }
    case 'path':
    case 'shape':
    case 'geoshape': {
      // (only a path mark parses a path string: vega draws its arcs as beziers; a shape's geo path goes to the context directly)
      const arcs = type === 'path' ? 'bezier' : 'exact'
      for (const it of group.items ?? []) {
        if (!it.path) continue
        // vega path mark: translate, rotate, then the path scaled by (scaleX||1, scaleY||1)
        const rec = it as Record<string, unknown>
        const angle = (rec.angle as number) || 0
        const sx = (rec.scaleX as number) || 1
        const sy = (rec.scaleY as number) || 1
        const segs = parsePathData(it.path)
        buildInItemFrame(ctx, it.x || 0, it.y || 0, angle, sx, sy, () => tracePath(ctx, segs, 0, 0, arcs))
        paintPath(ctx, segs, it, defs, 'auto', gradientBox(it))
      }
      return
    }
    case 'arc': {
      for (const it of group.items ?? []) {
        const r = (it.outerRadius as number) ?? (it.radius as number) ?? 0
        const r0 = (it.innerRadius as number) ?? 0
        const a0 = (it.startAngle as number) ?? 0
        const a1 = (it.endAngle as number) ?? 0
        // The SVG renderer emits the arc path around (0,0) translated by the
        // item position; trace the same local path with the item offset.
        const cr = (it as Record<string, unknown>).cornerRadius as number | undefined ?? 0
        const pa = (it as Record<string, unknown>).padAngle as number | undefined ?? 0
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
        arcInto(ctx, 0, 0, r, r0, a0, a1, cr, pa)
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
