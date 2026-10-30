/**
 * Clipping of geometry events: to the visible part of the sphere (cut at the antimeridian, or at a small
 * circle around the view centre) and to a screen rectangle.
 *
 * Lines are cut into the pieces that lie inside the clip region. Polygons are cut ring by ring; the
 * cut pieces are then re-joined into closed rings by walking along the clip boundary between the points
 * where pieces leave and re-enter (`rejoin`), so a polygon that crosses the boundary stays a polygon.
 */
import {
  Events, LINE_END, LINE_START, POINT, POLYGON_END, POLYGON_START, Run, SPHERE,
} from './geo-events.js'
import {
  EPSILON, HALF_PI, PI, RADIANS, TAU, type Ring, type Vec3, acosClamped, addTo, cross, dot, lonLat, normalize, polygonContains,
  sameSpot, scaled, unitVector,
} from './geo-sphere.js'

/** A position on the boundary of a clip region. */
export interface Spot {
  readonly x: number
  readonly y: number
}

/** A maximal run of vertices of one ring that stays inside the clip region. */
interface Piece {
  xy: number[]
  /** non-zero when the first vertex is a boundary crossing of the second kind (see `CircleClipper`) */
  entryMark: number
  /** non-zero when the last vertex is a boundary crossing of the leaving kind */
  exitMark: number
}

/** Receives the pieces a line is cut into. */
interface PieceSink {
  begin(src: number): void
  add(x: number, y: number, src: number, mark?: number): void
  end(src: number): void
}

/** A sink that writes straight to an event buffer: the pieces of an open line. */
class LineWriter implements PieceSink {
  constructor(private readonly out: Events) {}
  begin(src: number): void {
    this.out.mark(LINE_START, src)
  }
  add(x: number, y: number, src: number): void {
    this.out.point(x, y, src)
  }
  end(src: number): void {
    this.out.mark(LINE_END, src)
  }
}

/** A sink that keeps the pieces of a ring for re-joining. */
class PieceCollector implements PieceSink {
  pieces: Piece[] = []
  private current: Piece | null = null
  begin(): void {
    this.pieces.push((this.current = { xy: [], entryMark: 0, exitMark: 0 }))
  }
  add(x: number, y: number, _src: number, mark = 0): void {
    const piece = this.current!
    if (!piece.xy.length) piece.entryMark = mark
    piece.exitMark = mark
    piece.xy.push(x, y)
  }
  end(): void {}
  take(): Piece[] {
    const taken = this.pieces
    this.pieces = []
    this.current = null
    return taken
  }
}

/** The last piece of a ring continues into its first when the ring was cut somewhere other than at its start. */
function joinEnds(pieces: Piece[]): void {
  const first = pieces.shift()!
  const last = pieces.pop()!
  pieces.push({
    xy: last.xy.concat(first.xy),
    entryMark: last.xy.length ? last.entryMark : first.entryMark,
    exitMark: first.xy.length ? first.exitMark : last.exitMark,
  })
}

type Emit = (x: number, y: number) => void

/** Writes the boundary stretch from one crossing to the next (`direction` 1 or -1) as points. */
type Interpolator = (from: Spot | null, to: Spot | null, direction: number, emit: Emit) => void

/* ---- re-joining cut rings ---------------------------------------------------------------------- */

/** A place where a cut piece meets the clip boundary, threaded into two cyclic lists. */
class Crossing {
  visited = false
  next!: Crossing
  prev!: Crossing
  /** the same crossing in the other list */
  twin!: Crossing
  constructor(readonly x: number, readonly y: number, readonly piece: Piece | null, public entering: boolean) {}
}

function thread(list: Crossing[]): void {
  const n = list.length
  for (let i = 0; i < n; i++) {
    const a = list[i]!
    const b = list[(i + 1) % n]!
    a.next = b
    b.prev = a
  }
}

