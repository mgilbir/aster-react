/**
 * Seeded generators for the generated geo differentials (`differential-geo-generated.test.mts`):
 * random GeoJSON (points, lines, polygons with holes, antimeridian-crossing and pole-enclosing
 * rings, degenerate rings, huge and tiny coordinates) and random projection parameters for every
 * projection type Aster registers. Everything is a pure function of the seed, so a failure names
 * the (seed, index) that reproduces it.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json | undefined }

/** mulberry32: small, fast, and good enough to drive test generation. */
export class Rand {
  private s: number
  constructor(seed: number) {
    this.s = seed >>> 0
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next()
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1))
  }
  chance(p: number): boolean {
    return this.next() < p
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!
  }
  /** pick by weight: `[weight, value]` pairs */
  weighted<T>(xs: ReadonlyArray<readonly [number, T]>): T {
    let total = 0
    for (const [w] of xs) total += w
    let r = this.next() * total
    for (const [w, v] of xs) if ((r -= w) < 0) return v
    return xs[xs.length - 1]![1]
  }
}

export function seedOf(type: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (const c of type) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}

type Pt = number[]

const EDGE_LON = [-180, 180, 0, 179.9999999, -179.9999999, 90, -90, 1e-7, -1e-7, 179.999, -179.999, 0.5e-6]
const EDGE_LAT = [-90, 90, 0, 89.9999999, -89.9999999, 1e-9, -1e-9, 89.999, -89.999, 45]

export function lon(r: Rand): number {
  return r.weighted<() => number>([
    [10, () => r.range(-180, 180)],
    [3, () => r.pick(EDGE_LON)],
    [1, () => r.range(-540, 540)],
    [1, () => r.range(-1e-5, 1e-5)],
    [0.3, () => r.range(-1e6, 1e6)],
  ])()
}
export function lat(r: Rand): number {
  return r.weighted<() => number>([
    [10, () => r.range(-90, 90)],
    [3, () => r.pick(EDGE_LAT)],
    [0.7, () => r.range(-130, 130)],
    [1, () => r.range(-1e-5, 1e-5)],
  ])()
}
const pt = (r: Rand): Pt => [lon(r), lat(r)]

function close(ring: Pt[]): Pt[] {
  return ring.length ? [...ring, ring[0]!.slice()] : ring
}

/** a ring of `n` vertices around `c`, star-shaped with random radii (degrees), wound either way */
function blob(r: Rand, c: Pt, rad: number, n: number, cw: boolean): Pt[] {
  const ring: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = ((cw ? -1 : 1) * 2 * Math.PI * i) / n
    const rr = rad * r.range(0.4, 1)
    ring.push([c[0]! + rr * Math.cos(a), Math.max(-90, Math.min(90, c[1]! + rr * Math.sin(a)))])
  }
  return close(ring)
}

function ringOf(r: Rand): Pt[] {
  const kind = r.weighted<string>([
    [6, 'blob'], [3, 'box'], [2, 'antimeridian'], [2, 'cap'], [2, 'random'], [2, 'degenerate'], [1, 'big'], [1, 'edge'],
  ])
  switch (kind) {
    case 'blob':
      return blob(r, [r.range(-180, 180), r.range(-85, 85)], r.pick([0.01, 1, 5, 20, 45, 80]), r.int(3, 14), r.chance(0.6))
    case 'box': {
      const x = r.range(-170, 160)
      const y = r.range(-80, 70)
      const w = r.range(0.001, 60)
      const h = r.range(0.001, 40)
      const ring = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
      return close(r.chance(0.5) ? ring : ring.reverse())
    }
    case 'antimeridian': {
      const w = r.range(1, 40)
      const y = r.range(-80, 60)
      const h = r.range(1, 25)
      const ring = [[180 - w, y], [-180 + w, y], [-180 + w, y + h], [180 - w, y + h]]
      return close(r.chance(0.5) ? ring : ring.reverse())
    }
    case 'cap': {
      // a parallel ring: encloses a pole (counter-clockwise from above the north pole = the cap itself)
      const phi = r.pick([60, 80, 89, 89.9999, -60, -80, -89])
      const n = r.int(4, 24)
      const ring: Pt[] = []
      for (let i = 0; i < n; i++) ring.push([-180 + (360 * i) / n, phi])
      return close(r.chance(0.5) ? ring : ring.reverse())
    }
    case 'random': {
      const n = r.int(3, 9)
      return close(Array.from({ length: n }, () => pt(r)))
    }
    case 'degenerate': {
      const p = pt(r)
      const q = pt(r)
      return r.pick<Pt[]>([
        [], [p], [p, p], [p, q], [p, q, p], close([p, p, p, p]), close([p, q, p, q]),
        close([p, [p[0]! + 1, p[1]!], [p[0]! + 2, p[1]!]]), // collinear
        [p, q, [q[0]!, q[1]!]], // not closed
        close([p, [p[0]! + 1e-9, p[1]!], [p[0]! + 1e-9, p[1]! + 1e-9]]),
      ])
    }
    case 'big': {
      // a hole-shaped ring wound the other way round: covers more than a hemisphere
      return blob(r, [r.range(-180, 180), r.range(-60, 60)], r.pick([60, 100, 150]), r.int(6, 20), false)
    }
    default: {
      // vertices pinned to the edges of the coordinate space
      const n = r.int(3, 7)
      return close(Array.from({ length: n }, () => [r.pick(EDGE_LON), r.pick(EDGE_LAT)]))
    }
  }
}

