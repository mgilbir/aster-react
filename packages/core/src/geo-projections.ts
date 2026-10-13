/**
 * d3-geo projections (3.1.1): the projection factory machinery, fitting,
 * adaptive resampling, and the sixteen projection types Vega registers.
 * Faithful transcription verified against oracle vectors recorded from pinned
 * d3-geo@3.1.1.
 */
import {
  compose,
  clipAntimeridian,
  rotateRadians,
  clipCircle,
  clipExtent as makeClipExtent,
  clipRectangle,
  cos as mcos,
  degrees as mdegrees,
  epsilon,
  geoStream,
  pathBoundsStream,
  halfPi,
  identityFn,
  log as mlog,
  pi,
  radians as mradians,
  rotation,
  sqrt as msqrt,
  tan as mtan,
  tau,
  transformer,
  type SR,
} from './geo-lib.js'
import { atan, atan2, abs, asin, acos, cos, exp, floor, log, pow, sign, sin, sqrt, tan } from './geo-lib.js'

const radians = mradians
const degrees = mdegrees

function geoRotation(rotate: number[]): any {
  return rotation(rotate)
}

// d3's transform.js `transformer`: a curry (stream) => wrappedStream
function transformMethods(methods: Record<string, unknown>): any {
  return transformer(methods)
}

const transformRadians: any = transformMethods({
  point(this: any, x: number, y: number) {
    this.stream.point(x * radians, y * radians)
  },
})

function transformRotate(rotate: any): any {
  return transformMethods({
    point(this: any, x: number, y: number) {
      const r = rotate(x, y)
      return this.stream.point(r[0], r[1])
    },
  })
}

function scaleTranslate(k: number, dx: number, dy: number, sx: number, sy: number): any {
  function transform(x: number, y: number): number[] {
    x *= sx
    y *= sy
    return [dx + k * x, dy - k * y]
  }
  transform.invert = function (x: number, y: number): number[] {
    return [((x - dx) / k) * sx, ((dy - y) / k) * sy]
  }
  return transform
}

function scaleTranslateRotate(k: number, dx: number, dy: number, sx: number, sy: number, alpha: number): any {
  if (!alpha) return scaleTranslate(k, dx, dy, sx, sy)
  const cosAlpha = cos(alpha)
  const sinAlpha = sin(alpha)
  const a = cosAlpha * k
  const b = sinAlpha * k
  const ai = cosAlpha / k
  const bi = sinAlpha / k
  const ci = (sinAlpha * dy - cosAlpha * dx) / k
  const fi = (sinAlpha * dx + cosAlpha * dy) / k
  function transform(x: number, y: number): number[] {
    x *= sx
    y *= sy
    return [a * x - b * y + dx, dy - b * x - a * y]
  }
  transform.invert = function (x: number, y: number): number[] {
    return [sx * (ai * x - bi * y + ci), sy * (fi - bi * x - ai * y)]
  }
  return transform
}

// ---- projection/index.js ----------------------------------------------------

export function projectionRaw(project: any): any {
  return (projectionMutator(function () {
    return project
  }) as any)()
}

