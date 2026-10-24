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
import { attempt, quietLogger } from './differential-util.mts'
import { cases, GEOMS, POINTS } from './projection-cases.mjs'

type Proj = ((p: number[]) => unknown) & Record<string, unknown> & { path: ((g: unknown) => unknown) & { pointRadius(): unknown } }

function sample(proj: Proj): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const m of ['type', 'scale', 'translate', 'center', 'rotate', 'clipAngle', 'clipExtent', 'precision', 'parallels', 'reflectX', 'reflectY']) {
    if (typeof proj[m] === 'function') o[m] = attempt(() => (proj[m] as () => unknown)())
  }
  o.type = proj.type
  o.points = POINTS.map((p) => attempt(() => proj(p)))
  const paths: Record<string, unknown> = {}
  for (const [g, geo] of Object.entries(GEOMS)) paths[g] = attempt(() => proj.path(geo))
  o.paths = paths
  o.pointRadius = attempt(() => proj.path.pointRadius())
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
    return sample(view.scale('p') as Proj)
  } catch {
    return { $: 'throw' }
  }
}

function viaAster(params: Record<string, unknown>): unknown {
  try {
    return sample(buildProjection({ name: 'p', ...structuredClone(params) } as never) as Proj)
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