function lineOf(r: Rand): Pt[] {
  const kind = r.weighted<string>([[6, 'walk'], [2, 'random'], [2, 'cross'], [1, 'degenerate'], [1, 'pole'], [1.5, 'meridian']])
  switch (kind) {
    case 'walk': {
      let p = pt(r)
      const out = [p]
      const step = r.pick([0.5, 5, 30, 90])
      for (let i = r.int(1, 10); i > 0; i--) {
        p = [p[0]! + r.range(-step, step), Math.max(-90, Math.min(90, p[1]! + r.range(-step, step)))]
        out.push(p)
      }
      return out
    }
    case 'random':
      return Array.from({ length: r.int(2, 8) }, () => pt(r))
    case 'cross': {
      const y = r.range(-80, 80)
      return [[r.range(120, 180), y], [r.range(-180, -120), y + r.range(-10, 10)], [r.range(120, 180), y + r.range(-10, 10)]]
    }
    case 'meridian': {
      // along one meridian (or the antimeridian), where a great-circle crossing has no longitude to speak of
      const l = r.pick([r.range(-180, 180), 180, -180, 179.9999999, -179.9999999, 0])
      return Array.from({ length: r.int(2, 5) }, () => [l + r.pick([0, 0, 1e-9, -1e-9]), r.range(-90, 90)])
    }
    case 'pole':
      return [[r.range(-180, 180), r.range(60, 89)], [r.range(-180, 180), r.range(-89, -60)], [180, 90]]
    default: {
      const p = pt(r)
      return r.pick<Pt[]>([[], [p], [p, p], [p, p, p]])
    }
  }
}

function polygonCoords(r: Rand): Pt[][] {
  const out = [ringOf(r)]
  for (let i = r.pick([0, 0, 0, 1, 1, 2]); i > 0; i--) out.push(ringOf(r))
  return out
}

export function geometry(r: Rand): Json {
  const kind = r.weighted<string>([
    [5, 'Polygon'], [3, 'MultiPolygon'], [3, 'LineString'], [2, 'MultiLineString'], [2, 'Point'], [2, 'MultiPoint'],
    [1, 'GeometryCollection'], [1, 'Sphere'],
  ])
  switch (kind) {
    case 'Polygon': return { type: 'Polygon', coordinates: polygonCoords(r) }
    case 'MultiPolygon': return { type: 'MultiPolygon', coordinates: Array.from({ length: r.int(1, 3) }, () => polygonCoords(r)) }
    case 'LineString': return { type: 'LineString', coordinates: lineOf(r) }
    case 'MultiLineString': return { type: 'MultiLineString', coordinates: Array.from({ length: r.int(1, 3) }, () => lineOf(r)) }
    case 'Point': return { type: 'Point', coordinates: pt(r) }
    case 'MultiPoint': return { type: 'MultiPoint', coordinates: Array.from({ length: r.int(1, 6) }, () => pt(r)) }
    case 'GeometryCollection': return { type: 'GeometryCollection', geometries: Array.from({ length: r.int(0, 3) }, () => geometry(r)) }
    default: return { type: 'Sphere' }
  }
}