export function projectionMutator(projectAt: any): any {
  let project: any
  let k = 150 // scale
  let x = 480
  let y = 250 // translate
  let lambda = 0
  let phi = 0 // center
  let deltaLambda = 0
  let deltaPhi = 0
  let deltaGamma = 0 // rotate
  let rotate: any
  let alpha = 0 // post-rotate angle
  let sx = 1 // reflectX
  let sy = 1 // reflectY
  let theta: any = null
  let preclip: any = clipAntimeridian() // pre-clip angle
  let x0: any = null
  let y0: any
  let x1: any
  let y1: any
  let postclip: any = identityFn // post-clip extent
  let delta2 = 0.5 // precision
  let projectResample: any
  let projectTransform: any
  let projectRotateTransform: any
  let cache: any
  let cacheStream: any

  const projection: any = function (point: number[]): number[] {
    return projectRotateTransform(point[0]! * radians, point[1]! * radians)
  }

  function invert(point: number[]): number[] | undefined {
    point = projectRotateTransform.invert(point[0], point[1])
    return point && [point[0]! * degrees, point[1]! * degrees]
  }

  projection.stream = function (stream: any): any {
    return cache && cacheStream === stream
      ? cache
      : (cache = transformRadians(transformRotate(rotate)(preclip(projectResample(postclip((cacheStream = stream)))))))
  }

  projection.preclip = function (_?: any): any {
    return arguments.length ? ((preclip = _), (theta = undefined), reset()) : preclip
  }

  projection.postclip = function (_?: any): any {
    return arguments.length ? ((postclip = _), (x0 = y0 = x1 = y1 = null as any), reset()) : postclip
  }

  projection.clipAngle = function (_?: number): any {
    return arguments.length
      ? ((preclip = +_! ? clipCircle((theta = (_ as number) * radians)) : ((theta = null), clipAntimeridian())), reset())
      : (theta as any) * degrees
  }

  projection.clipExtent = function (_?: number[][] | null): any {
    return arguments.length
      ? ((postclip =
          _ == null
            ? ((x0 = y0 = x1 = y1 = null as unknown as number), identityFn)
            : (clipRectangle((x0 = +(_ as any)[0][0]), (y0 = +(_ as any)[0][1]), (x1 = +(_ as any)[1][0]), (y1 = +(_ as any)[1][1])) as any)),
        reset())
      : x0 == null
        ? null
        : [[x0, y0], [x1, y1]]
  }

  projection.scale = function (_?: number): any {
    return arguments.length ? ((k = +_!), recenter()) : k
  }

  projection.translate = function (_?: number[]): any {
    return arguments.length ? ((x = +(_ as any)[0]), (y = +(_ as any)[1]), recenter()) : [x, y]
  }

  projection.center = function (_?: number[]): any {
    return arguments.length
      ? ((lambda = ((_ as any)[0] % 360) * radians), (phi = ((_ as any)[1] % 360) * radians), recenter())
      : [lambda * degrees, phi * degrees]
  }

  projection.rotate = function (_?: number[]): any {
    return arguments.length
      ? ((deltaLambda = ((_ as any)[0] % 360) * radians),
        (deltaPhi = ((_ as any)[1] % 360) * radians),
        (deltaGamma = (_ as any).length > 2 ? ((_ as any)[2] % 360) * radians : 0),
        recenter())
      : [deltaLambda * degrees, deltaPhi * degrees, deltaGamma * degrees]
  }

  projection.angle = function (_?: number): any {
    return arguments.length ? ((alpha = ((_ as any) % 360) * radians), recenter()) : alpha * degrees
  }

  projection.reflectX = function (_?: boolean): any {
    return arguments.length ? ((sx = _ ? -1 : 1), recenter()) : sx < 0
  }

  projection.reflectY = function (_?: boolean): any {
    return arguments.length ? ((sy = _ ? -1 : 1), recenter()) : sy < 0
  }

  projection.precision = function (_?: number): any {
    return arguments.length ? ((projectResample = resample(projectTransform, (delta2 = (_ as number) * (_ as number)))), reset()) : sqrt(delta2)
  }

  projection.fitExtent = function (extent: number[][], object: any): any {
    return fitExtent(projection, extent, object)
  }
  projection.fitSize = function (size: number[], object: any): any {
    return fitSize(projection, size, object)
  }
  projection.fitWidth = function (width: number, object: any): any {
    return fitWidth(projection, width, object)
  }
  projection.fitHeight = function (height: number, object: any): any {
    return fitHeight(projection, height, object)
  }

  function recenter(): any {
    const center: any = scaleTranslateRotate(k, 0, 0, sx, sy, alpha).apply(null, project(lambda, phi))
    const transform = scaleTranslateRotate(k, x - center[0], y - center[1], sx, sy, alpha)
    rotate = rotateRadians(deltaLambda, deltaPhi, deltaGamma)
    projectTransform = compose(project, transform)
    projectRotateTransform = compose(rotate, projectTransform)
    projectResample = resample(projectTransform, delta2)
    return reset()
  }

  function reset(): any {
    cache = cacheStream = null
    return projection
  }

  return function (this: any, ...args: any[]): any {
    project = projectAt.apply(this, args)
    projection.invert = project.invert && invert
    return recenter()
  }
}

// ---- projection/resample.js -------------------------------------------------

const maxDepth = 16 // maximum depth of subdivision
const cosMinDistance = cos(30 * radians) // cos(minimum angular distance)

export function resample(project: any, delta2: number): any {
  return +delta2 ? resampleLine(project, delta2) : resampleNone(project)
}

function resampleNone(project: any): any {
  return transformMethods({
    point(this: any, x: number, y: number) {
      const p = project(x, y)
      this.stream.point(p[0], p[1])
    },
  })
}

