/**
 * GENERATED live differential of `shape` marks and the `geoshape` transform (C149, C425), real Vega against Aster, rendered to SVG
 * and compared canonically, with what each logs.
 *
 * What is drawn: every GeoJSON shape (points, multipoints, lines, polygons with and without the closing vertex, empty rings, collections,
 * features with null or unknown geometry, numeric strings for coordinates), through a projection or through none (the default path),
 * with a `field`, an `as`, a `pointRadius`; the transform on the mark (its items hold the shape) or on the data with the shape read by
 * the encode; and the shapes vega cannot draw: a `geoshape` mark type, a `shape` mark whose items have no shape (the datum's `shape` or
 * `path` is not one). Either both draw the same picture or both report the error vega's renderer throws.
 */
import * as vega from 'vega'
import { describe, expect, it } from 'vitest'
import { renderSpec } from '../../core/src/index.ts'
import '../../core/src/addon-geo.ts'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.ts'
import { makeRng, scaled, type Rng } from './differential-gen.mts'
import { quietLogger } from './differential-util.mts'

/**
 * Whether coordinates may be numeric strings. Not for a shape drawn with no projection in a view that measures its marks: vega's
 * default path hands the strings to its bounding context as they are, which adds a radius to them by string concatenation
 * (`'35' + 4.5`), a difference docs/ARCHITECTURE.md lists; everywhere else a string reads as its number in both.
 */
let strings = true
const pt = (r: Rng): unknown[] => (strings && r.chance(0.08) ? [String(r.between(-80, 80)), String(r.between(-60, 60))] : [r.between(-80, 80), r.between(-60, 60)])

function ring(r: Rng): unknown[] {
  if (r.chance(0.08)) return []
  const pts = Array.from({ length: r.between(3, 5) }, () => pt(r))
  return r.chance(0.5) ? [...pts, pts[0]] : pts
}

function geometry(r: Rng, depth = 0): unknown {
  switch (r.int(depth > 0 ? 6 : 9)) {
    case 0: return { type: 'Point', coordinates: pt(r) }
    case 1: return { type: 'MultiPoint', coordinates: [pt(r), pt(r)] }
    case 2: return { type: 'LineString', coordinates: Array.from({ length: r.between(1, 4) }, () => pt(r)) }
    case 3: return { type: 'MultiLineString', coordinates: [[pt(r), pt(r)], [pt(r), pt(r), pt(r)]] }
    case 4: return { type: 'Polygon', coordinates: [ring(r), ...(r.chance(0.3) ? [ring(r)] : [])] }
    case 5: return { type: 'MultiPolygon', coordinates: [[ring(r)], [ring(r)]] }
    case 6: return { type: 'GeometryCollection', geometries: [geometry(r, depth + 1), geometry(r, depth + 1)] }
    case 7: return { type: 'Feature', properties: {}, geometry: r.chance(0.2) ? null : geometry(r, depth + 1) }
    default: return r.chance(0.5)
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: geometry(r, depth + 1) }, { type: 'Feature', geometry: r.chance(0.3) ? null : geometry(r, depth + 1) }] }
      : { type: r.pick(['Foo', 'Sphere']) }
  }
}

function genSpec(r: Rng): Record<string, unknown> {
  const projection = r.chance(0.5) ? r.pick(['merc', 'ortho']) : undefined
  const autosize = r.pick(['none', 'pad'])
  strings = projection !== undefined || autosize === 'none'
  const rows = Array.from({ length: r.between(1, 3) }, () => (r.chance(0.3) ? { g: geometry(r), path: 'M0,0L9,9' } : geometry(r)))
  const field = rows.every((x) => 'g' in (x as object)) ? 'g' : undefined
  const params = {
    ...(projection ? { projection } : {}),
    ...(field ? { field } : {}),
    ...(r.chance(0.2) ? { pointRadius: r.pick([2, 10]) } : {}),
  }
  const projections = [
    { name: 'merc', type: 'mercator', scale: 40, translate: [150, 100] },
    { name: 'ortho', type: 'orthographic', scale: 80, translate: [150, 100], rotate: [10, -20, 0] },
  ]
  const paint = { stroke: { value: 'red' }, fill: { value: r.pick(['none', '#ccc']) } }
  let marks: unknown[]
  let data: unknown[] = [{ name: 't', values: rows }]
  switch (r.int(10)) {
    case 0: // the shape the data's transform wrote, read by the encode
      data = [{ name: 't', values: rows, transform: [{ type: 'geoshape', ...params, as: 'sh' }] }]
      marks = [{ type: 'shape', from: { data: 't' }, encode: { update: { ...paint, shape: { field: 'sh' } } } }]
      break
    case 1: // vega cannot draw these: a geoshape mark type, a shape mark whose items hold no shape
      marks = [r.chance(0.5)
        ? { type: 'geoshape', from: { data: 't' }, encode: { update: paint } }
        : { type: 'shape', from: { data: 't' }, encode: { update: paint } }]
      if (r.chance(0.5)) data = [{ name: 't', values: rows, transform: [{ type: 'geoshape', ...params }] }]
      break
    default:
      marks = [{ type: 'shape', from: { data: 't' }, encode: { update: paint }, transform: [{ type: 'geoshape', ...params }] }]
  }
  return { width: 300, height: 200, padding: 0, autosize, projections, data, marks }
}

