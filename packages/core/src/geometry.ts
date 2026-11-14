/**
 * Mark geometry, computed once per input and shared by every consumer: the SVG string renderer and the DOM patcher, the canvas
 * renderer, the hit index, bounds, the label transform's painter and `intersect()`.
 *
 * Design. (What reads the geometry as numbers -- segments, polygons, the canvas replay -- is in geometry-read.ts.)
 *  - An {@link Outline} is a generator's drawing calls (moveTo, lineTo, bezierCurveTo, arc, closePath)
 *    recorded once, at full precision. Replaying it into a sink makes the same calls, with the same numbers in the same
 *    order (the arity of `arc` included), as running the generator on that sink: the canvas, the bounds pen and the label
 *    painter get exactly what they got before.
 *  - A {@link PathData} is SVG path data as commands and numbers rather than text: what rects and symbols are defined as. It
 *    writes its text (the bytes the SVG renderer has always written), the segments `parsePathData` would read back from that
 *    text (computed, never parsed), the text translated by an offset (dense symbol batches) and the tokens `boundsFromPath`
 *    reads.
 *  - The geometry of a line, an area or a trail (one per mark), of an arc (one per item) and of a symbol shape (one per shape
 *    and radius) is cached together with what its consumers derive from it: the SVG text, the parse-equivalent segments, the
 *    flattened outline the hit index tests, and that outline placed at the mark's offset.
 *
 * Invalidation. Scene items are not immutable: the evaluator rewrites reused items in place on every evaluation (its mark
 * defaults, a geoshape's `path`, an image's vetted `url`), an append grows an items array in place, a transition rewrites one
 * frame scene in place, and a hand-built scene can be changed by its owner between two renders -- none of which moves `__gen`.
 * So no cache here trusts object identity: a cache is KEYED by a scene object (its lifetime: a WeakMap entry dies with the
 * scene) but every lookup re-reads exactly the inputs the generator reads, coerced as the generator coerces them, and compares
 * them with the stored ones (`Object.is`). A hit proves the generator would produce the same output. The inputs:
 *  - line: the curve (`interpolate`, `orient`, `tension` of the first item, resolved) and per item `defined === false`,
 *    `x || 0`, `y || 0`;
 *  - area: those, `orient === 'horizontal'` of the first item, and per item the baseline `x + (width || 0)` or
 *    `y + (height || 0)`;
 *  - trail: per item `defined === false`, `+(x || 0)`, `+(y || 0)`, `+(size || 1)`;
 *  - arc: its six numbers as the arc mark's accessors read them (`arcNumbers`);
 *  - symbol: the shape and the radius (the whole key);
 *  - a placement: the offset (tx, ty).
 * Nothing else is read: group offsets are applied after the cache (a placement is keyed by them), the device pixel ratio is a
 * context transform, and text is not cached here (text widths have their own cache, cleared with the metrics provider).
 *
 * What the output pins: every command and every floating-point expression of the generators; the text writers' rounding; and
 * what the parser made of the text, which the canvas and the hit index have always seen: a number reads back as `v + 0` (the
 * text has no negative zero), relative `h`/`v` are summed onto the current point, `Z` follows only drawn commands. A path
 * with a coordinate that is not finite prints `NaN`/`Infinity`, which the parser reads as stray command letters: such a path
 * is still read from its text (`parsePathData`), exactly as before. Free: the recording, the cache keys and lifetimes,
 * laziness.
 */
import { ArcPathWriter, PathWriter, resolveCurve, traceArea, traceLine, type Curve } from './shape.js'
import type { PathSeg } from './path-data.js'
import type { Poly } from './path-flatten.js'
import type { Placement } from './geometry-read.js'
import { customSymbolCommands, renderSvgPath } from './svg-path.js'
import type { SceneItem } from './types.js'

/**
 * A path text the writers built piece by piece is a rope of thousands of pieces; a kept one would hold them all in the old
 * generation, where every collection marks them again. Reading a character makes the engine flatten it into one string.
 */