function resampleLine(project: any, delta2: number): any {
  function resampleLineTo(x0: number, y0: number, lambda0: number, a0: number, b0: number, c0: number, x1: number, y1: number, lambda1: number, a1: number, b1: number, c1: number, depth: number, stream: any): void {
    const dx = x1 - x0
    const dy = y1 - y0
    const d2 = dx * dx + dy * dy
    if (d2 > 4 * delta2 && depth--) {
      let a = a0 + a1
      let b = b0 + b1
      let c = c0 + c1
      const m = sqrt(a * a + b * b + c * c)
      const phi2 = asin((c /= m))
      const lambda2 =
        abs(abs(c) - 1) < epsilon || abs(lambda0 - lambda1) < epsilon ? (lambda0 + lambda1) / 2 : atan2(b, a)
      const p = project(lambda2, phi2)
      const x2 = p[0]
      const y2 = p[1]
      const dx2 = x2 - x0
      const dy2 = y2 - y0
      const dz = dy * dx2 - dx * dy2
      if (
        (dz * dz) / d2 > delta2 || // perpendicular projected distance
        abs((dx * dx2 + dy * dy2) / d2 - 0.5) > 0.3 || // midpoint close to an end
        a0 * a1 + b0 * b1 + c0 * c1 < cosMinDistance // angular distance
      ) {
        resampleLineTo(x0, y0, lambda0, a0, b0, c0, x2, y2, lambda2, (a /= m), (b /= m), c, depth, stream)
        stream.point(x2, y2)
        resampleLineTo(x2, y2, lambda2, a, b, c, x1, y1, lambda1, a1, b1, c1, depth, stream)
      }
    }
  }
  return function (stream: any): any {
    let lambda00: number, x00: number, y00: number, a00: number, b00: number, c00: number // first point
    let lambda0: number, x0: number, y0: number, a0: number, b0: number, c0: number // previous point
    const resampleStream: any = {
      point,
      lineStart,
      lineEnd,
      polygonStart() {
        stream.polygonStart()
        resampleStream.lineStart = ringStart
      },
      polygonEnd() {
        stream.polygonEnd()
        resampleStream.lineStart = lineStart
      },
    }

    function point(x: number, y: number): void {
      const p = project(x, y)
      stream.point(p[0], p[1])
    }
    function lineStart(): void {
      x0 = NaN
      resampleStream.point = linePoint
      stream.lineStart()
    }
    function linePoint(lambda: number, phi: number): void {
      const c = cartesianP([lambda, phi])
      const p = project(lambda, phi)
      resampleLineTo(x0, y0, lambda0, a0, b0, c0, (x0 = p[0]!), (y0 = p[1]!), (lambda0 = lambda), a0 = c[0]!, (b0 = c[1]!), (c0 = c[2]!), maxDepth, stream)
      stream.point(x0, y0)
    }
    function lineEnd(): void {
      resampleStream.point = point
      stream.lineEnd()
    }
    function ringStart(): void {
      lineStart()
      resampleStream.point = ringPoint
      resampleStream.lineEnd = ringEnd
    }
    function ringPoint(lambda: number, phi: number): void {
      linePoint((lambda00 = lambda), phi)
      x00 = x0, y00 = y0, a00 = a0, b00 = b0, c00 = c0
      resampleStream.point = linePoint
    }
    function ringEnd(): void {
      resampleLineTo(x0, y0, lambda0, a0, b0, c0, x00, y00, lambda00, a00, b00, c00, maxDepth, stream)
      resampleStream.lineEnd = lineEnd
      lineEnd()
    }
    return resampleStream
  }
}

// local cartesian helper (lambda, phi in radians) — mirrors d3's cartesian()
function cartesianP(s: number[]): number[] {
  const cosPhi = cos(s[1]!)
  return [cosPhi * cos(s[0]!), cosPhi * sin(s[0]!), sin(s[1]!)]
}

// ---- projection/fit.js ------------------------------------------------------

function fit(projection: any, fitBounds: (b: number[][]) => void, object: any): any {
  const clip = projection.clipExtent && projection.clipExtent()
  projection.scale(150).translate([0, 0])
  if (clip != null) projection.clipExtent(null)
  geoStream(object, projection.stream(pathBoundsStream as any))
  fitBounds(pathBoundsStream.result())
  if (clip != null) projection.clipExtent(clip)
  return projection
}

export function fitExtent(projection: any, extent: number[][], object: any): any {
  return fit(projection, function (b: any) {
    const w = extent[1]![0]! - extent[0]![0]!
    const h = extent[1]![1]! - extent[0]![1]!
    const k = Math.min(w / (b[1][0] - b[0][0]), h / (b[1][1] - b[0][1]))
    const x = +extent[0]![0]! + (w - k * (b[1][0] + b[0][0])) / 2
    const y = +extent[0]![1]! + (h - k * (b[1][1] + b[0][1])) / 2
    projection.scale(150 * k).translate([x, y])
  }, object)
}

export function fitSize(projection: any, size: number[], object: any): any {
  return fitExtent(projection, [[0, 0], size], object)
}

export function fitWidth(projection: any, width: number, object: any): any {
  return fit(projection, function (b: any) {
    const w = +width
    const k = w / (b[1][0] - b[0][0])
    const x = (w - k * (b[1][0] + b[0][0])) / 2
    const y = -k * b[0][1]
    projection.scale(150 * k).translate([x, y])
  }, object)
}

