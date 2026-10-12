/**
 * TopoJSON decoding — a faithful port of the topojson-client (3.1.0) surface
 * the load addon uses: `feature` (including the internal `object` walker that
 * `mesh` shares) and `mesh`/`meshArcs` with their arc-stitching machinery.
 * Pinned by oracle vectors (`testdata/vectors/topojson-client.json`).
 */

import identity from './topojson-identity.js'

// --- transform ---------------------------------------------------------------

interface TopologyTransform {
  scale: [number, number]
  translate: [number, number]
}

interface Topology {
  type: 'Topology'
  arcs: number[][][]
  objects: Record<string, TopoObject>
  bbox?: number[]
  transform?: TopologyTransform
}

interface TopoObject {
  type: string
  id?: string | number
  bbox?: number[]
  properties?: Record<string, unknown>
  coordinates?: unknown
  arcs?: unknown
  geometries?: TopoObject[]
}

type Point = [number, number, ...number[]]

function reverse(array: unknown[], n: number): void {
  let t: unknown
  let j = array.length
  let i = j - n
  while (i < --j) t = array[i], array[i++] = array[j], array[j] = t
}

function transform(transform: TopologyTransform | undefined): (input: number[], i: number) => Point {
  if (transform == null) return identity
  let x0: number
  let y0: number
  const kx = transform.scale[0]
  const ky = transform.scale[1]
  const dx = transform.translate[0]
  const dy = transform.translate[1]
  return function (input: number[], i: number): Point {
    if (!i) x0 = y0 = 0
    let j = 2
    const n = input.length
    const output = new Array(n) as Point
    output[0] = (x0 += input[0]!) * kx + dx
    output[1] = (y0 += input[1]!) * ky + dy
    while (j < n) output[j] = input[j] as number, ++j
    return output
  }
}

// --- feature -----------------------------------------------------------------

function featureFn(topology: Topology, o: TopoObject): GeoLike {
  const id = o.id
  const bbox = o.bbox
  const properties = o.properties == null ? {} : o.properties
  const geometry = object(topology, o)
  return id == null && bbox == null ? { type: 'Feature', properties, geometry }
    : bbox == null ? { type: 'Feature', id, properties, geometry }
    : { type: 'Feature', id, bbox, properties, geometry }
}

/** `feature(topology, object)` — a string selects a named object. */
export function feature(topology: Topology, o: TopoObject | string): GeoLike {
  const obj = (typeof o === 'string' ? topology.objects[o] : o) as TopoObject
  return obj.type === 'GeometryCollection'
    ? { type: 'FeatureCollection', features: obj.geometries!.map((g) => featureFn(topology, g)) }
    : featureFn(topology, obj)
}

interface GeoLike {
  type: string
  id?: string | number
  bbox?: number[]
  properties?: Record<string, unknown>
  geometry?: GeoGeometry | null
  features?: GeoLike[]
  coordinates?: unknown
  arcs?: unknown
}

interface GeoGeometry {
  type: string
  [key: string]: unknown
  coordinates?: unknown
  geometries?: GeoGeometry[]
}

export function object(topology: Topology, o: TopoObject): GeoGeometry | null {
  const transformPoint = transform(topology.transform)
  const arcs = topology.arcs

  function arc(i: number, points: unknown[]): void {
    if (points.length) points.pop()
    const a = arcs[i < 0 ? ~i : i] as number[][]
    for (let k = 0, n = a.length; k < n; ++k) {
      points.push(transformPoint(a[k] as number[], k))
    }
    if (i < 0) reverse(points, a.length)
  }

  function point(p: number[]): unknown {
    return transformPoint(p, 0)
  }

  function line(arcs: number[]): unknown[] {
    const points: unknown[] = []
    for (let i = 0, n = arcs.length; i < n; ++i) arc(arcs[i] as number, points)
    if (points.length < 2) points.push(points[0] as number) // This should never happen per the specification.
    return points
  }

  function ring(arcs: number[]): unknown[] {
    const points = line(arcs)
    while (points.length < 4) points.push(points[0] as number) // This may happen if an arc has only two points.
    return points
  }

  function polygon(arcs: number[][]): unknown[] {
    return arcs.map(ring)
  }

  function geometry(o: TopoObject): GeoGeometry | null {
    const type = o.type
    let coordinates: unknown
    switch (type) {
      case 'GeometryCollection': return { type, geometries: o.geometries!.map((g) => geometry(g) as GeoGeometry) }
      case 'Point': coordinates = point(o.coordinates as number[]); break
      case 'MultiPoint': coordinates = (o.coordinates as number[][]).map(point); break
      case 'LineString': coordinates = line(o.arcs as number[]); break
      case 'MultiLineString': coordinates = (o.arcs as number[][]).map(line); break
      case 'Polygon': coordinates = polygon(o.arcs as number[][]); break
      case 'MultiPolygon': coordinates = (o.arcs as number[][][]).map(polygon); break
      default: return null
    }
    return { type, coordinates }
  }

  return geometry(o)
}

// --- mesh --------------------------------------------------------------------

export function meshArcs(topology: Topology, o?: TopoObject | string, filter?: (a: TopoObject, b: TopoObject) => boolean): { type: 'MultiLineString'; arcs: number[][] } {
  let arcs: number[]
  if (arguments.length > 1) {
    const obj = (typeof o === 'string' ? topology.objects[o] : o) as TopoObject
    arcs = extractArcs(topology, obj, filter)
  } else {
    arcs = new Array(topology.arcs.length)
    for (let i = 0, n = topology.arcs.length; i < n; ++i) arcs[i] = i
  }
  return { type: 'MultiLineString', arcs: stitch(topology, arcs) }
}

