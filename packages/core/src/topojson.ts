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

export interface TopoObject {
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
  const objects = topology.objects as unknown
  if (objects === null || typeof objects !== 'object' || !Object.hasOwn(objects, object)) throw new Error(`[aster] topojson object "${object}" not found`)
  const o = (objects as Record<string, unknown>)[object]
  if (o === null || typeof o !== 'object') throw malformed(`object "${object}" is not a geometry object`)
  return o as TopoObject
}

// -- what the decoder reads, checked as it reads it -------------------------------------------------------------------
//
// A topology is data from a url or a spec: one that does not have the shape TopoJSON defines is an `[aster] topojson: ...`
// error naming what is wrong, never a raw TypeError from deep inside the decoder, and an arc index is checked before it
// sizes anything (an index of 4e9 must not make a walk over 4e9 slots).

function malformed(what: string): Error {
  return new Error(`[aster] topojson: ${what}`)
}

/** `v` as a list, or a malformed-topology error naming `what`. */
function listOf<T>(v: unknown, what: string): T[] {
  if (!Array.isArray(v)) throw malformed(`${what} must be an array`)
  return v as T[]
}

/** The arc list of a topology. */
function arcsOfTopology(topology: Topology): number[][][] {
  return listOf<number[][]>(topology.arcs, 'the topology\'s "arcs"')
}

/** The array position of a signed arc index (`~i` for arc `i` walked backwards), checked against the arcs there are. */
function arcSlot(index: unknown, count: number): number {
  if (typeof index !== 'number' || !Number.isInteger(index)) throw malformed(`an arc index must be an integer, got ${JSON.stringify(index) ?? String(index)}`)
  const slot = index < 0 ? ~index : index
  if (slot >= count) throw malformed(`arc index ${index} refers to arc ${slot}, but the topology has ${count} arcs`)
  return slot
}

/**
 * A reader of the arcs by signed index: each arc a list (of positions; a list of fewer than two decodes as upstream decodes it,
 * and only the mesh's stitching, which reads an arc's second position, needs two). Each position is checked where it is read
 * ({@link position}): a second pass over the arc would cost as much as decoding it.
 */
function arcReader(arcs: readonly unknown[], minLength = 0): (index: unknown) => Position[] {
  const count = arcs.length
  return (index) => {
    // (arcSlot, with the common case inline: this is read once per arc a geometry refers to)
    const slot = typeof index === 'number' && index >= 0 && index < count && (index | 0) === index ? index : arcSlot(index, count)
    const arc = arcs[slot]
    if (!Array.isArray(arc) || arc.length < minLength) {
      throw malformed(minLength ? `arc ${slot} must be a list of at least ${minLength} positions` : `arc ${slot} must be a list`)
    }
    return arc as Position[]
  }
}

/**
 * A position as read from an arc. A delta-encoded one is read by index, so anything but null or undefined decodes (a value that
 * is not a list to NaN, as upstream); a plain one is copied, so it must be a list.
 */
function position(p: unknown, copied = false): Position {
  if (p == null || (copied && !Array.isArray(p))) throw malformed(`a position must be a list, got ${JSON.stringify(p) ?? String(p)}`)
  return p as Position
}

/** A topology's transform, when it has one: a `scale` and a `translate`, each two numbers. */
function transformOf(topology: Topology): Transform | undefined {
  const t = topology.transform as unknown
  if (t == null) return undefined
  const pair = (v: unknown): boolean => Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number'
  if (typeof t !== 'object' || !pair((t as Transform).scale) || !pair((t as Transform).translate)) {
    throw malformed('a transform needs "scale" and "translate", each a pair of numbers')
  }
  return t as Transform
}

// -- geometry -------------------------------------------------------------------------------------------------------

