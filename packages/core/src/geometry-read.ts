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
import { parsePathData, tracePath, type PathSeg } from './path-data.js'
import { Flattener, type Poly } from './path-flatten.js'
import type { ArcGeometry, CurveGeometry, Outline, PathData, SymbolGeometry } from './geometry.js'

/** The four calls a line or an area makes (`PathWriter`'s commands). */
interface CurveSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void
  closePath(): void
}

// (the outline's op codes: geometry.ts)
const MOVE = 0, LINE = 1, CUBIC = 2, CLOSE = 7
const ARGS = [2, 2, 6, 4, 5, 5, 5, 0]

/**
 * Replays a line or area outline as the text a `PathWriter(digits)` writes for it, read back by `parsePathData` and traced by
 * `tracePath`, would draw: every number rounded (`scale` 0: not), then `+ 0`; `Z` only once something was written. The
 * outline must be finite at that scale.
 */
function replayAsText(o: Outline, s: CurveSink, scale: number): void {
  const a = o.args
  const ops = o.ops
  let k = 0
  let drawn = false
  if (scale === 0) {
    for (let i = 0; i < ops.length; i++) {
      switch (ops[i]) {
        case MOVE: s.moveTo(a[k]! + 0, a[k + 1]! + 0); drawn = true; break
        case LINE: s.lineTo(a[k]! + 0, a[k + 1]! + 0); drawn = true; break
        case CUBIC: s.bezierCurveTo(a[k]! + 0, a[k + 1]! + 0, a[k + 2]! + 0, a[k + 3]! + 0, a[k + 4]! + 0, a[k + 5]! + 0); drawn = true; break
        case CLOSE: if (drawn) s.closePath(); break
      }
      k += ARGS[ops[i]!]!
    }
    return
  }
  const r = (v: number): number => Math.round(v * scale) / scale + 0
  for (let i = 0; i < ops.length; i++) {
    switch (ops[i]) {
      case MOVE: s.moveTo(r(a[k]!), r(a[k + 1]!)); drawn = true; break
      case LINE: s.lineTo(r(a[k]!), r(a[k + 1]!)); drawn = true; break
      case CUBIC: s.bezierCurveTo(r(a[k]!), r(a[k + 1]!), r(a[k + 2]!), r(a[k + 3]!), r(a[k + 4]!), r(a[k + 5]!)); drawn = true; break
      case CLOSE: if (drawn) s.closePath(); break
    }
    k += ARGS[ops[i]!]!
  }
}

/** Every number of the outline, rounded at `scale` (0: not), is finite: its text reads back as numbers. */
function outlineFinite(o: Outline, scale: number): boolean {
  for (const v of o.args) if (!Number.isFinite(scale ? Math.round(v * scale) / scale : v)) return false
  return true
}

/**
 * A sink that receives a curve as the text a `PathWriter(digits)` would write for it, read back and traced, would draw it on
 * `s`. `finite` turns false when a number that is not finite passes (its text would not read back as a number).
 */
class AsText implements CurveSink {
  drawn = false
  finite = true
  constructor(private readonly s: CurveSink, private readonly scale: number) {}
  private r(v: number): number {
    const k = this.scale
    const x = k ? Math.round(v * k) / k + 0 : v + 0
    if (!Number.isFinite(x)) this.finite = false
    return x
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

// --- lines and areas -----------------------------------------------------------------------------------------------------

/** The recorded numbers are all finite (then so are they rounded: rounding to 3 digits overflows only beyond 1e305). */
const curveFinite = (g: CurveGeometry): boolean => (g.finiteCache ??= outlineFinite(g.outline, 0) && outlineFinite(g.outline, 1000))

/** The segments of a line's or area's full-precision text (a gradient's box is measured on them). */
export function curveExactSegs(g: CurveGeometry): PathSeg[] {
  if (!curveFinite(g)) return parsePathData(g.exactText())
  const segs: PathSeg[] = []
  replayAsText(g.outline, {
    moveTo: (x, y) => { segs.push({ cmd: 'M', x, y }) },
    lineTo: (x, y) => { segs.push({ cmd: 'L', x, y }) },
    bezierCurveTo: (c1x, c1y, c2x, c2y, x, y) => { segs.push({ cmd: 'C', c1x, c1y, c2x, c2y, x, y }) },
    closePath: () => { segs.push({ cmd: 'Z' }) },
  }, 0)
  return segs
}

/** What the canvas draws for a line or area: its full-precision text's segments traced on `s` (the recording replayed). */
export function drawCurveExact(g: CurveGeometry, s: CurveSink): void {
  if (curveFinite(g)) replayAsText(g.outline, s, 0)
  else tracePath(s as never, parsePathData(g.exactText()))
}

/** The hit index's polygons of a line or area (of its full-precision text, as the canvas draws it) placed at (tx, ty). */
export function curvePolys(g: CurveGeometry, tx: number, ty: number): Poly[] {
  return placed(g, () => {
    const f = new Flattener(IDENTITY)
    const t = new AsText(f, 0)
    g.draw(t)
    if (t.finite) return f.polys
    return flattenSegs(parsePathData(g.exactText()))
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
  if (g.digits === null) return arcSegs(g)
  if (g.exactSegCache === undefined) {
    const w = new ArcSegWriter(null)
    g.outline.replay(w)
    if (w.finite) g.exactSegCache = w.segs as PathSeg[]
    else {
      const t = new ArcPathWriter(null)
      g.outline.replay(t)
      g.exactSegCache = parsePathData(t.d)
    }
  }
  return g.exactSegCache
}

/** The hit index's polygons of a trail or an arc (of its full-precision text) placed at (tx, ty). */
export const arcPolys = (g: ArcGeometry, tx: number, ty: number): Poly[] => placed(g, () => flattenSegs(arcExactSegs(g)), tx, ty)

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

/** The polygons of a path string (a path mark's, a shape's, a scene-carried one), untransformed; parsed once per distinct string. */
export function pathPolys(d: string): Poly[] {
  const segs = parsePathData(d)
  let polys = PATH_POLYS.get(segs)
  if (polys === undefined) PATH_POLYS.set(segs, (polys = flattenSegs(segs)))
  return polys
}
