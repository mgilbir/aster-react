/**
 * GENERATED live differential of the `graticule` transform's parameters (C154): real Vega (vega-geo's Graticule over d3-geo's
 * geoGraticule) and Aster make the dataset from the same parameters, in one process, and its rows (the MultiLineString's
 * coordinates) must be identical to the bit, or both must refuse.
 *
 * What is drawn: `extent`, `extentMajor`, `extentMinor` in either corner order (west-east and south-north the wrong way round),
 * as numbers or numeric strings; `step`, `stepMajor`, `stepMinor` including zero, negative and NaN steps; `precision` as a number,
 * zero or a numeric string; parameters in several orders (the order they are applied in matters).
 */
import * as vega from 'vega'
import { describe, expect, it } from 'vitest'
import { datasetsOfScene, evaluateChart, compileChart } from '../../core/src/index.ts'
import '../../core/src/addon-geo.ts'
import { compareCases, makeRng, scaled, type Rng } from './differential-gen.mts'
import { quietLogger } from './differential-util.mts'

function corner(r: Rng, lo: number, hi: number): unknown[] {
  const x = r.between(lo, hi)
  const y = r.between(Math.max(-90, lo / 2), Math.min(90, hi / 2))
  return r.chance(0.15) ? [String(x), String(y)] : [x, y]
}

function extent(r: Rng): unknown[] {
  const a = corner(r, -180, 0)
  const b = corner(r, 0, 180)
  // the wrong way round in one axis, both, or neither
  switch (r.int(4)) {
    case 0: return [b, a]
    case 1: return [[b[0], a[1]], [a[0], b[1]]]
    case 2: return [[a[0], b[1]], [b[0], a[1]]]
    default: return [a, b]
  }
}

const step = (r: Rng): unknown[] => [r.pick<unknown>([10, 15, 30, 45, 0, -10, NaN, '20', 5]), r.pick<unknown>([10, 20, 30, 0, '15', 90])]

function params(r: Rng): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const keys = ['extent', 'extentMajor', 'extentMinor', 'step', 'stepMajor', 'stepMinor', 'precision'].filter(() => r.chance(0.4))
  // any order
  for (let i = keys.length - 1; i > 0; i--) { const j = r.int(i + 1); [keys[i], keys[j]] = [keys[j]!, keys[i]!] }
  for (const k of keys) {
    out[k] = k.startsWith('extent') ? extent(r) : k.startsWith('step') ? step(r) : r.pick<unknown>([2.5, 1, 10, 0, '45', '5', 90])
  }
  return out
}

async function viaVega(spec: unknown): Promise<unknown> {
  const errors: unknown[][] = []
  try {
    const view = new vega.View(vega.parse(structuredClone(spec) as vega.Spec), { renderer: 'none', logger: quietLogger(errors) as never })
    await view.runAsync()
    if (errors.length) return { refused: true }
    return JSON.parse(JSON.stringify(view.data('g').map((d: { type: string; coordinates: unknown }) => ({ type: d.type, coordinates: d.coordinates }))))
  } catch {
    return { refused: true }
  }
}

function viaAster(spec: unknown): unknown {
  const errors: unknown[] = []
  try {
    const scene = evaluateChart(compileChart(structuredClone(spec) as never), { logger: { error: (e: unknown) => errors.push(e), warn() {}, info() {}, debug() {} } })
    if (errors.length) return { refused: true }
    const rows = (datasetsOfScene(scene).get('g') ?? []) as Array<{ type: string; coordinates: unknown }>
    return JSON.parse(JSON.stringify(rows.map((d) => ({ type: d.type, coordinates: d.coordinates }))))
  } catch {
    return { refused: true }
  }
}

describe(`graticule parameters vs vega@${vega.version} (generated, live)`, () => {
  it('the same lines for every extent order, step and precision, or a refusal on both sides', async () => {
    const r = makeRng(0x154)
    const cases: Array<{ spec: unknown; label: string; want: unknown }> = []
    for (let i = 0; i < scaled(400); i++) {
      const p = params(r)
      const spec = { width: 100, height: 100, data: [{ name: 'g', transform: [{ type: 'graticule', ...p }] }] }
      cases.push({ spec, label: JSON.stringify(p), want: await viaVega(spec) })
    }
    let lines = 0
    compareCases('graticule', cases.length, (i) => {
      const c = cases[i]!
      if (!(c.want as { refused?: boolean }).refused) lines++
      return { label: c.label, oracle: () => c.want, aster: () => viaAster(c.spec) }
    })
    expect(lines).toBeGreaterThan(cases.length * 0.8)
  })
})
