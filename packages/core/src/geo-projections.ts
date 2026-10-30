/**
 * Map projections as objects: a raw projection (geo-raw.ts) with the state that places it on the page
 * (scale, translation, centre, rotation, reflection, clipping, resampling precision), the composite
 * Albers USA projection, and the planar identity projection.
 *
 * A projection offers two ways to use it. `project` / `invert` map one position. `planar` maps a whole
 * geometry event buffer: rotate the sphere, clip to the visible part, project with adaptive resampling,
 * clip to the screen rectangle. A `GeoPath` draws and measures through `planar`.
 *
 * What the state is, and how it is applied, follows the reference d3-geo projection so that the results
 * match it exactly. In particular the clip rectangle of a cylindrical projection is recomputed when the
 * scale, translation, centre or clip extent changes but not when the rotation does, and a fit leaves the
 * clip extent as it found it.
 */
import { Events, POINT, SPHERE, forEachChunk, interleave } from './geo-events.js'
import { Rectangle, CircleClipper, antimeridian, clipToSphere, type SphereClipper } from './geo-clip.js'
import { BoundsBox, GeoPath, type PlanarSource } from './geo-path.js'
import {
  azimuthalEqualAreaRaw, azimuthalEquidistantRaw, conicConformalRaw, conicEqualAreaRaw, conicEquidistantRaw,
  equalEarthRaw, equirectangularRaw, gnomonicRaw, mercatorRaw, mollweideRaw, naturalEarth1Raw, orthographicRaw,
  stereographicRaw, transverseMercatorRaw, type RawProjection,
} from './geo-raw.js'
import { resample } from './geo-resample.js'
import { DEGREES, EPSILON, PI, RADIANS, Rotation, TAU, rotationOrigin } from './geo-sphere.js'

type Extent = [[number, number], [number, number]]
type Params = Record<string, unknown>

/** What the rest of the engine knows about a projection. */
export interface GeoProjection extends PlanarSource {
  /** the registry name the projection was made under */
  type: string
  readonly path: GeoPath
  readonly scale: number
  readonly translate: [number, number]
  /** Apply the parameters of a vega projection definition that this projection has, in vega's order. */
  configure(params: Params): void
  /** The planar position of a longitude/latitude (degrees); null when the projection leaves it out. */
  project(lon: number, lat: number): [number, number] | null
  /** The longitude/latitude (degrees) at a planar position. */
  invert(x: number, y: number): [number, number]
  fitExtent(extent: number[][], object: unknown): void
  fitSize(size: number[], object: unknown): void
  fitWidth(width: number, object: unknown): void
  fitHeight(height: number, object: unknown): void
}

/** The properties of a projection definition that vega applies, in the order it applies them. */
const APPLIED = ['clipAngle', 'clipExtent', 'scale', 'translate', 'center', 'rotate', 'parallels', 'precision', 'reflectX', 'reflectY'] as const

/** Behaviour shared by all projections: the path they draw with, and fitting to data. */
abstract class Projection implements GeoProjection {
  type = ''
  readonly path: GeoPath = new GeoPath(this)

  abstract get scale(): number
  abstract get translate(): [number, number]
  abstract planar(ev: Events): Events
  abstract project(lon: number, lat: number): [number, number] | null
  abstract invert(x: number, y: number): [number, number]
  abstract configure(params: Params): void
  protected abstract setScale(k: unknown): void
  protected abstract setTranslate(t: ArrayLike<unknown>): void
  /** The clip extent as last set, `null` for none; `undefined` if the projection cannot be clipped to an extent. */
  protected clipExtentOrNothing(): Extent | null | undefined {
    return undefined
  }
  protected setClipExtent(_extent: ArrayLike<ArrayLike<unknown>> | null): void {}

