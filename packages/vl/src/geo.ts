/**
 * Maps: vega-lite 6.4.3's projection compilation (compile/projection/{parse,component,assemble}.ts),
 * the `geojson` / `geopoint` data nodes (compile/data/{geojson,geopoint}.ts) and the `geoshape`
 * mark's post-encoding transform (compile/mark/geoshape.ts), kept apart from compile.ts so the
 * unit compiler only asks three questions of it: does this unit have a projection, what are its
 * geo transforms, and which projections does the whole view assemble.
 *
 * The model mirrors vega-lite's:
 *  - a unit that draws a `geoshape`, or encodes `longitude`/`latitude` (a field or a datum), has a
 *    projection component, named `<prefix>projection` after its place in the layer tree;
 *  - a component FITS the data (`size` + `fit`) unless the unit's own `projection` gives a `scale`
 *    or `translate`;
 *  - the children of a layer merge their components when no property conflicts, the layer then
 *    owning one projection fitted to the union of the children's data.
 */
import { VLCompileError, flatField, pushAll } from './names.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

export const GEO_POSITION_CHANNELS = ['longitude', 'latitude', 'longitude2', 'latitude2'] as const

/** [longitude, latitude] pairs in the order vega-lite emits their transforms (the second is the "2" pair). */
const GEO_PAIRS = [['longitude', 'latitude'], ['longitude2', 'latitude2']] as const

/** vega-lite `PROJECTION_PROPERTIES`: the properties two layers must agree on to share a projection. */
const PROJECTION_PROPERTIES = [
  'type', 'clipAngle', 'clipExtent', 'center', 'rotate', 'precision', 'reflectX', 'reflectY', 'coefficient',
  'distance', 'fraction', 'lobes', 'parallel', 'radius', 'ratio', 'spacing', 'tilt',
]

/** vega-lite `isFieldOrDatumDef`. */
function isFieldOrDatumDef(def: unknown): boolean {
  return isObj(def) && (def.field !== undefined || def.aggregate === 'count' || def.datum !== undefined)
}

/** vega-lite `UnitModel.hasProjection`: a geoshape, or a field/datum on a geographic position channel. */
export function hasProjection(mark: string, encoding: Obj): boolean {
  return mark === 'geoshape' || GEO_POSITION_CHANNELS.some((c) => isFieldOrDatumDef(encoding[c]))
}

/** vega-lite `replaceExprRef` at level 0: each top-level `{expr}` becomes `{signal}`. */
function replaceExprRef(o: Obj | undefined): Obj {
  const out: Obj = {}
  for (const [k, v] of Object.entries(o ?? {})) {
    out[k] = isObj(v) && typeof v.expr === 'string' ? { signal: v.expr, ...Object.fromEntries(Object.entries(v).filter(([kk]) => kk !== 'expr')) } : v
  }
  return out
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]))
  }
  return false
}

/** What the fit of a projection reads: a `geojson` signal (by name) or a unit's main dataset (resolved at assembly). */
export type FitSource = { signal: string } | { main: object }

/** vega-lite `ProjectionComponent`. */
export class ProjectionComponent {
  merged = false
  /** set when a layer took this projection over: units look their projection name up through it */
  renamedTo: ProjectionComponent | undefined

  constructor(
    public name: string,
    /** every property the author gave (config.projection under the unit's own projection) */
    public specified: Obj,
    public size: Obj[] | undefined,
    public data: FitSource[] | undefined,
    /**
     * vega-lite defaults a UNIT's projection type to `equalEarth`; the projection a layer elevates from
     * its children is built from their specified properties alone, so without a type it is vega's (mercator)
     */
    public defaultType = false,
  ) {}

  /** vega-lite `isFit`: the projection fits the data. */
  get isFit(): boolean {
    return this.data !== undefined
  }
}

/** The projection name a unit's transforms refer to (vega-lite `model.projectionName()`): follows the layer renames. */
export function finalProjectionName(c: ProjectionComponent | undefined): string | undefined {
  let cur = c
  if (!cur) return undefined
  while (cur.renamedTo) cur = cur.renamedTo
  return cur.name
}