function flat(s: string): string {
  s.charCodeAt(0)
  return s
}

// --- the recording ---------------------------------------------------------------------------------------------------------

/** Every call a generator can make on its sink (a canvas context has them all). */
export interface OutlineSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void
  closePath(): void
}

const MOVE = 0, LINE = 1, CUBIC = 2, ARC = 3, ARC_CW = 4, ARC_CCW = 5, CLOSE = 6
const ARGS = [2, 2, 6, 5, 5, 5, 0]

/** A generator's drawing calls, recorded at full precision. */
export class Outline implements OutlineSink {
  readonly ops: number[] = []
  readonly args: number[] = []
  /** Something other than `closePath` was called. */
  drawn = false
  moveTo(x: number, y: number): void { this.ops.push(MOVE); this.args.push(x, y); this.drawn = true }
  lineTo(x: number, y: number): void { this.ops.push(LINE); this.args.push(x, y); this.drawn = true }
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    this.ops.push(CUBIC); this.args.push(x1, y1, x2, y2, x, y); this.drawn = true
  }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void {
    this.ops.push(ccw === undefined ? ARC : ccw ? ARC_CCW : ARC_CW); this.args.push(x, y, r, a0, a1); this.drawn = true
  }
  closePath(): void { this.ops.push(CLOSE) }

  /** The same calls, in the same order, with the same numbers, on `s`. */
  replay(s: Partial<OutlineSink>): void {
    const a = this.args
    let k = 0
    for (const op of this.ops) {
      switch (op) {
        case MOVE: s.moveTo!(a[k]!, a[k + 1]!); break
        case LINE: s.lineTo!(a[k]!, a[k + 1]!); break
        case CUBIC: s.bezierCurveTo!(a[k]!, a[k + 1]!, a[k + 2]!, a[k + 3]!, a[k + 4]!, a[k + 5]!); break
        case ARC: s.arc!(a[k]!, a[k + 1]!, a[k + 2]!, a[k + 3]!, a[k + 4]!); break
        case ARC_CW: s.arc!(a[k]!, a[k + 1]!, a[k + 2]!, a[k + 3]!, a[k + 4]!, false); break
        case ARC_CCW: s.arc!(a[k]!, a[k + 1]!, a[k + 2]!, a[k + 3]!, a[k + 4]!, true); break
        case CLOSE: s.closePath!(); break
      }
      k += ARGS[op]!
    }
  }
}

/** The four calls a line or an area makes (`PathWriter`'s commands). */
interface CurveSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void
  closePath(): void
}

/** Records only whether anything is drawn. */
class DrawnDetector implements CurveSink {
  drawn = false
  moveTo(): void { this.drawn = true }
  lineTo(): void { this.drawn = true }
  bezierCurveTo(): void { this.drawn = true }
  closePath(): void {}
}

/**
 * The geometry of a line or area mark. The curve is traced from its columns on demand: straight into the SVG writer, the
 * bounds pen or the hit flattener, and recorded once (an {@link Outline}) for the canvas, which repaints it; whatever is
 * recorded is replayed rather than traced again.
 */
export class CurveGeometry {
  private text3?: string
  private recorded?: Outline
  private emptyCache?: boolean
  /** (geometry-read.ts) */
  finiteCache?: boolean
  /** (geometry-read.ts: the hit index's polygons) */
  hitLocal?: Poly[]
  hitPlacement?: Placement
  /** `cols`: x and y of a line; top x, top y and the baseline of an area (a horizontal area's bottom x, a vertical one's bottom y). */
  constructor(
    readonly curve: Curve,
    readonly live: Uint8Array,
    readonly cols: Float64Array[],
    readonly kind: 'line' | 'area',
    readonly horizontal: boolean,
  ) {}