/**
 * Join the cut pieces of a polygon's rings into closed rings. `crossings` along the boundary are sorted
 * by `compare` and alternately entering and leaving the region, starting from `startInside`; a ring is
 * traced by following a piece to where it leaves, then the boundary to the next entering crossing.
 */
function rejoin(
  pieces: readonly Piece[],
  compare: (a: Spot, b: Spot) => number,
  startInside: boolean,
  interpolate: Interpolator,
  out: Events,
  src: number,
): void {
  const subject: Crossing[] = []
  const boundary: Crossing[] = []
  const emit: Emit = (x, y) => out.point(x, y, src)
  for (const piece of pieces) {
    const n = piece.xy.length / 2 - 1
    if (n <= 0) continue
    const xy = piece.xy
    if (sameSpot(xy[0]!, xy[1]!, xy[2 * n]!, xy[2 * n + 1]!)) {
      if (!piece.entryMark && !piece.exitMark) {
        // a piece that closes on itself needs no joining
        out.mark(LINE_START, src)
        for (let i = 0; i < n; i++) out.point(xy[2 * i]!, xy[2 * i + 1]!, src)
        out.mark(LINE_END, src)
        continue
      }
      // a piece cut exactly where it closes: nudge its end so the two crossings can be told apart
      xy[2 * n]! += 2 * EPSILON
    }
    const head = new Crossing(xy[0]!, xy[1]!, piece, true)
    const tail = new Crossing(xy[2 * n]!, xy[2 * n + 1]!, piece, false)
    subject.push(head, tail)
    boundary.push((head.twin = new Crossing(head.x, head.y, null, false)), (tail.twin = new Crossing(tail.x, tail.y, null, true)))
    head.twin.twin = head
    tail.twin.twin = tail
  }
  if (!subject.length) return
  boundary.sort((a, b) => compare(a, b))
  thread(subject)
  thread(boundary)
  for (const crossing of boundary) crossing.entering = startInside = !startInside
  const first = subject[0]!
  for (;;) {
    // the next crossing no ring has passed through yet
    let current = first
    let onSubject = true
    while (current.visited) if ((current = current.next) === first) return
    let points = current.piece
    out.mark(LINE_START, src)
    do {
      current.visited = current.twin.visited = true
      if (current.entering) {
        if (onSubject) for (let i = 0; i < points!.xy.length; i += 2) out.point(points!.xy[i]!, points!.xy[i + 1]!, src)
        else interpolate(current, current.next, 1, emit)
        current = current.next
      } else {
        if (onSubject) {
          points = current.prev.piece
          for (let i = points!.xy.length - 2; i >= 0; i -= 2) out.point(points!.xy[i]!, points!.xy[i + 1]!, src)
        } else interpolate(current, current.prev, -1, emit)
        current = current.prev
      }
      current = current.twin
      points = current.piece
      onSubject = !onSubject
    } while (!current.visited)
    out.mark(LINE_END, src)
  }
}

/* ---- clipping to the sphere -------------------------------------------------------------------- */

/** A region of the sphere to keep, and how to cut lines and polygons to it. */
export interface SphereClipper {
  /** a position known to lie outside the region (the start of the containment test) */
  readonly outside: readonly [number, number]
  visible(lambda: number, phi: number): boolean
  /**
   * Cut a polyline (a run of vertices; a `closed` one returns to its first vertex) into pieces. The result
   * says whether the cut was clean: bit 0, no crossings; bit 1, the first and last pieces of a closed ring
   * continue into each other.
   */
  cut(line: Run, closed: boolean, startSrc: number, endSrc: number, sink: PieceSink): number
  interpolate: Interpolator
  /** the order of crossings along the boundary */
  compare(a: Spot, b: Spot): number
}

/**
 * Intersections of a great circle through two vertices with the meridian of the antimeridian cut: the
 * latitude where the segment from (lambda0, phi0) to (lambda1, phi1) crosses it.
 */