  /**
   * Fit the projection to `object`: project it at a reference scale with no clipping to the screen, then
   * have `place` choose the scale and translation from the projected bounds.
   */
  private fit(object: unknown, place: (bounds: number[][]) => void): void {
    const clip = this.clipExtentOrNothing()
    this.setScale(150)
    this.setTranslate([0, 0])
    if (clip != null) this.setClipExtent(null)
    const box = new BoundsBox()
    forEachChunk(object, (ev) => {
      const planar = this.planar(ev)
      box.add(planar)
      planar.release()
    })
    place(box.result())
    if (clip != null) this.setClipExtent(clip)
  }

  fitExtent(extent: number[][], object: unknown): void {
    this.fit(object, (b) => {
      const w = extent[1]![0]! - extent[0]![0]!
      const h = extent[1]![1]! - extent[0]![1]!
      const k = Math.min(w / (b[1]![0]! - b[0]![0]!), h / (b[1]![1]! - b[0]![1]!))
      const x = +extent[0]![0]! + (w - k * (b[1]![0]! + b[0]![0]!)) / 2
      const y = +extent[0]![1]! + (h - k * (b[1]![1]! + b[0]![1]!)) / 2
      this.setScale(150 * k)
      this.setTranslate([x, y])
    })
  }

  fitSize(size: number[], object: unknown): void {
    this.fitExtent([[0, 0], size], object)
  }

  fitWidth(width: number, object: unknown): void {
    this.fit(object, (b) => {
      const w = +width
      const k = w / (b[1]![0]! - b[0]![0]!)
      const x = (w - k * (b[1]![0]! + b[0]![0]!)) / 2
      const y = -k * b[0]![1]!
      this.setScale(150 * k)
      this.setTranslate([x, y])
    })
  }

  fitHeight(height: number, object: unknown): void {
    this.fit(object, (b) => {
      const h = +height
      const k = h / (b[1]![1]! - b[0]![1]!)
      const x = -k * b[0]![0]!
      const y = (h - k * (b[1]![1]! + b[0]![1]!)) / 2
      this.setScale(150 * k)
      this.setTranslate([x, y])
    })
  }
}

/** How a conic projection is built from its two standard parallels (radians). */
type ConicBuilder = (phi0: number, phi1: number) => RawProjection

/** Options of a spherical projection. */
interface SphericalOptions {
  /** the projection takes standard parallels */
  conic?: ConicBuilder
  /**
   * A cylindrical projection whose clip rectangle follows the visible world: `across` is the plane axis
   * along which the world is cut, and `quarterTurn` that the user-facing centre and rotation are turned
   * a quarter turn from the raw projection's own.
   */
  cylinder?: { across: 'x' | 'y'; quarterTurn: boolean }
}

const scratch: number[] = [0, 0]

/** A projection of the sphere: raw projection, rotation, clipping, resampling, scale and translation. */
class SphericalProjection extends Projection {
  private k = 150
  private tx = 480
  private ty = 250
  /** the centre of the map, radians */
  private lambda = 0
  private phi = 0
  /** the rotation of the sphere, radians */
  private rotLambda = 0
  private rotPhi = 0
  private rotGamma = 0
  private sx = 1
  private sy = 1
  private theta: number | null = null
  private clipper: SphereClipper = antimeridian
  private extent: Extent | null = null
  private rect: Rectangle | null = null
  /** squared resampling precision */
  private delta2 = 0.5
  private phi0 = 0
  private phi1 = PI / 3
  // derived by recenter()
  private rotation = new Rotation(0, 0, 0)
  private dx = 0
  private dy = 0
  private readonly mapPlanar = (lambda: number, phi: number, out: number[]): void => {
    this.raw.forward(lambda, phi, out)
    const x = out[0]! * this.sx
    const y = out[1]! * this.sy
    out[0] = this.dx + this.k * x
    out[1] = this.dy - this.k * y
  }

  constructor(
    private raw: RawProjection,
    private readonly options: SphericalOptions = {},
  ) {
    super()
    this.recenter()
    if (options.cylinder) this.reclip()
  }

