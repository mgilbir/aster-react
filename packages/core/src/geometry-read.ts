/**
 * Mark geometry read as numbers: what the canvas, the hit index, the label painter and `intersect()` take from the shared
 * geometry (geometry.ts) instead of parsing SVG text back. Apart from geometry.ts so that a page that only writes SVG does not
 * carry the parser, the flattener or these readers.
 *
 * Everything here equals what the old text round trip produced: segments are those `parsePathData` reads from the text
 * (every number `v + 0`, relative `h`/`v` summed onto the current point, `Z` only after something was drawn), polygons those
 * `flattenPath` builds from that text. A path with a number that does not print as one (`NaN`, `Infinity`) is still read
 * from its text, exactly as before; what is computed is kept on the geometry object.
 */
import { ArcPathWriter, ArcSegWriter } from './shape.js'
import { drawnPathCommands, parsePathData, parseSvgPathData, renderSvgPath, tracePath, type PathCommand, type PathSeg } from './path-data.js'
import { Flattener, FLOAT32_OVERFLOW, held, type Poly } from './path-flatten.js'
import type { ArcGeometry, CurveGeometry, PathData, SymbolGeometry } from './geometry.js'

/** The four calls a line or an area makes (`PathWriter`'s commands). */
interface CurveSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void
  closePath(): void
}

/**
 * A sink that receives a curve as its full-precision text, read back by `parsePathData` and traced by `tracePath`, would draw
 * it on `s`: every number `+ 0` (the text has no negative zero), `Z` only once something was drawn. `held` turns false when a
 * number passes that a canvas cannot take (not finite, or beyond single precision: see `held`), settled in the one comparison each
 * number costs; the text of such a number does not read back as the number a canvas would have had.
 */
class AsText implements CurveSink {
  drawn = false
  held = true
  constructor(private readonly s: CurveSink) {}
  private r(v: number): number {
    // (the common number is one a canvas holds, so finite: one comparison answers both)
    if (!(Math.abs(v) < FLOAT32_OVERFLOW)) this.held = false
    return v + 0
  }
  moveTo(x: number, y: number): void { this.s.moveTo(this.r(x), this.r(y)); this.drawn = true }
  lineTo(x: number, y: number): void { this.s.lineTo(this.r(x), this.r(y)); this.drawn = true }
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    this.s.bezierCurveTo(this.r(x1), this.r(y1), this.r(x2), this.r(y2), this.r(x), this.r(y)); this.drawn = true
  }
  closePath(): void { if (this.drawn) this.s.closePath() }
}

// --- polygons ------------------------------------------------------------------------------------------------------------

const IDENTITY = (x: number, y: number): [number, number] => [x, y]

/** Polygons of parsed segments, as `flattenPath` makes them from the text those segments were read from. */
export function flattenSegs(segs: readonly PathSeg[], t: (x: number, y: number) => [number, number] = IDENTITY): Poly[] {
  const f = new Flattener(t)
  tracePath(f, segs as PathSeg[])
  return f.polys
}

/** `polys` under `t`, point by point (what flattening under `t` gives: the flattener samples curves before it transforms). */
export function transformPolys(polys: readonly Poly[], t: (x: number, y: number) => [number, number]): Poly[] {
  return polys.map(({ pts, closed, curved }) => {
    const out = new Array<number>(pts.length)
    for (let i = 0; i < pts.length; i += 2) {
      const [x, y] = t(pts[i]!, pts[i + 1]!)
      out[i] = x
      out[i + 1] = y
    }
    return curved === undefined ? { pts: out, closed } : { pts: out, closed, curved }
  })
}

/** An outline placed at an offset: the hit index's polygons for one position of the mark. */
export interface Placement { tx: number; ty: number; polys: Poly[] }

function place(local: Poly[], tx: number, ty: number): Poly[] {
  return local.map(({ pts, closed, curved }) => {
    const out = new Array<number>(pts.length)
    for (let i = 0; i < pts.length; i += 2) {
      out[i] = tx + pts[i]!
      out[i + 1] = ty + pts[i + 1]!
    }
    // (which segments are chords of a curve does not move with the outline: shared)
    return curved === undefined ? { pts: out, closed } : { pts: out, closed, curved }
  })
}

