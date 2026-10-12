/**
 * d3-geo (3.1.1): spherical math, streams, rotation, clipping, path
 * generation, measures, and the projection machinery. Faithful transcription
 * verified against oracle vectors recorded from pinned d3-geo@3.1.1.
 */
import { Adder, merge } from './arr.js'

export type SR = any // upstream is duck-typed JS; vectors verify behaviour

// ---- math.js ----------------------------------------------------------------

export const epsilon = 1e-6
export const epsilon2 = 1e-12
export const pi = Math.PI
export const halfPi = pi / 2
export const quarterPi = pi / 4
export const tau = pi * 2
export const degrees = 180 / pi
export const radians = pi / 180
export const abs = Math.abs
export const atan = Math.atan
export const atan2 = Math.atan2
export const cos = Math.cos
export const ceil = Math.ceil
export const exp = Math.exp
export const floor = Math.floor
export const hypot = Math.hypot
export const log = Math.log
export const pow = Math.pow
export const sin = Math.sin
export const sign = Math.sign || ((x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0))
export const sqrt = Math.sqrt
export const tan = Math.tan

export function acos(x: number): number {
  return x > 1 ? 0 : x < -1 ? pi : Math.acos(x)
}
export function asin(x: number): number {
  return x > 1 ? halfPi : x < -1 ? -halfPi : Math.asin(x)
}
export function haversin(x: number): number {
  return (x = sin(x / 2)) * x
}

export function geoNoop(): void {}

// ---- identity.js / pointEqual.js --------------------------------------------

export const identityFn = (x: unknown) => x

export function pointEqual(a: any, b: any): boolean {
  return abs(a[0]! - b[0]!) < epsilon && abs(a[1]! - b[1]!) < epsilon
}

// ---- cartesian.js -----------------------------------------------------------

export function spherical(cartesian: any): any {
  return [atan2(cartesian[1]!, cartesian[0]!), asin(cartesian[2]!)]
}

export function cartesian(sphericalIn: any): any {
  const lambda = sphericalIn[0]!
  const phi = sphericalIn[1]!
  const cosPhi = cos(phi)
  return [cosPhi * cos(lambda), cosPhi * sin(lambda), sin(phi)]
}

export function cartesianDot(a: any, b: any): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
}

export function cartesianCross(a: any, b: any): any {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]
}

export function cartesianAddInPlace(a: any, b: any): void {
  a[0]! += b[0]!, a[1]! += b[1]!, a[2]! += b[2]!
}

export function cartesianScale(vector: any, k: number): any {
  return [vector[0]! * k, vector[1]! * k, vector[2]! * k]
}

export function cartesianNormalizeInPlace(d: any): void {
  const l = sqrt(d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]!)
  d[0] /= l, d[1] /= l, d[2] /= l
}

// ---- stream.js --------------------------------------------------------------

export interface Stream {
  point?(x: number, y: number, m?: number): void
  lineStart?(): void
  lineEnd?(): void
  polygonStart?(): void
  polygonEnd?(): void
  sphere?(): void
  result?(): unknown
}

function streamGeometry(geometry: SR, stream: Stream): void {
  if (geometry && streamGeometryType[geometry.type]) {
    (streamGeometryType[geometry.type] as (o: SR, s: Stream) => void)(geometry, stream)
  }
}

const streamObjectType: Record<string, (object: SR, stream: Stream) => void> = {
  Feature(object, stream) {
    streamGeometry(object.geometry, stream)
  },
  FeatureCollection(object, stream) {
    const features = object.features
    let i = -1
    const n = features.length
    while (++i < n) streamGeometry(features[i].geometry, stream)
  },
}

const streamGeometryType: Record<string, (object: SR, stream: Stream) => void> = {
  Sphere(object, stream) {
    stream.sphere!()
  },
  Point(object, stream) {
    object = object.coordinates
    stream.point!(object[0], object[1], object[2])
  },
  MultiPoint(object, stream) {
    const coordinates = object.coordinates
    let i = -1
    const n = coordinates.length
    while (++i < n) (object = coordinates[i]), stream.point!(object[0], object[1], object[2])
  },
  LineString(object, stream) {
    streamLine(object.coordinates, stream, 0)
  },
  MultiLineString(object, stream) {
    const coordinates = object.coordinates
    let i = -1
    const n = coordinates.length
    while (++i < n) streamLine(coordinates[i], stream, 0)
  },
  Polygon(object, stream) {
    streamPolygon(object.coordinates, stream)
  },
  MultiPolygon(object, stream) {
    const coordinates = object.coordinates
    let i = -1
    const n = coordinates.length
    while (++i < n) streamPolygon(coordinates[i], stream)
  },
  GeometryCollection(object, stream) {
    const geometries = object.geometries
    let i = -1
    const n = geometries.length
    while (++i < n) streamGeometry(geometries[i], stream)
  },
}

function streamLine(coordinates: any, stream: Stream, closed: number): void {
  let i = -1
  const n = coordinates.length - closed
  stream.lineStart!()
  while (++i < n) stream.point!(coordinates[i]![0], coordinates[i]![1], coordinates[i]![2])
  stream.lineEnd!()
}

function streamPolygon(coordinates: any, stream: Stream): void {
  let i = -1
  const n = coordinates.length
  stream.polygonStart!()
  while (++i < n) streamLine(coordinates[i]!, stream, 1)
  stream.polygonEnd!()
}

export function geoStream(object: SR, stream: Stream): void {
  if (object && streamObjectType[object.type]) {
    (streamObjectType[object.type] as (o: SR, s: Stream) => void)(object, stream)
  } else {
    streamGeometry(object, stream)
  }
}

// ---- transform.js -----------------------------------------------------------

export function transformer(methods: Record<string, unknown>): (stream: Stream) => Stream {
  return function (stream: Stream): Stream {
    const s: any = new (TransformStream as any)()
    for (const key in methods) s[key] = methods[key]
    s.stream = stream
    return s
  }
}

function TransformStream(this: SR) {}
TransformStream.prototype = {
  constructor: TransformStream,
  point(x: number, y: number) {
    this.stream.point(x, y)
  },
  sphere() {
    this.stream.sphere()
  },
  lineStart() {
    this.stream.lineStart()
  },
  lineEnd() {
    this.stream.lineEnd()
  },
  polygonStart() {
    this.stream.polygonStart()
  },
  polygonEnd() {
    this.stream.polygonEnd()
  },
}

export function transformRadians(methods: Record<string, unknown>): { stream: (stream: Stream) => Stream } {
  return { stream: transformer(methods) }
}

// ---- compose.js -------------------------------------------------------------

export function compose(a: SR, b: SR): SR {
  function composeFn(x: number, y: number): any {
    const r = a(x, y)
    return b(r[0], r[1])
  }
  if (a.invert && b.invert) {
    composeFn.invert = function (x: number, y: number): any {
      const r = b.invert(x, y)
      return r && a.invert(r[0], r[1])
    }
  }
  return composeFn
}

// ---- rotation.js ------------------------------------------------------------

function rotationIdentity(lambda: number, phi: number): any {
  if (abs(lambda) > pi) lambda -= Math.round(lambda / tau) * tau
  return [lambda, phi]
}
rotationIdentity.invert = rotationIdentity

export function rotateRadians(deltaLambda: number, deltaPhi: number, deltaGamma: number): SR {
  return (deltaLambda %= tau)
    ? (deltaPhi || deltaGamma
        ? compose(rotationLambda(deltaLambda), rotationPhiGamma(deltaPhi, deltaGamma))
        : rotationLambda(deltaLambda))
    : (deltaPhi || deltaGamma
        ? rotationPhiGamma(deltaPhi, deltaGamma)
        : rotationIdentity)
}

function forwardRotationLambda(deltaLambda: number) {
  return function (lambda: number, phi: number): any {
    lambda += deltaLambda
    if (abs(lambda) > pi) lambda -= Math.round(lambda / tau) * tau
    return [lambda, phi]
  }
}

function rotationLambda(deltaLambda: number): any {
  const rotation: any = forwardRotationLambda(deltaLambda)
  rotation.invert = forwardRotationLambda(-deltaLambda)
  return rotation
}