  /** Recompute what depends on scale, translation, centre, rotation and reflection. */
  private recenter(): void {
    const { k, sx, sy } = this
    this.raw.forward(this.lambda, this.phi, scratch)
    // the page position of the map centre when nothing is translated
    const cx = 0 + k * (scratch[0]! * sx)
    const cy = 0 - k * (scratch[1]! * sy)
    this.dx = this.tx - cx
    this.dy = this.ty - cy
    this.rotation = new Rotation(this.rotLambda, this.rotPhi, this.rotGamma)
  }

  /** Unrotated sphere position (radians) to page position: the raw projection, then scale and translate. */
  private projectAffine(lambda: number, phi: number, out: number[]): void {
    this.raw.forward(lambda, phi, out)
    const x = out[0]! * this.sx
    const y = out[1]! * this.sy
    out[0] = this.dx + this.k * x
    out[1] = this.dy - this.k * y
  }

  /** Keep a cylindrical projection's clip rectangle to the part of the page the world covers. */
  private reclip(): void {
    const { across, quarterTurn } = this.options.cylinder!
    const k = PI * this.k
    const visibleRotate = [this.rotLambda * DEGREES, this.rotPhi * DEGREES, this.rotGamma * DEGREES - (quarterTurn ? 90 : 0)]
    const at = rotationOrigin(visibleRotate)
    const t = this.project(at[0], at[1])!
    const e = this.extent
    const clip: number[][] =
      e == null
        ? [[t[0] - k, t[1] - k], [t[0] + k, t[1] + k]]
        : across === 'x'
          ? [[Math.max(t[0] - k, e[0][0]), e[0][1]], [Math.min(t[0] + k, e[1][0]), e[1][1]]]
          : [[e[0][0], Math.max(t[1] - k, e[0][1])], [e[1][0], Math.min(t[1] + k, e[1][1])]]
    this.rect = new Rectangle(+clip[0]![0]!, +clip[0]![1]!, +clip[1]![0]!, +clip[1]![1]!)
  }

  private afterPlacement(): void {
    this.recenter()
    if (this.options.cylinder) this.reclip()
  }

  /* ---- reading the state ----------------------------------------------------------------------- */

  get scale(): number {
    return this.k
  }
  get translate(): [number, number] {
    return [this.tx, this.ty]
  }
  get center(): [number, number] {
    const c: [number, number] = [this.lambda * DEGREES, this.phi * DEGREES]
    return this.options.cylinder?.quarterTurn ? [c[1], -c[0]] : c
  }
  get rotate(): [number, number, number] {
    return [this.rotLambda * DEGREES, this.rotPhi * DEGREES, this.rotGamma * DEGREES - (this.options.cylinder?.quarterTurn ? 90 : 0)]
  }
  get clipAngle(): number {
    return (this.theta as number) * DEGREES
  }
  get clipExtent(): Extent | null {
    return this.extent && [[this.extent[0][0], this.extent[0][1]], [this.extent[1][0], this.extent[1][1]]]
  }
  get precision(): number {
    return Math.sqrt(this.delta2)
  }
  get parallels(): [number, number] | undefined {
    return this.options.conic ? [this.phi0 * DEGREES, this.phi1 * DEGREES] : undefined
  }
  get reflectX(): boolean {
    return this.sx < 0
  }
  get reflectY(): boolean {
    return this.sy < 0
  }

  /* ---- changing the state ---------------------------------------------------------------------- */

  setClipAngle(angle: unknown): void {
    if (+(angle as number)) {
      this.theta = (angle as number) * RADIANS
      this.clipper = new CircleClipper(this.theta)
    } else {
      this.theta = null
      this.clipper = antimeridian
    }
  }

