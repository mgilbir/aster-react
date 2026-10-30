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

/** How many events a stage handles per call of its loop body: a loop that runs long inside one call makes V8 compile it a second time. */
export const BATCH = 128

/** Buffers that have been given back, ready to be taken again (typed arrays cost microseconds to allocate). */
const free: Events[] = []
/** The recycled buffers hold at most this many events in all (about 3 MB); a buffer that does not fit is left to the garbage collector. */
const KEEP_EVENTS = 1 << 17
let keptEvents = 0

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

  /**
   * An empty buffer with room for at least `capacity` events (it still grows past that): a recycled one when
   * there is one. Hand it back with `release` once nothing reads it.
   */
  static take(capacity = 0): Events {
    const ev = free.pop()
    if (!ev) return new Events(Math.max(64, capacity))
    keptEvents -= ev.op.length
    ev.count = 0
    ev.onlyPoints = true
    if (ev.op.length < capacity) ev.grow(capacity)
    return ev
  }

  /** Give the buffer back for reuse. Neither the buffer nor any `Run` of it may be used afterwards. */
  release(): void {
    if (keptEvents + this.op.length <= KEEP_EVENTS) {
      keptEvents += this.op.length
      free.push(this)
    }
  }

  /** The number of events (the lists are longer: their tail is spare capacity). */
  get length(): number {
    return this.count
  }

  private grow(atLeast = 0): void {
    const capacity = Math.max(this.op.length * 2, atLeast)
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
    const c = Events.take(this.count)
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

/** Add the events of a geometry; false when its type is not one that is drawn. */
function addGeometry(out: Events, geometry: AnyObject | null | undefined): boolean {
  if (!geometry) return false
  const c = geometry.coordinates
  switch (geometry.type) {
    case 'Sphere':
      out.mark(SPHERE, out.length)
      return true
    case 'Point':
      addPoint(out, c)
      return true
    case 'MultiPoint':
      for (let i = 0; i < c.length; i++) addPoint(out, c[i])
      return true
    case 'LineString':
      addLine(out, c, 0)
      return true
    case 'MultiLineString':
      for (let i = 0; i < c.length; i++) addLine(out, c[i], 0)
      return true
    case 'Polygon':
      addPolygon(out, c)
      return true
    case 'MultiPolygon':
      for (let i = 0; i < c.length; i++) addPolygon(out, c[i])
      return true
    case 'GeometryCollection': {
      const parts = geometry.geometries
      for (let i = 0; i < parts.length; i++) addGeometry(out, parts[i])
      return true
    }
  }
  return false
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

/**
 * The same events as `eventsOf`, handed over one geometry at a time: each feature of a FeatureCollection,
 * each member of a GeometryCollection. A stage that sees the geometries one after another gives the results
 * it would for all of them at once, and never holds more than one geometry's events (the `src` of a chunk
 * counts from its own first event). `bare` says that `object` is a geometry, not a Feature or collection.
 */
export function forEachChunk(object: unknown, visit: (ev: Events) => void, bare = false): void {
  const o = object as AnyObject | null | undefined
  if (!o) return
  const wrapped = !bare && Object.hasOwn(OBJECT_TYPES, o.type)
  const features = wrapped && o.type !== 'Feature' ? o.features : null
  for (let k = 0, n = features ? features.length : 1; k < n; k++) {
    const geometry: AnyObject | null | undefined = features ? features[k].geometry : wrapped ? o.geometry : o
    if (!geometry) continue
    if (geometry.type === 'GeometryCollection') {
      const parts = geometry.geometries
      for (let i = 0; i < parts.length; i++) forEachChunk(parts[i], visit, true)
      continue
    }
    const ev = Events.take()
    if (geometry.type === 'Point') {
      // by far the commonest geometry of a map of events, and one point needs no walk through the type switch
      const c = geometry.coordinates
      ev.point(+c[0], +c[1], 0)
      visit(ev)
    } else if (addGeometry(ev, geometry)) visit(ev)
    else ev.release()
  }
}

/**
 * Interleave pipelines that ran over the same input: events are ordered by the input event they descend
 * from, and, within one input event, by pipeline. This is the order in which the pipelines would have
 * written to a shared output had every input event been pushed through all of them in turn.
 */
export function interleave(parts: readonly Events[]): Events {
  const out = Events.take(parts.reduce((n, part) => n + part.length, 0))
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