  /** The curve drawn on `s` at full precision: the recording replayed, or the curve traced. */
  draw(s: CurveSink): void {
    if (this.recorded !== undefined) { this.recorded.replay(s); return }
    if (this.kind === 'line') geometryCounts.lineTrace++
    else geometryCounts.areaTrace++
    const [a, b, base] = this.cols as [Float64Array, Float64Array, Float64Array | undefined]
    if (this.kind === 'line') traceLine(s, this.curve, a, b, this.live)
    // (the baseline is the other coordinate's column: a horizontal area's bottom shares the top's y, a vertical one's its x)
    else if (this.horizontal) traceArea(s, this.curve, a, b, base!, b, this.live)
    else traceArea(s, this.curve, a, b, a, base!, this.live)
  }

  /** The drawing calls, recorded once (the canvas replays them on every paint). */
  get outline(): Outline {
    if (this.recorded === undefined) {
      const o = new Outline()
      this.draw(o)
      this.recorded = o
    }
    return this.recorded
  }

  /** Nothing is drawn (the SVG text is empty). */
  get empty(): boolean {
    if (this.text3 !== undefined) return this.text3 === ''
    if (this.recorded !== undefined) return !this.recorded.drawn
    if (this.emptyCache === undefined) {
      const d = new DrawnDetector()
      this.draw(d)
      this.emptyCache = !d.drawn
    }
    return this.emptyCache
  }

  /** The SVG `d`: `PathWriter(3)`'s text. */
  text(): string {
    if (this.text3 === undefined) {
      const w = new PathWriter(3)
      this.draw(w)
      this.text3 = flat(w.d)
    }
    return this.text3
  }

  /** The full-precision text (`PathWriter(null)`'s). */
  exactText(): string {
    const w = new PathWriter(null)
    this.draw(w)
    return w.d
  }


}

/** Scratch columns, grown as needed: a lookup writes the items' coerced values here and compares them with the entry's. */
let scratch: Float64Array[] = [new Float64Array(64), new Float64Array(64), new Float64Array(64)]
let scratchLive = new Uint8Array(64)

function ensureScratch(n: number): void {
  if (scratchLive.length >= n) return
  const size = Math.max(n, scratchLive.length * 2)
  scratch = [new Float64Array(size), new Float64Array(size), new Float64Array(size)]
  scratchLive = new Uint8Array(size)
}

function sameColumns(e: CurveGeometry, n: number, ncols: number): boolean {
  if (e.live.length !== n) return false
  const live = e.live
  for (let i = 0; i < n; i++) if (live[i] !== scratchLive[i]) return false
  for (let c = 0; c < ncols; c++) {
    const a = e.cols[c]!
    const b = scratch[c]!
    for (let i = 0; i < n; i++) if (live[i] && !Object.is(a[i], b[i])) return false
  }
  return true
}

const LINES = new WeakMap<SceneItem, CurveGeometry>()
const AREAS = new WeakMap<SceneItem, CurveGeometry>()

/**
 * How many times a mark's geometry was generated: a line's or area's curve traced from its columns (by each consumer the
 * first time it needs it, until the canvas records it), a trail's, an arc's or a symbol shape's built. A test reads it: an unchanged mark must not be regenerated.
 */
export const geometryCounts = { lineTrace: 0, areaTrace: 0, trail: 0, arc: 0, symbol: 0 }

function itemCurve(first: Record<string, unknown> | undefined): Curve {
  return resolveCurve(first?.interpolate as string | undefined, first?.orient as string | undefined, first?.tension as number | undefined)
}

const sameCurve = (a: Curve, b: Curve): boolean => a.run === b.run && Object.is(a.param, b.param)

/**
 * The geometry of a line mark through `items` (a gap where `defined === false`), in the curve the first item names; null
 * for no items.
 */