  protected override setClipExtent(extent: ArrayLike<ArrayLike<unknown>> | null): void {
    if (extent == null) {
      this.extent = null
      this.rect = null
    } else {
      const x0 = +(extent[0]![0] as number)
      const y0 = +(extent[0]![1] as number)
      const x1 = +(extent[1]![0] as number)
      const y1 = +(extent[1]![1] as number)
      this.extent = [[x0, y0], [x1, y1]]
      this.rect = new Rectangle(x0, y0, x1, y1)
    }
    if (this.options.cylinder) this.reclip()
  }

  protected override clipExtentOrNothing(): Extent | null {
    return this.clipExtent
  }

  setScale(k: unknown): void {
    this.k = +(k as number)
    this.afterPlacement()
  }

  setTranslate(t: ArrayLike<unknown>): void {
    this.tx = +(t[0] as number)
    this.ty = +(t[1] as number)
    this.afterPlacement()
  }

  setCenter(c: ArrayLike<number>): void {
    const [lon, lat] = this.options.cylinder?.quarterTurn ? [-c[1]!, c[0]!] : [c[0]!, c[1]!]
    this.lambda = (lon % 360) * RADIANS
    this.phi = (lat % 360) * RADIANS
    this.afterPlacement()
  }

  setRotate(r: ArrayLike<number>): void {
    const quarter = this.options.cylinder?.quarterTurn
    const v = quarter ? [r[0]!, r[1]!, r.length > 2 ? r[2]! + 90 : 90] : r
    this.rotLambda = (v[0]! % 360) * RADIANS
    this.rotPhi = (v[1]! % 360) * RADIANS
    this.rotGamma = v.length > 2 ? (v[2]! % 360) * RADIANS : 0
    this.recenter()
  }

  setParallels(p: ArrayLike<number>): void {
    this.phi0 = p[0]! * RADIANS
    this.phi1 = p[1]! * RADIANS
    this.raw = this.options.conic!(this.phi0, this.phi1)
    this.recenter()
  }

  setPrecision(p: number): void {
    this.delta2 = p * p
  }

  setReflect(x: boolean | undefined, y: boolean | undefined): void {
    if (x !== undefined) this.sx = x ? -1 : 1
    if (y !== undefined) this.sy = y ? -1 : 1
    this.recenter()
  }

  /** Cylindrical projections only: set the clip extent and recompute the clip rectangle. */
  setExtentOf(extent: ArrayLike<ArrayLike<unknown>> | null): void {
    this.setClipExtent(extent)
  }

  configure(params: Params): void {
    for (const key of APPLIED) {
      const v = params[key]
      if (v == null) continue
      switch (key) {
        case 'clipAngle':
          this.setClipAngle(v)
          break
        case 'clipExtent':
          this.setClipExtent(v as number[][])
          break
        case 'scale':
          this.setScale(v)
          break
        case 'translate':
          this.setTranslate(v as number[])
          break
        case 'center':
          this.setCenter(v as number[])
          break
        case 'rotate':
          this.setRotate(v as number[])
          break
        case 'parallels':
          if (this.options.conic) this.setParallels(v as number[])
          break
        case 'precision':
          this.setPrecision(v as number)
          break
        case 'reflectX':
          this.setReflect(!!v, undefined)
          break
        case 'reflectY':
          this.setReflect(undefined, !!v)
          break
      }
    }
  }

  /* ---- projecting ------------------------------------------------------------------------------ */

  project(lon: number, lat: number): [number, number] {
    const at = [0, 0]
    this.rotation.forward(lon * RADIANS, lat * RADIANS, at)
    this.projectAffine(at[0]!, at[1]!, at)
    return [at[0]!, at[1]!]
  }

  /** The position, if it survives clipping to the visible sphere and the screen rectangle. */
  projectVisible(lon: number, lat: number): [number, number] | null {
    const at = [0, 0]
    this.rotation.forward(lon * RADIANS, lat * RADIANS, at)
    if (!this.clipper.visible(at[0]!, at[1]!)) return null
    this.projectAffine(at[0]!, at[1]!, at)
    return !this.rect || this.rect.contains(at[0]!, at[1]!) ? [at[0]!, at[1]!] : null
  }

