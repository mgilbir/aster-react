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
import { compileChart, datasetsOfScene, evaluateChart } from '../../core/src/index.ts'
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

// ---------------------------------------------------------------------------------------------------- refusals
//
// What a spec author sees when the `forces` parameter is wrong. vega refuses while it parses the spec (its
// sub-parameter key matching), so the message names the offending force object as written, and a force it does not
// know is "Unsupported parameter", not "Unrecognized force".

type Outcome = { rows: unknown } | { error: string }

async function viaVega(t: Row): Promise<Outcome> {
  const errors: string[] = []
  try {
    const view = new vega.View(vega.parse({ data: [{ name: 'links', values: LINKS.slice(0, 5).map((l) => ({ ...l })) }, { name: 'nodes', values: NODES.slice(0, 8).map((r) => ({ ...r })), transform: [{ type: 'force', iterations: 5, static: true, ...structuredClone(t) }] }] } as never), { renderer: 'none', logLevel: vega.None })
    view.logger({ level: () => 1, error(...a: unknown[]) { errors.push(a.map((x) => (x as Error)?.message || String(x)).join(' ')); return this }, warn() { return this }, info() { return this }, debug() { return this } } as never)
    await view.runAsync()
    view.finalize()
    return errors.length ? { error: errors[0]!.replace(/^Error: /, '') } : { rows: (view.data('nodes') as Row[]).map((d) => [d.x, d.y].map(enc)) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/** The whole path a spec takes in Aster -- compile (the structural checks) and evaluate -- not just the transform. */
function viaAster(t: Row): Outcome {
  try {
    const spec = { data: [{ name: 'links', values: LINKS.slice(0, 5).map((l) => ({ ...l })) }, { name: 'nodes', values: NODES.slice(0, 8).map((r) => ({ ...r })), transform: [{ type: 'force', iterations: 5, static: true, ...structuredClone(t) }] }], marks: [] }
    const errors: string[] = []
    const logger = { error: (...a: unknown[]) => { errors.push(a.map((x) => (x as Error)?.message || String(x)).join(' ')) }, warn() {} }
    const scene = evaluateChart(compileChart(spec as never), { logger })
    if (errors.length) return { error: errors[0]!.replace(/^Error: /, '') }
    return { rows: (datasetsOfScene(scene).get('nodes') as unknown as Row[]).map((d) => [d.x, d.y].map(enc)) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

const BAD_FORCES: Array<[string, Row]> = [
  ['an unknown force name', { forces: [{ force: 'gravity', strength: 1 }] }],
  ['an unknown name after good forces', { forces: [{ force: 'center' }, { force: 'collide', radius: 3 }, { force: 'swirl', k: 2 }] }],
  ['a force name in the wrong case', { forces: [{ force: 'Center' }] }],
  ['a force name that is a built-in property', { forces: [{ force: 'constructor' }] }],
  ['a force name that is not a string', { forces: [{ force: 7 }] }],
  ['a null force name', { forces: [{ force: null }] }],
  ['a force with no name', { forces: [{ x: 1 }] }],
  ['an empty force object', { forces: [{}] }],
  ['a force object that is a string', { forces: ['center'] }],
  ['a force that is null', { forces: [null] }],
  ['a force that is a number', { forces: [3] }],
  ['a force that is an array', { forces: [['center']] }],
  ['forces as an object', { forces: { force: 'center' } }],
  ['forces as a string', { forces: 'center' }],
  ['forces as a number', { forces: 5 }],
  ['forces as null', { forces: null }],
  ['forces as a signal reference', { forces: { signal: '[{force: "center"}]' } }],
  ['forces left out', {}],
  ['forces empty', { forces: [] }],
  ['a name given as a signal', { forces: [{ force: { signal: '"center"' } }] }],
  ['extra keys on a known force', { forces: [{ force: 'center', bogus: 1, x: 10 }] }],
  ['a link force naming a data set that does not exist', { forces: [{ force: 'link', links: 'nowhere' }] }],
  ['a link force with no links', { forces: [{ force: 'link', distance: 20 }] }],
  ['a link force whose ends are no node', { forces: [{ force: 'link', links: 'links' }] }],
  ['a link force with a node id nobody has', { forces: [{ force: 'link', links: 'links', id: 'nope' }] }],
  ['a radius that calls an unknown function', { forces: [{ force: 'collide', radius: { expr: 'nosuch(datum.size)' } }] }],
  ['a strength that is a string', { forces: [{ force: 'nbody', strength: 'strong' }] }],
  ['x without a target field', { forces: [{ force: 'x', strength: 0.5 }] }],
  ['iterations that are not a number', { iterations: 'many', forces: [{ force: 'center' }] }],
  ['alpha that is not a number', { alpha: 'high', forces: [{ force: 'center' }] }],
]

describe('force transform refusals vs real vega (live)', () => {
  for (const [name, t] of BAD_FORCES) {
    it(name, async () => {
      const want = await viaVega(t)
      const got = viaAster(t)
      if ('error' in want) expect('error' in got ? got.error : 'no error').toBe(want.error)
      else expect(got).toEqual(want)
    })
  }
  it('is not trivially passing: some of these cases are refused by vega, some are not', async () => {
    const outcomes = await Promise.all(BAD_FORCES.map(([, t]) => viaVega(t)))
    expect(outcomes.filter((o) => 'error' in o).length).toBeGreaterThan(10)
    expect(outcomes.filter((o) => 'rows' in o).length).toBeGreaterThan(2)
  })
})