export function lineGeometry(items: readonly SceneItem[]): CurveGeometry | null {
  const n = items.length
  const first = items[0]
  if (first === undefined) return null
  const curve = itemCurve(first as Record<string, unknown>)
  ensureScratch(n)
  const [xs, ys] = scratch as [Float64Array, Float64Array]
  for (let i = 0; i < n; i++) {
    const it = items[i]!
    if (it.defined === false) { scratchLive[i] = 0; continue }
    scratchLive[i] = 1
    xs[i] = (it.x as number) || 0
    ys[i] = (it.y as number) || 0
  }
  const cached = LINES.get(first)
  if (cached !== undefined && sameCurve(cached.curve, curve) && sameColumns(cached, n, 2)) return cached
  const live = scratchLive.slice(0, n)
  const cx = new Float64Array(n), cy = new Float64Array(n)
  for (let i = 0; i < n; i++) if (live[i]) { cx[i] = xs[i]!; cy[i] = ys[i]! }
  const e = new CurveGeometry(curve, live, [cx, cy], 'line', false)
  LINES.set(first, e)
  return e
}

/**
 * The geometry of an area mark: the top boundary at the items' (x, y), the bottom at `y + height` (a horizontal area:
 * `x + width`); null for no items.
 */
export function areaGeometry(items: readonly SceneItem[]): CurveGeometry | null {
  const n = items.length
  const first = items[0] as Record<string, unknown> | undefined
  if (first === undefined) return null
  const curve = itemCurve(first)
  const horizontal = first.orient === 'horizontal'
  ensureScratch(n)
  const [tx, ty, base] = scratch as [Float64Array, Float64Array, Float64Array]
  for (let i = 0; i < n; i++) {
    const it = items[i]!
    if (it.defined === false) { scratchLive[i] = 0; continue }
    scratchLive[i] = 1
    const x = (it.x as number) || 0
    const y = (it.y as number) || 0
    tx[i] = x
    ty[i] = y
    base[i] = horizontal ? x + ((it.width as number) || 0) : y + ((it.height as number) || 0)
  }
  const cached = AREAS.get(first as SceneItem)
  if (cached !== undefined && cached.horizontal === horizontal && sameCurve(cached.curve, curve) && sameColumns(cached, n, 3)) return cached
  const live = scratchLive.slice(0, n)
  const topX = new Float64Array(n), topY = new Float64Array(n), b = new Float64Array(n)
  for (let i = 0; i < n; i++) if (live[i]) { topX[i] = tx[i]!; topY[i] = ty[i]!; b[i] = base[i]! }
  const e = new CurveGeometry(curve, live, [topX, topY, b], 'area', horizontal)
  AREAS.set(first as SceneItem, e)
  return e
}

// --- trails and arcs: outlines of lines and circular arcs -------------------------------------------------------------------

/** The geometry of an outline made of lines and arcs, written by an `ArcPathWriter(digits)` (a trail at full precision, an arc at 3 digits). */
export class ArcGeometry {
  private textCache?: string
  /** (geometry-read.ts) */
  segCache?: PathSeg[]
  /** (geometry-read.ts: an arc's full-precision segments, the hit index's polygons, intersect()'s outline) */
  exactSegCache?: PathSeg[]
  hitLocal?: Poly[]
  hitPlacement?: Placement
  local?: Poly[]
  constructor(readonly outline: Outline, readonly digits: number | null, readonly key: Float64Array) {}

  /** The SVG `d`. */
  text(): string {
    if (this.textCache === undefined) {
      const w = new ArcPathWriter(this.digits)
      this.outline.replay(w)
      this.textCache = flat(w.d)
    }
    return this.textCache
  }


}

const TRAILS = new WeakMap<SceneItem, ArcGeometry>()

/** A trail's inputs, as `trailInto` reads them: per item `defined === false` (NaN), else x, y and size. */
function trailKey(items: readonly SceneItem[]): Float64Array {
  const key = new Float64Array(items.length * 3)
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    if (it.defined === false) { key[3 * i] = NaN; key[3 * i + 1] = NaN; key[3 * i + 2] = NaN; continue }
    key[3 * i] = +((it.x as number) || 0)
    key[3 * i + 1] = +((it.y as number) || 0)
    key[3 * i + 2] = +((it.size as number) || 1)
  }
  return key
}

/** (a NaN x marks an undefined item: a defined item's x is `+(x || 0)`, never NaN) */
function sameKey(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}