export function fitHeight(projection: any, height: number, object: any): any {
  return fit(projection, function (b: any) {
    const h = +height
    const k = h / (b[1][1] - b[0][1])
    const x = -k * b[0][0]
    const y = (h - k * (b[1][1] + b[0][1])) / 2
    projection.scale(150 * k).translate([x, y])
  }, object)
}


// ---- conic.js ---------------------------------------------------------------

export function conicProjection(projectAt: any): any {
  let phi0 = 0
  let phi1 = pi / 3
  const m = projectionMutator(projectAt)
  const p = m(phi0, phi1)
  p.parallels = function (_?: number[]): any {
    return arguments.length ? m((phi0 = (_ as any)[0] * radians), (phi1 = (_ as any)[1] * radians)) : [phi0 * degrees, phi1 * degrees]
  }
  return p
}

// ---- mercator.js ------------------------------------------------------------

export function mercatorRaw(lambda: number, phi: number): number[] {
  return [lambda, log(tan((halfPi + phi) / 2))]
}
mercatorRaw.invert = function (x: number, y: number): number[] {
  return [x, 2 * atan(exp(y)) - halfPi]
}

export function mercatorProjection(project: any): any {
  const m = projectionRaw(project)
  const center = m.center
  const scale = m.scale
  const translate = m.translate
  const clipExtent = m.clipExtent
  let x0: any = null
  let y0: any
  let x1: any
  let y1: any // clip extent

  m.scale = function (_?: number): any {
    return arguments.length ? (scale(_), reclip()) : scale()
  }
  m.translate = function (_?: number[]): any {
    return arguments.length ? (translate(_), reclip()) : translate()
  }
  m.center = function (_?: number[]): any {
    return arguments.length ? (center(_), reclip()) : center()
  }
  m.clipExtent = function (_?: number[][] | null): any {
    return arguments.length
      ? (_ == null
          ? (x0 = y0 = x1 = y1 = null)
          : ((x0 = +(_ as any)[0][0]), (y0 = +(_ as any)[0][1]), (x1 = +(_ as any)[1][0]), (y1 = +(_ as any)[1][1])),
        reclip())
      : x0 == null
        ? null
        : [[x0, y0], [x1, y1]]
  }

  function reclip(): any {
    const k = pi * scale()
    const t: any = m(geoRotation(m.rotate()).invert([0, 0]))
    return clipExtent(
      x0 == null
        ? [[t[0] - k, t[1] - k], [t[0] + k, t[1] + k]]
        : project === mercatorRaw
          ? [[Math.max(t[0] - k, x0), y0], [Math.min(t[0] + k, x1), y1]]
          : [[x0, Math.max(t[1] - k, y0)], [x1, Math.min(t[1] + k, y1)]],
    )
  }

  return reclip()
}

export function mercator(): any {
  return mercatorProjection(mercatorRaw).scale(961 / tau)
}

// ---- equirectangular.js -----------------------------------------------------

export function equirectangularRaw(lambda: number, phi: number): number[] {
  return [lambda, phi]
}
equirectangularRaw.invert = equirectangularRaw

export function equirectangular(): any {
  return projectionRaw(equirectangularRaw).scale(152.63)
}

// ---- azimuthal.js -----------------------------------------------------------

export function azimuthalRaw(scale: (c: number) => number): any {
  return function (x: number, y: number): number[] {
    const cx = cos(x)
    const cy = cos(y)
    const k = scale(cx * cy)
    if (k === Infinity) return [2, 0]
    return [k * cy * sin(x), k * sin(y)]
  }
}

export function azimuthalInvert(angle: (z: number) => number): any {
  return function (x: number, y: number): number[] {
    const z = sqrt(x * x + y * y)
    const c = angle(z)
    const sc = sin(c)
    const cc = cos(c)
    return [atan2(x * sc, z * cc), asin(z && (y * sc) / z)]
  }
}

// ---- azimuthalEqualArea.js --------------------------------------------------

export const azimuthalEqualAreaRaw = azimuthalRaw(function (cxcy: number) {
  return sqrt(2 / (1 + cxcy))
})
azimuthalEqualAreaRaw.invert = azimuthalInvert(function (z: number) {
  return 2 * asin(z / 2)
})

export function azimuthalEqualArea(): any {
  return projectionRaw(azimuthalEqualAreaRaw).scale(124.75).clipAngle(180 - 1e-3)
}

// ---- azimuthalEquidistant.js ------------------------------------------------

export const azimuthalEquidistantRaw = azimuthalRaw(function (c: number) {
  return (c = acos(c)) && c / sin(c)
})
azimuthalEquidistantRaw.invert = azimuthalInvert(function (z: number) {
  return z
})