/** The facts about one unit the projection compiler needs. */
export interface GeoUnit {
  mark: string
  encoding: Obj
  /** the unit's own `projection` (a layer's reaches its children) */
  projection: Obj | undefined
  configProjection: Obj | undefined
  /** vega-lite `getName`: '' for the root, `layer_1_` for the second child of the root layer */
  prefix: string
  /** this unit's key for its main dataset, resolved when the projections are assembled */
  handle: object
}

/** The geo-related names a unit compiles with (the geojson signals, the geopoint outputs, the projection). */
export interface UnitGeo {
  component: ProjectionComponent
  /** the unit's own projection fits the data (so `geojson` transforms are emitted) */
  isFit: boolean
  prefix: string
}

/** vega-lite `gatherFitData`. */
function gatherFitData(u: GeoUnit): FitSource[] {
  const data: FitSource[] = []
  for (const pair of GEO_PAIRS) {
    if (isFieldOrDatumDef(u.encoding[pair[0]]) || isFieldOrDatumDef(u.encoding[pair[1]])) {
      data.push({ signal: `${u.prefix}geojson_${data.length}` })
    }
  }
  const shape = u.encoding.shape
  if (isObj(shape) && shape.field !== undefined && shape.type === 'geojson') {
    data.push({ signal: `${u.prefix}geojson_${data.length}` })
  }
  if (data.length === 0) data.push({ main: u.handle })
  return data
}

/** vega-lite `parseUnitProjection`. */
export function parseUnitProjection(u: GeoUnit): ProjectionComponent | undefined {
  if (!hasProjection(u.mark, u.encoding)) return undefined
  const proj = replaceExprRef(u.projection)
  const fit = !(proj.scale != null || proj.translate != null)
  const specified: Obj = { ...replaceExprRef(u.configProjection), ...proj }
  return new ProjectionComponent(
    `${u.prefix}projection`,
    specified,
    fit ? [{ signal: 'width' }, { signal: 'height' }] : undefined,
    fit ? gatherFitData(u) : undefined,
    true,
  )
}

/** vega-lite `mergeIfNoConflict`. */
function mergeIfNoConflict(first: ProjectionComponent, second: ProjectionComponent): ProjectionComponent | null {
  const allPropertiesShared = PROJECTION_PROPERTIES.every((prop) => {
    const a = prop in first.specified
    const b = prop in second.specified
    if (!a && !b) return true
    return a && b && deepEqual(first.specified[prop], second.specified[prop])
  })
  if (deepEqual(first.size, second.size)) {
    if (allPropertiesShared) return first
    if (Object.keys(first.specified).length === 0) return second
    if (Object.keys(second.specified).length === 0) return first
  }
  return null
}

/** vega-lite `parseNonUnitProjections`: the layer-level projection of already-parsed children, if they merge. */
export function mergeLayerProjections(layerName: string, children: Array<ProjectionComponent | undefined>): ProjectionComponent | undefined {
  let nonUnit: ProjectionComponent | undefined
  const mergeable = children.every((projection) => {
    if (!projection) return true
    if (!nonUnit) {
      nonUnit = projection
      return true
    }
    const merge = mergeIfNoConflict(nonUnit, projection)
    if (merge) nonUnit = merge
    return !!merge
  })
  if (nonUnit && mergeable) {
    const layer = new ProjectionComponent(
      layerName,
      nonUnit.specified,
      nonUnit.size,
      nonUnit.data ? nonUnit.data.map((d) => ({ ...d })) : undefined,
    )
    for (const projection of children) {
      if (!projection) continue
      if (projection.isFit) pushAll(layer.data!, projection.data!)
      projection.renamedTo = layer
      projection.merged = true
    }
    return layer
  }
  return undefined
}

/** The `type` of a projection component: the author's, else vega-lite's `equalEarth`. */
function projectionOf(c: ProjectionComponent): Obj {
  const { name: _n, ...rest } = c.specified
  void _n
  return { name: c.name, ...(c.defaultType && !c.specified.type ? { type: 'equalEarth' } : {}), ...rest }
}

/** The component each assembled projection came from (a composite drops the ones it later merges away). */
export const ASSEMBLED_FROM = new WeakMap<object, ProjectionComponent>()