function rotationPhiGamma(deltaPhi: number, deltaGamma: number): any {
  const cosDeltaPhi = cos(deltaPhi)
  const sinDeltaPhi = sin(deltaPhi)
  const cosDeltaGamma = cos(deltaGamma)
  const sinDeltaGamma = sin(deltaGamma)
  function rotation(lambda: number, phi: number): any {
    const cosPhi = cos(phi)
    const x = cos(lambda) * cosPhi
    const y = sin(lambda) * cosPhi
    const z = sin(phi)
    const k = z * cosDeltaPhi + x * sinDeltaPhi
    return [
      atan2(y * cosDeltaGamma - k * sinDeltaGamma, x * cosDeltaPhi - z * sinDeltaPhi),
      asin(k * cosDeltaGamma + y * sinDeltaGamma),
    ]
  }
  rotation.invert = function (lambda: number, phi: number): any {
    const cosPhi = cos(phi)
    const x = cos(lambda) * cosPhi
    const y = sin(lambda) * cosPhi
    const z = sin(phi)
    const k = z * cosDeltaGamma - y * sinDeltaGamma
    return [
      atan2(y * cosDeltaGamma + z * sinDeltaGamma, x * cosDeltaPhi + k * sinDeltaPhi),
      asin(k * cosDeltaPhi - x * sinDeltaPhi),
    ]
  }
  return rotation
}

export function rotation(rotate: any): SR {
  rotate = rotateRadians(rotate[0]! * radians, rotate[1]! * radians, rotate.length > 2 ? rotate[2]! * radians : 0)
  function forward(coordinates: any): any {
    coordinates = rotate(coordinates[0]! * radians, coordinates[1]! * radians)
    return (coordinates[0]! *= degrees), (coordinates[1]! *= degrees), coordinates
  }
  forward.invert = function (coordinates: any): any {
    coordinates = rotate.invert(coordinates[0]! * radians, coordinates[1]! * radians)
    return (coordinates[0]! *= degrees), (coordinates[1]! *= degrees), coordinates
  }
  return forward
}

// ---- clip/buffer.js ---------------------------------------------------------

export function clipBuffer(): SR {
  let lines: any = []
  let line: any = []
  return {
    point(x: number, y: number, m?: number) {
      line.push([x, y, m])
    },
    lineStart() {
      lines.push((line = []))
    },
    lineEnd: geoNoop,
    rejoin() {
      if (lines.length > 1) lines.push(lines.pop()!.concat(lines.shift()!))
    },
    result() {
      const result = lines
      lines = []
      line = []
      return result
    },
  }
}

// ---- clip/rejoin.js ---------------------------------------------------------

class Intersection {
  x: any
  z: any | null
  o: Intersection | null
  e: boolean
  v = false
  n: Intersection | null = null
  p: Intersection | null = null
  constructor(point: any, points: any | null, other: Intersection | null, entry: boolean) {
    this.x = point
    this.z = points
    this.o = other
    this.e = entry
  }
}

function link(array: Intersection[]): void {
  const n = array.length
  if (!n) return
  let i = 0
  let a = array[0]!
  let b: Intersection
  while (++i < n) {
    a.n = b = array[i]!
    b.p = a
    a = b
  }
  a.n = b = array[0]!
  b.p = a
}

/** A generalized polygon clipping: rejoin cut segments by interpolating along the clip edge. */
export function clipRejoin(segments: any, compareIntersection: (a: SR, b: SR) => number, startInside: boolean, interpolate: SR, stream: Stream): void {
  const subject: Intersection[] = []
  const clip: Intersection[] = []
  let i: number
  let n: number
  segments.forEach(function (segment: any) {
    if ((n = segment.length - 1) <= 0) return
    let p0: any = segment[0]
    const p1: any = segment[n]
    let x: Intersection
    if (pointEqual(p0, p1)) {
      if (!p0[2] && !p1[2]) {
        stream.lineStart!()
        for (i = 0; i < n; ++i) stream.point!((p0 = segment[i])[0], p0[1])
        stream.lineEnd!()
        return
      }
      // handle degenerate cases by moving the point
      p1[0] += 2 * epsilon
    }
    subject.push((x = new Intersection(p0, segment, null, true)))
    clip.push((x.o = new Intersection(p0, null, x, false)))
    subject.push((x = new Intersection(p1, segment, null, false)))
    clip.push((x.o = new Intersection(p1, null, x, true)))
  })
  if (!subject.length) return
  clip.sort(compareIntersection)
  link(subject)
  link(clip)
  for (i = 0, n = clip.length; i < n; ++i) {
    clip[i]!.e = startInside = !startInside
  }
  const start = subject[0]!
  let points: any | null
  for (;;) {
    // Find first unvisited intersection.
    let current: Intersection = start
    let isSubject = true
    while (current.v) if ((current = current.n!) === start) return
    points = current.z
    stream.lineStart!()
    do {
      current.v = current.o!.v = true
      if (current.e) {
        if (isSubject) {
          for (i = 0, n = points!.length; i < n; ++i) stream.point!(points![i]![0], points![i]![1])
        } else {
          interpolate(current.x, current.n!.x, 1, stream)
        }
        current = current.n!
      } else {
        if (isSubject) {
          points = current.p!.z
          for (i = points!.length - 1; i >= 0; --i) stream.point!(points![i]![0], points![i]![1])
        } else {
          interpolate(current.x, current.p!.x, -1, stream)
        }
        current = current.p!
      }
      current = current.o!
      points = current.z
      isSubject = !isSubject
    } while (!current.v)
    stream.lineEnd!()
  }
}

// ---- clip/line.js (Cohen–Sutherland-style 2D line clip) ---------------------

export function clipLine2D(a: any, b: any, x0: number, y0: number, x1: number, y1: number): boolean | undefined {
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
  if (!dx && r > 0) return undefined
  r /= dx
  if (dx < 0) {
    if (r < t0) return undefined
    if (r < t1) t1 = r
  } else if (dx > 0) {
    if (r > t1) return undefined
    if (r > t0) t0 = r
  }
  r = x1 - ax
  if (!dx && r < 0) return undefined
  r /= dx
  if (dx < 0) {
    if (r > t1) return undefined
    if (r > t0) t0 = r
  } else if (dx > 0) {
    if (r < t0) return undefined
    if (r < t1) t1 = r
  }
  r = y0 - ay
  if (!dy && r > 0) return undefined
  r /= dy
  if (dy < 0) {
    if (r < t0) return undefined
    if (r < t1) t1 = r
  } else if (dy > 0) {
    if (r > t1) return undefined
    if (r > t0) t0 = r
  }
  r = y1 - ay
  if (!dy && r < 0) return undefined
  r /= dy
  if (dy < 0) {
    if (r > t1) return undefined
    if (r > t0) t0 = r
  } else if (dy > 0) {
    if (r < t0) return undefined
    if (r < t1) t1 = r
  }
  if (t0 > 0) (a[0] = ax + t0 * dx), (a[1] = ay + t0 * dy)
  if (t1 < 1) (b[0] = ax + t1 * dx), (b[1] = ay + t1 * dy)
  return true
}

// ---- clip/index.js ----------------------------------------------------------