export function azimuthalEquidistant(): any {
  return projectionRaw(azimuthalEquidistantRaw).scale(79.4188).clipAngle(180 - 1e-3)
}

// ---- gnomonic.js ------------------------------------------------------------

export function gnomonicRaw(x: number, y: number): number[] {
  const cy = cos(y)
  const k = cos(x) * cy
  return [(cy * sin(x)) / k, sin(y) / k]
}
gnomonicRaw.invert = azimuthalInvert(atan)

export function gnomonic(): any {
  return projectionRaw(gnomonicRaw).scale(144.049).clipAngle(60)
}

// ---- orthographic.js --------------------------------------------------------

export function orthographicRaw(x: number, y: number): number[] {
  return [cos(y) * sin(x), sin(y)]
}
orthographicRaw.invert = azimuthalInvert(asin)

export function orthographic(): any {
  return projectionRaw(orthographicRaw).scale(249.5).clipAngle(90 + epsilon)
}

// ---- stereographic.js -------------------------------------------------------

export function stereographicRaw(x: number, y: number): number[] {
  const cy = cos(y)
  const k = 1 + cos(x) * cy
  return [(cy * sin(x)) / k, sin(y) / k]
}
stereographicRaw.invert = azimuthalInvert(function (z: number) {
  return 2 * atan(z)
})

export function stereographic(): any {
  return projectionRaw(stereographicRaw).scale(250).clipAngle(142)
}

// ---- cylindricalEqualArea.js ------------------------------------------------

export function cylindricalEqualAreaRaw(phi0: number): any {
  const cosPhi0 = cos(phi0)
  function forward(lambda: number, phi: number): number[] {
    return [lambda * cosPhi0, sin(phi) / cosPhi0]
  }
  forward.invert = function (x: number, y: number): number[] {
    return [x / cosPhi0, asin(y * cosPhi0)]
  }
  return forward
}

// ---- conicConformal.js ------------------------------------------------------

function tany(y: number): number {
  return tan((halfPi + y) / 2)
}

export function conicConformalRaw(y0: number, y1: number): any {
  const cy0 = cos(y0)
  const n = y0 === y1 ? sin(y0) : log(cy0 / cos(y1)) / log(tany(y1) / tany(y0))
  const f = (cy0 * pow(tany(y0), n)) / n
  if (!n) return mercatorRaw
  function project(x: number, y: number): number[] {
    if (f > 0) {
      if (y < -halfPi + epsilon) y = -halfPi + epsilon
    } else {
      if (y > halfPi - epsilon) y = halfPi - epsilon
    }
    const r = f / pow(tany(y), n)
    return [r * sin(n * x), f - r * cos(n * x)]
  }
  project.invert = function (x: number, y: number): number[] {
    const fy = f - y
    let l = atan2(x, abs(fy)) * sign(fy)
    const r = sign(n) * sqrt(x * x + fy * fy)
    if (fy * n < 0) l -= pi * sign(x) * sign(fy)
    return [l / n, 2 * atan(pow(f / r, 1 / n)) - halfPi]
  }
  return project
}

export function conicConformal(): any {
  return conicProjection(conicConformalRaw).scale(109.5).parallels([30, 30])
}

// ---- conicEqualArea.js ------------------------------------------------------

export function conicEqualAreaRaw(y0: number, y1: number): any {
  const sy0 = sin(y0)
  const n = (sy0 + sin(y1)) / 2
  // Are the parallels symmetrical around the Equator?
  if (abs(n) < epsilon) return cylindricalEqualAreaRaw(y0)
  const c = 1 + sy0 * (2 * n - sy0)
  const r0 = sqrt(c) / n
  function project(x: number, y: number): number[] {
    const r = sqrt(c - 2 * n * sin(y)) / n
    return [r * sin((x *= n)), r0 - r * cos(x)]
  }
  project.invert = function (x: number, y: number): number[] {
    const r0y = r0 - y
    let l = atan2(x, abs(r0y)) * sign(r0y)
    if (r0y * n < 0) l -= pi * sign(x) * sign(r0y)
    return [l / n, asin((c - (x * x + r0y * r0y) * n * n) / (2 * n))]
  }
  return project
}

export function conicEqualArea(): any {
  return conicProjection(conicEqualAreaRaw).scale(155.424).center([0, 33.6442])
}

// ---- conicEquidistant.js ----------------------------------------------------

export function conicEquidistantRaw(y0: number, y1: number): any {
  const cy0 = cos(y0)
  const n = y0 === y1 ? sin(y0) : (cy0 - cos(y1)) / (y1 - y0)
  const g = cy0 / n + y0
  if (abs(n) < epsilon) return equirectangularRaw
  function project(x: number, y: number): number[] {
    const gy = g - y
    const nx = n * x
    return [gy * sin(nx), g - gy * cos(nx)]
  }
  project.invert = function (x: number, y: number): number[] {
    const gy = g - y
    let l = atan2(x, abs(gy)) * sign(gy)
    if (gy * n < 0) l -= pi * sign(x) * sign(gy)
    return [l / n, g - sign(n) * sqrt(x * x + gy * gy)]
  }
  return project
}