  invert(x: number, y: number): [number, number] {
    const { k, dx, dy, sx, sy } = this
    const inverse = this.raw.inverse!
    const at = [0, 0]
    inverse(((x - dx) / k) * sx, ((dy - y) / k) * sy, at)
    this.rotation.inverse(at[0]!, at[1]!, at)
    return [at[0]! * DEGREES, at[1]! * DEGREES]
  }

  planar(ev: Events): Events {
    if (ev.onlyPoints) return this.planarPoints(ev, scratch)
    // the rotation overwrites the events: `planar` takes ownership of its input
    this.rotation.rotateEvents(ev)
    const clipped = clipToSphere(ev, this.clipper)
    ev.release()
    const projected = resample(clipped, this.mapPlanar, this.delta2)
    clipped.release()
    if (!this.rect) return projected
    const out = this.rect.clip(projected)
    projected.release()
    return out
  }

  /** Geometry that is only points passes each stage independently, so the stages fold into one loop. */
  private planarPoints(ev: Events, at: number[]): Events {
    const out = Events.take(ev.length)
    for (let i = 0; i < ev.length; i++) {
      this.rotation.forward(ev.x[i]! * RADIANS, ev.y[i]! * RADIANS, at)
      if (!this.clipper.visible(at[0]!, at[1]!)) continue
      this.projectAffine(at[0]!, at[1]!, at)
      if (this.rect && !this.rect.contains(at[0]!, at[1]!)) continue
      out.point(at[0]!, at[1]!, ev.src[i]!)
    }
    ev.release()
    return out
  }
}

/** The three projections of the Albers USA composite sit side by side; each draws its own region. */
class AlbersUsa extends Projection {
  private readonly lower48 = newAlbers()
  private readonly alaska = newConicEqualArea()
  private readonly hawaii = newConicEqualArea()
  private readonly pointProjections: SphericalProjection[]

  constructor() {
    super()
    this.alaska.setRotate([154, 0])
    this.alaska.setCenter([-2, 58.5])
    this.alaska.setParallels([55, 65])
    this.hawaii.setRotate([157, 0])
    this.hawaii.setCenter([-3, 19.9])
    this.hawaii.setParallels([8, 18])
    this.pointProjections = [this.lower48, this.alaska, this.hawaii]
    this.setScale(1070)
  }

  get scale(): number {
    return this.lower48.scale
  }
  get translate(): [number, number] {
    return this.lower48.translate
  }
  get precision(): number {
    return this.lower48.precision
  }

  protected setScale(k: unknown): void {
    this.lower48.setScale(k)
    this.alaska.setScale((k as number) * 0.35)
    this.hawaii.setScale(k)
    this.setTranslate(this.lower48.translate)
  }

  protected setTranslate(t: ArrayLike<unknown>): void {
    const k = this.lower48.scale
    const x = +(t[0] as number)
    const y = +(t[1] as number)
    this.lower48.setTranslate(t)
    this.lower48.setExtentOf([[x - 0.455 * k, y - 0.238 * k], [x + 0.455 * k, y + 0.238 * k]])
    this.alaska.setTranslate([x - 0.307 * k, y + 0.201 * k])
    this.alaska.setExtentOf([
      [x - 0.425 * k + EPSILON, y + 0.12 * k + EPSILON],
      [x - 0.214 * k - EPSILON, y + 0.234 * k - EPSILON],
    ])
    this.hawaii.setTranslate([x - 0.205 * k, y + 0.212 * k])
    this.hawaii.setExtentOf([
      [x - 0.214 * k + EPSILON, y + 0.166 * k + EPSILON],
      [x - 0.115 * k - EPSILON, y + 0.234 * k - EPSILON],
    ])
  }