export function clip(pointVisible: (l: number, p: number) => boolean, clipLine: SR, interpolate: SR, start: any): SR {
  return function (sink: Stream): SR {
    const line = clipLine(sink)
    const ringBuffer = clipBuffer()
    const ringSink = clipLine(ringBuffer)
    let polygonStarted = false
    let polygon: any
    let segments: any
    let ring: any

    const clipStream: SR = {
      point,
      lineStart,
      lineEnd,
      polygonStart() {
        clipStream.point = pointRing
        clipStream.lineStart = ringStart
        clipStream.lineEnd = ringEnd
        segments = []
        polygon = []
      },
      polygonEnd() {
        clipStream.point = point
        clipStream.lineStart = lineStart
        clipStream.lineEnd = lineEnd
        segments = merge(segments) as number[][][]
        const startInside = polygonContains(polygon, start)
        if (segments.length) {
          if (!polygonStarted) sink.polygonStart!(), (polygonStarted = true)
          clipRejoin(segments, compareIntersection, startInside, interpolate, sink)
        } else if (startInside) {
          if (!polygonStarted) sink.polygonStart!(), (polygonStarted = true)
          sink.lineStart!()
          interpolate(null, null, 1, sink)
          sink.lineEnd!()
        }
        if (polygonStarted) sink.polygonEnd!(), (polygonStarted = false)
        segments = polygon = null
      },
      sphere() {
        sink.polygonStart!()
        sink.lineStart!()
        interpolate(null, null, 1, sink)
        sink.lineEnd!()
        sink.polygonEnd!()
      },
    }

    function point(lambda: number, phi: number): void {
      if (pointVisible(lambda, phi)) sink.point!(lambda, phi)
    }
    function pointLine(lambda: number, phi: number): void {
      line.point(lambda, phi)
    }
    function lineStart(): void {
      clipStream.point = pointLine
      line.lineStart()
    }
    function lineEnd(): void {
      clipStream.point = point
      line.lineEnd()
    }
    function pointRing(lambda: number, phi: number): void {
      ring!.push([lambda, phi])
      ringSink.point(lambda, phi)
    }
    function ringStart(): void {
      ringSink.lineStart()
      ring = []
    }
    function ringEnd(): void {
      pointRing(ring![0]![0], ring![0]![1])
      ringSink.lineEnd()
      const clean = ringSink.clean()
      const ringSegments = ringBuffer.result()
      let i: number
      const n = ringSegments.length
      let m: number
      let segment: any
      let pt: any
      ring!.pop()
      polygon.push(ring!)
      ring = null as unknown as number[][]
      if (!n) return
      // No intersections.
      if (clean & 1) {
        segment = ringSegments[0]!
        if ((m = segment.length - 1) > 0) {
          if (!polygonStarted) sink.polygonStart!(), (polygonStarted = true)
          sink.lineStart!()
          for (i = 0; i < m; ++i) sink.point!((pt = segment[i]!)[0], pt[1])
          sink.lineEnd!()
        }
        return
      }
      // Rejoin connected segments.
      if (n > 1 && clean & 2) ringSegments.push(ringSegments.pop()!.concat(ringSegments.shift()!))
      segments.push(ringSegments.filter(validSegment))
    }

    return clipStream
  }
}

function validSegment(segment: any): boolean {
  return segment.length > 1
}

// Intersections are sorted along the clip edge. For both antimeridian cutting
// and circle clipping, the same comparison is used.
export function compareIntersection(a: SR, b: SR): number {
  return ((a = a.x)[0] < 0 ? a[1] - halfPi - epsilon : halfPi - a[1]) -
         ((b = b.x)[0] < 0 ? b[1] - halfPi - epsilon : halfPi - b[1])
}

// ---- clip/antimeridian.js ---------------------------------------------------

function clipAntimeridianLine(stream: Stream): SR {
  let lambda0 = NaN
  let phi0 = NaN
  let sign0 = NaN
  let clean: number // no intersections
  return {
    lineStart() {
      stream.lineStart!()
      clean = 1
    },
    point(lambda1: number, phi1: number) {
      const sign1 = lambda1 > 0 ? pi : -pi
      let delta = abs(lambda1 - lambda0)
      if (abs(delta - pi) < epsilon) {
        // line crosses a pole
        stream.point!(lambda0, (phi0 = (phi0 + phi1) / 2 > 0 ? halfPi : -halfPi))
        stream.point!(sign0, phi0)
        stream.lineEnd!()
        stream.lineStart!()
        stream.point!(sign1, phi0)
        stream.point!(lambda1, phi0)
        clean = 0
      } else if (sign0 !== sign1 && delta >= pi) {
        // line crosses antimeridian
        if (abs(lambda0 - sign0) < epsilon) lambda0 -= sign0 * epsilon // handle degeneracies
        if (abs(lambda1 - sign1) < epsilon) lambda1 -= sign1 * epsilon
        phi0 = clipAntimeridianIntersect(lambda0, phi0, lambda1, phi1)
        stream.point!(sign0, phi0)
        stream.lineEnd!()
        stream.lineStart!()
        stream.point!(sign1, phi0)
        clean = 0
      }
      stream.point!((lambda0 = lambda1), (phi0 = phi1))
      sign0 = sign1
    },
    lineEnd() {
      stream.lineEnd!()
      lambda0 = phi0 = NaN
    },
    clean() {
      return 2 - clean // if intersections, rejoin first and last segments
    },
  }
}

function clipAntimeridianIntersect(lambda0: number, phi0: number, lambda1: number, phi1: number): number {
  const sinLambda0Lambda1 = sin(lambda0 - lambda1)
  return abs(sinLambda0Lambda1) > epsilon
    ? atan(
        (sin(phi0) * (cos(phi1)) * sin(lambda1) -
          sin(phi1) * (cos(phi0)) * sin(lambda0)) /
          (cos(phi0) * cos(phi1) * sinLambda0Lambda1),
      )
    : (phi0 + phi1) / 2
}

function clipAntimeridianInterpolate(from: any | null, to: any | null, direction: number, stream: Stream): void {
  let phi: number
  if (from == null) {
    phi = direction * halfPi
    stream.point!(-pi, phi)
    stream.point!(0, phi)
    stream.point!(pi, phi)
    stream.point!(pi, 0)
    stream.point!(pi, -phi)
    stream.point!(0, -phi)
    stream.point!(-pi, -phi)
    stream.point!(-pi, 0)
    stream.point!(-pi, phi)
  } else if (abs(from[0]! - to![0]!) > epsilon) {
    const lambda = from[0]! < to![0]! ? pi : -pi
    phi = (direction * lambda) / 2
    stream.point!(-lambda, phi)
    stream.point!(0, phi)
    stream.point!(lambda, phi)
  } else {
    stream.point!(to![0]!, to![1]!)
  }
}

export function clipAntimeridian(): SR {
  return clip(
    function () {
      return true
    },
    clipAntimeridianLine,
    clipAntimeridianInterpolate,
    [-pi, -halfPi],
  )
}

// ---- circle.js (only the stream used by clipCircle) -------------------------

/** Generates a circle centered at [0°, 0°], with a given radius and precision. */
export function circleStream(stream: Stream, radius: number, delta: number, direction: number, t0?: number | null, t1?: number | null): void {
  if (!delta) return
  const cosRadius = cos(radius)
  const sinRadius = sin(radius)
  const step = direction * delta
  if (t0 == null) {
    t0 = radius + direction * tau
    t1 = radius - step / 2
  } else {
    t0 = circleRadius(cosRadius, t0)
    t1 = circleRadius(cosRadius, t1!)
    if (direction > 0 ? t0 < t1 : t0 > t1) t0 += direction * tau
  }
  for (let point: any, t = t0; direction > 0 ? t! > t1! : t! < t1!; t -= step) {
    point = spherical([cosRadius, -sinRadius * cos(t!), -sinRadius * sin(t!)])
    stream.point!(point[0]!, point[1]!)
  }
}

function circleRadius(cosRadius: number, point: number | number[]): number {
  const p = cartesian(point as number[])
  p[0] -= cosRadius
  cartesianNormalizeInPlace(p)
  const radius = acos(-p[1]!)
  return ((-p[2]! < 0 ? -radius : radius) + tau - epsilon) % tau
}

// ---- clip/circle.js ---------------------------------------------------------