/** any GeoJSON object a path or a fit can be handed: a geometry, a Feature (maybe geometry-less), a FeatureCollection */
export function geoObject(r: Rand): Json {
  const k = r.weighted<string>([[8, 'geometry'], [2, 'Feature'], [1, 'FeatureCollection']])
  if (k === 'geometry') return geometry(r)
  if (k === 'Feature') return { type: 'Feature', properties: {}, geometry: r.chance(0.1) ? null : geometry(r) }
  return {
    type: 'FeatureCollection',
    features: Array.from({ length: r.int(0, 4) }, () => ({ type: 'Feature', properties: {}, geometry: r.chance(0.1) ? null : geometry(r) })),
  }
}

/**
 * Shapes that a clip rectangle has nothing to cut: small ones, wholly inside the area an albersUsa part (or a mercator
 * world) covers, in the places the three parts of albersUsa draw (the lower 48, Alaska, Hawaii), alone and several to a
 * shape so that the parts of albersUsa have something to merge, with holes, with nothing in them, and with their
 * positions on the clip rectangle's edge.
 */
export function regional(r: Rand): Json {
  const places: Pt[] = [[-98, 39], [-84, 33], [-120, 37], [-150, 64], [-157, 20.8], [-69, 45], [-110, 45]]
  const ring = (c: Pt, cw: boolean): Pt[] => blob(r, c, r.pick([0.05, 0.4, 1.5]), r.int(3, 9), cw)
  const polygon = (c: Pt): Pt[][] => {
    const rings = [ring(c, true)]
    if (r.chance(0.3)) rings.push(ring(c, false).map((p) => [c[0]! + (p[0]! - c[0]!) / 4, c[1]! + (p[1]! - c[1]!) / 4] as Pt))
    if (r.chance(0.08)) rings.push([])
    return rings
  }
  const line = (c: Pt): Pt[] => Array.from({ length: r.pick([0, 1, 2, 3, 6]) }, () => [c[0]! + r.range(-1.5, 1.5), c[1]! + r.range(-1.5, 1.5)] as Pt)
  const member = (): Json => {
    const c = r.pick(places)
    switch (r.pick(['Polygon', 'Polygon', 'MultiPolygon', 'LineString', 'MultiLineString', 'Point', 'MultiPoint', 'Polygon-empty'])) {
      case 'Polygon': return { type: 'Polygon', coordinates: polygon(c) }
      case 'MultiPolygon': return { type: 'MultiPolygon', coordinates: Array.from({ length: r.int(1, 3) }, () => polygon(r.pick(places))) }
      case 'LineString': return { type: 'LineString', coordinates: line(c) }
      case 'MultiLineString': return { type: 'MultiLineString', coordinates: Array.from({ length: r.int(1, 3) }, () => line(r.pick(places))) }
      case 'Point': return { type: 'Point', coordinates: c }
      case 'MultiPoint': return { type: 'MultiPoint', coordinates: Array.from({ length: r.int(1, 4) }, () => r.pick(places)) }
      default: return { type: 'Polygon', coordinates: [] }
    }
  }
  const k = r.pick(['one', 'collection', 'features', 'multi'])
  if (k === 'one') return member()
  if (k === 'collection') return { type: 'GeometryCollection', geometries: Array.from({ length: r.int(1, 4) }, member) }
  if (k === 'features') return { type: 'FeatureCollection', features: Array.from({ length: r.int(1, 4) }, () => ({ type: 'Feature', properties: {}, geometry: member() })) }
  return { type: 'MultiPolygon', coordinates: Array.from({ length: r.int(2, 4) }, () => polygon(r.pick(places))) }
}

