/**
 * The geometry event buffer: what every stage of the geo engine reads and writes.
 *
 * A GeoJSON object is flattened once into a linear sequence of events (a point, the start or end of a
 * line, the start or end of a polygon, the whole sphere). Each stage of a projection (rotation, clipping,
 * resampling) is a pure function from one buffer to another, and the output stages (path string, planar
 * measures, spherical measures) are folds over the final buffer. Nothing is shared between stages, so a
 * stage can be tested alone and a buffer can feed several pipelines.
 *
 * Every event carries `src`: the index, in the buffer the flattening produced, of the event it descends
 * from. Stages keep it, which is what lets pipelines that run side by side over one geometry (the three
 * parts of the albersUsa composite) be interleaved again in the order the input events arrived.
 */

export const POINT = 0
export const LINE_START = 1
export const LINE_END = 2
export const POLYGON_START = 3
export const POLYGON_END = 4
export const SPHERE = 5

/** Buffers that have been given back, ready to be taken again (typed arrays cost microseconds to allocate). */
const free: Events[] = []
/** A buffer that grew past this many events is left to the garbage collector instead of being kept. */
const KEEP_CAPACITY = 1 << 16

export class Events {
  /** one entry per event, in four parallel lists: its kind, its coordinates (0 for events that have none), its `src` */
  op: Uint8Array
  x: Float64Array
  y: Float64Array
  src: Int32Array
  private count = 0
  /** no event so far is anything but a point: stages can take a shortcut */
  onlyPoints = true

  constructor(capacity = 64) {
    this.op = new Uint8Array(capacity)
    this.x = new Float64Array(capacity)
    this.y = new Float64Array(capacity)
    this.src = new Int32Array(capacity)
  }

  /** An empty buffer: a recycled one when there is one. Hand it back with `release` once nothing reads it. */
  static take(): Events {
    const ev = free.pop()
    if (!ev) return new Events()
    ev.count = 0
    ev.onlyPoints = true
    return ev
  }

  /** Give the buffer back for reuse. Neither the buffer nor any `Run` of it may be used afterwards. */
  release(): void {
    if (this.op.length <= KEEP_CAPACITY && free.length < 16) free.push(this)
  }

  /** The number of events (the lists are longer: their tail is spare capacity). */
  get length(): number {
    return this.count
  }

  private grow(): void {
    const capacity = this.op.length * 2
    const op = new Uint8Array(capacity)
    const x = new Float64Array(capacity)
    const y = new Float64Array(capacity)
    const src = new Int32Array(capacity)
    op.set(this.op)
    x.set(this.x)
    y.set(this.y)
    src.set(this.src)
    this.op = op
    this.x = x
    this.y = y
    this.src = src
  }

  point(x: number, y: number, src: number): void {
    if (this.count === this.op.length) this.grow()
    const i = this.count++
    this.op[i] = POINT
    this.x[i] = x
    this.y[i] = y
    this.src[i] = src
  }

  mark(op: number, src: number): void {
    if (this.count === this.op.length) this.grow()
    const i = this.count++
    this.op[i] = op
    this.x[i] = 0
    this.y[i] = 0
    this.src[i] = src
    this.onlyPoints = false
  }

  /** A copy that a stage can overwrite without disturbing the original. */
  copy(): Events {
    const c = Events.take()
    while (c.op.length < this.count) c.grow()
    c.op.set(this.op.subarray(0, this.count))
    c.x.set(this.x.subarray(0, this.count))
    c.y.set(this.y.subarray(0, this.count))
    c.src.set(this.src.subarray(0, this.count))
    c.count = this.count
    c.onlyPoints = this.onlyPoints
    return c
  }
}

/** The vertices of one line or ring: the points of an event buffer from index `from` up to (not including) `to`. */
export class Run {
  readonly x: Float64Array
  readonly y: Float64Array
  readonly src: Int32Array
  constructor(
    ev: Events,
    readonly from: number,
    readonly to: number,
  ) {
    this.x = ev.x
    this.y = ev.y
    this.src = ev.src
  }

  get length(): number {
    return this.to - this.from
  }
}

type Coordinate = ArrayLike<unknown>
type AnyObject = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** Own-property lookup: `type` comes from data, and `constructor` or `__proto__` must not select a handler. */
const handlerOf = <T>(table: Record<string, T>, type: unknown): T | undefined =>
  Object.hasOwn(table, type as string) ? table[type as string] : undefined

function addPoint(out: Events, c: Coordinate): void {
  out.point(+(c[0] as number), +(c[1] as number), out.length)
}