export function conicEquidistant(): any {
  return conicProjection(conicEquidistantRaw).scale(131.154).center([0, 13.9389])
}

// ---- albers.js / albersUsa.js -----------------------------------------------

export function albers(): any {
  return conicEqualArea()
    .parallels([29.5, 45.5])
    .scale(1070)
    .translate([480, 250])
    .rotate([96, 0])
    .center([-0.6, 38.7])
}

// The projections must have mutually exclusive clip regions on the sphere,
// as this will avoid emitting interleaving lines and polygons.
function multiplex(streams: any[]): any {
  const n = streams.length
  return {
    point(x: number, y: number) {
      let i = -1
      while (++i < n) streams[i].point(x, y)
    },
    sphere() {
      let i = -1
      while (++i < n) streams[i].sphere()
    },
    lineStart() {
      let i = -1
      while (++i < n) streams[i].lineStart()
    },
    lineEnd() {
      let i = -1
      while (++i < n) streams[i].lineEnd()
    },
    polygonStart() {
      let i = -1
      while (++i < n) streams[i].polygonStart()
    },
    polygonEnd() {
      let i = -1
      while (++i < n) streams[i].polygonEnd()
    },
  }
}

// A composite projection for the United States, configured by default for 960x500.
export function albersUsa(): any {
  let cache: any
  let cacheStream: any
  const lower48 = albers()
  let lower48Point: any
  const alaska = conicEqualArea().rotate([154, 0]).center([-2, 58.5]).parallels([55, 65])
  let alaskaPoint: any // EPSG:3338
  const hawaii = conicEqualArea().rotate([157, 0]).center([-3, 19.9]).parallels([8, 18])
  let hawaiiPoint: any // ESRI:102007
  let point: any
  const pointStream: any = {
    point(x: number, y: number) {
      point = [x, y]
    },
  }

  function albersUsaProjection(coordinates: number[]): number[] | null {
    const x = coordinates[0]
    const y = coordinates[1]
    point = null
    return ((lower48Point.point(x, y), point) ||
      (alaskaPoint.point(x, y), point) ||
      (hawaiiPoint.point(x, y), point)) as number[] | null
  }

  albersUsaProjection.invert = function (coordinates: number[]): number[] {
    const k = lower48.scale()
    const t = lower48.translate()
    const x = (coordinates[0]! - t[0]) / k
    const y = (coordinates[1]! - t[1]) / k
    return (y >= 0.12 && y < 0.234 && x >= -0.425 && x < -0.214
      ? alaska
      : y >= 0.166 && y < 0.234 && x >= -0.214 && x < -0.115
        ? hawaii
        : lower48
    ).invert(coordinates)
  }

  albersUsaProjection.stream = function (stream: any): any {
    return cache && cacheStream === stream
      ? cache
      : (cache = multiplex([lower48.stream((cacheStream = stream)), alaska.stream(stream), hawaii.stream(stream)]))
  }

  albersUsaProjection.precision = function (_?: any): any {
    if (!arguments.length) return lower48.precision()
    lower48.precision(_), alaska.precision(_), hawaii.precision(_)
    return reset()
  }

  albersUsaProjection.scale = function (_?: any): any {
    if (!arguments.length) return lower48.scale()
    lower48.scale(_), alaska.scale((_ as any) * 0.35), hawaii.scale(_)
    return albersUsaProjection.translate(lower48.translate())
  }

  albersUsaProjection.translate = function (_?: any): any {
    if (!arguments.length) return lower48.translate()
    const k = lower48.scale()
    const x = +_![0]
    const y = +_![1]
    lower48Point = lower48
      .translate(_)
      .clipExtent([[x - 0.455 * k, y - 0.238 * k], [x + 0.455 * k, y + 0.238 * k]])
      .stream(pointStream)
    alaskaPoint = alaska
      .translate([x - 0.307 * k, y + 0.201 * k])
      .clipExtent([
        [x - 0.425 * k + epsilon, y + 0.12 * k + epsilon],
        [x - 0.214 * k - epsilon, y + 0.234 * k - epsilon],
      ])
      .stream(pointStream)
    hawaiiPoint = hawaii
      .translate([x - 0.205 * k, y + 0.212 * k])
      .clipExtent([
        [x - 0.214 * k + epsilon, y + 0.166 * k + epsilon],
        [x - 0.115 * k - epsilon, y + 0.234 * k - epsilon],
      ])
      .stream(pointStream)
    return reset()
  }

  albersUsaProjection.fitExtent = function (extent: number[][], object: any): any {
    return fitExtent(albersUsaProjection, extent, object)
  }
  albersUsaProjection.fitSize = function (size: number[], object: any): any {
    return fitSize(albersUsaProjection, size, object)
  }
  albersUsaProjection.fitWidth = function (width: number, object: any): any {
    return fitWidth(albersUsaProjection, width, object)
  }
  albersUsaProjection.fitHeight = function (height: number, object: any): any {
    return fitHeight(albersUsaProjection, height, object)
  }

  function reset(): any {
    cache = cacheStream = null
    return albersUsaProjection
  }

  return albersUsaProjection.scale(1070)
}