function antimeridianCrossing(lambda0: number, phi0: number, lambda1: number, phi1: number): number {
  const sinLambda0Lambda1 = Math.sin(lambda0 - lambda1)
  return Math.abs(sinLambda0Lambda1) > EPSILON
    ? Math.atan(
        (Math.sin(phi0) * Math.cos(phi1) * Math.sin(lambda1) - Math.sin(phi1) * Math.cos(phi0) * Math.sin(lambda0)) /
          (Math.cos(phi0) * Math.cos(phi1) * sinLambda0Lambda1),
      )
    : (phi0 + phi1) / 2
}

/** Crossings along the cut are ordered south to north on the west side, then north to south on the east. */
const compareAlongCut = (a: Spot, b: Spot): number =>
  (a.x < 0 ? a.y - HALF_PI - EPSILON : HALF_PI - a.y) - (b.x < 0 ? b.y - HALF_PI - EPSILON : HALF_PI - b.y)

/** Keeps the whole sphere, cut open along the antimeridian so that geometry never wraps. */
export const antimeridian: SphereClipper = {
  outside: [-PI, -HALF_PI],
  visible: () => true,
  cut(line, closed, startSrc, endSrc, sink) {
    let lambda0 = NaN
    let phi0 = NaN
    let sign0 = NaN
    let clean = 1
    const n = line.length
    const { from } = line
    sink.begin(startSrc)
    for (let i = 0, total = closed ? n + 1 : n; i < total; i++) {
      const at = from + (i < n ? i : 0)
      let lambda1 = line.x[at]!
      const phi1 = line.y[at]!
      const src = i < n ? line.src[at]! : endSrc
      const sign1 = lambda1 > 0 ? PI : -PI
      const delta = Math.abs(lambda1 - lambda0)
      if (Math.abs(delta - PI) < EPSILON) {
        // the segment passes over a pole: go up to it, round to the other side of the cut, and come back
        phi0 = (phi0 + phi1) / 2 > 0 ? HALF_PI : -HALF_PI
        sink.add(lambda0, phi0, src)
        sink.add(sign0, phi0, src)
        sink.end(src)
        sink.begin(src)
        sink.add(sign1, phi0, src)
        sink.add(lambda1, phi0, src)
        clean = 0
      } else if (sign0 !== sign1 && delta >= PI) {
        // the segment crosses the antimeridian
        if (Math.abs(lambda0 - sign0) < EPSILON) lambda0 -= sign0 * EPSILON
        if (Math.abs(lambda1 - sign1) < EPSILON) lambda1 -= sign1 * EPSILON
        phi0 = antimeridianCrossing(lambda0, phi0, lambda1, phi1)
        sink.add(sign0, phi0, src)
        sink.end(src)
        sink.begin(src)
        sink.add(sign1, phi0, src)
        clean = 0
      }
      sink.add((lambda0 = lambda1), (phi0 = phi1), src)
      sign0 = sign1
    }
    sink.end(endSrc)
    return 2 - clean
  },
  interpolate(from, to, direction, emit) {
    if (from == null) {
      // the whole outline of the sphere: the rectangle that the antimeridian cut opens it into
      const phi = direction * HALF_PI
      emit(-PI, phi)
      emit(0, phi)
      emit(PI, phi)
      emit(PI, 0)
      emit(PI, -phi)
      emit(0, -phi)
      emit(-PI, -phi)
      emit(-PI, 0)
      emit(-PI, phi)
    } else if (Math.abs(from.x - to!.x) > EPSILON) {
      // between the two sides of the cut, along the pole that lies between them
      const lambda = from.x < to!.x ? PI : -PI
      const phi = (direction * lambda) / 2
      emit(-lambda, phi)
      emit(0, phi)
      emit(lambda, phi)
    } else emit(to!.x, to!.y)
  },
  compare: compareAlongCut,
}

/** The angular coordinate, around the clip circle, at which a position on it lies. */
function circleAngle(cosRadius: number, spot: Spot): number {
  const p = unitVector(spot.x, spot.y)
  p[0] -= cosRadius
  normalize(p)
  const radius = acosClamped(-p[1])
  return ((-p[2] < 0 ? -radius : radius) + TAU - EPSILON) % TAU
}

