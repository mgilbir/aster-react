/**
 * Replay of the "projection spec -> built projection" oracle vectors
 * (`packages/conformance/scripts/gen-projection-vectors.mjs` ->
 * `testdata/vectors/spec-level/vega-projection.json`): vega-geo's Projection
 * transform over vega-projection's registry. Types are case-insensitive, an
 * unrecognised type throws, parameters apply in vega's order, and `fit` with
 * `size` / `extent` fits the projection to the data (audit C27, C63, C95).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildProjection } from './geo.js'

interface File {
  oracle: string
  geoms: Record<string, unknown>
  points: number[][]
  cases: Array<{ name: string; params: Record<string, unknown>; want: unknown }>
}
const file = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'testdata', 'vectors', 'spec-level', 'vega-projection.json'), 'utf8'),
) as File

function dec(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(dec)
  switch ((v as Record<string, unknown>)['$']) {
    case 'undef': return undefined
    case 'nan': return NaN
    case 'inf': return Infinity
    case '-inf': return -Infinity
    case '-0': return -0
    default: {
      const o: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = dec(x)
      return o
    }
  }
}

function enc(v: unknown): unknown {
  if (v === undefined) return { $: 'undef' }
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $: 'nan' }
    if (v === Infinity) return { $: 'inf' }
    if (v === -Infinity) return { $: '-inf' }
    if (v === 0 && 1 / v < 0) return { $: '-0' }
    return v
  }
  if (typeof v === 'function') return { $: 'fn' }
  if (Array.isArray(v)) return v.map(enc)
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) o[k] = enc((v as Record<string, unknown>)[k])
    return o
  }
  return v
}

const attempt = (f: () => unknown): unknown => {
  try {
    return enc(f())
  } catch {
    return { $: 'throw' }
  }
}

type Proj = ((p: number[]) => unknown) & Record<string, unknown> & { path: ((g: unknown) => unknown) & { pointRadius(): unknown } }

function sample(proj: Proj): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const m of ['type', 'scale', 'translate', 'center', 'rotate', 'clipAngle', 'clipExtent', 'precision', 'parallels', 'reflectX', 'reflectY']) {
    if (typeof proj[m] === 'function') o[m] = attempt(() => (proj[m] as () => unknown)())
  }
  o.type = proj.type
  o.points = file.points.map((p) => attempt(() => proj(p)))
  o.paths = {}
  for (const [g, geo] of Object.entries(file.geoms)) (o.paths as Record<string, unknown>)[g] = attempt(() => proj.path(geo))
  o.pointRadius = attempt(() => proj.path.pointRadius())
  return o
}

describe(`projection oracle vectors (${file.oracle})`, () => {
  for (const c of file.cases) {
    it(c.name, () => {
      let got: unknown
      try {
        got = sample(buildProjection({ name: 'p', ...(dec(c.params) as Record<string, unknown>) } as never) as Proj)
      } catch {
        got = { $: 'throw' }
      }
      expect(got).toEqual(c.want)
    })
  }
})