/** The polygons of `local` moved by (tx, ty), as `flattenPath(d, (x, y) => [tx + x, ty + y])` builds them; the last placement is kept. */
function placed(e: { hitLocal?: Poly[]; hitPlacement?: Placement }, local: () => Poly[], tx: number, ty: number): Poly[] {
  const p = e.hitPlacement
  if (p !== undefined && Object.is(p.tx, tx) && Object.is(p.ty, ty)) return p.polys
  const polys = place(e.hitLocal ??= local(), tx, ty)
  e.hitPlacement = { tx, ty, polys }
  return polys
}

/** {@link placed} for a canvas's reading of an outline that is not all numbers (`canvasHitLocal`: kept apart from the SVG's). */
function placedCanvas(e: { canvasHitLocal?: Poly[]; canvasHitPlacement?: Placement }, local: () => Poly[], tx: number, ty: number): Poly[] {
  const p = e.canvasHitPlacement
  if (p !== undefined && Object.is(p.tx, tx) && Object.is(p.ty, ty)) return p.polys
  const polys = place(e.canvasHitLocal ??= local(), tx, ty)
  e.canvasHitPlacement = { tx, ty, polys }
  return polys
}

// --- lines and areas -----------------------------------------------------------------------------------------------------

/** The recorded numbers are all finite: its text reads back as numbers (rounding is not involved: these readers are full precision). */
const curveFinite = (g: CurveGeometry): boolean => (g.finiteCache ??= g.outline.args.every(Number.isFinite))

/** The segments of a line's or area's full-precision text (a gradient's box is measured on them). */
export function curveExactSegs(g: CurveGeometry): PathSeg[] {
  if (!curveFinite(g)) return parsePathData(g.exactText())
  const segs: PathSeg[] = []
  g.outline.replay(new AsText({
    moveTo: (x, y) => { segs.push({ cmd: 'M', x, y }) },
    lineTo: (x, y) => { segs.push({ cmd: 'L', x, y }) },
    bezierCurveTo: (c1x, c1y, c2x, c2y, x, y) => { segs.push({ cmd: 'C', c1x, c1y, c2x, c2y, x, y }) },
    closePath: () => { segs.push({ cmd: 'Z' }) },
  }))
  return segs
}

/** What the canvas draws for a line or area: its full-precision text's segments traced on `s` (the recording replayed). */
export function drawCurveExact(g: CurveGeometry, s: CurveSink): void {
  if (curveFinite(g)) g.outline.replay(new AsText(s))
  else tracePath(s as never, parsePathData(g.exactText()))
}

/** The hit index's polygons of a line or area (of its full-precision text, as the canvas draws it) placed at (tx, ty). */
export function curvePolys(g: CurveGeometry, tx: number, ty: number, canvas = false): Poly[] {
  // (vega's canvas draws the path with calls, which leave out the ones that have a number they cannot hold; its SVG has the text,
  // which a browser reads up to the first thing that is no number)
  if (canvas && !canvasHolds(g)) {
    return placedCanvas(g, () => {
      const f = new Flattener(IDENTITY)
      g.draw(new AsText(f))
      return f.polys
    }, tx, ty)
  }
  return placed(g, () => {
    const f = new Flattener(IDENTITY)
    const t = new AsText(f)
    g.draw(t)
    if (t.held) return f.polys
    return flattenSegs(parseSvgPathData(g.exactText()))
  }, tx, ty)
}

// --- trails and arcs -----------------------------------------------------------------------------------------------------

/** The segments `parsePathData(g.text())` reads (computed, not parsed; a path that is not finite is parsed, as it always was). */
export function arcSegs(g: ArcGeometry): PathSeg[] {
  if (g.segCache === undefined) {
    const w = new ArcSegWriter(g.digits)
    g.outline.replay(w)
    g.segCache = w.finite ? (w.segs as PathSeg[]) : parsePathData(g.text())
  }
  return g.segCache
}