/** Keeps the cap of the sphere within `radius` of the view centre (longitude 0, latitude 0). */
export class CircleClipper implements SphereClipper {
  readonly outside: readonly [number, number]
  private readonly cosRadius: number
  private readonly small: boolean
  private readonly curved: boolean
  private readonly step = 2 * RADIANS

  constructor(private readonly radius: number) {
    this.cosRadius = Math.cos(radius)
    this.small = this.cosRadius > 0
    this.curved = Math.abs(this.cosRadius) > EPSILON
    this.outside = this.small ? [0, -radius] : [-PI, radius - PI]
  }

  visible(lambda: number, phi: number): boolean {
    return Math.cos(lambda) * Math.cos(phi) > this.cosRadius
  }

  compare = compareAlongCut

  interpolate: Interpolator = (from, to, direction, emit) => {
    const { radius, cosRadius, step: delta } = this
    if (!delta) return
    const sinRadius = Math.sin(radius)
    const step = direction * delta
    let t0: number
    let t1: number
    if (from == null) {
      t0 = radius + direction * TAU
      t1 = radius - step / 2
    } else {
      t0 = circleAngle(cosRadius, from)
      t1 = circleAngle(cosRadius, to!)
      if (direction > 0 ? t0 < t1 : t0 > t1) t0 += direction * TAU
    }
    for (let t = t0; direction > 0 ? t > t1 : t < t1; t -= step) {
      const at = lonLat([cosRadius, -sinRadius * Math.cos(t), -sinRadius * Math.sin(t)])
      emit(at[0], at[1])
    }
  }

  /** Which sides of the cap's bounding box (left, right, below, above) a position is beyond. */
  private outcode(lambda: number, phi: number): number {
    const r = this.small ? this.radius : PI - this.radius
    let code = 0
    if (lambda < -r) code |= 1
    else if (lambda > r) code |= 2
    if (phi < -r) code |= 4
    else if (phi > r) code |= 8
    return code
  }

  /**
   * Where the great circle through a and b meets the clip circle: the first intersection, or both of them
   * (ordered along the segment, `undefined` when the segment does not reach the circle) when `both` is set.
   */
  private crossing(a: readonly [number, number], b: readonly [number, number]): [number, number]
  private crossing(a: readonly [number, number], b: readonly [number, number], both: true): [[number, number], [number, number]] | undefined
  private crossing(a: readonly [number, number], b: readonly [number, number], both?: true): unknown {
    const cr = this.cosRadius
    const pa = unitVector(a[0], a[1])
    const pb = unitVector(b[0], b[1])
    // two planes, n1.p = d1 and n2.p = d2: their line of intersection is c1 n1 + c2 n2 + t (n1 x n2)
    const n1: Vec3 = [1, 0, 0]
    const n2 = cross(pa, pb)
    const n2n2 = dot(n2, n2)
    const n1n2 = n2[0]
    const determinant = n2n2 - n1n2 * n1n2
    // both ends at the poles: no unique great circle
    if (!determinant) return !both ? a : undefined
    const c1 = (cr * n2n2) / determinant
    const c2 = (-cr * n1n2) / determinant
    const n1xn2 = cross(n1, n2)
    const A = scaled(n1, c1)
    addTo(A, scaled(n2, c2))
    // the points of that line on the unit sphere: the roots of |p(t)|^2 = 1
    const u = n1xn2
    const w = dot(A, u)
    const uu = dot(u, u)
    const t2 = w * w - uu * (dot(A, A) - 1)
    if (t2 < 0) return undefined as never
    const t = Math.sqrt(t2)
    const q = scaled(u, (-w - t) / uu)
    addTo(q, A)
    const first = lonLat(q)
    if (!both) return first
    // is the first intersection between a and b?
    let lambda0 = a[0]
    let lambda1 = b[0]
    let phi0 = a[1]
    let phi1 = b[1]
    let swap: number
    if (lambda1 < lambda0) (swap = lambda0), (lambda0 = lambda1), (lambda1 = swap)
    const delta = lambda1 - lambda0
    const polar = Math.abs(delta - PI) < EPSILON
    const meridian = polar || delta < EPSILON
    if (!polar && phi1 < phi0) (swap = phi0), (phi0 = phi1), (phi1 = swap)
    if (
      meridian
        ? polar
          ? phi0 + phi1 > 0 !== (first[1] < (Math.abs(first[0] - lambda0) < EPSILON ? phi0 : phi1))
          : phi0 <= first[1] && first[1] <= phi1
        : delta > PI !== (lambda0 <= first[0] && first[0] <= lambda1)
    ) {
      const q1 = scaled(u, (-w + t) / uu)
      addTo(q1, A)
      return [first, lonLat(q1)]
    }
    return undefined
  }