/** The position(s) of arc data in absolute coordinates, as fresh arrays. */
function decodePositions(positions: readonly Position[], transform: Transform | undefined): Position[] {
  const n = positions.length
  const out = new Array<Position>(n)
  if (!transform) {
    for (let i = 0; i < n; i++) out[i] = position(positions[i], true).slice()
    return out
  }
  const kx = transform.scale[0]
  const ky = transform.scale[1]
  const dx = transform.translate[0]
  const dy = transform.translate[1]
  let x = 0
  let y = 0
  for (let i = 0; i < n; i++) {
    const p = position(positions[i])
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
    if (p == null) position(p)
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
  const arcAt = arcReader(arcsOfTopology(topology))
  const transform = transformOf(topology)
  let decoded = 0

  /** Append arc `index` (negative: backwards) to `points`, which already holds the line so far. */
  function appendArc(points: Position[], index: number): void {
    // the joint is the previous arc's last position and this arc's first: keep one
    if (points.length) points.pop()
    const raw = arcAt(index)
    // one arc can be referenced from any number of geometries, so the decoded size is not bounded by the input's
    meterCoords(raw.length, 'topojson arcs', (decoded += raw.length))
    const first = points.length
    if (transform) appendTransformed(points, raw, transform)
    else for (let i = 0; i < raw.length; i++) points.push(position(raw[i], true).slice())
    if (index < 0) reverseTail(points, first)
  }

  function line(indices: unknown): Position[] {
    const points: Position[] = []
    for (const index of listOf<number>(indices, 'a line\'s "arcs"')) appendArc(points, index)
    if (points.length < 2) points.push(points[0] as Position)
    return points
  }

  function ring(indices: unknown): Position[] {
    const points = line(indices)
    while (points.length < 4) points.push(points[0] as Position)
    return points
  }

  const polygon = (rings: unknown): Position[][] => listOf<number[]>(rings, 'a polygon\'s "arcs"').map(ring)
  /** A point geometry's position is absolute (scaled and shifted), not a delta from another position. */
  const point = (p: unknown): Position => decodePositions([listOf<number>(p, 'a point\'s position')], transform)[0]!

  function geometry(o: TopoObject): Geometry | null {
    const type = o.type
    switch (type) {
      case 'GeometryCollection': return { type, geometries: geometriesOf(o).map(geometry) }
      case 'Point': return { type, coordinates: point(o.coordinates) }
      case 'MultiPoint': return { type, coordinates: listOf<Position>(o.coordinates, 'a MultiPoint\'s "coordinates"').map(point) }
      case 'LineString': return { type, coordinates: line(o.arcs) }
      case 'MultiLineString': return { type, coordinates: listOf<number[]>(o.arcs, 'a MultiLineString\'s "arcs"').map(line) }
      case 'Polygon': return { type, coordinates: polygon(o.arcs) }
      case 'MultiPolygon': return { type, coordinates: listOf<number[][]>(o.arcs, 'a MultiPolygon\'s "arcs"').map(polygon) }
      default: return null
    }
  }
  return geometry
}

/** The members of a GeometryCollection, each a geometry object. */
function geometriesOf(o: TopoObject): TopoObject[] {
  const list = listOf<TopoObject>(o.geometries, 'a GeometryCollection\'s "geometries"')
  for (const g of list) if (g === null || typeof g !== 'object') throw malformed('a GeometryCollection has a member that is not a geometry object')
  return list
}

// -- feature --------------------------------------------------------------------------------------------------------

function featureOf(o: TopoObject, geometry: (o: TopoObject) => Geometry | null): Feature {
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
    ? { type: 'FeatureCollection', features: geometriesOf(o).map((g) => featureOf(g, geometry)) }
    : featureOf(o, geometry)
}

// -- mesh -----------------------------------------------------------------------------------------------------------

/** Which arcs a mesh keeps: called with the first and the last geometry object that use an arc. */
export type MeshFilter = (a: TopoObject, b: TopoObject) => boolean

/**
 * The arcs a geometry uses, one entry per arc in ascending arc index: the arc as first referenced (its sign says which
 * way) and, if `filter` is given, kept only when `filter(first geometry using it, last geometry using it)` holds. With
 * the usual `a !== b` that keeps the arcs shared by two different shapes (interior borders); with `a === b` the arcs
 * used by one shape only (the outline).
 */
function arcsOf(root: TopoObject, filter: MeshFilter | undefined, arcCount: number): number[] {
  const first: number[] = []
  const firstGeometry: TopoObject[] = []
  const lastGeometry: TopoObject[] = []
  let current: TopoObject

  const note = (index: unknown): void => {
    // (checked before it sizes the tables: an index past the arcs there are is an error, not a walk over that many slots)
    const arc = arcSlot(index, arcCount)
    if (firstGeometry[arc] === undefined) {
      first[arc] = index as number
      firstGeometry[arc] = current
    }
    lastGeometry[arc] = current
  }
  const visit = (o: TopoObject): void => {
    current = o
    switch (o.type) {
      case 'GeometryCollection': geometriesOf(o).forEach(visit); break
      case 'LineString': listOf<number>(o.arcs, 'a LineString\'s "arcs"').forEach(note); break
      case 'MultiLineString': case 'Polygon':
        listOf<unknown>(o.arcs, `a ${o.type}'s "arcs"`).forEach((a) => listOf<number>(a, `a ${o.type}'s "arcs"`).forEach(note)); break
      case 'MultiPolygon':
        listOf<unknown>(o.arcs, 'a MultiPolygon\'s "arcs"').forEach((p) => listOf<unknown>(p, 'a MultiPolygon\'s "arcs"').forEach((a) => listOf<number>(a, 'a MultiPolygon\'s "arcs"').forEach(note))); break
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
  const dataOf = arcReader(arcsOfTopology(topology), 2)
  const transform = transformOf(topology)

  // arcs of one or two positions with no movement go first, since another arc may subsume them
  for (let j = 0, placed = -1; j < indices.length; j++) {
    const index = indices[j]!
    const arc = dataOf(index)
    if (arc.length < 3 && !position(arc[1])[0] && !arc[1]![1]) {
      const displaced = indices[++placed]!
      indices[placed] = index
      indices[j] = displaced
    }
  }

  /** The keys of an arc's first and last position, as walked (a negative index walks it backwards). */
  const ends = (index: number): [string, string] => {
    const arc = dataOf(index)
    const first = position(arc[0])
    let last: Position
    if (transform) {
      // deltas: the last position is the sum of all of them
      last = [0, 0]
      for (const d of arc) {
        const delta = position(d)
        last[0]! += delta[0]!
        last[1]! += delta[1]!
      }
    } else {
      last = position(arc[arc.length - 1])
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
export function mesh(topology: Topology, object?: TopoObject | string, filter?: MeshFilter): Geometry {
  const arcCount = arcsOfTopology(topology).length
  const indices = object === undefined
    ? Array.from({ length: arcCount }, (_, i) => i)
    : arcsOf(resolveObject(topology, object), filter, arcCount)
  const lines = decoder(topology)({ type: 'MultiLineString', arcs: stitch(topology, indices) })
  return lines as Geometry
}