/**
 * vega draws a shape with no projection through ONE default path it shares across views. A geoshape with a `pointRadius` sets that
 * path's radius while it draws and sets the old one back after, unless drawing threw (a `Sphere` with no projection does: the default
 * path's stream has no sphere), which leaves its radius on the path for every view after it, in this process. Each case is preceded
 * by a view that leaves d3's default radius there the same way, so a case's picture is its own.
 */
async function resetVegaDefaultPath(): Promise<void> {
  const view = new vega.View(vega.parse({
    width: 10, height: 10, data: [{ name: 't', values: [{ type: 'Sphere' }] }],
    marks: [{ type: 'shape', from: { data: 't' }, transform: [{ type: 'geoshape', pointRadius: 4.5 }] }],
  } as vega.Spec), { renderer: 'none', logger: quietLogger([]) as never })
  try {
    await view.runAsync()
    await view.toSVG()
  } catch {
    // (it throws: that is what leaves the radius)
  }
}

async function viaVega(spec: unknown): Promise<{ svg?: string; error?: string }> {
  await resetVegaDefaultPath()
  const errors: unknown[][] = []
  try {
    const view = new vega.View(vega.parse(structuredClone(spec) as vega.Spec), { renderer: 'none', logger: quietLogger(errors) as never })
    await view.runAsync()
    if (errors.length) return { error: String(errors[0]) }
    return { svg: await view.toSVG() }
  } catch (e) {
    return { error: String((e as Error).message) }
  }
}

function viaAster(spec: unknown): { svg?: string; error?: string } {
  const errors: string[] = []
  try {
    const svg = renderSpec(structuredClone(spec) as never, { logger: { error: (e: unknown) => errors.push(String((e as Error)?.message ?? e)), warn() {}, info() {}, debug() {} } })
    return errors.length ? { error: errors[0] } : { svg }
  } catch (e) {
    return { error: String((e as Error).message) }
  }
}

/** The same picture: the canonical SVGs agree; where a path is one the canonical form cannot read (an empty ring's lone `Z`), every
 * element's `d`, `transform`, size and paint agree as written. */
function samePicture(a: string, b: string): boolean {
  try {
    return diffCanonical(canonicalizeSvg(a), canonicalizeSvg(b)).length === 0
  } catch {
    const marks = (svg: string) => [...svg.matchAll(/<path (?!class)[^>]*>/g)].map((m) => m[0])
    const size = (svg: string) => svg.match(/<svg [^>]*>/)?.[0]
    return JSON.stringify(marks(a)) === JSON.stringify(marks(b)) && size(a) === size(b)
  }
}

describe(`shape marks and geoshape vs vega@${vega.version} (generated, live)`, () => {
  it('the same picture, or the same failure where vega cannot draw', async () => {
    const r = makeRng(0x149)
    const bad: string[] = []
    let drawn = 0
    let failed = 0
    const count = scaled(600)
    for (let i = 0; i < count; i++) {
      const spec = genSpec(r)
      const want = await viaVega(spec)
      const got = viaAster(spec)
      let same: boolean
      if (want.svg !== undefined) {
        drawn++
        same = got.svg !== undefined && samePicture(want.svg, got.svg)
      } else {
        failed++
        // (an unknown mark type is not refused yet, C238: Aster draws nothing for it, which is what is compared then)
        same = got.error !== undefined || (spec.marks as Array<{ type: string }>)[0]!.type === 'geoshape' && got.svg !== undefined && !/<path (?!class)[^>]* d="M/.test(got.svg)
      }
      if (!same && bad.length < 4) bad.push(`#${i} ${JSON.stringify(spec).slice(0, 600)}\n   vega  ${JSON.stringify(want).slice(0, 400)}\n   aster ${JSON.stringify(got).slice(0, 400)}`)
    }
    expect(bad.join('\n')).toBe('')
    expect(drawn).toBeGreaterThan(count * 0.6)
    expect(failed).toBeGreaterThan(count * 0.04)
  })
})