  cut(line: Run, closed: boolean, _startSrc: number, endSrc: number, sink: PieceSink): number {
    const { small, curved } = this
    let previous: [number, number] | null = null
    let code0 = 0
    let inside0 = false
    let insideFirst = false
    let clean = 1
    const n = line.length
    const { from } = line
    for (let i = 0, total = closed ? n + 1 : n; i < total; i++) {
      const at = from + (i < n ? i : 0)
      const lambda = line.x[at]!
      const phi = line.y[at]!
      const src = i < n ? line.src[at]! : endSrc
      const here: [number, number] = [lambda, phi]
      const inside = this.visible(lambda, phi)
      const code = small ? (inside ? 0 : this.outcode(lambda, phi)) : inside ? this.outcode(lambda + (lambda < 0 ? PI : -PI), phi) : 0
      if (!previous && (insideFirst = inside0 = inside)) sink.begin(src)
      if (inside !== inside0) {
        clean = 0
        if (inside) {
          // the segment enters the region: start a piece at the boundary
          sink.begin(src)
          const at = this.crossing(here, previous!)
          sink.add(at[0], at[1], src)
          previous = at
        } else {
          // the segment leaves the region: end the piece at the boundary
          const at = this.crossing(previous!, here)
          sink.add(at[0], at[1], src, 2)
          sink.end(src)
          previous = at
        }
      } else if (curved && previous && (small ? !inside : inside)) {
        // a segment between two points on the same side can still cut a chord of the circle
        let chord: [[number, number], [number, number]] | undefined
        if (!(code & code0) && (chord = this.crossing(here, previous, true))) {
          clean = 0
          if (small) {
            sink.begin(src)
            sink.add(chord[0][0], chord[0][1], src)
            sink.add(chord[1][0], chord[1][1], src)
            sink.end(src)
          } else {
            sink.add(chord[1][0], chord[1][1], src)
            sink.end(src)
            sink.begin(src)
            sink.add(chord[0][0], chord[0][1], src, 3)
          }
        }
      }
      if (inside && (!previous || !sameSpot(previous[0], previous[1], lambda, phi))) sink.add(lambda, phi, src)
      previous = here
      inside0 = inside
      code0 = code
    }
    if (inside0) sink.end(endSrc)
    return clean | ((insideFirst && inside0 ? 1 : 0) << 1)
  }
}

/** Writes the ring a polygon-covering clip region leaves when no piece of the polygon crosses its boundary. */
function emitBoundaryRing(clipper: { interpolate: Interpolator }, out: Events, src: number): void {
  out.mark(LINE_START, src)
  clipper.interpolate(null, null, 1, (x, y) => out.point(x, y, src))
  out.mark(LINE_END, src)
}

/**
 * Clip events (rotated, in radians) to a region of the sphere. Open lines come out as the pieces inside
 * the region; polygons come out as rings, including, when the polygon swallows the whole region, the
 * region's own outline.
 */