/** The polygons of a trail's or arc's text, untransformed. */
export const arcLocalPolys = (g: ArcGeometry): Poly[] => (g.local ??= flattenSegs(arcSegs(g)))

/**
 * The segments of a trail's or arc's full-precision text (`ArcPathWriter(null)`'s; for a trail, its own text's). Writing them
 * throws for a negative radius, as writing the text does.
 */
export function arcExactSegs(g: ArcGeometry): PathSeg[] {
  if (g.exactSegCache === undefined) {
    const w = new ArcSegWriter(null)
    g.outline.replay(w)
    if (w.finite && canvasHolds(g)) g.exactSegCache = w.segs as PathSeg[]
    else {
      const t = new ArcPathWriter(null)
      g.outline.replay(t)
      g.exactSegCache = parseSvgPathData(t.d)
    }
  }
  return g.exactSegCache
}

/** The hit index's polygons of a trail or an arc (of its full-precision text) placed at (tx, ty). */
export function arcPolys(g: ArcGeometry, tx: number, ty: number, canvas = false): Poly[] {
  // (an outline whose numbers are not all finite: vega's canvas draws it with calls, which leave out the ones that have a number they
  // cannot hold; its SVG has the text, which a browser reads up to the first thing that is no number)
  if (canvas && !canvasHolds(g)) {
    return placedCanvas(g, () => {
      const f = new Flattener(IDENTITY)
      g.outline.replay(f)
      return f.polys
    }, tx, ty)
  }
  return placed(g, () => flattenSegs(arcExactSegs(g)), tx, ty)
}

/** Whether every number the calls of an outline carry is one a canvas takes (finite, within single precision): else it leaves that call out. */
export function canvasHolds(g: { outline: { args: number[] }; canvasHeld?: boolean }): boolean {
  return (g.canvasHeld ??= g.outline.args.every(held))
}

/** The polygons of an arc's or trail's outline as a canvas reads it, untransformed (intersect() draws on one). */
export function arcCanvasLocalPolys(g: ArcGeometry): Poly[] {
  if (canvasHolds(g)) return arcLocalPolys(g)
  return placedCanvas(g, () => {
    const f = new Flattener(IDENTITY)
    g.outline.replay(f)
    return f.polys
  }, 0, 0)
}

// --- path data: rects, symbols, the frame ----------------------------------------------------------------------------------

/** The segments `parsePathData(d.text())` reads (its relative commands made absolute the parser's way). Requires `d.finite`. */
function dataSegs(d: PathData): PathSeg[] {
  const out: PathSeg[] = []
  const v = d.values
  let k = 0
  let x = 0, y = 0, sx = 0, sy = 0
  for (let c = 0; c < d.letters.length; c++) {
    switch (d.letters[c]) {
      case 'M': x = sx = v[k]!; y = sy = v[k + 1]!; out.push({ cmd: 'M', x, y }); break
      case 'L': x = v[k]!; y = v[k + 1]!; out.push({ cmd: 'L', x, y }); break
      case 'C': x = v[k + 4]!; y = v[k + 5]!; out.push({ cmd: 'C', c1x: v[k]!, c1y: v[k + 1]!, c2x: v[k + 2]!, c2y: v[k + 3]!, x, y }); break
      case 'Q': x = v[k + 2]!; y = v[k + 3]!; out.push({ cmd: 'Q', cx: v[k]!, cy: v[k + 1]!, x, y }); break
      case 'A': x = v[k + 5]!; y = v[k + 6]!; out.push({ cmd: 'A', rx: v[k]!, ry: v[k + 1]!, rot: v[k + 2]!, large: v[k + 3]!, sweep: v[k + 4]!, x, y }); break
      case 'h': x = v[k]! + x; out.push({ cmd: 'H', x }); break
      case 'v': y = v[k]! + y; out.push({ cmd: 'V', y }); break
      case 'Z': x = sx; y = sy; out.push({ cmd: 'Z' }); break
    }
    k += d.counts[c]!
  }
  return out
}

/** Parsed segments of path data: computed when its numbers are finite, else parsed from its text (as they always were). */
export function segsOf(d: PathData): PathSeg[] {
  return d.finite ? dataSegs(d) : parsePathData(d.text())
}