/** shapes in the plane, for an identity projection clipped to [[0, 0], [100, 100]]: inside, empty, and on the edge */
export const PLANAR_SHAPES: Json[] = [
  { type: 'Polygon', coordinates: [[[10, 10], [90, 10], [90, 90], [10, 90], [10, 10]]] },
  { type: 'Polygon', coordinates: [[[10, 10], [90, 10], [90, 90], [10, 90], [10, 10]], [[40, 40], [40, 60], [60, 60], [60, 40], [40, 40]]] },
  { type: 'Polygon', coordinates: [[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]] },
  { type: 'Polygon', coordinates: [[[10, 10], [100, 20], [50, 90], [10, 10]]] },
  { type: 'Polygon', coordinates: [[[0, 50], [50, 20], [50, 80], [0, 50]]] },
  { type: 'Polygon', coordinates: [] },
  { type: 'Polygon', coordinates: [[]] },
  { type: 'Polygon', coordinates: [[[5, 5]]] },
  { type: 'Polygon', coordinates: [[[5, 5], [5, 5]]] },
  { type: 'MultiPolygon', coordinates: [[[[10, 10], [20, 10], [20, 20], [10, 10]]], [[[70, 70], [80, 70], [80, 80], [70, 70]]]] },
  { type: 'MultiPolygon', coordinates: [[[[10, 10], [20, 10], [20, 20], [10, 10]]], []] },
  { type: 'LineString', coordinates: [] },
  { type: 'LineString', coordinates: [[10, 10]] },
  { type: 'LineString', coordinates: [[10, 10], [20, 30], [90, 90]] },
  { type: 'LineString', coordinates: [[0, 10], [100, 10]] },
  { type: 'LineString', coordinates: [[10, 10], [10, 10], [10, 10]] },
  { type: 'MultiLineString', coordinates: [[[10, 10], [20, 30]], [], [[60, 60], [90, 70], [80, 20]]] },
  { type: 'Point', coordinates: [50, 50] },
  { type: 'Point', coordinates: [0, 50] },
  { type: 'MultiPoint', coordinates: [[1, 1], [99, 99], [100, 100], [50, 50]] },
  { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [5, 5] }, { type: 'LineString', coordinates: [[1, 2], [3, 4]] }, { type: 'Polygon', coordinates: [[[10, 10], [30, 10], [30, 30], [10, 10]]] }] },
  { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: null }, { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[10, 10], [30, 10], [30, 30], [10, 10]]] } }] },
]

/** a geometry that is certain to have extent (for fitting): a few well-formed blobs */
export function fittable(r: Rand): Json {
  const one = () => ({ type: 'Polygon', coordinates: [blob(r, [r.range(-170, 170), r.range(-70, 70)], r.pick([2, 10, 30]), r.int(4, 12), true)] })
  const k = r.pick(['polygon', 'collection', 'line', 'points'])
  if (k === 'polygon') return one()
  if (k === 'collection') return { type: 'FeatureCollection', features: Array.from({ length: r.int(1, 3) }, () => ({ type: 'Feature', properties: {}, geometry: one() })) }
  if (k === 'line') return { type: 'LineString', coordinates: lineOf(r).concat([[r.range(-100, 100), r.range(-60, 60)]]) }
  return { type: 'MultiPoint', coordinates: Array.from({ length: r.int(2, 6) }, () => [r.range(-170, 170), r.range(-80, 80)]) }
}

/** every projection type Aster registers (vega-projection's lower-cased registry names) */
export const PROJECTION_TYPES = [
  'albers', 'albersUsa', 'azimuthalEqualArea', 'azimuthalEquidistant', 'conicConformal', 'conicEqualArea',
  'conicEquidistant', 'equalEarth', 'equirectangular', 'gnomonic', 'identity', 'mercator', 'mollweide',
  'naturalEarth1', 'orthographic', 'stereographic', 'transverseMercator',
] as const

const num = (r: Rand, ...ranges: Array<[number, number]>): number => {
  const [a, b] = r.pick(ranges)
  return r.range(a, b)
}