export function clipToSphere(ev: Events, clipper: SphereClipper): Events {
  const out = Events.take(ev.length)
  const lines = new LineWriter(out)
  let lineFrom = 0
  let lineSrc = 0
  let inLine = false
  // polygon state
  let inPolygon = false
  let polygonStarted = false
  let rings: Ring[] = []
  let cutRings: Piece[][] = []

  const startPolygon = (src: number): void => {
    if (!polygonStarted) out.mark(POLYGON_START, src)
    polygonStarted = true
  }

  const endRing = (ring: Run, src: number): void => {
    if (!ring.length) throw new TypeError("Cannot read properties of undefined (reading '0')")
    const collector = new PieceCollector()
    // the ring is cut closed: with its first vertex repeated at the end
    const clean = clipper.cut(ring, true, lineSrc, src, collector)
    const pieces = collector.take()
    rings.push(ring)
    const n = pieces.length
    if (!n) return
    if (clean & 1) {
      // no crossings: the ring is entirely inside, and comes out as it went in
      const only = pieces[0]!
      const m = only.xy.length / 2 - 1
      if (m > 0) {
        startPolygon(src)
        out.mark(LINE_START, src)
        for (let i = 0; i < m; i++) out.point(only.xy[2 * i]!, only.xy[2 * i + 1]!, src)
        out.mark(LINE_END, src)
      }
      return
    }
    if (n > 1 && clean & 2) joinEnds(pieces)
    cutRings.push(pieces.filter((piece) => piece.xy.length > 2))
  }

  for (let i = 0; i < ev.length; i++) {
    const src = ev.src[i]!
    switch (ev.op[i]!) {
      case POINT:
        if (!inLine && clipper.visible(ev.x[i]!, ev.y[i]!)) out.point(ev.x[i]!, ev.y[i]!, src)
        break
      case LINE_START:
        inLine = true
        lineFrom = i + 1
        lineSrc = src
        break
      case LINE_END: {
        inLine = false
        const line = new Run(ev, lineFrom, i)
        if (inPolygon) endRing(line, src)
        else clipper.cut(line, false, lineSrc, src, lines)
        break
      }
      case POLYGON_START:
        inPolygon = true
        rings = []
        cutRings = []
        break
      case POLYGON_END: {
        inPolygon = false
        const pieces = cutRings.flat()
        const [lambda, phi] = clipper.outside
        const startInside = polygonContains(rings, lambda, phi)
        if (pieces.length) {
          startPolygon(src)
          rejoin(pieces, (a, b) => clipper.compare(a, b), startInside, clipper.interpolate, out, src)
        } else if (startInside) {
          startPolygon(src)
          emitBoundaryRing(clipper, out, src)
        }
        if (polygonStarted) out.mark(POLYGON_END, src)
        polygonStarted = false
        rings = []
        cutRings = []
        break
      }
      case SPHERE:
        out.mark(POLYGON_START, src)
        emitBoundaryRing(clipper, out, src)
        out.mark(POLYGON_END, src)
        break
    }
  }
  return out
}

/* ---- clipping to a rectangle ------------------------------------------------------------------- */

/** Coordinates beyond this are clamped before a segment is clipped, so the clipping arithmetic stays finite. */
const CLAMP = 1e9

const clamp = (v: number): number => Math.max(-CLAMP, Math.min(CLAMP, v))

/**
 * Clip the segment a-b to the rectangle (Liang-Barsky), moving the endpoints that lie outside onto the
 * edges. Returns false when no part of the segment is inside.
 */