// ---- equalEarth.js ----------------------------------------------------------

const A1 = 1.340264
const A2 = -0.081106
const A3 = 0.000893
const A4 = 0.003796
const M = sqrt(3) / 2
const iterations = 12

export function equalEarthRaw(lambda: number, phi: number): number[] {
  const l = asin(M * sin(phi))
  const l2 = l * l
  const l6 = l2 * l2 * l2
  return [
    (lambda * cos(l)) / (M * (A1 + 3 * A2 * l2 + l6 * (7 * A3 + 9 * A4 * l2))),
    l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2)),
  ]
}
equalEarthRaw.invert = function (x: number, y: number): number[] {
  let l = y
  let l2 = l * l
  let l6 = l2 * l2 * l2
  for (let i = 0, delta: number, fy: number, fpy: number; i < iterations; ++i) {
    fy = l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2)) - y
    fpy = A1 + 3 * A2 * l2 + l6 * (7 * A3 + 9 * A4 * l2)
    l -= delta = fy / fpy
    l2 = l * l
    l6 = l2 * l2 * l2
    if (abs(delta) < epsilon) break
  }
  return [
    (M * x * (A1 + 3 * A2 * l2 + l6 * (7 * A3 + 9 * A4 * l2))) / cos(l),
    asin(sin(l) / M),
  ]
}

export function equalEarth(): any {
  return projectionRaw(equalEarthRaw).scale(177.158)
}

// ---- naturalEarth1.js -------------------------------------------------------

export function naturalEarth1Raw(lambda: number, phi: number): number[] {
  const phi2 = phi * phi
  const phi4 = phi2 * phi2
  return [
    lambda * (0.8707 - 0.131979 * phi2 + phi4 * (-0.013791 + phi4 * (0.003971 * phi2 - 0.001529 * phi4))),
    phi * (1.007226 + phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4))),
  ]
}
naturalEarth1Raw.invert = function (x: number, y: number): number[] {
  let phi = y
  let i = 25
  let delta: number
  let phi2: number
  let phi4: number
  do {
    phi2 = phi * phi
    phi4 = phi2 * phi2
    phi -= delta =
      (phi * (1.007226 + phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4))) - y) /
      (1.007226 + phi2 * (0.015085 * 3 + phi4 * (-0.044475 * 7 + 0.028874 * 9 * phi2 - 0.005916 * 11 * phi4)))
  } while (abs(delta) > epsilon && --i > 0)
  return [
    x / (0.8707 + (phi2 = phi * phi) * (-0.131979 + phi2 * (-0.013791 + phi2 * phi2 * phi2 * (0.003971 - 0.001529 * phi2)))),
    phi,
  ]
}

export function naturalEarth1(): any {
  return projectionRaw(naturalEarth1Raw).scale(175.295)
}

// ---- mollweide.js (d3-geo-projection) ---------------------------------------

export function mollweideBromleyTheta(cp: number, phi: number): number {
  const cpsinPhi = cp * sin(phi)
  let i = 30
  let delta: number
  do phi -= delta = (phi + sin(phi) - cpsinPhi) / (1 + cos(phi))
  while (abs(delta) > epsilon && --i > 0)
  return phi / 2
}

export function mollweideBromleyRaw(cx: number, cy: number, cp: number): any {
  function forward(lambda: number, phi: number): number[] {
    return [cx * lambda * cos((phi = mollweideBromleyTheta(cp, phi))), cy * sin(phi)]
  }
  forward.invert = function (x: number, y: number): number[] {
    y = asin(y / cy)
    return [x / (cx * cos(y)), asin((2 * y + sin(2 * y)) / cp)]
  }
  return forward
}

const sqrt2 = msqrt(2)

export const mollweideRaw = mollweideBromleyRaw(sqrt2 / halfPi, sqrt2, pi)

export function mollweide(): any {
  return projectionRaw(mollweideRaw).scale(169.529)
}

// ---- identity.js ------------------------------------------------------------

