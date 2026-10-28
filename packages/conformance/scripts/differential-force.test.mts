/**
 * LIVE differential for the `force` transform (vega-force over d3-force 3.0.0 / d3-quadtree 3.0.1): the same nodes
 * and links go through real vega (a dataset with a `force` transform) and through Aster's port (the transforms
 * addon); every node's x, y, vx, vy and index must agree to the last bit. The cases cover each force (center,
 * collide, nbody, link, x, y) alone and together, per-datum `{expr}` radii and strengths, a field-valued focus,
 * static and non-static runs, coincident nodes (the jiggle) and fixed nodes (`fx` / `fy`).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '../../core/src/addon-transforms.ts'
import { compileExpr } from '../../core/src/expression.ts'
import { applyTransforms, type TransformContext } from '../../core/src/transform.ts'
import { enc } from './differential-util.mts'

type Row = Record<string, unknown>
const NODES: Row[] = Array.from({ length: 60 }, (_, i) => ({ id: i, size: 4 + (i * 37) % 23, gx: (i * 53) % 200, gy: (i * 29) % 120 }))
const LINKS: Row[] = Array.from({ length: 50 }, (_, i) => ({ source: i % 60, target: (i * 7 + 3) % 60, w: 1 + i % 4 }))
// nodes that start on the same spot (the forces break the tie with the simulation's seeded jiggle), and pinned ones
const TIES: Row[] = [
  ...Array.from({ length: 12 }, (_, i) => ({ id: i, size: 8, x: 50, y: 50, gx: 50, gy: 50 })),
  ...Array.from({ length: 6 }, (_, i) => ({ id: 12 + i, size: 6, x: 10 * i, y: 5 * i, fx: 10 * i, fy: 5 * i, gx: 60, gy: 60 })),
]

const SIGNALS: Record<string, unknown> = { vd: 0.3, a: 0.8, amin: 0.01, atarget: 0.05 }

const CASES: Array<[string, Row, Row[]?]> = [
  ['center', { iterations: 30, static: true, forces: [{ force: 'center', x: 100, y: 60 }] }],
  ['collide, constant radius', { iterations: 300, static: true, forces: [{ force: 'collide', radius: 5 }] }],
  ['collide, expr radius, strength and iterations', { iterations: 200, static: true, forces: [{ force: 'collide', radius: { expr: 'datum.size / 2' }, strength: 0.6, iterations: 3 }] }],
  ['x and y toward a field', { iterations: 300, static: true, forces: [{ force: 'x', x: 'gx' }, { force: 'y', y: 'gy', strength: 0.3 }] }],
  ['nbody with theta and a distance range', { iterations: 150, static: true, forces: [{ force: 'center', x: 100, y: 60 }, { force: 'nbody', strength: -20, theta: 0.7, distanceMin: 2, distanceMax: 90 }] }],
  ['nbody, expr strength', { iterations: 100, static: true, forces: [{ force: 'nbody', strength: { expr: '-datum.size' } }] }],
  ['link with distance and strength', { iterations: 200, static: true, forces: [{ force: 'center', x: 100, y: 60 }, { force: 'collide', radius: 4 }, { force: 'nbody', strength: -30 }, { force: 'link', links: 'links', distance: 25, strength: 0.5, iterations: 2 }] }],
  ['link, expr distance and a node id field', { iterations: 150, static: true, forces: [{ force: 'link', links: 'links', id: 'id', distance: { expr: '10 + datum.w * 5' } }, { force: 'center' }] }],
  ['a tick when the flow starts (non-static)', { iterations: 100, static: false, forces: [{ force: 'collide', iterations: 2, radius: 5 }, { force: 'center', x: 100, y: 60 }, { force: 'x', x: 'gx', strength: 0.02 }] }],
  // vega applies these four to the simulation only when the parameter is a signal EXPRESSION (a literal or the bare name of a declared signal is never "modified")
  ['alpha, alphaMin, alphaTarget, velocityDecay as literals (not applied)', { iterations: 120, static: true, alpha: 0.8, alphaMin: 0.01, alphaTarget: 0.05, velocityDecay: 0.3, forces: [{ force: 'collide', radius: 6 }, { force: 'x', x: 'gx' }] }],
  ['alpha above 1 as a literal (read directly by the transform)', { iterations: 60, static: true, alpha: 2.5, forces: [{ force: 'collide', radius: 6 }, { force: 'x', x: 'gx' }] }],
  ['alpha, alphaMin, alphaTarget, velocityDecay as names of declared signals (not applied)', { iterations: 120, static: true, alpha: { signal: 'a' }, alphaMin: { signal: 'amin' }, alphaTarget: { signal: 'atarget' }, velocityDecay: { signal: 'vd' }, forces: [{ force: 'collide', radius: 6 }, { force: 'x', x: 'gx' }] }],
  ['alpha, alphaMin, alphaTarget, velocityDecay as signal expressions (applied)', { iterations: 120, static: true, alpha: { signal: 'a * 1' }, alphaMin: { signal: 'amin + 0' }, alphaTarget: { signal: 'atarget * 1' }, velocityDecay: { signal: 'vd * 1' }, forces: [{ force: 'collide', radius: 6 }, { force: 'x', x: 'gx' }] }],
  ['velocityDecay alone as an expression', { iterations: 120, static: true, velocityDecay: { signal: '0.3' }, forces: [{ force: 'collide', radius: 6 }, { force: 'x', x: 'gx' }] }],
  ['coincident and pinned nodes', { iterations: 100, static: true, forces: [{ force: 'collide', radius: 7 }, { force: 'nbody', strength: -5 }] }, TIES],
]

const readOut = (rows: Row[]): unknown => rows.map((d) => [d.x, d.y, d.vx, d.vy, d.index].map(enc))

describe('force transform vs real vega (live)', () => {
  for (const [name, t, nodes = NODES] of CASES) {
    it(name, async () => {
      const spec = {
        signals: Object.entries(SIGNALS).map(([name, value]) => ({ name, value })),
        data: [
          { name: 'links', values: LINKS.map((l) => ({ ...l })) },
          { name: 'nodes', values: nodes.map((r) => ({ ...r })), transform: [{ type: 'force', ...t }] },
        ],
      }
      const view = new vega.View(vega.parse(spec as never), { renderer: 'none' })
      await view.runAsync()
      const want = readOut(view.data('nodes') as Row[])
      view.finalize()

      const runtime = { scale: () => undefined, data: () => [], expr: (e: string) => compileExpr(e, runtime as never) }
      const linkRows = LINKS.map((l) => ({ ...l }))
      const ctx = { runtime, signals: { ...SIGNALS }, datasets: (n: string) => (n === 'links' ? linkRows : undefined) } as unknown as TransformContext
      const got = readOut(applyTransforms(nodes.map((r) => ({ ...r })), [{ type: 'force', ...structuredClone(t) }] as never, ctx))
      expect(got).toEqual(want)
    })
  }

  it('is not trivially passing: the layout moves the nodes', () => {
    const ctx = { runtime: { scale: () => undefined, data: () => [], expr: (e: string) => compileExpr(e, {} as never) }, signals: {} } as unknown as TransformContext
    const out = applyTransforms(NODES.map((r) => ({ ...r })), [{ type: 'force', iterations: 50, static: true, forces: [{ force: 'center', x: 100, y: 60 }, { force: 'nbody', strength: -30 }] }] as never, ctx)
    expect(new Set(out.map((d) => d.x)).size).toBeGreaterThan(50)
  })
})