/**
 * The capsules of a trail drawn into any sink (the path text and the bounds both take them from here). Each segment between
 * consecutive items is a capsule (round caps of the items' widths). x and y are `item.x || 0`, the size `item.size || 1`;
 * an item with `defined === false` ends the run.
 */
export function trailInto(context: Pick<OutlineSink, 'moveTo' | 'lineTo' | 'arc' | 'closePath'>, items: readonly SceneItem[]): void {
  let ready = false
  let x1 = 0, y1 = 0, r1 = 0
  const point = (x2: number, y2: number, w2: number): void => {
    const r2 = w2 / 2
    if (ready) {
      let ux = y1 - y2
      let uy = x2 - x1
      if (ux || uy) {
        // get normal vector
        const ud = Math.hypot(ux, uy)
        const rx = (ux /= ud) * r1
        const ry = (uy /= ud) * r1
        const t = Math.atan2(uy, ux)
        // draw segment
        context.moveTo(x1 - rx, y1 - ry)
        context.lineTo(x2 - ux * r2, y2 - uy * r2)
        context.arc(x2, y2, r2, t - Math.PI, t)
        context.lineTo(x1 + rx, y1 + ry)
        context.arc(x1, y1, r1, t, t + Math.PI)
      } else {
        context.arc(x2, y2, r2, 0, 2 * Math.PI)
      }
      context.closePath()
    } else {
      ready = true
    }
    x1 = x2
    y1 = y2
    r1 = r2
  }
  const n = items.length
  let defined0 = false
  for (let i = 0; i <= n; ++i) {
    const it = items[i]
    if (!(i < n && !(it!.defined === false)) === defined0) {
      if (defined0 = !defined0) ready = false
    }
    if (defined0) point(+((it!.x as number) || 0), +((it!.y as number) || 0), +((it!.size as number) || 1))
  }
}

/** The geometry of a trail through `items` (its text at full precision); null for no items. */
export function trailGeometry(items: readonly SceneItem[]): ArcGeometry | null {
  const first = items[0]
  if (first === undefined) return null
  const key = trailKey(items)
  const cached = TRAILS.get(first)
  if (cached !== undefined && sameKey(cached.key, key)) return cached
  geometryCounts.trail++
  const outline = new Outline()
  trailInto(outline, items)
  const e = new ArcGeometry(outline, null, key)
  TRAILS.set(first, e)
  return e
}

const ARCS = new WeakMap<SceneItem, ArcGeometry>()

/**
 * An arc item's six numbers (outer and inner radius, start and end angle, corner radius, pad angle), as the arc mark's
 * accessors read them: missing, null, NaN or 0 reads as 0 (`outerRadius` standing in with the older `radius`), anything else
 * is taken as a number.
 */
export function arcNumbers(it: SceneItem): Float64Array {
  const rec = it as Record<string, unknown>
  return Float64Array.of(
    +((it.outerRadius ?? it.radius) as number || 0), +(it.innerRadius as number || 0), +(it.startAngle as number || 0),
    +(it.endAngle as number || 0), +(rec.cornerRadius as number || 0), +(rec.padAngle as number || 0),
  )
}

/** The geometry of an arc item's sector about the origin (its text at 3 digits), traced by `trace` from its six numbers. */
export function arcGeometry(it: SceneItem, trace: (sink: Outline, n: Float64Array) => void): ArcGeometry {
  const key = arcNumbers(it)
  const cached = ARCS.get(it)
  if (cached !== undefined && sameKey(cached.key, key)) return cached
  geometryCounts.arc++
  const outline = new Outline()
  trace(outline, key)
  const e = new ArcGeometry(outline, 3, key)
  ARCS.set(it, e)
  return e
}

// --- path data as commands: rects and symbols ------------------------------------------------------------------------------

/** How a number is written into path text, and the number `parsePathData` reads back from that text. */
interface NumberFormat {
  text(v: number): string
  value(v: number): number
}

