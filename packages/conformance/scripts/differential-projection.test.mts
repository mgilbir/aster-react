/**
 * LIVE differential for "projection spec -> built projection": every case's spec is built by
 * real Vega (vega-geo's Projection transform over vega-projection's registry) and by Aster's
 * `buildProjection` (same process, same engine); the projection's properties, projected
 * points and path strings must be identical. See `differential-util.mts` for why nothing is
 * recorded (projections are trig-heavy, and trig differs in the last bit between V8 versions).
 * Types are case-insensitive, an unrecognised type throws, parameters apply in vega's order,
 * and `fit` with `size` / `extent` fits the projection to the data (audit C27, C63, C95).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { buildProjection } from '../../core/src/geo.ts'
import type { GeoProjection } from '../../core/src/geo-projections.ts'
import { attempt, quietLogger } from './differential-util.mts'
import { cases, GEOMS, POINTS } from './projection-cases.mjs'

type D3Proj = ((p: number[]) => unknown) & Record<string, unknown> & { path: ((g: unknown) => unknown) & { pointRadius(): unknown } }

const PROPS = ['scale', 'translate', 'center', 'rotate', 'clipAngle', 'clipExtent', 'precision', 'parallels', 'reflectX', 'reflectY']

/** What the projection reports, read from vega's d3 projection. */
function sampleD3(proj: D3Proj): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const m of PROPS) {
    if (typeof proj[m] === 'function') o[m] = attempt(() => (proj[m] as () => unknown)())
  }
  o.type = proj.type
  o.points = POINTS.map((p) => attempt(() => proj(p)))
  const paths: Record<string, unknown> = {}
  for (const [g, geo] of Object.entries(GEOMS)) paths[g] = attempt(() => proj.path(geo))
  o.pointRadius = attempt(() => proj.path.pointRadius())
  o.paths = paths
  return o
}

/** The same report from Aster's projection, whose state is read as properties. */
function sampleAster(proj: GeoProjection): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const m of PROPS) {
    if ((proj as unknown as Record<string, unknown>)[m] !== undefined) o[m] = attempt(() => (proj as unknown as Record<string, unknown>)[m])
  }
  o.type = proj.type
  o.points = POINTS.map((p) => attempt(() => proj.project(p[0]!, p[1]!)))
  const paths: Record<string, unknown> = {}
  for (const [g, geo] of Object.entries(GEOMS)) paths[g] = attempt(() => proj.path.draw(geo))
  o.pointRadius = attempt(() => proj.path.pointRadius)
  o.paths = paths
  return o
}

async function viaVega(params: Record<string, unknown>): Promise<unknown> {
  try {
    const errors: unknown[][] = []
    const quiet = quietLogger(errors)
    const spec = structuredClone({ width: 300, height: 200, projections: [{ name: 'p', ...params }] })
    const view = new vega.View(vega.parse(spec as vega.Spec), { renderer: 'none', logLevel: vega.None, logger: quiet as never })
    view.logger(quiet as never)
    await view.runAsync()
    if (errors.length) throw new Error(String(errors[0]))
    return sampleD3(view.scale('p') as D3Proj)
  } catch {
    return { $: 'throw' }
  }
}

function viaAster(params: Record<string, unknown>): unknown {
  try {
    return sampleAster(buildProjection({ name: 'p', ...structuredClone(params) } as never))
  } catch {
    return { $: 'throw' }
  }
}

describe(`projection specs vs vega@${vega.version} (live)`, () => {
  for (const c of cases) {
    it(c.name, async () => {
      const want = await viaVega(c.params)
      expect(viaAster(c.params)).toEqual(want)
    })
  }
  it('covers the whole case list', () => {
    expect(cases.length).toBeGreaterThanOrEqual(304)
  })
})