  configure(params: Params): void {
    for (const key of APPLIED) {
      const v = params[key]
      if (v == null) continue
      if (key === 'scale') this.setScale(v)
      else if (key === 'translate') this.setTranslate(v as number[])
      else if (key === 'precision') for (const p of this.pointProjections) p.setPrecision(v as number)
    }
  }

  project(lon: number, lat: number): [number, number] | null {
    for (const p of this.pointProjections) {
      const at = p.projectVisible(lon, lat)
      if (at) return at
    }
    return null
  }

  invert(x: number, y: number): [number, number] {
    const k = this.lower48.scale
    const t = this.lower48.translate
    const u = (x - t[0]) / k
    const v = (y - t[1]) / k
    return (
      v >= 0.12 && v < 0.234 && u >= -0.425 && u < -0.214
        ? this.alaska
        : v >= 0.166 && v < 0.234 && u >= -0.214 && u < -0.115
          ? this.hawaii
          : this.lower48
    ).invert(x, y)
  }

  planar(ev: Events): Events {
    // each part consumes the events it is given: all but the first get their own copy
    const parts = this.pointProjections
    const copies = parts.map((_, k) => (k === 0 ? ev : ev.copy()))
    const results = parts.map((part, k) => part.planar(copies[k]!))
    const nonEmpty = results.filter((r) => r.length > 0)
    // most geometry lies in one region: its part's output is then the answer, with nothing to interleave
    if (nonEmpty.length <= 1) {
      const keep = nonEmpty[0] ?? results[0]!
      for (const r of results) if (r !== keep) r.release()
      return keep
    }
    const merged = interleave(results)
    for (const r of results) r.release()
    return merged
  }
}

/** The planar identity projection: scale, translate and reflect coordinates that are already planar. */
class IdentityProjection extends Projection {
  private k = 1
  private tx = 0
  private ty = 0
  private sx = 1
  private sy = 1
  private extent: Extent | null = null
  private rect: Rectangle | null = null

  get scale(): number {
    return this.k
  }
  get translate(): [number, number] {
    return [this.tx, this.ty]
  }
  get clipExtent(): Extent | null {
    return this.extent && [[this.extent[0][0], this.extent[0][1]], [this.extent[1][0], this.extent[1][1]]]
  }
  get reflectX(): boolean {
    return this.sx < 0
  }
  get reflectY(): boolean {
    return this.sy < 0
  }

  protected setScale(k: unknown): void {
    this.k = +(k as number)
  }
  protected setTranslate(t: ArrayLike<unknown>): void {
    this.tx = +(t[0] as number)
    this.ty = +(t[1] as number)
  }
  protected override clipExtentOrNothing(): Extent | null {
    return this.clipExtent
  }
  protected override setClipExtent(extent: ArrayLike<ArrayLike<unknown>> | null): void {
    if (extent == null) {
      this.extent = null
      this.rect = null
      return
    }
    const x0 = +(extent[0]![0] as number)
    const y0 = +(extent[0]![1] as number)
    const x1 = +(extent[1]![0] as number)
    const y1 = +(extent[1]![1] as number)
    this.extent = [[x0, y0], [x1, y1]]
    this.rect = new Rectangle(x0, y0, x1, y1)
  }

  configure(params: Params): void {
    for (const key of APPLIED) {
      const v = params[key]
      if (v == null) continue
      if (key === 'clipExtent') this.setClipExtent(v as number[][])
      else if (key === 'scale') this.setScale(v)
      else if (key === 'translate') this.setTranslate(v as number[])
      else if (key === 'reflectX') this.sx = v ? -1 : 1
      else if (key === 'reflectY') this.sy = v ? -1 : 1
    }
  }

  project(x: number, y: number): [number, number] {
    return [x * (this.k * this.sx) + this.tx, y * (this.k * this.sy) + this.ty]
  }

  invert(x: number, y: number): [number, number] {
    return [(x - this.tx) / (this.k * this.sx), (y - this.ty) / (this.k * this.sy)]
  }