export function clipCircle(radius: number): SR {
  const cr = cos(radius)
  const delta = 2 * radians
  const smallRadius = cr > 0
  const notHemisphere = abs(cr) > epsilon // TODO optimise for this common case

  function interpolate(from: any | null, to: any | null, direction: number, stream: Stream): void {
    circleStream(stream, radius, delta, direction, from, to)
  }

  function visible(lambda: number, phi: number): boolean {
    return cos(lambda) * cos(phi) > cr
  }

  // Takes a line and cuts into visible segments. Return values used for polygon
  // clipping: 0 - there were intersections or the line was empty; 1 - no
  // intersections; 2 - there were intersections, and the first and last
  // segments should be rejoined.
  function clipLineFn(stream: Stream): SR {
    let point0: any | null
    let c0: number
    let v0: boolean
    let v00: boolean
    let clean: number
    return {
      lineStart() {
        v00 = v0 = false
        clean = 1
      },
      point(lambda: number, phi: number) {
        const point1: any = [lambda, phi]
        let point2: any | number[][] | undefined
        const v = visible(lambda, phi)
        const c = smallRadius
          ? v ? 0 : code(lambda, phi)
          : v ? code(lambda + (lambda < 0 ? pi : -pi), phi) : 0
        if (!point0 && (v00 = v0 = v)) stream.lineStart!()
        if (v !== v0) {
          point2 = intersect(point0!, point1)
          if (!point2 || pointEqual(point0!, point2 as number[]) || pointEqual(point1, point2 as number[])) {
            point1[2] = 1
          }
        }
        if (v !== v0) {
          clean = 0
          if (v) {
            // outside going in
            stream.lineStart!()
            point2 = intersect(point1, point0!)
            stream.point!(point2![0], point2![1])
          } else {
            // inside going out
            point2 = intersect(point0!, point1)
            stream.point!(point2![0], point2![1], 2)
            stream.lineEnd!()
          }
          point0 = point2 as number[]
        } else if (notHemisphere && point0 && (smallRadius ? !v : v)) {
          let t: any
          // If the codes for two points are different, or are both zero,
          // and there this segment intersects with the small circle.
          if (!(c & c0) && (t = intersect(point1, point0, true) as number[][])) {
            clean = 0
            if (smallRadius) {
              stream.lineStart!()
              stream.point!(t[0]![0], t[0]![1])
              stream.point!(t[1]![0], t[1]![1])
              stream.lineEnd!()
            } else {
              stream.point!(t[1]![0], t[1]![1])
              stream.lineEnd!()
              stream.lineStart!()
              stream.point!(t[0]![0], t[0]![1], 3)
            }
          }
        }
        if (v && (!point0 || !pointEqual(point0, point1))) {
          stream.point!(point1[0], point1[1])
        }
        point0 = point1
        v0 = v
        c0 = c
      },
      lineEnd() {
        if (v0) stream.lineEnd!()
        point0 = null
      },
      // Rejoin first and last segments if there were intersections and the first
      // and last points were visible.
      clean() {
        return clean | ((v00 && v0 ? 1 : 0) << 1)
      },
    }
  }

  // Intersects the great circle between a and b with the clip circle.
  function intersect(a: any, b: any, two?: boolean): any | number[][] | undefined {
    const pa = cartesian(a)
    const pb = cartesian(b)
    // We have two planes, n1.p = d1 and n2.p = d2.
    // Find intersection line p(t) = c1 n1 + c2 n2 + t (n1 x n2).
    const n1 = [1, 0, 0] // normal
    const n2 = cartesianCross(pa, pb)
    const n2n2 = cartesianDot(n2, n2)
    const n1n2 = n2[0]! // cartesianDot(n1, n2)
    const determinant = n2n2 - n1n2 * n1n2
    // Two polar points.
    if (!determinant) return !two ? a : undefined
    const c1 = (cr * n2n2) / determinant
    const c2 = (-cr * n1n2) / determinant
    const n1xn2 = cartesianCross(n1, n2)
    const A = cartesianScale(n1, c1)
    const B = cartesianScale(n2, c2)
    cartesianAddInPlace(A, B)
    // Solve |p(t)|^2 = 1.
    const u = n1xn2
    const w = cartesianDot(A, u)
    const uu = cartesianDot(u, u)
    const t2 = w * w - uu * (cartesianDot(A, A) - 1)
    if (t2 < 0) return undefined
    const t = sqrt(t2)
    let q = cartesianScale(u, (-w - t) / uu)
    cartesianAddInPlace(q, A)
    q = spherical(q)
    if (!two) return q
    // Two intersection points.
    let lambda0 = a[0]!
    let lambda1 = b[0]!
    let phi0 = a[1]!
    let phi1 = b[1]!
    let z: number
    if (lambda1 < lambda0) (z = lambda0), (lambda0 = lambda1), (lambda1 = z)
    const delta2v = lambda1 - lambda0
    const polar = abs(delta2v - pi) < epsilon
    const meridian = polar || delta2v < epsilon
    if (!polar && phi1 < phi0) (z = phi0), (phi0 = phi1), (phi1 = z)
    // Check that the first point is between a and b.
    if (
      meridian
        ? polar
          ? phi0 + phi1 > 0 !== (q[1]! < (abs(q[0]! - lambda0) < epsilon ? phi0 : phi1))
          : phi0 <= q[1]! && q[1]! <= phi1
        : delta2v > pi !== (lambda0 <= q[0]! && q[0]! <= lambda1)
    ) {
      const q1 = cartesianScale(u, (-w + t) / uu)
      cartesianAddInPlace(q1, A)
      return [q, spherical(q1)]
    }
    return undefined
  }

  // Generates a 4-bit vector representing the location of a point relative to
  // the small circle's bounding box.
  function code(lambda: number, phi: number): number {
    const r = smallRadius ? radius : pi - radius
    let codeV = 0
    if (lambda < -r) codeV |= 1 // left
    else if (lambda > r) codeV |= 2 // right
    if (phi < -r) codeV |= 4 // below
    else if (phi > r) codeV |= 8 // above
    return codeV
  }

  return clip(visible, clipLineFn, interpolate, smallRadius ? [0, -radius] : [-pi, radius - pi])
}

// ---- clip/rectangle.js ------------------------------------------------------

const clipMax = 1e9
const clipMin = -clipMax

