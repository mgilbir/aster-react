/**
 * TopoJSON decoding: `feature` turns a topology's object into GeoJSON features, and `mesh` into the single line geometry
 * of the boundaries between (or around) its shapes.
 *
 * A topology stores each shared boundary once, as an arc: a list of positions, delta-encoded from the previous position
 * when the topology carries a `transform` (integers that scale and shift to coordinates). Geometries refer to arcs by
 * index; a negative index `~i` is arc `i` walked backwards. Joining the arcs of a line puts the arcs' shared end point in
 * once.
 *
 * What is fixed by the output: the decoded coordinates are computed as `(sum of deltas) * scale + translate`, in that
 * order; a line or ring is padded by repeating its first position up to the length GeoJSON requires; and `mesh` lists
 * the arcs it keeps in ascending arc index and then stitches them into runs, whose order and orientation come from the
 * stitching rules below (empty arcs first, then arcs are chained by matching end points in the order they are given).
 * Decoded positions are fresh arrays, never the topology's own.
 */
import { meterCoords } from './limits.js'

interface Transform {
  scale: [number, number]
  translate: [number, number]
}

interface Topology {
  type: 'Topology'
  arcs: number[][][]
  objects: Record<string, TopoObject>
  bbox?: number[]
  transform?: Transform
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

type Position = number[]

interface Geometry {
  type: string
  coordinates?: unknown
  geometries?: Array<Geometry | null>
}

interface Feature {
  type: string
  id?: string | number
  bbox?: number[]
  properties?: Record<string, unknown>
  geometry?: Geometry | null
  features?: Feature[]
}

/** The object a name or an object refers to; a name must be an own property of `objects` (not `constructor`, ...). */
function resolveObject(topology: Topology, object: TopoObject | string | undefined): TopoObject {
  if (typeof object !== 'string') return object as TopoObject
  if (!Object.hasOwn(topology.objects ?? {}, object)) throw new Error(`[aster] topojson object "${object}" not found`)
  return topology.objects[object] as TopoObject
}

// -- geometry -------------------------------------------------------------------------------------------------------

/** The position(s) of arc data in absolute coordinates, as fresh arrays. */
function decodePositions(positions: readonly Position[], transform: Transform | undefined): Position[] {
  const n = positions.length
  const out = new Array<Position>(n)
  if (!transform) {
    for (let i = 0; i < n; i++) out[i] = positions[i]!.slice()
    return out
  }
  const kx = transform.scale[0]
  const ky = transform.scale[1]
  const dx = transform.translate[0]
  const dy = transform.translate[1]
  let x = 0
  let y = 0
  for (let i = 0; i < n; i++) {
    const p = positions[i]!
    const q = [(x += p[0]!) * kx + dx, (y += p[1]!) * ky + dy]
    for (let j = 2; j < p.length; j++) q.push(p[j]!)
    out[i] = q
  }
  return out
}

/** Append the decoded positions of a delta-encoded arc to `out`. */
function appendTransformed(out: Position[], raw: readonly Position[], transform: Transform): void {
  const kx = transform.scale[0]
  const ky = transform.scale[1]
  const dx = transform.translate[0]
  const dy = transform.translate[1]
  let x = 0
  let y = 0
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i]!
    const q = [(x += p[0]!) * kx + dx, (y += p[1]!) * ky + dy]
    for (let j = 2; j < p.length; j++) q.push(p[j]!)
    out.push(q)
  }
}

/** Reverse `points` from index `from` to the end. */
function reverseTail(points: Position[], from: number): void {
  for (let i = from, j = points.length - 1; i < j; i++, j--) {
    const t = points[i]!
    points[i] = points[j]!
    points[j] = t
  }
}