/** The segments of a symbol shape's 3-digit text. */
export function symbolRoundedSegs(g: SymbolGeometry): PathSeg[] {
  return (g.segs3 ??= segsOf(g.rounded()))
}

/** The segments of a symbol shape's full-precision text (what the canvas paints). */
export function symbolExactSegs(g: SymbolGeometry): PathSeg[] {
  return (g.segsEx ??= segsOf(g.exact()))
}

/** A symbol shape's hit outline: its full-precision shape's polygons, and how far from the centre they reach. */
export function symbolOutline(g: SymbolGeometry): { polys: Poly[]; reach: number } {
  if (g.outlineCache === undefined) {
    const polys = flattenSegs(symbolExactSegs(g))
    let reach = 0
    for (const { pts } of polys) for (let i = 0; i < pts.length; i += 2) reach = Math.max(reach, Math.hypot(pts[i]!, pts[i + 1]!))
    g.outlineCache = { polys, reach }
  }
  return g.outlineCache
}

// --- path strings a scene carries ------------------------------------------------------------------------------------------

/** Untransformed polygons of a parsed path, kept as long as the parse cache keeps the segments. */
const PATH_POLYS = new WeakMap<PathSeg[], Poly[]>()

/** The polygons of a path string the engine wrote (a shape's, a guide's, a scene-carried one), untransformed; parsed once per distinct string. */
export function pathPolys(d: string): Poly[] {
  const segs = parsePathData(d)
  let polys = PATH_POLYS.get(segs)
  if (polys === undefined) PATH_POLYS.set(segs, (polys = flattenSegs(segs)))
  return polys
}

/** A path mark's polygons by scale (`${scaleX},${scaleY}`), kept as long as the parse cache keeps the commands. */
const PATH_MARK_POLYS = new WeakMap<PathCommand[], Map<string, Poly[]>>()

/**
 * The polygons of a path mark's text as vega's canvas draws it with the item's own `x` and `y` as the offset (`pathRender(context, path,
 * x, y, sx, sy)`): each coordinate is `x + l`, `y + t` in JavaScript's arithmetic, so a numeric string for `l` or `t` is joined to
 * the number before it (`10 + "106"` is `"10106"`), and the canvas reads the result as a number. Not cached: only an item whose
 * position is not a number is read so (a number is `pathMarkPolys` moved).
 */
export function pathMarkPolysAt(d: string, sx: number, sy: number, l: unknown, t: unknown): Poly[] {
  const f = new Flattener(IDENTITY)
  const n = (v: number): number => +v
  renderSvgPath({
    moveTo: (x, y) => { f.moveTo(n(x), n(y)) },
    lineTo: (x, y) => { f.lineTo(n(x), n(y)) },
    bezierCurveTo: (a, b, c, e, x, y) => { f.bezierCurveTo(n(a), n(b), n(c), n(e), n(x), n(y)) },
    quadraticCurveTo: (a, b, x, y) => { f.quadraticCurveTo(n(a), n(b), n(x), n(y)) },
    closePath: () => { f.closePath() },
  }, drawnPathCommands(d), l as number, t as number, sx, sy)
  return f.polys
}

/**
 * The polygons of a path mark's text, scaled by (sx, sy) about its origin as vega draws it (path-data.ts `renderSvgPath`: the scale
 * is in the numbers the arcs are computed from, so a turned ellipse scaled unevenly is not the unscaled outline scaled), as far as
 * the text reads; not moved or turned. Read once per distinct text, flattened once per scale.
 */
export function pathMarkPolys(d: string, sx: number, sy: number): Poly[] {
  const commands = drawnPathCommands(d)
  let byScale = PATH_MARK_POLYS.get(commands)
  if (byScale === undefined) PATH_MARK_POLYS.set(commands, (byScale = new Map()))
  const key = `${sx},${sy}`
  let polys = byScale.get(key)
  if (polys === undefined) {
    const f = new Flattener(IDENTITY)
    renderSvgPath(f, commands, 0, 0, sx, sy)
    byScale.set(key, (polys = f.polys))
  }
  return polys
}
