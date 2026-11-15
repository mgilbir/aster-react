/**
 * The hit index built for the canvas renderer picks as vega's canvas renderer does; the default one as the browser hit-tests
 * vega's SVG. Real vega in Chromium is the oracle of `pnpm conformance:signals` (its pointer phase compares both renderers over
 * generated scenes); these pin each rule on a scene made for it.
 */
import { describe, it, expect } from 'vitest'
import { compileChart, evaluateChart } from './index.js'
import { buildHitIndex } from './hit.js'
import { Bounds, boundLeaf } from './bounds.js'
import type { SceneGroup, SceneItem, VgSpec } from './types.js'

const view = (marks: unknown[], extra: Record<string, unknown> = {}): VgSpec =>
  ({ width: 300, height: 200, padding: 0, autosize: 'none', marks, ...extra }) as unknown as VgSpec
const both = (spec: VgSpec): { svg: ReturnType<typeof buildHitIndex>; canvas: ReturnType<typeof buildHitIndex>; scene: ReturnType<typeof evaluateChart> } => {
  const scene = evaluateChart(compileChart(spec))
  return { svg: buildHitIndex(scene), canvas: buildHitIndex(scene, undefined, { renderer: 'canvas' }), scene }
}
const markOf = (r: { marktype: string } | null): string => (r ? r.marktype : 'none')

describe('a hit index for the canvas renderer', () => {
  it('a clipped group item takes the pointer only inside its box, its stroke past the box included (marks/group.js)', () => {
    const { svg, canvas } = both(view([{
      type: 'group', encode: { update: { x: { value: 50 }, y: { value: 50 }, width: { value: 100 }, height: { value: 60 }, fill: { value: '#eee' }, stroke: { value: '#222' }, strokeWidth: { value: 10 }, clip: { value: true } } },
    }]))
    // 3 px outside the box, inside the outer half of the stroke: the svg's stroke, nothing on the canvas
    expect(markOf(svg.pick(153, 80))).toBe('group')
    expect(markOf(canvas.pick(153, 80))).toBe('none')
    // inside the box both take it
    expect(markOf(svg.pick(148, 80))).toBe('group')
    expect(markOf(canvas.pick(148, 80))).toBe('group')
  })

  it('a rounded clipped group item takes the pointer only inside its rounded outline (hitCorner)', () => {
    const { svg, canvas } = both(view([{
      type: 'group', encode: { update: { x: { value: 50 }, y: { value: 50 }, width: { value: 100 }, height: { value: 60 }, fill: { value: '#eee' }, stroke: { value: '#222' }, strokeWidth: { value: 4 }, cornerRadius: { value: 20 }, clip: { value: true } } },
    }]))
    // in the corner's stroke band, outside the rounded fill
    expect(markOf(svg.pick(55.5, 56))).toBe('group')
    expect(markOf(canvas.pick(55.5, 56))).toBe('none')
  })

  it('a stroke is tested with a miter join limited at 10 whatever its limit says, within the bounds vega measured', () => {
    // a sharp corner at (100, 100): the two edges meet at about 22 degrees, so its miter is 5.2 half-widths long
    const spec = view([{
      type: 'path', encode: { update: { x: { value: 0 }, y: { value: 0 }, path: { value: 'M40,120L100,100L40,96' }, stroke: { value: '#000' }, strokeWidth: { value: 4 }, strokeMiterLimit: { value: 2 } } },
    }])
    const { svg, canvas } = both(spec)
    // 3 px past the corner along its bisector (the bounds reach 4 px past it, 2 half-widths): the svg bevels the corner (limit 2),
    // vega's canvas pick miters it (its context's limit, 10)
    expect(markOf(svg.pick(102.9, 99.7))).toBe('none')
    expect(markOf(canvas.pick(102.9, 99.7))).toBe('path')
  })

  it('an item takes the pointer only within the bounds vega measured for it (util/canvas/pick.js)', () => {
    // a turned square path: its corners reach past what the bounds pass measures for a turned path
    const spec = view([{
      type: 'path', encode: { update: { x: { value: 150 }, y: { value: 100 }, angle: { value: 45 }, path: { value: 'M-40,-40L40,-40L40,40L-40,40Z' }, fill: { value: 'steelblue' } } },
    }])
    const { svg, canvas, scene } = both(spec)
    const item = ((scene.items as SceneGroup[]).find((m) => m.marktype === 'path')!.items as SceneItem[])[0]!
    const b = boundLeaf(new Bounds(), item, true)
    let found = 0
    // every point of the painted shape that is outside the measured bounds: the svg takes it, the canvas does not
    for (let x = 80; x <= 220; x += 2) {
      for (let y = 30; y <= 170; y += 2) {
        const inBounds = x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2
        const s = markOf(svg.pick(x, y))
        const c = markOf(canvas.pick(x, y))
        if (s === 'path' && !inBounds) { found++; expect(c).toBe('none') } else expect(c).toBe(s)
      }
    }
    expect(found).toBeGreaterThan(0)
  })

  it('a segment shorter than the stroker can turn on is no corner: the canvas pick miters no spike there', () => {
    // a triangle whose last point stops a hair below the first: closing it adds a segment of 1e-9 px pointing up, which would turn
    // the outline back on itself (a 153 degree turn, a miter 4.3 half-widths long: within the canvas pick's limit of 10)
    const spec = view([{
      type: 'path', encode: { update: { x: { value: 0 }, y: { value: 0 }, path: { value: 'M100,100L160,100L130,40L100,100.000000001Z' }, stroke: { value: '#000' }, strokeWidth: { value: 6 } } },
    }])
    const { svg, canvas } = both(spec)
    // 8 px down that spike's bisector: off the real corner's miter (it points down and left at 32 degrees) and off both edges' bands (the svg's limit of 4
    // bevels that turn anyway)
    for (const ix of [svg, canvas]) expect(markOf(ix.pick(98.2, 107.8))).toBe('none')
  })

  it('where two curves meet the stroker joins them along their own tangents: a turn of the chords there is no corner', () => {
    // a horizontal monotone area through points whose y turns back (the curve has a cusp at (204.1, 12.6)): vega's renderers find
    // nothing just above the cusp, where a miter of the two chords that meet there would reach (the pointer phase's gen-1026)
    const rows = [{ x: -3.7292274832725525, y: 193.51377403363585 }, { x: 45.117202475667, y: 176.17105511948466 }, { x: 204.10199604928493, y: 12.596820592880249 }, { x: 238.73358450829983, y: 20.40951866656542 }, { x: 240.78277863562107, y: 217.26916816085577 }]
    const spec = view([{
      type: 'area', from: { data: 'd' },
      encode: { update: { x: { field: 'x' }, y: { field: 'y' }, x2: { value: 97.95538808684796 }, orient: { value: 'horizontal' }, interpolate: { value: 'monotone' }, fill: { value: '#bab0ac' }, stroke: { value: '#e45756' }, strokeWidth: { value: 6 }, opacity: { value: 0.4 } } },
    }], { padding: 10, width: 300, height: 220, data: [{ name: 'd', values: rows }] })
    const { svg, canvas } = both(spec)
    for (const ix of [svg, canvas]) expect(markOf(ix.pick(214, 22))).toBe('none')
  })
})