/** random vega projection parameters (the properties vega-geo's Projection transform applies) */
export function projectionParams(r: Rand, type: string, opts: { fit?: boolean } = {}): Record<string, Json> {
  const p: Record<string, Json> = { type }
  const some = (prob: number) => r.chance(prob)
  if (some(0.75)) p.scale = r.weighted<number>([[8, r.range(20, 600)], [1, r.range(0.001, 5)], [1, r.range(1e3, 1e5)], [0.3, 0]])
  if (some(0.75)) p.translate = [r.range(-100, 600), r.range(-100, 500)]
  if (some(0.45)) p.center = [r.pick([r.range(-180, 180), r.range(-400, 400), 0]), r.pick([r.range(-80, 80), r.range(-200, 200), 0])]
  if (some(0.55)) {
    p.rotate = r.weighted<Json>([
      [6, [r.range(-180, 180), r.range(-90, 90)]],
      [3, [r.range(-180, 180), r.range(-90, 90), r.range(-180, 180)]],
      [1, [r.range(-720, 720), r.range(-400, 400), r.range(-400, 400)]],
      [1, [0, 0, 0]],
    ])
  }
  if (some(0.5)) p.clipAngle = r.weighted<number>([[4, r.range(1, 179)], [2, r.pick([30, 60, 90, 120, 179, 180, 89.999999, 90.000001])], [1, 0], [0.5, num(r, [0, 1e-3], [-180, 0])], [0.4, r.range(180, 360)]])
  if (some(0.35)) {
    const x0 = r.range(-100, 400)
    const y0 = r.range(-100, 300)
    p.clipExtent = [[x0, y0], [x0 + r.weighted<number>([[8, r.range(10, 600)], [1, 0], [0.5, -r.range(1, 100)]]), y0 + r.weighted<number>([[8, r.range(10, 500)], [1, 0], [0.5, -r.range(1, 100)]])]]
  }
  if (some(0.45)) p.precision = r.weighted<number>([[4, r.range(0.1, 3)], [2, r.pick([0, 0.1, 0.5, 1, 2, 5, 10, 100])], [1, 0.1], [0.4, -0.5]])
  if (some(0.25)) p.reflectX = r.chance(0.5)
  if (some(0.25)) p.reflectY = r.chance(0.5)
  if (some(0.45)) {
    const a = r.range(-90, 90)
    p.parallels = r.weighted<Json>([[5, [a, r.range(-90, 90)]], [1, [a, a]], [1, [a, -a]], [1, [0, 0]], [1, [r.range(0, 89), r.range(0, 89)]], [0.5, [a, 90]]])
  }
  // a projection that sends its horizon to infinity (gnomonic at 90 degrees, stereographic at 180) makes every segment
  // near it subdivide to full depth: millions of points per polygon, minutes per case, on both sides
  if (type === 'gnomonic' && typeof p.clipAngle === 'number' && Math.abs(p.clipAngle) > 80) p.clipAngle = 80
  if (type === 'stereographic' && typeof p.clipAngle === 'number' && Math.abs(p.clipAngle) > 160) p.clipAngle = 160
  if (some(0.1)) p.pointRadius = r.range(0.5, 12)
  // the d3-geo-projection extras vega lists but no registered type here reads
  if (some(0.05)) p.coefficient = r.range(0, 1)
  if (some(0.05)) p.lobes = r.int(2, 8)
  if (opts.fit) {
    p.fit = fittable(r)
    if (some(0.5)) p.size = [r.range(50, 800), r.range(50, 600)]
    if (some(0.5)) p.extent = [[r.range(0, 50), r.range(0, 50)], [r.range(100, 700), r.range(100, 500)]]
    if (p.size === undefined && p.extent === undefined) p.size = [r.range(100, 600), r.range(100, 400)]
  }
  return p
}

/**
 * Replace some parameters of a projection definition by values of the wrong kind (a number where a pair belongs, a string
 * where a number does, a missing element, NaN, an extent without its second corner). Vega applies them through the same
 * setters, so both sides coerce them alike, or fail alike.
 */