/** `String(Number(v))`: full precision (the rect, a symbol's measured or painted shape). */
export const EXACT: NumberFormat = { text: (v) => String(Number(v)), value: (v) => Number(v) + 0 }
/**
 * d3-path's rounding with `digits = 3` (d3-shape's `withPath` default): vega routes its d3-shape mark shapes (symbol, arc, line,
 * area) through a d3-path buffer of 3 digits, so their SVG coordinates are rounded to 3 decimals; vega's own rect and frame
 * builders (and the trail, through a digits-less d3-path) write raw doubles. `v * 1000` coerces like `Number(v)`.
 */
export const DIGITS3: NumberFormat = {
  text: (v) => String(Math.round(v * 1000) / 1000),
  value: (v) => Math.round(v * 1000) / 1000 + 0,
}

/**
 * SVG path data built command by command: its text as it is written, and each argument as the number the parser reads back
 * from that text (`Number(text)`, which is `String`'s inverse: so an argument's text is also `String(value)`, but for the one
 * {@link PathData.hBack} writes).
 */
export class PathData {
  readonly letters: string[] = []
  /** Argument count per command. */
  readonly counts: number[] = []
  readonly values: number[] = []
  finite = true
  private t = ''
  private first = true
  /** The text of an argument that is not `String(value)` (`hBack`'s), by argument index. */
  odd: Map<number, string> | undefined
  constructor(readonly fmt: NumberFormat) {}

  private cmd(letter: string, count: number): void { this.letters.push(letter); this.counts.push(count); this.t += letter; this.first = true }
  private put(text: string, value: number): void {
    if (!Number.isFinite(value)) this.finite = false
    this.values.push(value)
    this.t += this.first ? text : ',' + text
    this.first = false
  }
  private arg(v: number): void { this.put(this.fmt.text(v), this.fmt.value(v)) }

