/**
 * GENERATED live differential of a mark's `clip` (C150): every kind of clip (`true`, `false`, `{path}`, `{sphere}` of a projection,
 * of one that clips the sphere away, of one that is not there, `{signal}` holding `geoShape(...)`, `pathShape(...)` or a boolean)
 * on every kind of mark (a group mark among them, nested, with items of its own), real Vega against Aster, as SVG compared canonically
 * (the clip shapes included).
 */
import * as vega from 'vega'
import { describe, expect, it } from 'vitest'
import { renderSpec } from '../../core/src/index.ts'
import '../../core/src/addon-geo.ts'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.ts'
import { makeRng, scaled, type Rng } from './differential-gen.mts'
import { quietLogger } from './differential-util.mts'

const CLIPS: unknown[] = [
  true, false, { path: 'M10,10L150,20L120,160Z' }, { path: { signal: "'M0,0L80,0L80,80Z'" } },
  { sphere: 'p' }, { sphere: 'tiny' }, { sphere: 'nope' }, { sphere: { signal: "'p'" } },
  { signal: "geoShape('p', {type: 'Sphere'})" }, { signal: "pathShape('M5,5L100,5L5,100Z')" }, { signal: 'true' }, { signal: "geoShape('nope', {type: 'Sphere'})" },
]

function leaf(r: Rng): Record<string, unknown> {
  const fill = { value: r.pick(['blue', 'green']) }
  switch (r.int(4)) {
    case 0: return { type: 'rect', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, width: { value: 120 }, height: { value: 90 }, fill } } }
    case 1: return { type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, size: { value: 4000 }, fill } } }
    case 2: return { type: 'text', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, text: { value: 'clipped text' }, fontSize: { value: 30 }, fill } } }
    default: return { type: 'path', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, path: { value: 'M0,0L150,0L150,150Z' }, fill } } }
  }
}

function genSpec(r: Rng): Record<string, unknown> {
  const clip = r.pick(CLIPS)
  let mark: Record<string, unknown>
  if (r.chance(0.5)) {
    mark = {
      type: 'group', clip,
      ...(r.chance(0.4) ? { from: { data: 't' } } : {}),
      encode: { update: { x: { value: r.between(0, 40) }, y: { value: r.between(0, 40) }, width: { value: 160 }, height: { value: 160 }, ...(r.chance(0.3) ? { clip: { value: true } } : {}), ...(r.chance(0.3) ? { fill: { value: '#eee' } } : {}) } },
      marks: [leaf(r)],
    }
  } else {
    mark = { ...leaf(r), clip }
  }
  return {
    width: 200, height: 200, autosize: 'none',
    projections: [
      { name: 'p', type: 'orthographic', scale: r.between(50, 95), translate: [100, 100] },
      { name: 'tiny', type: 'orthographic', scale: 90, translate: [100, 100], clipExtent: [[0, 0], [0, 0]] },
    ],
    data: [{ name: 't', values: [{ x: r.between(-20, 60), y: r.between(-20, 60) }, { x: r.between(60, 150), y: r.between(60, 150) }] }],
    marks: [mark],
  }
}

async function viaVega(spec: unknown): Promise<string> {
  const errors: unknown[][] = []
  const view = new vega.View(vega.parse(structuredClone(spec) as vega.Spec), { renderer: 'none', logger: quietLogger(errors) as never })
  await view.runAsync()
  if (errors.length) throw new Error(String(errors[0]))
  return view.toSVG()
}

/** The distinct clip shapes in `<defs>`, in document order (ids differ between the engines, and Aster writes one shape once). */
const clipShapes = (svg: string): string[] => [...new Set([...svg.matchAll(/<clipPath[^>]*>(.*?)<\/clipPath>/g)].map((m) => m[1]!))]

describe(`a mark's clip vs vega@${vega.version} (generated, live)`, () => {
  it('clips every mark, a group mark too, to what vega clips it to', async () => {
    const r = makeRng(0x150)
    const count = scaled(300)
    let groups = 0
    for (let i = 0; i < count; i++) {
      const spec = genSpec(r)
      if ((spec.marks as Array<{ type: string }>)[0]!.type === 'group') groups++
      const want = await viaVega(spec)
      const got = renderSpec(structuredClone(spec) as never)
      const label = JSON.stringify((spec.marks as unknown[])[0]).slice(0, 400)
      expect(clipShapes(got), label).toEqual(clipShapes(want))
      expect(diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got)), label).toEqual([])
    }
    expect(groups).toBeGreaterThan(count * 0.3)
  })
})