export function clipRectangle(x0: number, y0: number, x1: number, y1: number): SR {
  function visible(x: number, y: number): boolean {
    return x0 <= x && x <= x1 && y0 <= y && y <= y1
  }
  function interpolate(from: any | null, to: any | null, direction: number, stream: Stream): void {
    let a = 0
    let a1 = 0
    if (
      from == null ||
      (a = corner(from, direction)) !== (a1 = corner(to!, direction)) ||
      comparePoint(from, to!) < 0 !== direction > 0
    ) {
      do stream.point!(a === 0 || a === 3 ? x0 : x1, a > 1 ? y1 : y0)
      while ((a = (a + direction + 4) % 4) !== a1)
    } else {
      stream.point!(to![0]!, to![1]!)
    }
  }
  function corner(p: any, direction: number): number {
    return abs(p[0]! - x0) < epsilon
      ? direction > 0 ? 0 : 3
      : abs(p[0]! - x1) < epsilon
        ? direction > 0 ? 2 : 1
        : abs(p[1]! - y0) < epsilon
          ? direction > 0 ? 1 : 0
          : direction > 0 ? 3 : 2 // abs(p[1] - y1) < epsilon
  }
  function compareIntersectionR(a: SR, b: SR): number {
    return comparePoint(a.x, b.x)
  }
  function comparePoint(a: any, b: any): number {
    const ca = corner(a, 1)
    const cb = corner(b, 1)
    return ca !== cb
      ? ca - cb
      : ca === 0
        ? b[1]! - a[1]!
        : ca === 1
          ? a[0]! - b[0]!
          : ca === 2
            ? a[1]! - b[1]!
            : b[0]! - a[0]!
  }
  return function (stream: Stream): SR {
    let activeStream = stream
    const bufferStream = clipBuffer()
    let segments: any | null
    let polygon: any | null
    let ring: any | null
    let x__: number
    let y__: number
    let v__: boolean // first point
    let x_: number
    let y_: number
    let v_: boolean // previous point
    let first: boolean
    let clean: boolean
    const clipStream: SR = {
      point,
      lineStart,
      lineEnd,
      polygonStart,
      polygonEnd,
    }
    function point(x: number, y: number): void {
      if (visible(x, y)) activeStream.point!(x, y)
    }
    function polygonInside(): number {
      let winding = 0
      for (let i = 0, n = polygon!.length; i < n; ++i) {
        const ringI = polygon![i]!
        for (let j = 1, m = ringI.length, pt = ringI[0]!, a0: number, a1: number, b0 = pt[0]!, b1 = pt[1]!; j < m; ++j) {
          a0 = b0, a1 = b1, pt = ringI[j]!, b0 = pt[0]!, b1 = pt[1]!
          if (a1 <= y1) {
            if (b1 > y1 && (b0 - a0) * (y1 - a1) > (b1 - a1) * (x0 - a0)) ++winding
          } else {
            if (b1 <= y1 && (b0 - a0) * (y1 - a1) < (b1 - a1) * (x0 - a0)) --winding
          }
        }
      }
      return winding
    }
    // Buffer geometry within a polygon and then clip it en masse.
    function polygonStart(): void {
      activeStream = bufferStream as unknown as Stream
      segments = []
      polygon = []
      clean = true
    }
    function polygonEnd(): void {
      const startInside = polygonInside()
      const cleanInside = clean && startInside
      let visibleSegs = ((segments = merge(segments!) as number[][][])).length
      if (cleanInside || visibleSegs) {
        stream.polygonStart!()
        if (cleanInside) {
          stream.lineStart!()
          interpolate(null, null, 1, stream)
          stream.lineEnd!()
        }
        if (visibleSegs) {
          clipRejoin(segments as any, compareIntersectionR, startInside as any, interpolate, stream)
        }
        stream.polygonEnd!()
      }
      activeStream = stream
      segments = polygon = ring = null
    }
    function lineStart(): void {
      clipStream.point = linePoint
      if (polygon) polygon.push((ring = []))
      first = true
      v_ = false
      x_ = y_ = NaN
    }
    function lineEnd(): void {
      if (segments) {
        linePoint(x__, y__)
        if (v__ && v_) (bufferStream as SR).rejoin()
        segments.push((bufferStream as SR).result())
      }
      clipStream.point = point
      if (v_) activeStream.lineEnd!()
    }
    function linePoint(x: number, y: number): void {
      const v = visible(x, y)
      if (polygon) ring!.push([x, y])
      if (first) {
        x__ = x, y__ = y, v__ = v
        first = false
        if (v) {
          activeStream.lineStart!()
          activeStream.point!(x, y)
        }
      } else {
        if (v && v_) activeStream.point!(x, y)
        else {
          const a: any = [(x_ = Math.max(clipMin, Math.min(clipMax, x_))), (y_ = Math.max(clipMin, Math.min(clipMax, y_)))]
          const b: any = [(x = Math.max(clipMin, Math.min(clipMax, x))), (y = Math.max(clipMin, Math.min(clipMax, y)))]
          if (clipLine2D(a, b, x0, y0, x1, y1)) {
            if (!v_) {
              activeStream.lineStart!()
              activeStream.point!(a[0], a[1])
            }
            activeStream.point!(b[0], b[1])
            if (!v) activeStream.lineEnd!()
            clean = false
          } else if (v) {
            activeStream.lineStart!()
            activeStream.point!(x, y)
            clean = false
          }
        }
      }
      x_ = x, y_ = y, v_ = v
    }
    return clipStream
  }
}

// ---- clip/extent.js ---------------------------------------------------------

export function clipExtent(): SR {
  let x0 = 0
  let y0 = 0
  let x1 = 960
  let y1 = 500
  let cache: Stream | null
  let cacheStream: Stream | null
  let clipS: SR
  return (clipS = {
    stream(stream: Stream): Stream {
      return cache && cacheStream === stream ? cache : (cache = (clipRectangle(x0, y0, x1, y1) as (s: Stream) => Stream)((cacheStream = stream)!))
    },
    extent(_: any): SR {
      return arguments.length
        ? ((x0 = +_[0][0]), (y0 = +_[0][1]), (x1 = +_[1][0]), (y1 = +_[1][1]), (cache = cacheStream = null), clipS)
        : [[x0, y0], [x1, y1]]
    },
  })
}

// ---- polygonContains.js -----------------------------------------------------

function longitude(point: any): number {
  return abs(point[0]!) <= pi
    ? point[0]!
    : sign(point[0]!) * (((abs(point[0]!) + pi) % tau) - pi)
}

export function polygonContains(polygon: any, point: any): boolean {
  const lambda = longitude(point)
  let phi = point[1]!
  const sinPhi = sin(phi)
  const normal: any = [sin(lambda), -cos(lambda), 0]
  let angle = 0
  let winding = 0
  const sum = new Adder()
  if (sinPhi === 1) phi = halfPi + epsilon
  else if (sinPhi === -1) phi = -halfPi - epsilon
  for (let i = 0, n = polygon.length; i < n; ++i) {
    if (!(polygon[i]!.length)) continue
    const ring = polygon[i]!
    const m = ring.length
    let point0 = ring[m - 1]!
    let lambda0 = longitude(point0)
    let phi0 = point0[1]! / 2 + quarterPi
    let sinPhi0 = sin(phi0)
    let cosPhi0 = cos(phi0)
    let lambda1: number, phi1: number, sinPhi1: number, cosPhi1: number
    let point1: any
    for (let j = 0; j < m; ++j, lambda0 = lambda1, sinPhi0 = sinPhi1, cosPhi0 = cosPhi1, point0 = point1) {
      point1 = ring[j]
      lambda1 = longitude(point1)
      phi1 = point1[1]! / 2 + quarterPi
      sinPhi1 = sin(phi1)
      cosPhi1 = cos(phi1)
      const delta = lambda1 - lambda0
      const signV = delta >= 0 ? 1 : -1
      const absDelta = signV * delta
      const antimeridian = absDelta > pi
      const k = sinPhi0 * sinPhi1
      sum.add(atan2(k * signV * sin(absDelta), cosPhi0 * cosPhi1 + k * cos(absDelta)))
      angle += antimeridian ? delta + signV * tau : delta
      // Are the longitudes either side of the point's meridian (lambda),
      // and are the latitudes smaller than the parallel (phi)?
      if (antimeridian !== (lambda0 >= lambda !== (lambda1 >= lambda))) {
        const arc = cartesianCross(cartesian(point0), cartesian(point1))
        cartesianNormalizeInPlace(arc)
        const intersection = cartesianCross(normal, arc)
        cartesianNormalizeInPlace(intersection)
        const phiArc = (antimeridian !== delta >= 0 ? -1 : 1) * asin(intersection[2]!)
        if (phi > phiArc || (phi === phiArc && (arc[0] || arc[1]))) {
          winding += antimeridian !== delta >= 0 ? 1 : -1
        }
      }
    }
  }
  // First, determine whether the South pole is inside or outside; second, count
  // the (signed) number of times a segment crosses a lambda from the point to
  // the South pole.
  return ((((angle < -epsilon || (angle < epsilon && +sum < -epsilon2)) ? 1 : 0) ^ (winding & 1)) !== 0)
}

// ---- area.js ----------------------------------------------------------------

export let areaRingSum = new Adder()
let areaSum = new Adder()
let lambda00A: number
let phi00A: number
let lambda0A: number
let cosPhi0A: number
let sinPhi0A: number

export const areaStream: SR = {
  point: geoNoop,
  lineStart: geoNoop,
  lineEnd: geoNoop,
  polygonStart() {
    areaRingSum = new Adder()
    areaStream.lineStart = areaRingStart
    areaStream.lineEnd = areaRingEnd
  },
  polygonEnd() {
    const areaRing = +areaRingSum
    areaSum.add(areaRing < 0 ? tau + areaRing : areaRing)
    this.lineStart = this.lineEnd = this.point = geoNoop
  },
  sphere() {
    areaSum.add(tau)
  },
}

function areaRingStart(): void {
  areaStream.point = areaPointFirst
}
function areaRingEnd(): void {
  areaPoint(lambda00A, phi00A)
}
function areaPointFirst(lambda: number, phi: number): void {
  areaStream.point = areaPoint
  lambda00A = lambda, phi00A = phi
  lambda0A = lambda * radians, (phi = phi * radians)
  cosPhi0A = cos((phi = phi / 2 + quarterPi))
  sinPhi0A = sin(phi)
}
function areaPoint(lambda: number, phi: number): void {
  lambda *= radians, phi *= radians
  phi = phi / 2 + quarterPi // half the angular distance from south pole
  // Spherical excess E for a spherical triangle with vertices: south pole,
  // previous point, current point. Uses a formula derived from Cagnoli's
  // theorem. See Todhunter, Spherical Trig. (1871), Sec. 103, Eq. (2).
  const dLambda = lambda - lambda0A
  const sdLambda = dLambda >= 0 ? 1 : -1
  const adLambda = sdLambda * dLambda
  const cosPhi = cos(phi)
  const sinPhi = sin(phi)
  const k = sinPhi0A * sinPhi
  const u = cosPhi0A * cosPhi + k * cos(adLambda)
  const v = k * sdLambda * sin(adLambda)
  areaRingSum.add(atan2(v, u))
  // Advance the previous points.
  lambda0A = lambda, cosPhi0A = cosPhi, sinPhi0A = sinPhi
}