function clipSegment(a: number[], b: number[], x0: number, y0: number, x1: number, y1: number): boolean {
  const ax = a[0]!
  const ay = a[1]!
  const bx = b[0]!
  const by = b[1]!
  let t0 = 0
  let t1 = 1
  const dx = bx - ax
  const dy = by - ay
  let r: number
  r = x0 - ax
  if (!dx && r > 0) return false
  r /= dx
  if (dx < 0) {
    if (r < t0) return false
    if (r < t1) t1 = r
  } else if (dx > 0) {
    if (r > t1) return false
    if (r > t0) t0 = r
  }
  r = x1 - ax
  if (!dx && r < 0) return false
  r /= dx
  if (dx < 0) {
    if (r > t1) return false
    if (r > t0) t0 = r
  } else if (dx > 0) {
    if (r < t0) return false
    if (r < t1) t1 = r
  }
  r = y0 - ay
  if (!dy && r > 0) return false
  r /= dy
  if (dy < 0) {
    if (r < t0) return false
    if (r < t1) t1 = r
  } else if (dy > 0) {
    if (r > t1) return false
    if (r > t0) t0 = r
  }
  r = y1 - ay
  if (!dy && r < 0) return false
  r /= dy
  if (dy < 0) {
    if (r > t1) return false
    if (r > t0) t0 = r
  } else if (dy > 0) {
    if (r < t0) return false
    if (r < t1) t1 = r
  }
  if (t0 > 0) (a[0] = ax + t0 * dx), (a[1] = ay + t0 * dy)
  if (t1 < 1) (b[0] = ax + t1 * dx), (b[1] = ay + t1 * dy)
  return true
}

/** An axis-aligned clip rectangle, and the boundary walk its re-joining needs. */
export class Rectangle {
  constructor(readonly x0: number, readonly y0: number, readonly x1: number, readonly y1: number) {}

  contains(x: number, y: number): boolean {
    return this.x0 <= x && x <= this.x1 && this.y0 <= y && y <= this.y1
  }

  /** Which corner, counting from the top-left in the `direction` of travel, a boundary position leads to. */
  private corner(p: Spot, direction: number): number {
    return Math.abs(p.x - this.x0) < EPSILON
      ? direction > 0 ? 0 : 3
      : Math.abs(p.x - this.x1) < EPSILON
        ? direction > 0 ? 2 : 1
        : Math.abs(p.y - this.y0) < EPSILON
          ? direction > 0 ? 1 : 0
          : direction > 0 ? 3 : 2
  }

  /** Order boundary positions clockwise from the top-left corner. */
  compare = (a: Spot, b: Spot): number => {
    const ca = this.corner(a, 1)
    const cb = this.corner(b, 1)
    return ca !== cb ? ca - cb : ca === 0 ? b.y - a.y : ca === 1 ? a.x - b.x : ca === 2 ? a.y - b.y : b.x - a.x
  }

  interpolate: Interpolator = (from, to, direction, emit) => {
    let a = 0
    let a1 = 0
    if (from == null || (a = this.corner(from, direction)) !== (a1 = this.corner(to!, direction)) || this.compare(from, to!) < 0 !== direction > 0) {
      do emit(a === 0 || a === 3 ? this.x0 : this.x1, a > 1 ? this.y1 : this.y0)
      while ((a = (a + direction + 4) % 4) !== a1)
    } else emit(to!.x, to!.y)
  }

  /**
   * The winding number of a polygon (rings of [x, y] with the first vertex repeated) about the corner (x0, y1):
   * non-zero when the rectangle's reference corner lies inside the polygon.
   */
  private winding(rings: readonly number[][]): number {
    let winding = 0
    for (const ring of rings) {
      const n = ring.length / 2
      let b0 = ring[0]!
      let b1 = ring[1]!
      for (let j = 1; j < n; j++) {
        const a0 = b0
        const a1 = b1
        b0 = ring[2 * j]!
        b1 = ring[2 * j + 1]!
        if (a1 <= this.y1) {
          if (b1 > this.y1 && (b0 - a0) * (this.y1 - a1) > (b1 - a1) * (this.x0 - a0)) ++winding
        } else if (b1 <= this.y1 && (b0 - a0) * (this.y1 - a1) < (b1 - a1) * (this.x0 - a0)) --winding
      }
    }
    return winding
  }