/** Decodes the geometries of one topology. */
function decoder(topology: Topology) {
  const { arcs, transform } = topology

  /** Append arc `index` (negative: backwards) to `points`, which already holds the line so far. */
  function appendArc(points: Position[], index: number): void {
    // the joint is the previous arc's last position and this arc's first: keep one
    if (points.length) points.pop()
    const raw = arcs[index < 0 ? ~index : index] as Position[]
    // one arc can be referenced from any number of geometries, so the decoded size is not bounded by the input's
    meterCoords(raw.length, 'topojson arcs')
    const first = points.length
    if (transform) appendTransformed(points, raw, transform)
    else for (let i = 0; i < raw.length; i++) points.push(raw[i]!.slice())
    if (index < 0) reverseTail(points, first)
  }

  function line(indices: number[]): Position[] {
    const points: Position[] = []
    for (const index of indices) appendArc(points, index)
    if (points.length < 2) points.push(points[0] as Position)
    return points
  }

  function ring(indices: number[]): Position[] {
    const points = line(indices)
    while (points.length < 4) points.push(points[0] as Position)
    return points
  }

  const polygon = (rings: number[][]): Position[][] => rings.map(ring)
  /** A point geometry's position is absolute (scaled and shifted), not a delta from another position. */
  const point = (p: Position): Position => decodePositions([p], transform)[0]!

  function geometry(o: TopoObject): Geometry | null {
    const type = o.type
    switch (type) {
      case 'GeometryCollection': return { type, geometries: o.geometries!.map(geometry) }
      case 'Point': return { type, coordinates: point(o.coordinates as Position) }
      case 'MultiPoint': return { type, coordinates: (o.coordinates as Position[]).map(point) }
      case 'LineString': return { type, coordinates: line(o.arcs as number[]) }
      case 'MultiLineString': return { type, coordinates: (o.arcs as number[][]).map(line) }
      case 'Polygon': return { type, coordinates: polygon(o.arcs as number[][]) }
      case 'MultiPolygon': return { type, coordinates: (o.arcs as number[][][]).map(polygon) }
      default: return null
    }
  }
  return geometry
}

// -- feature --------------------------------------------------------------------------------------------------------

function featureOf(topology: Topology, o: TopoObject, geometry: (o: TopoObject) => Geometry | null): Feature {
  const { id, bbox } = o
  const properties = o.properties == null ? {} : o.properties
  const g = geometry(o)
  return id == null && bbox == null ? { type: 'Feature', properties, geometry: g }
    : bbox == null ? { type: 'Feature', id, properties, geometry: g }
    : { type: 'Feature', id, bbox, properties, geometry: g }
}

/** `feature(topology, object)`: a Feature, or a FeatureCollection for a GeometryCollection; a string names an object. */
export function feature(topology: Topology, object: TopoObject | string): Feature {
  const o = resolveObject(topology, object)
  const geometry = decoder(topology)
  return o.type === 'GeometryCollection'
    ? { type: 'FeatureCollection', features: o.geometries!.map((g) => featureOf(topology, g, geometry)) }
    : featureOf(topology, o, geometry)
}

// -- mesh -----------------------------------------------------------------------------------------------------------

type Filter = (a: TopoObject, b: TopoObject) => boolean

/**
 * The arcs a geometry uses, one entry per arc in ascending arc index: the arc as first referenced (its sign says which
 * way) and, if `filter` is given, kept only when `filter(first geometry using it, last geometry using it)` holds. With
 * the usual `a !== b` that keeps the arcs shared by two different shapes (interior borders); with `a === b` the arcs
 * used by one shape only (the outline).
 */
function arcsOf(root: TopoObject, filter: Filter | undefined): number[] {
  const first: number[] = []
  const firstGeometry: TopoObject[] = []
  const lastGeometry: TopoObject[] = []
  let current: TopoObject

  const note = (index: number): void => {
    const arc = index < 0 ? ~index : index
    if (firstGeometry[arc] === undefined) {
      first[arc] = index
      firstGeometry[arc] = current
    }
    lastGeometry[arc] = current
  }
  const visit = (o: TopoObject): void => {
    current = o
    switch (o.type) {
      case 'GeometryCollection': o.geometries!.forEach(visit); break
      case 'LineString': (o.arcs as number[]).forEach(note); break
      case 'MultiLineString': case 'Polygon': (o.arcs as number[][]).forEach((a) => a.forEach(note)); break
      case 'MultiPolygon': (o.arcs as number[][][]).forEach((p) => p.forEach((a) => a.forEach(note))); break
    }
  }
  visit(root)

  const kept: number[] = []
  for (let arc = 0; arc < firstGeometry.length; arc++) {
    if (firstGeometry[arc] === undefined) continue
    if (!filter || filter(firstGeometry[arc]!, lastGeometry[arc]!)) kept.push(first[arc]!)
  }
  return kept
}