/**
 * d3-geo's geoIdentity: an equirectangular pass-through with scale/translate,
 * reflection, angle and an optional post-clip rectangle. No preclip/resample:
 * geometry coordinates are used as-is (planar).
 */
export function geoIdentity(): any {
  let k = 1
  let tx = 0
  let ty = 0
  let sx = 1
  let sy = 1
  let alpha = 0
  let ca = 1
  let sa = 0
  let x0: number | null = null
  let y0 = 0
  let x1 = 0
  let y1 = 0
  let kx = 1
  let ky = 1
  let postclip: any = identityFn
  let cache: any
  let cacheStream: any

  const transform = transformer({
    point(this: { stream: { point(x: number, y: number): void } }, x: number, y: number) {
      const p = projection([x, y]) as number[]
      this.stream.point(p[0]!, p[1]!)
    },
  } as Record<string, unknown>)

  function reset(): any {
    kx = k * sx
    ky = k * sy
    cache = cacheStream = null
    return projection
  }

  function projection(p: number[]): number[] {
    let x = p[0]! * kx
    let y = p[1]! * ky
    if (alpha) {
      const t = y * ca - x * sa
      x = x * ca + y * sa
      y = t
    }
    return [x + tx, y + ty]
  }
  projection.invert = function (p: number[]): number[] {
    let x = p[0]! - tx
    let y = p[1]! - ty
    if (alpha) {
      const t = y * ca + x * sa
      x = x * ca - y * sa
      y = t
    }
    return [x / kx, y / ky]
  }
  projection.stream = function (stream: any): any {
    return cache && cacheStream === stream ? cache : (cache = transform(postclip((cacheStream = stream))))
  }
  projection.postclip = function (_?: any): any {
    return arguments.length ? ((postclip = _), (x0 = y0 = x1 = y1 = null as unknown as number), reset()) : postclip
  }
  projection.clipExtent = function (_?: number[][] | null): any {
    if (!arguments.length) return x0 == null ? null : [[x0, y0], [x1, y1]]
    if (_ == null) {
      x0 = y0 = x1 = y1 = null as unknown as number
      postclip = identityFn
    } else {
      const e = _ as number[][]
      x0 = +e[0]![0]!
      y0 = +e[0]![1]!
      x1 = +e[1]![0]!
      y1 = +e[1]![1]!
      postclip = clipRectangle(x0, y0, x1, y1)
    }
    return reset()
  }
  projection.scale = function (_?: number): any {
    return arguments.length ? ((k = +_!), reset()) : k
  }
  projection.translate = function (_?: number[]): any {
    return arguments.length ? ((tx = +_![0]!), (ty = +_![1]!), reset()) : [tx, ty]
  }
  projection.angle = function (_?: number): any {
    return arguments.length ? ((alpha = ((_ as number) % 360) * radians), (sa = sin(alpha)), (ca = cos(alpha)), reset()) : alpha * degrees
  }
  projection.reflectX = function (_?: boolean): any {
    return arguments.length ? ((sx = _ ? -1 : 1), reset()) : sx < 0
  }
  projection.reflectY = function (_?: boolean): any {
    return arguments.length ? ((sy = _ ? -1 : 1), reset()) : sy < 0
  }
  projection.fitExtent = function (extent: number[][], object: any): any {
    return fitExtent(projection, extent, object)
  }
  projection.fitSize = function (size: number[], object: any): any {
    return fitSize(projection, size, object)
  }
  projection.fitWidth = function (width: number, object: any): any {
    return fitWidth(projection, width, object)
  }
  projection.fitHeight = function (height: number, object: any): any {
    return fitHeight(projection, height, object)
  }
  return projection
}

// ---- transverseMercator.js --------------------------------------------------

export function transverseMercatorRaw(lambda: number, phi: number): number[] {
  return [log(tan((halfPi + phi) / 2)), -lambda]
}
transverseMercatorRaw.invert = function (x: number, y: number): number[] {
  return [-y, 2 * atan(exp(x)) - halfPi]
}

export function transverseMercator(): any {
  const m = mercatorProjection(transverseMercatorRaw)
  const center = m.center
  const rotate = m.rotate
  m.center = function (_?: any): any {
    return arguments.length ? center([-(_ as any)[1], (_ as any)[0]]) : ((_ = center()), [_[1], -_[0]])
  }
  m.rotate = function (_?: any): any {
    return arguments.length
      ? rotate([(_ as any)[0], (_ as any)[1], (_ as any).length > 2 ? (_ as any)[2] + 90 : 90])
      : ((_ = rotate()), [_[0], _[1], _[2] - 90])
  }
  return rotate([0, 0, 90]).scale(159.155)
}

// re-exports used by geo.ts
export { geoStream, geoArea, geoBounds, geoCentroid, geoPath } from './geo-lib.js'