export function geoArea(object: SR): number {
  areaSum = new Adder()
  geoStream(object, areaStream)
  return areaSum.valueOf() * 2
}

// ---- bounds.js --------------------------------------------------------------

let lambda0B: number, phi0B: number, lambda1B: number, phi1B: number // bounds
let lambda2B: number // previous lambda-coordinate
let lambda00B: number, phi00B: number // first point
let p0B: any | null // previous 3D point
let deltaSumB: Adder
let rangesB: any
let rangeB: any

const boundsStreamB: SR = {
  point: boundsPoint,
  lineStart: boundsLineStart,
  lineEnd: boundsLineEnd,
  polygonStart() {
    boundsStreamB.point = boundsRingPoint
    boundsStreamB.lineStart = boundsRingStart
    boundsStreamB.lineEnd = boundsRingEnd
    deltaSumB = new Adder()
    areaStream.polygonStart()
  },
  polygonEnd() {
    areaStream.polygonEnd()
    boundsStreamB.point = boundsPoint
    boundsStreamB.lineStart = boundsLineStart
    boundsStreamB.lineEnd = boundsLineEnd
    if (+areaRingSum < 0) lambda0B = -(lambda1B = 180), (phi0B = -(phi1B = 90))
    else if (+deltaSumB > epsilon) phi1B = 90
    else if (+deltaSumB < -epsilon) phi0B = -90
    rangeB[0] = lambda0B, (rangeB[1] = lambda1B)
  },
  sphere() {
    lambda0B = -(lambda1B = 180), (phi0B = -(phi1B = 90))
  },
}

function boundsPoint(lambda: number, phi: number): void {
  rangesB.push((rangeB = [(lambda0B = lambda), (lambda1B = lambda)]))
  if (phi < phi0B) phi0B = phi
  if (phi > phi1B) phi1B = phi
}

function linePointB(lambda: number, phi: number): void {
  const p = cartesian([lambda * radians, phi * radians])
  if (p0B) {
    const normal = cartesianCross(p0B, p)
    const equatorial = [normal[1]!, -normal[0]!, 0]
    let inflection = cartesianCross(equatorial, normal)
    cartesianNormalizeInPlace(inflection)
    inflection = spherical(inflection)
    const delta = lambda - lambda2B
    const signV = delta > 0 ? 1 : -1
    let lambdai = inflection[0]! * degrees * signV
    let phii: number
    const antimeridian = abs(delta) > 180
    if (antimeridian !== (signV * lambda2B < lambdai && lambdai < signV * lambda)) {
      phii = inflection[1]! * degrees
      if (phii > phi1B) phi1B = phii
    } else if ((lambdai = ((lambdai + 360) % 360) - 180), antimeridian !== (signV * lambda2B < lambdai && lambdai < signV * lambda)) {
      phii = -inflection[1]! * degrees
      if (phii < phi0B) phi0B = phii
    } else {
      if (phi < phi0B) phi0B = phi
      if (phi > phi1B) phi1B = phi
    }
    if (antimeridian) {
      if (lambda < lambda2B) {
        if (angleB(lambda0B, lambda) > angleB(lambda0B, lambda1B)) lambda1B = lambda
      } else {
        if (angleB(lambda, lambda1B) > angleB(lambda0B, lambda1B)) lambda0B = lambda
      }
    } else {
      if (lambda1B >= lambda0B) {
        if (lambda < lambda0B) lambda0B = lambda
        if (lambda > lambda1B) lambda1B = lambda
      } else {
        if (lambda > lambda2B) {
          if (angleB(lambda0B, lambda) > angleB(lambda0B, lambda1B)) lambda1B = lambda
        } else {
          if (angleB(lambda, lambda1B) > angleB(lambda0B, lambda1B)) lambda0B = lambda
        }
      }
    }
  } else {
    rangesB.push((rangeB = [(lambda0B = lambda), (lambda1B = lambda)]))
  }
  if (phi < phi0B) phi0B = phi
  if (phi > phi1B) phi1B = phi
  p0B = p, (lambda2B = lambda)
}

function boundsLineStart(): void {
  boundsStreamB.point = linePointB
}

function boundsLineEnd(): void {
  rangeB[0] = lambda0B, (rangeB[1] = lambda1B)
  boundsStreamB.point = boundsPoint
  p0B = null
}

function boundsRingPoint(lambda: number, phi: number): void {
  if (p0B) {
    const delta = lambda - lambda2B
    deltaSumB.add(abs(delta) > 180 ? delta + (delta > 0 ? 360 : -360) : delta)
  } else {
    lambda00B = lambda, (phi00B = phi)
  }
  areaStream.point(lambda, phi)
  linePointB(lambda, phi)
}

function boundsRingStart(): void {
  areaStream.lineStart()
}

function boundsRingEnd(): void {
  boundsRingPoint(lambda00B, phi00B)
  areaStream.lineEnd()
  if (abs(+deltaSumB) > epsilon) lambda0B = -(lambda1B = 180)
  rangeB[0] = lambda0B, (rangeB[1] = lambda1B)
  p0B = null
}

// Finds the left-right distance between two longitudes.
function angleB(lambda0: number, lambda1: number): number {
  return (lambda1 -= lambda0) < 0 ? lambda1 + 360 : lambda1
}

function rangeCompare(a: any, b: any): number {
  return a[0]! - b[0]!
}

function rangeContains(range: any, x: number): boolean {
  return range[0]! <= range[1]! ? range[0]! <= x && x <= range[1]! : x < range[0]! || range[1]! < x
}

export function geoBounds(feature: SR): any {
  let i: number, n: number, a: any, b: any, merged: any, deltaMax: number, delta: number
  phi1B = lambda1B = -(lambda0B = phi0B = Infinity)
  rangesB = []
  geoStream(feature, boundsStreamB)
  // First, sort ranges by their minimum longitudes.
  if ((n = rangesB.length)) {
    rangesB.sort(rangeCompare)
    // Then, merge any ranges that overlap.
    for (i = 1, a = rangesB[0]!, merged = [a]; i < n; ++i) {
      b = rangesB[i]!
      if (rangeContains(a, b[0]!) || rangeContains(a, b[1]!)) {
        if (angleB(a[0]!, b[1]!) > angleB(a[0]!, a[1]!)) a[1] = b[1]
        if (angleB(b[0]!, a[1]!) > angleB(a[0]!, a[1]!)) a[0] = b[0]
      } else {
        merged.push((a = b))
      }
    }
    // Finally, find the largest gap between the merged ranges.
    for (deltaMax = -Infinity, n = merged.length - 1, i = 0, a = merged[n]!; i <= n; a = b, ++i) {
      b = merged[i]!
      if ((delta = angleB(a[1]!, b[0]!)) > deltaMax) (deltaMax = delta), (lambda0B = b[0]!), (lambda1B = a[1]!)
    }
  }
  rangesB = rangeB = null as unknown as number[][]
  return lambda0B === Infinity || phi0B === Infinity
    ? [[NaN, NaN], [NaN, NaN]]
    : [[lambda0B, phi0B], [lambda1B, phi1B]]
}

// ---- centroid.js ------------------------------------------------------------

let W0C: number, W1C: number
let X0C: number, Y0C: number, Z0C: number
let X1C: number, Y1C: number, Z1C: number
let X2C: Adder, Y2C: Adder, Z2C: Adder
let lambda00C: number, phi00C: number
let x0C: number, y0C: number, z0C: number