  M(x: number, y: number): this { this.cmd('M', 2); this.arg(x); this.arg(y); return this }
  L(x: number, y: number): this { this.cmd('L', 2); this.arg(x); this.arg(y); return this }
  C(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this {
    this.cmd('C', 6); this.arg(x1); this.arg(y1); this.arg(x2); this.arg(y2); this.arg(x); this.arg(y); return this
  }
  Q(x1: number, y1: number, x: number, y: number): this { this.cmd('Q', 4); this.arg(x1); this.arg(y1); this.arg(x); this.arg(y); return this }
  /** A circular arc to (x, y), no x-axis rotation. */
  A(r: number, large: 0 | 1, sweep: 0 | 1, x: number, y: number): this {
    this.cmd('A', 7); this.arg(r); this.arg(r); this.put('0', 0); this.put(String(large), large); this.put(String(sweep), sweep); this.arg(x); this.arg(y)
    return this
  }
  /** A relative horizontal line by `dx`. */
  h(dx: number): this { this.cmd('h', 1); this.arg(dx); return this }
  /** A relative vertical line by `dy`. */
  v(dy: number): this { this.cmd('v', 1); this.arg(dy); return this }
  /**
   * The closing edge of a rectangle `w` wide: back by `w` (vega's `h${-w}`), written `h-` and the text of `w`, or for a negative
   * width the text of `-w` (a negative width closes forward). Either way the parser reads `-w`.
   */
  hBack(w: number): this {
    this.cmd('h', 1)
    const n = Number(w)
    const text = n < 0 ? this.fmt.text(-w) : '-' + this.fmt.text(w)
    ;(this.odd ??= new Map()).set(this.values.length, text)
    this.put(text, -(n + 0))
    return this
  }
  Z(): this { this.cmd('Z', 0); return this }

  /** The path text. */
  text(): string { return this.t }

  /** The tokens `boundsFromPath` reads from the text: each command letter with the numbers that follow it. */
  tokens(): Array<{ c: string; n: number[] }> {
    const out: Array<{ c: string; n: number[] }> = []
    let k = 0
    for (let c = 0; c < this.letters.length; c++) {
      const n = this.counts[c]!
      out.push({ c: this.letters[c]!, n: this.values.slice(k, k + n) })
      k += n
    }
    return out
  }
}

// --- symbols ---------------------------------------------------------------------------------------------------------------

const HALF_SQRT3 = Math.sqrt(3) / 2 // vega util/constants HalfSqrt3

/**
 * A symbol's shape at radius `r` about the origin, as path data. vega: `symbols(item.shape || 'circle')`; any name that is not
 * a built-in shape is a custom SVG path, parsed and scaled by r (svg-path.ts), which throws vega's "Invalid SVG path" error
 * for an invalid one.
 */
export function symbolData(shape: string | undefined, r: number, fmt: NumberFormat): PathData {
  const p = new PathData(fmt)
  switch (shape || 'circle') {
    case 'square':
      return p.M(-r, -r).h(2 * r).v(2 * r).h(-2 * r).Z()
    case 'cross': {
      const s = r / 2.5
      return p.M(-r, -s).L(-r, s).L(-s, s).L(-s, r).L(s, r).L(s, s).L(r, s).L(r, -s).L(s, -s).L(s, -r).L(-s, -r).L(-s, -s).Z()
    }
    case 'diamond':
      return p.M(-r, 0).L(0, -r).L(r, 0).L(0, r).Z()
    case 'triangle-up': {
      const h = r * HALF_SQRT3
      return p.M(0, -h).L(-r, h).L(r, h).Z()
    }
    case 'triangle-down': {
      const h = r * HALF_SQRT3
      return p.M(0, h).L(-r, -h).L(r, -h).Z()
    }
    case 'triangle-right': {
      const h = r * HALF_SQRT3
      return p.M(h, 0).L(-h, -r).L(-h, r).Z()
    }
    case 'triangle-left': {
      const h = r * HALF_SQRT3
      return p.M(-h, 0).L(h, -r).L(h, r).Z()
    }
    case 'stroke':
      return p.M(-r, 0).L(r, 0)
    case 'arrow': {
      const st = r / 7
      const t = r / 2.5
      const v = r / 8
      return p.M(-st, r).L(st, r).L(st, -v).L(t, -v).L(0, -r).L(-t, -v).L(-st, -v).Z()
    }
    case 'wedge': {
      const h = r * Math.sqrt(3) / 2
      const o = h - r * (Math.sqrt(3) / 3)
      const b = r / 4
      return p.M(0, -h - o).L(-b, h - o).L(b, h - o).Z()
    }
    case 'triangle': {
      const h = r * Math.sqrt(3) / 2
      const o = h - r * (Math.sqrt(3) / 3)
      return p.M(0, -h - o).L(-r, h - o).L(r, h - o).Z()
    }
    case 'circle':
      // d3-symbol's circle through a canvas arc: the arcs only render for a truthy radius, so with r=0 the path degenerates to
      // its moveTo ('M0,0') and with r=NaN to 'MNaN,0' -- matching vega's renderer.
      return r > 0 ? p.M(r, 0).A(r, 1, 1, -r, 0).A(r, 1, 1, r, 0) : r === 0 ? p.M(0, 0) : p.M(r, 0)
    default: {
      // d3-path's closePath only writes Z after a point exists
      let open = false
      const commands = customSymbolCommands(shape!)
      renderSvgPath({
        moveTo: (x, y) => { p.M(x, y); open = true },
        lineTo: (x, y) => { p.L(x, y); open = true },
        bezierCurveTo: (a, b, c, d, x, y) => { p.C(a, b, c, d, x, y); open = true },
        quadraticCurveTo: (a, b, x, y) => { p.Q(a, b, x, y); open = true },
        closePath: () => { if (open) p.Z() },
      }, commands, 0, 0, r)
      return p
    }
  }
}

/** A symbol shape at one radius and what its consumers derive from it. */
export class SymbolGeometry {
  private r3?: PathData
  private ex?: PathData
  private text3?: string
  /** (geometry-read.ts) */
  segs3?: PathSeg[]
  segsEx?: PathSeg[]
  outlineCache?: { polys: Poly[]; reach: number }
  constructor(readonly shape: string | undefined, readonly r: number) {}