/** A run of arcs being chained, with the position keys of its two ends. */
interface Run {
  arcs: number[]
  start: string
  end: string
}

/** A position as the text two arcs must share to be joined. */
const keyOf = (p: ArrayLike<number>): string =>
  p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number' ? p[0] + ',' + p[1] : Array.prototype.join.call(p)

/**
 * Chain `indices` (signed arc indices) into runs of arcs that meet end to end. Arcs with no extent are placed first. An
 * arc joins a run that ends where it starts, or starts where it ends; joining may in turn join two runs into one. Runs
 * are found by their end and by their start position, one run per position, so a run that shares an end with a later one
 * is only reachable by its start. The runs come out in the order their ends were registered (a re-registered end moves
 * to the back), then those found only by start, then any arc that ended up in none as a run of its own.
 */
function stitch(topology: Topology, indices: number[]): number[][] {
  const { arcs: arcData, transform } = topology
  const dataOf = (index: number): Position[] => arcData[index < 0 ? ~index : index] as Position[]

  // arcs of one or two positions with no movement go first, since another arc may subsume them
  for (let j = 0, placed = -1; j < indices.length; j++) {
    const index = indices[j]!
    const arc = dataOf(index)
    if (arc.length < 3 && !arc[1]![0] && !arc[1]![1]) {
      const displaced = indices[++placed]!
      indices[placed] = index
      indices[j] = displaced
    }
  }

  /** The keys of an arc's first and last position, as walked (a negative index walks it backwards). */
  const ends = (index: number): [string, string] => {
    const arc = dataOf(index)
    const first = arc[0] as Position
    let last: Position
    if (transform) {
      // deltas: the last position is the sum of all of them
      last = [0, 0]
      for (const delta of arc) {
        last[0]! += delta[0]!
        last[1]! += delta[1]!
      }
    } else {
      last = arc[arc.length - 1] as Position
    }
    return index < 0 ? [keyOf(last), keyOf(first)] : [keyOf(first), keyOf(last)]
  }

  const byEnd = new Map<string, Run>()
  const byStart = new Map<string, Run>()
  const register = (run: Run): void => {
    byEnd.set(run.end, run)
    byStart.set(run.start, run)
  }

  for (const index of indices) {
    const [start, end] = ends(index)
    let run = byEnd.get(start)
    let other: Run | undefined
    if (run) {
      // extend a run that ends where this arc starts
      byEnd.delete(run.end)
      run.arcs.push(index)
      run.end = end
      if ((other = byStart.get(end))) {
        byStart.delete(other.start)
        register(other === run ? run : { arcs: run.arcs.concat(other.arcs), start: run.start, end: other.end })
      } else register(run)
    } else if ((run = byStart.get(end))) {
      // or one that starts where it ends
      byStart.delete(run.start)
      run.arcs.unshift(index)
      run.start = start
      if ((other = byEnd.get(start))) {
        byEnd.delete(other.end)
        register(other === run ? run : { arcs: other.arcs.concat(run.arcs), start: other.start, end: run.end })
      } else register(run)
    } else {
      register({ arcs: [index], start, end })
    }
  }

  const runs: number[][] = []
  const used = new Set<number>()
  const emit = (run: Run): void => {
    for (const index of run.arcs) used.add(index < 0 ? ~index : index)
    runs.push(run.arcs)
  }
  for (const run of byEnd.values()) {
    byStart.delete(run.start)
    emit(run)
  }
  // runs that lost their place in the table by end (another run ends at the same position) are still in the one by start
  for (const run of byStart.values()) emit(run)
  for (const index of indices) if (!used.has(index < 0 ? ~index : index)) runs.push([index])
  return runs
}

/**
 * `mesh(topology)`: every arc once, stitched. `mesh(topology, object, filter)`: the arcs of the object (or the named
 * object), optionally only those `filter` keeps (see `arcsOf`). A MultiLineString geometry.
 */
export function mesh(topology: Topology, object?: TopoObject | string, filter?: Filter): Geometry {
  const indices = object === undefined
    ? Array.from({ length: topology.arcs.length }, (_, i) => i)
    : arcsOf(resolveObject(topology, object), filter)
  const lines = decoder(topology)({ type: 'MultiLineString', arcs: stitch(topology, indices) })
  return lines as Geometry
}