const centroidStreamC: SR = {
  sphere: geoNoop,
  point: centroidPointC,
  lineStart: centroidLineStartC,
  lineEnd: centroidLineEndC,
  polygonStart() {
    centroidStreamC.lineStart = centroidRingStartC
    centroidStreamC.lineEnd = centroidRingEndC
  },
  polygonEnd() {
    centroidStreamC.lineStart = centroidLineStartC
    centroidStreamC.lineEnd = centroidLineEndC
  },
}

// Arithmetic mean of Cartesian vectors.
function centroidPointC(lambda: number, phi: number): void {
  lambda *= radians, phi *= radians
  const cosPhi = cos(phi)
  centroidPointCartesianC(cosPhi * cos(lambda), cosPhi * sin(lambda), sin(phi))
}

function centroidPointCartesianC(x: number, y: number, z: number): void {
  ++W0C
  X0C += (x - X0C) / W0C
  Y0C += (y - Y0C) / W0C
  Z0C += (z - Z0C) / W0C
}

function centroidLineStartC(): void {
  centroidStreamC.point = centroidLinePointFirstC
}

function centroidLinePointFirstC(lambda: number, phi: number): void {
  lambda *= radians, phi *= radians
  const cosPhi = cos(phi)
  x0C = cosPhi * cos(lambda)
  y0C = cosPhi * sin(lambda)
  z0C = sin(phi)
  centroidStreamC.point = centroidLinePointC
  centroidPointCartesianC(x0C, y0C, z0C)
}

function centroidLinePointC(lambda: number, phi: number): void {
  lambda *= radians, phi *= radians
  const cosPhi = cos(phi)
  const x = cosPhi * cos(lambda)
  const y = cosPhi * sin(lambda)
  const z = sin(phi)
  let w: number
  w = atan2(sqrt((w = y0C * z - z0C * y) * w + (w = z0C * x - x0C * z) * w + (w = x0C * y - y0C * x) * w), x0C * x + y0C * y + z0C * z)
  W1C += w
  X1C += w * (x0C + (x0C = x))
  Y1C += w * (y0C + (y0C = y))
  Z1C += w * (z0C + (z0C = z))
  centroidPointCartesianC(x0C, y0C, z0C)
}

function centroidLineEndC(): void {
  centroidStreamC.point = centroidPointC
}

// See J. E. Brock, The Inertia Tensor for a Spherical Triangle,
// J. Applied Mechanics 42, 239 (1975).
function centroidRingStartC(): void {
  centroidStreamC.point = centroidRingPointFirstC
}

function centroidRingEndC(): void {
  centroidRingPointC(lambda00C, phi00C)
  centroidStreamC.point = centroidPointC
}

function centroidRingPointFirstC(lambda: number, phi: number): void {
  lambda00C = lambda, (phi00C = phi)
  lambda *= radians, phi *= radians
  centroidStreamC.point = centroidRingPointC
  const cosPhi = cos(phi)
  x0C = cosPhi * cos(lambda)
  y0C = cosPhi * sin(lambda)
  z0C = sin(phi)
  centroidPointCartesianC(x0C, y0C, z0C)
}

function centroidRingPointC(lambda: number, phi: number): void {
  lambda *= radians, phi *= radians
  const cosPhi = cos(phi)
  const x = cosPhi * cos(lambda)
  const y = cosPhi * sin(lambda)
  const z = sin(phi)
  const cx = y0C * z - z0C * y
  const cy = z0C * x - x0C * z
  const cz = x0C * y - y0C * x
  const m = hypot(cx, cy, cz)
  const w = asin(m) // line weight = angle
  const v = m && -w / m // area weight multiplier
  X2C.add(v * cx)
  Y2C.add(v * cy)
  Z2C.add(v * cz)
  W1C += w
  X1C += w * (x0C + (x0C = x))
  Y1C += w * (y0C + (y0C = y))
  Z1C += w * (z0C + (z0C = z))
  centroidPointCartesianC(x0C, y0C, z0C)
}

export function geoCentroid(object: SR): any {
  W0C = W1C = X0C = Y0C = Z0C = X1C = Y1C = Z1C = 0
  X2C = new Adder()
  Y2C = new Adder()
  Z2C = new Adder()
  geoStream(object, centroidStreamC)
  let x = +X2C
  let y = +Y2C
  let z = +Z2C
  let m = hypot(x, y, z)
  // If the area-weighted centroid is undefined, fall back to the length-weighted centroid.
  if (m < epsilon2) {
    x = X1C, y = Y1C, z = Z1C
    // If the feature has zero length, fall back to the arithmetic mean of point vectors.
    if (W1C < epsilon) x = X0C, y = Y0C, z = Z0C
    m = hypot(x, y, z)
    // If the feature still has an undefined centroid, then return.
    if (m < epsilon2) return [NaN, NaN]
  }
  return [atan2(y, x) * degrees, asin(z / m) * degrees]
}

// ---- path/context.js --------------------------------------------------------

export function pathContext(context: any): SR {
  const ctx: any = {
    _context: context,
    _radius: 4.5,
    pointRadius(_: number) {
      return (this._radius = _), this
    },
    polygonStart() {
      this._line = 0
    },
    polygonEnd() {
      this._line = NaN
    },
    lineStart() {
      this._point = 0
    },
    lineEnd() {
      if (this._line === 0) this._context.closePath()
      this._point = NaN
    },
    point(x: number, y: number) {
      switch (this._point) {
        case 0: {
          this._context.moveTo(x, y)
          this._point = 1
          break
        }
        case 1: {
          this._context.lineTo(x, y)
          break
        }
        default: {
          this._context.moveTo(x + this._radius, y)
          this._context.arc(x, y, this._radius, 0, tau)
          break
        }
      }
    },
    result: geoNoop,
  }
  return ctx
}

// ---- path/string.js ---------------------------------------------------------

// Simple caching for constant-radius points.
let cacheDigits: number | undefined
let cacheAppend: any
let cacheRadius: number | undefined
let cacheCircle: string | undefined

function appendRaw(this: any, strings: any, ...values: number[]): void {
  let i = 1
  this._ += strings[0]
  for (const j = strings.length; i < j; ++i) {
    this._ += values[i - 1]! + strings[i]
  }
}

function appendRound(digits: number): any {
  const d = floor(digits)
  if (!(d >= 0)) throw new RangeError(`invalid digits: ${digits}`)
  if (d > 15) return appendRaw
  if (d !== cacheDigits) {
    const k = 10 ** d
    cacheDigits = d
    cacheAppend = function (this: any, strings: any, ...values: number[]): void {
      let i = 1
      this._ += strings[0]
      for (const j = strings.length; i < j; ++i) {
        this._ += Math.round(values[i - 1]! * k) / k + strings[i]
      }
    }
  }
  return cacheAppend
}

export function pathString(digits: number | null): SR {
  const ps: any = {}
  ps._append = digits == null ? appendRaw : appendRound(digits)
  ps._radius = 4.5
  ps._ = ''
  ps.pointRadius = function (_: number): SR {
    this._radius = +_
    return this
  }
  ps.polygonStart = function (): void {
    this._line = 0
  }
  ps.polygonEnd = function (): void {
    this._line = NaN
  }
  ps.lineStart = function (): void {
    this._point = 0
  }
  ps.lineEnd = function (): void {
    if (this._line === 0) this._ += 'Z'
    this._point = NaN
  }
  ps.point = function (x: number, y: number): void {
    switch (this._point) {
      case 0: {
        this._append`M${x},${y}`
        this._point = 1
        break
      }
      case 1: {
        this._append`L${x},${y}`
        break
      }
      default: {
        this._append`M${x},${y}`
        if (this._radius !== cacheRadius || this._append !== cacheAppend) {
          const r = this._radius
          const s = this._
          this._ = '' // stash the old string so we can cache the circle path fragment
          this._append`m0,${r}a${r},${r} 0 1,1 0,${-2 * r}a${r},${r} 0 1,1 0,${2 * r}z`
          cacheRadius = r
          cacheAppend = this._append
          cacheCircle = this._
          this._ = s
        }
        this._ += cacheCircle
        break
      }
    }
  }
  ps.result = function (): string | null {
    const result = this._
    this._ = ''
    return result.length ? result : null
  }
  return ps
}