/** `mesh(topology[, object[, filter]])` — the stitched MultiLineString geometry. */
export function mesh(topology: Topology, o?: TopoObject | string, filter?: (a: TopoObject, b: TopoObject) => boolean): GeoGeometry {
  // upstream dispatches on arguments.length: mesh(topology) meshes every arc
  // eslint-disable-next-line prefer-rest-params
  const arcs = arguments.length > 1
    ? meshArcs(topology, o, filter)
    : meshArcs(topology)
  return object(topology, arcs as unknown as TopoObject) as GeoGeometry
}

function extractArcs(topology: Topology, object: TopoObject, filter?: (a: TopoObject, b: TopoObject) => boolean): number[] {
  const arcs: number[] = []
  const geomsByArc: Array<Array<{ i: number; g: TopoObject }>> = []
  let geom: TopoObject

  function extract0(i: number): void {
    const j = i < 0 ? ~i : i
    ;(geomsByArc[j] || (geomsByArc[j] = [])).push({ i, g: geom })
  }
  function extract1(arcs: number[]): void {
    arcs.forEach(extract0)
  }
  function extract2(arcs: number[][]): void {
    arcs.forEach(extract1)
  }
  function extract3(arcs: number[][][]): void {
    arcs.forEach(extract2)
  }
  function geometry(o: TopoObject): void {
    switch (geom = o, o.type) {
      case 'GeometryCollection': o.geometries!.forEach(geometry); break
      case 'LineString': extract1(o.arcs as number[]); break
      case 'MultiLineString': case 'Polygon': extract2(o.arcs as number[][]); break
      case 'MultiPolygon': extract3(o.arcs as number[][][]); break
    }
  }

  geometry(object)

  geomsByArc.forEach(filter == null
    ? function (geoms: Array<{ i: number; g: TopoObject }>) { arcs.push(geoms[0]!.i) }
    : function (geoms: Array<{ i: number; g: TopoObject }>) { if (filter!(geoms[0]!.g, geoms[geoms.length - 1]!.g)) arcs.push(geoms[0]!.i) })

  return arcs
}

/** A stitched arc run; upstream hangs `start`/`end` points on the array. */
type Fragment = number[] & { start?: Point; end?: Point }

function stitch(topology: Topology, arcs: number[]): number[][] {
  const stitchedArcs: Record<string, number> = {}
  const fragmentByStart: Record<string, Fragment> = {}
  const fragmentByEnd: Record<string, Fragment> = {}
  const fragments: number[][] = []
  let emptyIndex = -1

  // Stitch empty arcs first, since they may be subsumed by other arcs.
  arcs.forEach(function (i, j) {
    const arc = topology.arcs[i < 0 ? ~i : i] as number[][]
    let t: number
    if (arc.length < 3 && !(arc[1] as number[])[0] && !(arc[1] as number[])[1]) {
      t = arcs[++emptyIndex] as number, arcs[emptyIndex] = i, arcs[j] = t
    }
  })

  arcs.forEach(function (i) {
    const e = ends(i)
    const start = e[0]
    const end = e[1]
    let f: Fragment | undefined
    let g: Fragment | undefined
    if ((f = fragmentByEnd[String(start)])) {
      delete fragmentByEnd[String(f.end)]
      f.push(i)
      f.end = end
      if ((g = fragmentByStart[String(end)])) {
        delete fragmentByStart[String(g.start)]
        const fg = (g === f ? f : f.concat(g)) as Fragment
        fragmentByStart[String(fg.start = f.start!)] = fragmentByEnd[String(fg.end = g.end!)] = fg
      } else {
        fragmentByStart[String(f.start!)] = fragmentByEnd[String(f.end)] = f
      }
    } else if ((f = fragmentByStart[String(end)])) {
      delete fragmentByStart[String(f.start)]
      f.unshift(i)
      f.start = start
      if ((g = fragmentByEnd[String(start)])) {
        delete fragmentByEnd[String(g.end)]
        const gf = (g === f ? f : g.concat(f)) as Fragment
        fragmentByStart[String(gf.start = g.start!)] = fragmentByEnd[String(gf.end = f.end!)] = gf
      } else {
        fragmentByStart[String(f.start!)] = fragmentByEnd[String(f.end)] = f
      }
    } else {
      f = [i] as Fragment
      fragmentByStart[String(f.start = start)] = fragmentByEnd[String(f.end = end)] = f
    }
  })

  function ends(i: number): [Point, Point] {
    const arc = topology.arcs[i < 0 ? ~i : i] as number[][]
    const p0 = arc[0] as Point
    let p1: Point
    if (topology.transform) {
      p1 = [0, 0]
      arc.forEach(function (dp: number[]) { p1[0] += dp[0] as number, p1[1] += dp[1] as number })
    } else {
      p1 = arc[arc.length - 1] as Point
    }
    return i < 0 ? [p1, p0] : [p0, p1]
  }

  function flush(fragmentByEnd: Record<string, Fragment>, fragmentByStart: Record<string, Fragment>): void {
    for (const k in fragmentByEnd) {
      const f = fragmentByEnd[k] as Fragment
      delete fragmentByStart[String(f.start)]
      delete f.start
      delete f.end
      f.forEach(function (i) { stitchedArcs[String(i < 0 ? ~i : i)] = 1 })
      fragments.push(f)
    }
  }

  flush(fragmentByEnd, fragmentByStart)
  flush(fragmentByStart, fragmentByEnd)
  arcs.forEach(function (i) { if (!stitchedArcs[String(i < 0 ? ~i : i)]) fragments.push([i]) })

  return fragments
}