  /** The path data at 3 digits (the SVG `d`). */
  rounded(): PathData { return (this.r3 ??= symbolData(this.shape, this.r, DIGITS3)) }
  /** The path data at full precision (what the canvas paints and the bounds measure). */
  exact(): PathData { return (this.ex ??= symbolData(this.shape, this.r, EXACT)) }

  /** The SVG `d`. */
  text(): string { return (this.text3 ??= this.rounded().text()) }


}

/** Symbol shapes by name, then radius: bounded like the caches it replaces (a scatter has a handful of sizes). */
const SYMBOLS = new Map<string, Map<number, SymbolGeometry>>()
let symbolCount = 0
const SYMBOL_MAX = 1024

/**
 * The geometry of a symbol shape at radius r. A shape that is not a string (the encode can make one anything) is not cached.
 * Throws vega's "Invalid SVG path" error for an invalid custom shape, every time it is asked for.
 */
export function symbolGeometry(shape: string | undefined, r: number): SymbolGeometry {
  if (shape !== undefined && typeof shape !== 'string') return new SymbolGeometry(shape, r)
  const name = shape || 'circle'
  let byR = SYMBOLS.get(name)
  let g = byR?.get(r)
  if (g !== undefined) return g
  geometryCounts.symbol++
  g = new SymbolGeometry(shape, r)
  // (an invalid custom shape throws here, before anything is cached)
  if (name !== 'circle') g.rounded()
  if (symbolCount >= SYMBOL_MAX) { SYMBOLS.clear(); symbolCount = 0; byR = undefined }
  if (byR === undefined) SYMBOLS.set(name, (byR = new Map()))
  byR.set(r, g)
  symbolCount++
  return g
}

// --- rects -------------------------------------------------------------------------------------------------------------------

/**
 * A rect item's path data. Vega renders rect marks as paths: an undefined, null or NaN position is 0 (`item.x || 0`), so is a
 * missing or non-finite width or height (an unsized rect is a zero-size path at its origin). Corner radii (vega's rectangle
 * builder): each corner falls back to `cornerRadius`, is clamped to min(w, h) / 2, a falsy one is 0 and anything else is read
 * with unary plus (a non-numeric radius is NaN, which is NOT "no corner": the rounded path, in NaNs); the quarter arcs are
 * cubics with C = 0.448084975506.
 */
export function rectData(it: SceneItem): PathData {
  let w = it.width
  let h = it.height
  const x0 = (it.x as number | undefined) || 0
  const y0 = (it.y as number | undefined) || 0
  if (w == null) w = 0
  if (h == null) h = 0
  if (!Number.isFinite(w)) w = 0
  if (!Number.isFinite(h)) h = 0
  const rec = it as Record<string, unknown>
  const cr = rec.cornerRadius
  const s = Math.min(w, h) / 2
  const clampR = (v: unknown) => Math.max(0, Math.min(+(((v ?? cr) as number) || 0), s))
  const tl = clampR(rec.cornerRadiusTopLeft)
  const tr = clampR(rec.cornerRadiusTopRight)
  const br = clampR(rec.cornerRadiusBottomRight)
  const bl = clampR(rec.cornerRadiusBottomLeft)
  const p = new PathData(EXACT)
  if (!(tl <= 0 && tr <= 0 && bl <= 0 && br <= 0)) {
    const C = 0.448084975506
    const x2 = x0 + w
    const y2 = y0 + h
    return p.M(x0 + tl, y0).L(x2 - tr, y0)
      .C(x2 - C * tr, y0, x2, y0 + C * tr, x2, y0 + tr)
      .L(x2, y2 - br)
      .C(x2, y2 - C * br, x2 - C * br, y2, x2 - br, y2)
      .L(x0 + bl, y2)
      .C(x0 + C * bl, y2, x0, y2 - C * bl, x0, y2 - bl)
      .L(x0, y0 + tl)
      .C(x0, y0 + C * tl, x0 + C * tl, y0, x0 + tl, y0)
      .Z()
  }
  return p.M(x0, y0).h(w).v(h).h(-w).Z()
}