// ---- path/area.js (planar) --------------------------------------------------

let areaSumP = new Adder()
let areaRingSumP = new Adder()
let x00P: number, y00P: number, x0P: number, y0P: number

export const pathAreaStream: SR = {
  point: geoNoop,
  lineStart: geoNoop,
  lineEnd: geoNoop,
  polygonStart() {
    pathAreaStream.lineStart = areaRingStartP
    pathAreaStream.lineEnd = areaRingEndP
  },
  polygonEnd() {
    pathAreaStream.lineStart = pathAreaStream.lineEnd = pathAreaStream.point = geoNoop
    areaSumP.add(abs(+areaRingSumP))
    areaRingSumP = new Adder()
  },
  result() {
    const area = areaSumP.valueOf() / 2
    areaSumP = new Adder()
    return area
  },
}

function areaRingStartP(): void {
  pathAreaStream.point = areaPointFirstP
}
function areaPointFirstP(x: number, y: number): void {
  pathAreaStream.point = areaPointP
  x00P = x0P = x, (y00P = y0P = y)
}
function areaPointP(x: number, y: number): void {
  areaRingSumP.add(y0P * x - x0P * y)
  x0P = x, (y0P = y)
}
function areaRingEndP(): void {
  areaPointP(x00P, y00P)
}

// ---- path/bounds.js (planar) ------------------------------------------------

let x0B: number = Infinity
let y0B: number = x0B
let x1B: number = -x0B
let y1B: number = x1B

export const pathBoundsStream: SR = {
  point: boundsPointP,
  lineStart: geoNoop,
  lineEnd: geoNoop,
  polygonStart: geoNoop,
  polygonEnd: geoNoop,
  result() {
    const bounds = [[x0B, y0B], [x1B, y1B]]
    x1B = y1B = -(y0B = x0B = Infinity)
    return bounds
  },
}

function boundsPointP(x: number, y: number): void {
  if (x < x0B) x0B = x
  if (x > x1B) x1B = x
  if (y < y0B) y0B = y
  if (y > y1B) y1B = y
}

// ---- path/centroid.js (planar) ---------------------------------------------

let X0P = 0, Y0P = 0, Z0P = 0
let X1P = 0, Y1P = 0, Z1P = 0
let X2P = 0, Y2P = 0, Z2P = 0
let x00PC: number, y00PC: number, x0PC: number, y0PC: number

export const pathCentroidStream: SR = {
  point: centroidPointP,
  lineStart: centroidLineStartP,
  lineEnd: centroidLineEndP,
  polygonStart() {
    pathCentroidStream.lineStart = centroidRingStartP
    pathCentroidStream.lineEnd = centroidRingEndP
  },
  polygonEnd() {
    pathCentroidStream.point = centroidPointP
    pathCentroidStream.lineStart = centroidLineStartP
    pathCentroidStream.lineEnd = centroidLineEndP
  },
  result() {
    const centroid = Z2P
      ? [X2P / Z2P, Y2P / Z2P]
      : Z1P
        ? [X1P / Z1P, Y1P / Z1P]
        : Z0P
          ? [X0P / Z0P, Y0P / Z0P]
          : [NaN, NaN]
    X0P = Y0P = Z0P = X1P = Y1P = Z1P = X2P = Y2P = Z2P = 0
    return centroid
  },
}

function centroidPointP(x: number, y: number): void {
  X0P += x
  Y0P += y
  ++Z0P
}
function centroidLineStartP(): void {
  pathCentroidStream.point = centroidPointFirstLineP
}
function centroidPointFirstLineP(x: number, y: number): void {
  pathCentroidStream.point = centroidPointLineP
  centroidPointP((x0PC = x), (y0PC = y))
}
function centroidPointLineP(x: number, y: number): void {
  const dx = x - x0PC
  const dy = y - y0PC
  const z = sqrt(dx * dx + dy * dy)
  X1P += (z * (x0PC + x)) / 2
  Y1P += (z * (y0PC + y)) / 2
  Z1P += z
  centroidPointP((x0PC = x), (y0PC = y))
}
function centroidLineEndP(): void {
  pathCentroidStream.point = centroidPointP
}
function centroidRingStartP(): void {
  pathCentroidStream.point = centroidPointFirstRingP
}
function centroidRingEndP(): void {
  centroidPointRingP(x00PC, y00PC)
}
function centroidPointFirstRingP(x: number, y: number): void {
  pathCentroidStream.point = centroidPointRingP
  centroidPointP((x00PC = x0PC = x), (y00PC = y0PC = y))
}
function centroidPointRingP(x: number, y: number): void {
  const dx = x - x0PC
  const dy = y - y0PC
  let z = sqrt(dx * dx + dy * dy)
  X1P += (z * (x0PC + x)) / 2
  Y1P += (z * (y0PC + y)) / 2
  Z1P += z
  z = y0PC * x - x0PC * y
  X2P += z * (x0PC + x)
  Y2P += z * (y0PC + y)
  Z2P += z * 3
  centroidPointP((x0PC = x), (y0PC = y))
}

// ---- path/measure.js --------------------------------------------------------

let lengthSumP = new Adder()
let lengthRingP: boolean | null
let x00M: number, y00M: number, x0M: number, y0M: number

export const pathMeasureStream: SR = {
  point: geoNoop,
  lineStart() {
    pathMeasureStream.point = lengthPointFirstP
  },
  lineEnd() {
    if (lengthRingP) lengthPointP(x00M, y00M)
    pathMeasureStream.point = geoNoop
  },
  polygonStart() {
    lengthRingP = true
  },
  polygonEnd() {
    lengthRingP = null
  },
  result() {
    const length = +lengthSumP
    lengthSumP = new Adder()
    return length
  },
}

function lengthPointFirstP(x: number, y: number): void {
  pathMeasureStream.point = lengthPointP
  x00M = x0M = x, (y00M = y0M = y)
}
function lengthPointP(x: number, y: number): void {
  x0M -= x, y0M -= y
  lengthSumP.add(sqrt(x0M * x0M + y0M * y0M))
  x0M = x, (y0M = y)
}

// ---- path/index.js ----------------------------------------------------------

export function geoPath(projection?: any, context?: any): any {
  let digits: number | null = 3
  let pointRadius: any = 4.5
  let projectionStream: any
  let contextStream: any

  function path(object?: any): any {
    if (object) {
      if (typeof pointRadius === 'function') contextStream.pointRadius(+pointRadius.apply(null, arguments))
      geoStream(object, projectionStream(contextStream))
    }
    return contextStream.result()
  }
  path.area = function (object: any): number {
    geoStream(object, projectionStream(pathAreaStream))
    return pathAreaStream.result()
  }
  path.measure = function (object: any): number {
    geoStream(object, projectionStream(pathMeasureStream))
    return pathMeasureStream.result()
  }
  path.bounds = function (object: any): number[][] {
    geoStream(object, projectionStream(pathBoundsStream))
    return pathBoundsStream.result()
  }
  path.centroid = function (object: any): number[] {
    geoStream(object, projectionStream(pathCentroidStream))
    return pathCentroidStream.result()
  }
  path.projection = function (_?: any): any {
    if (!arguments.length) return projection
    projectionStream = _ == null ? ((projection = null), identityFn) : ((projection = _).stream as any)
    return path
  }
  path.context = function (_?: any): any {
    if (!arguments.length) return context
    contextStream = _ == null ? ((context = null), pathString(digits as number)) : pathContext((context = _))
    if (typeof pointRadius !== 'function') contextStream.pointRadius(pointRadius)
    return path
  }
  path.pointRadius = function (_?: any): any {
    if (!arguments.length) return pointRadius
    pointRadius = typeof _ === 'function' ? _ : ((contextStream.pointRadius(+_)), +_)
    return path
  }
  path.digits = function (_?: number | null): any {
    if (!arguments.length) return digits
    if (_ == null) digits = null
    else {
      const d = floor(_)
      if (!(d >= 0)) throw new RangeError(`invalid digits: ${_}`)
      digits = d
    }
    if (context === null) contextStream = pathString(digits)
    return path
  }
  return path.projection(projection).digits(digits).context(context)
}