  /** Clip planar events to this rectangle. */
  clip(ev: Events): Events {
    const { x0, y0, x1, y1 } = this
    const out = Events.take(ev.length)
    // the position and visibility of the first and the previous vertex of the line being clipped; these
    // outlive a line (an empty ring closes onto the previous line's first vertex)
    let xFirst: number = undefined as unknown as number
    let yFirst: number = undefined as unknown as number
    let visibleFirst = false
    let xPrev = NaN
    let yPrev = NaN
    let visiblePrev = false
    let first = true
    let clean = true
    // polygon state: rings kept for the winding test, and the clipped pieces of each ring
    let inPolygon = false
    let inLine = false
    let polygonRings: number[][] = []
    let ringXY: number[] = []
    let pieceLists: Piece[][] = []
    let pieces: Piece[] = []
    let src = 0

    const beginPiece = (): void => {
      if (inPolygon) pieces.push({ xy: [], entryMark: 0, exitMark: 0 })
      else out.mark(LINE_START, src)
    }
    const addVertex = (x: number, y: number): void => {
      if (inPolygon) {
        const piece = pieces[pieces.length - 1]!
        piece.xy.push(x, y)
      } else out.point(x, y, src)
    }
    const endPiece = (): void => {
      if (!inPolygon) out.mark(LINE_END, src)
    }

    const vertex = (xIn: number, yIn: number): void => {
      const visible = this.contains(xIn, yIn)
      let x = xIn
      let y = yIn
      if (inPolygon) ringXY.push(x, y)
      if (first) {
        xFirst = x
        yFirst = y
        visibleFirst = visible
        first = false
        if (visible) {
          beginPiece()
          addVertex(x, y)
        }
      } else if (visible && visiblePrev) addVertex(x, y)
      else {
        const a = [(xPrev = clamp(xPrev)), (yPrev = clamp(yPrev))]
        const b = [(x = clamp(x)), (y = clamp(y))]
        if (clipSegment(a, b, x0, y0, x1, y1)) {
          if (!visiblePrev) {
            beginPiece()
            addVertex(a[0]!, a[1]!)
          }
          addVertex(b[0]!, b[1]!)
          if (!visible) endPiece()
          clean = false
        } else if (visible) {
          beginPiece()
          addVertex(x, y)
          clean = false
        }
      }
      xPrev = x
      yPrev = y
      visiblePrev = visible
    }

    for (let i = 0; i < ev.length; i++) {
      src = ev.src[i]!
      switch (ev.op[i]!) {
        case POINT:
          if (inLine) vertex(ev.x[i]!, ev.y[i]!)
          else if (this.contains(ev.x[i]!, ev.y[i]!)) out.point(ev.x[i]!, ev.y[i]!, src)
          break
        case LINE_START:
          inLine = true
          if (inPolygon) {
            ringXY = []
            polygonRings.push(ringXY)
            pieces = []
          }
          first = true
          visiblePrev = false
          xPrev = yPrev = NaN
          break
        case LINE_END:
          inLine = false
          if (inPolygon) {
            vertex(xFirst, yFirst)
            if (visibleFirst && visiblePrev) {
              if (pieces.length > 1) joinEnds(pieces)
            }
            pieceLists.push(pieces)
            pieces = []
          }
          if (visiblePrev) endPiece()
          break
        case POLYGON_START:
          inPolygon = true
          polygonRings = []
          pieceLists = []
          clean = true
          break
        case POLYGON_END: {
          inPolygon = false
          const winding = this.winding(polygonRings)
          const startInside = winding !== 0
          const cleanInside = clean && startInside
          const all = pieceLists.flat()
          if (cleanInside || all.length) {
            out.mark(POLYGON_START, src)
            if (cleanInside) emitBoundaryRing(this, out, src)
            if (all.length) rejoin(all, this.compare, startInside, this.interpolate, out, src)
            out.mark(POLYGON_END, src)
          }
          polygonRings = []
          pieceLists = []
          break
        }
        case SPHERE:
          throw new TypeError('this.stream.sphere is not a function')
      }
    }
    return out
  }
}