/** vega-lite `assembleProjectionForModel`. */
export function assembleProjection(c: ProjectionComponent, resolveMain: (handle: object) => string): Obj[] {
  if (c.merged) return []
  const projection = projectionOf(c)
  const { name } = projection
  let out: Obj
  if (!c.data) {
    // a custom projection, no automatic fitting: centred by default, the author's parameters win
    out = { name, translate: { signal: '[width / 2, height / 2]' }, ...projection }
  } else {
    const size = { signal: `[${c.size!.map((ref) => ref.signal as string).join(', ')}]` }
    const fits: string[] = []
    for (const d of c.data) {
      const source = 'signal' in d ? d.signal : `data('${resolveMain(d.main)}')`
      if (!fits.includes(source)) fits.push(source)
    }
    out = { name, size, fit: { signal: fits.length > 1 ? `[${fits.join(', ')}]` : fits[0]! }, ...projection }
  }
  ASSEMBLED_FROM.set(out, c)
  return [out]
}

/** Rewrite the signal names a component's size and fit read (a child embedded in a composite renames its signals). */
export function renameComponentSignals(c: ProjectionComponent, rename: (expr: string) => string, renameName: (name: string) => string): void {
  if (c.size) c.size = c.size.map((ref) => ({ ...ref, signal: rename(ref.signal as string) }))
  if (c.data) c.data = c.data.map((d) => ('signal' in d ? { signal: renameName(d.signal) } : d))
}

// --- data nodes ---------------------------------------------------------------

/** One side of a geopoint/geojson field pair: a field name, or an expression for a datum/value. */
type GeoField = string | { expr: string }

function geoFieldOf(def: unknown, at: string): GeoField | undefined {
  if (!isObj(def)) return undefined
  if (typeof def.field === 'string') return def.field
  if (def.datum !== undefined) return { expr: geoConstant(def.datum, `${at}.datum`) }
  if (def.value !== undefined) return { expr: geoConstant(def.value, `${at}.value`) }
  return undefined
}

function geoConstant(v: unknown, at: string): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new VLCompileError(`${at}: a geographic position constant must be a finite number, got ${JSON.stringify(v)}`)
  }
  return `${v}`
}

/**
 * The geo transforms of a unit's data, in vega-lite's order (compile/data/parse.ts): the `geojson`
 * transforms that give the projection's fit its extent (only when the unit's projection fits), then
 * the `geopoint` transforms that project each position pair to the `<prefix>x`/`y`/`x2`/`y2` fields.
 *
 * `fieldMap` turns a field the author wrote into the key the data carries it under.
 */
export function geoDataTransforms(spec: Obj, geo: UnitGeo): Obj[] {
  const encoding = isObj(spec.encoding) ? spec.encoding : {}
  const out: Obj[] = []
  const projection = finalProjectionName(geo.component)!
  if (geo.isFit) {
    let counter = 0
    for (const pair of GEO_PAIRS) {
      const fields = pair.map((c) => geoFieldOf(encoding[c], `encoding.${c}`))
      if (fields[0] !== undefined || fields[1] !== undefined) {
        out.push({ type: 'geojson', fields, signal: `${geo.prefix}geojson_${counter++}` })
      }
    }
    const shape = encoding.shape
    if (isObj(shape) && typeof shape.field === 'string' && shape.type === 'geojson') {
      out.push({ type: 'filter', expr: `isValid(datum[${JSON.stringify(flatField(shape.field).key)}])` })
      out.push({ type: 'geojson', geojson: shape.field, signal: `${geo.prefix}geojson_${counter}` })
    }
  }
  for (const pair of GEO_PAIRS) {
    const fields = pair.map((c) => geoFieldOf(encoding[c], `encoding.${c}`))
    if (fields[0] !== undefined || fields[1] !== undefined) {
      const suffix = pair[0] === 'longitude2' ? '2' : ''
      out.push({ type: 'geopoint', projection, fields, as: [`${geo.prefix}x${suffix}`, `${geo.prefix}y${suffix}`] })
    }
  }
  return out
}

/** The mark transform of a geoshape (compile/mark/geoshape.ts `postEncodingTransform`). */
export function geoshapeTransform(spec: Obj, geo: UnitGeo): Obj {
  const shape = isObj(spec.encoding) ? spec.encoding.shape : undefined
  return {
    type: 'geoshape',
    projection: finalProjectionName(geo.component),
    ...(isObj(shape) && typeof shape.field === 'string' && shape.type === 'geojson' ? { field: `datum[${JSON.stringify(flatField(shape.field).key)}]` } : {}),
  }
}