function addLine(out: Events, coordinates: ArrayLike<Coordinate>, dropLast: number): void {
  out.mark(LINE_START, out.length)
  const n = coordinates.length - dropLast
  for (let i = 0; i < n; i++) addPoint(out, coordinates[i]!)
  out.mark(LINE_END, out.length)
}

function addPolygon(out: Events, rings: ArrayLike<ArrayLike<Coordinate>>): void {
  out.mark(POLYGON_START, out.length)
  // a GeoJSON ring repeats its first position at the end; the event form leaves the repeat out
  for (let i = 0; i < rings.length; i++) addLine(out, rings[i]!, 1)
  out.mark(POLYGON_END, out.length)
}

const GEOMETRIES: Record<string, (g: AnyObject, out: Events) => void> = {
  Sphere: (_, out) => out.mark(SPHERE, out.length),
  Point: (g, out) => addPoint(out, g.coordinates),
  MultiPoint: (g, out) => {
    const points = g.coordinates
    for (let i = 0; i < points.length; i++) addPoint(out, points[i])
  },
  LineString: (g, out) => addLine(out, g.coordinates, 0),
  MultiLineString: (g, out) => {
    const lines = g.coordinates
    for (let i = 0; i < lines.length; i++) addLine(out, lines[i], 0)
  },
  Polygon: (g, out) => addPolygon(out, g.coordinates),
  MultiPolygon: (g, out) => {
    const polygons = g.coordinates
    for (let i = 0; i < polygons.length; i++) addPolygon(out, polygons[i])
  },
  GeometryCollection: (g, out) => {
    const parts = g.geometries
    for (let i = 0; i < parts.length; i++) addGeometry(out, parts[i])
  },
}

function addGeometry(out: Events, geometry: AnyObject | null | undefined): void {
  if (geometry) handlerOf(GEOMETRIES, geometry.type)?.(geometry, out)
}

/**
 * The events of a GeoJSON geometry, Feature or FeatureCollection (only a FeatureCollection's features
 * are looked into, and only their `geometry`). Anything else yields no events.
 */
export function eventsOf(object: unknown): Events {
  const out = Events.take()
  const o = object as AnyObject | null | undefined
  if (o) {
    if (Object.hasOwn(OBJECT_TYPES, o.type)) {
      if (o.type === 'Feature') addGeometry(out, o.geometry)
      else {
        const features = o.features
        for (let i = 0; i < features.length; i++) addGeometry(out, features[i].geometry)
      }
    } else addGeometry(out, o)
  }
  return out
}

const OBJECT_TYPES = { Feature: true, FeatureCollection: true }

function chunkGeometry(geometry: AnyObject | null | undefined, visit: (ev: Events) => void): void {
  if (!geometry) return
  const handler = handlerOf(GEOMETRIES, geometry.type)
  if (!handler) return
  if (geometry.type === 'GeometryCollection') {
    const parts = geometry.geometries
    for (let i = 0; i < parts.length; i++) chunkGeometry(parts[i], visit)
    return
  }
  const ev = Events.take()
  handler(geometry, ev)
  visit(ev)
}

/**
 * The same events as `eventsOf`, handed over one geometry at a time: each feature of a FeatureCollection,
 * each member of a GeometryCollection. A stage that sees the geometries one after another gives the results
 * it would for all of them at once, and never holds more than one geometry's events (the `src` of a chunk
 * counts from its own first event).
 */
export function forEachChunk(object: unknown, visit: (ev: Events) => void): void {
  const o = object as AnyObject | null | undefined
  if (!o) return
  if (Object.hasOwn(OBJECT_TYPES, o.type)) {
    if (o.type === 'Feature') chunkGeometry(o.geometry, visit)
    else {
      const features = o.features
      for (let i = 0; i < features.length; i++) chunkGeometry(features[i].geometry, visit)
    }
  } else chunkGeometry(o, visit)
}

/**
 * Interleave pipelines that ran over the same input: events are ordered by the input event they descend
 * from, and, within one input event, by pipeline. This is the order in which the pipelines would have
 * written to a shared output had every input event been pushed through all of them in turn.
 */
export function interleave(parts: readonly Events[]): Events {
  const out = Events.take()
  const at = parts.map(() => 0)
  for (;;) {
    let best = -1
    let bestSrc = Infinity
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k]!
      if (at[k]! < part.length && part.src[at[k]!]! < bestSrc) {
        best = k
        bestSrc = part.src[at[k]!]!
      }
    }
    if (best < 0) return out
    const part = parts[best]!
    const i = at[best]!++
    if (part.op[i]! === POINT) out.point(part.x[i]!, part.y[i]!, bestSrc)
    else out.mark(part.op[i]!, bestSrc)
  }
}