  planar(ev: Events): Events {
    for (let i = 0; i < ev.length; i++) {
      const op = ev.op[i]!
      if (op === POINT) {
        const p = this.project(ev.x[i]!, ev.y[i]!)
        ev.x[i] = p[0]
        ev.y[i] = p[1]
      } else if (op === SPHERE) throw new TypeError('this.stream.sphere is not a function')
    }
    if (!this.rect) return ev
    const out = this.rect.clip(ev)
    ev.release()
    return out
  }
}

/* ---- the projections ---------------------------------------------------------------------------- */

// Each factory sets the projection's defaults one property at a time, in an order that matters only
// for the cylindrical projections (see the note at the top).

const spherical = (raw: RawProjection, options?: SphericalOptions): SphericalProjection => new SphericalProjection(raw, options)

/** A conic projection, starting from standard parallels at 0 and 60 degrees. */
const conic = (build: ConicBuilder): SphericalProjection => spherical(build(0, PI / 3), { conic: build })

export function mercator(): GeoProjection {
  const p = spherical(mercatorRaw, { cylinder: { across: 'x', quarterTurn: false } })
  p.setScale(961 / TAU)
  return p
}

export function transverseMercator(): GeoProjection {
  const p = spherical(transverseMercatorRaw, { cylinder: { across: 'y', quarterTurn: true } })
  p.setRotate([0, 0])
  p.setScale(159.155)
  return p
}

export function equirectangular(): GeoProjection {
  const p = spherical(equirectangularRaw)
  p.setScale(152.63)
  return p
}

export function azimuthalEqualArea(): GeoProjection {
  const p = spherical(azimuthalEqualAreaRaw)
  p.setScale(124.75)
  p.setClipAngle(180 - 1e-3)
  return p
}

export function azimuthalEquidistant(): GeoProjection {
  const p = spherical(azimuthalEquidistantRaw)
  p.setScale(79.4188)
  p.setClipAngle(180 - 1e-3)
  return p
}

export function gnomonic(): GeoProjection {
  const p = spherical(gnomonicRaw)
  p.setScale(144.049)
  p.setClipAngle(60)
  return p
}

export function orthographic(): GeoProjection {
  const p = spherical(orthographicRaw)
  p.setScale(249.5)
  p.setClipAngle(90 + EPSILON)
  return p
}

export function stereographic(): GeoProjection {
  const p = spherical(stereographicRaw)
  p.setScale(250)
  p.setClipAngle(142)
  return p
}

export function conicConformal(): GeoProjection {
  const p = conic(conicConformalRaw)
  p.setScale(109.5)
  p.setParallels([30, 30])
  return p
}

function newConicEqualArea(): SphericalProjection {
  const p = conic(conicEqualAreaRaw)
  p.setScale(155.424)
  p.setCenter([0, 33.6442])
  return p
}

export function conicEquidistant(): GeoProjection {
  const p = conic(conicEquidistantRaw)
  p.setScale(131.154)
  p.setCenter([0, 13.9389])
  return p
}

function newAlbers(): SphericalProjection {
  const p = newConicEqualArea()
  p.setParallels([29.5, 45.5])
  p.setScale(1070)
  p.setTranslate([480, 250])
  p.setRotate([96, 0])
  p.setCenter([-0.6, 38.7])
  return p
}

export const conicEqualArea = (): GeoProjection => newConicEqualArea()
export const albers = (): GeoProjection => newAlbers()
export const albersUsa = (): GeoProjection => new AlbersUsa()

export function equalEarth(): GeoProjection {
  const p = spherical(equalEarthRaw)
  p.setScale(177.158)
  return p
}

export function naturalEarth1(): GeoProjection {
  const p = spherical(naturalEarth1Raw)
  p.setScale(175.295)
  return p
}

export function mollweide(): GeoProjection {
  const p = spherical(mollweideRaw)
  p.setScale(169.529)
  return p
}

export const identity = (): GeoProjection => new IdentityProjection()