export function oddParams(r: Rand, params: Record<string, Json>): Record<string, Json> {
  const odd: Record<string, Json[]> = {
    scale: ['120', [100], true, NaN, -50, 1e4],
    translate: [[1], 'ab', 5, [null, 1], ['10', '20'], [NaN, 5]],
    center: [[10], 5, 'ab', [null, null], ['10', '20'], [400, 200]],
    rotate: [[1], 'xy', [1, 2, 3, 4], [null, 2], ['10', '20', '30'], [NaN, 0]],
    precision: ['1', -1, NaN, [1], 0, 0.1],
    clipAngle: ['60', [60], true, NaN, -60, 1e-3],
    clipExtent: [[[0, 0]], 5, [[0, 0], [1]], 'ab', [[0, 0], [NaN, 5]], [['0', '0'], ['100', '100']]],
    parallels: [[10], 5, 'ab', [NaN, 5], [90, 90], [-90, 90]],
    reflectX: ['false', 0, 1, [], 'true'],
    reflectY: ['false', 0, 1, [], 'true'],
    pointRadius: ['5', -3, NaN, 0],
  }
  const out = { ...params }
  for (const key of Object.keys(odd)) if (r.chance(0.12)) out[key] = r.pick(odd[key]!)
  return out
}

/** random lon/lat probe points (some at the poles and the antimeridian) */
export function probePoints(r: Rand, n: number): Pt[] {
  return Array.from({ length: n }, () => (r.chance(0.7) ? [r.range(-180, 180), r.range(-90, 90)] : pt(r)))
}

type Spec = Record<string, unknown>

/** a whole Vega spec: random projection, GeoJSON rows through geopath/geopoint/geoshape, sometimes a graticule */
export function randomSpec(r: Rand): Spec {
  const type = r.pick(PROJECTION_TYPES)
  const params = projectionParams(r, type, { fit: r.chance(0.3) })
  if (params.fit) params.size = [300, 200]
  delete params.extent
  const rows = Array.from({ length: r.int(1, 4) }, (_, i) => {
    const o = geoObject(r) as { type: string }
    const f = o.type === 'Feature' || o.type === 'FeatureCollection' ? o : { type: 'Feature', geometry: o }
    return { ...f, properties: { id: i, lon: lon(r), lat: lat(r) } }
  })
  const useRadius = r.chance(0.3)
  const radiusT = r.pick<Json>([4, { expr: 'datum.properties.id + 2' }])
  const graticule = r.chance(0.35)
  const data: Json[] = [
    { name: 'src', values: rows as Json[], transform: [
      { type: 'geopath', projection: 'p', as: 'gp', ...(useRadius ? { pointRadius: radiusT } : {}) },
      { type: 'geopoint', projection: 'p', fields: ['properties.lon', 'properties.lat'], as: ['px', 'py'] },
    ] },
  ]
  if (graticule) {
    data.push({ name: 'grat', transform: [{
      type: 'graticule',
      ...(r.chance(0.5) ? { extent: [[r.range(-180, 0), r.range(-90, 0)], [r.range(0, 180), r.range(0, 90)]] } : {}),
      ...(r.chance(0.5) ? { step: [r.pick([10, 15, 30]), r.pick([10, 15, 30])] } : {}),
      ...(r.chance(0.3) ? { precision: r.pick([0.1, 1, 5]) } : {}),
      ...(r.chance(0.3) ? { stepMajor: [r.pick([90, 45]), r.pick([90, 45])] } : {}),
    }] })
  }
  // (the path mark is fill-only: a stroked path mark whose every path is null widens the root by a pixel in Aster, which is the
  // bounds pass and not geo; see the report)
  const marks: Json[] = [
    { type: 'shape', from: { data: 'src' }, encode: { update: { fill: { value: '#ddd' }, stroke: { value: '#333' } } },
      transform: [{ type: 'geoshape', projection: 'p', ...(useRadius ? { pointRadius: radiusT } : {}) }] },
    { type: 'path', from: { data: 'src' }, encode: { update: { path: { field: 'gp' }, fill: { value: 'rgba(255,0,0,0.3)' } } } },
    { type: 'symbol', from: { data: 'src' }, encode: { update: { x: { field: 'px' }, y: { field: 'py' }, size: { value: 30 } } } },
  ]
  if (graticule) {
    marks.push({ type: 'shape', from: { data: 'grat' }, encode: { update: { stroke: { value: '#999' }, fill: { value: null } } }, transform: [{ type: 'geoshape', projection: 'p' }] })
  }
  return {
    width: 300, height: 200, padding: r.pick([0, 5]), autosize: r.pick(['none', 'pad']),
    data, projections: [{ name: 'p', ...params }], marks,
  }
}

