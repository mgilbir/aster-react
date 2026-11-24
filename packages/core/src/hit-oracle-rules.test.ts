/**
 * Rules of what is under the pointer that real vega in Chromium taught `pnpm conformance:geometry` (its generated specs, each renderer,
 * vega's canvas pick and the browser's hit test of vega's SVG): each is pinned on a scene made for it, with the answers the oracle gave
 * on the same scene (measured in Chromium, see the comments). The gate is the differential; these say which rule broke when it does.
 */
import { describe, it, expect } from 'vitest'
import { compileChart, evaluateChart } from './index.js'
import { buildHitIndex } from './hit.js'
import type { VgSpec } from './types.js'

const view = (marks: unknown[], extra: Record<string, unknown> = {}): VgSpec =>
  ({ width: 200, height: 100, padding: 0, autosize: 'none', marks, ...extra }) as unknown as VgSpec
const both = (spec: VgSpec): { svg: ReturnType<typeof buildHitIndex>; canvas: ReturnType<typeof buildHitIndex> } => {
  const scene = evaluateChart(compileChart(spec))
  return { svg: buildHitIndex(scene), canvas: buildHitIndex(scene, undefined, { renderer: 'canvas' }) }
}
const hit = (r: { marktype: string } | null): boolean => r !== null

describe('an arc is turned by its angle', () => {
  // (a quarter pie, 12 o'clock to 3 o'clock: the upper right; turned 90 degrees it is the lower right. Both renderers: marks/arc.js
  // `rotateItem` on the SVG, `rotate(angle)` before the path on the canvas.)
  const arc = (angle: number): VgSpec => view([{
    type: 'arc',
    encode: { update: { x: { value: 100 }, y: { value: 50 }, outerRadius: { value: 40 }, startAngle: { value: 0 }, endAngle: { value: Math.PI / 2 }, angle: { value: angle }, fill: { value: 'red' } } },
  }])
  it.each(['svg', 'canvas'] as const)('on the %s', (renderer) => {
    const upright = both(arc(0))[renderer]
    expect(hit(upright.pick(120, 30))).toBe(true)
    expect(hit(upright.pick(120, 70))).toBe(false)
    const turned = both(arc(90))[renderer]
    expect(hit(turned.pick(120, 30))).toBe(false)
    expect(hit(turned.pick(120, 70))).toBe(true)
  })
})

describe('a dash gap takes no pointer where vega draws the dash (C713)', () => {
  // measured in Chromium along y = 50 from x = 10, a 6 px stroke dashed [4, 2]: vega's canvas pick finds a RULE in its dashes only
  // (marks/rule.js draws the stroke state it picks with), a line, a rect and a symbol whole (util/canvas/pick.js sets the width and the
  // cap); the browser hit-tests every stroked shape in its dashes only.
  const rule = (): VgSpec => view([
    { type: 'rule', encode: { update: { x: { value: 10 }, y: { value: 50 }, x2: { value: 190 }, y2: { value: 50 }, stroke: { value: 'black' }, strokeWidth: { value: 6 }, strokeDash: { value: [4, 2] } } } },
  ])
  const line = (): VgSpec => view([{
    type: 'line', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { value: 50 }, stroke: { value: 'black' }, strokeWidth: { value: 6 }, strokeDash: { value: [4, 2] } } },
  }], { data: [{ name: 't', values: [{ x: 10 }, { x: 190 }] }] })
  it('a rule: its gaps on both renderers', () => {
    const r = both(rule())
    for (const idx of [r.svg, r.canvas]) {
      expect(hit(idx.pick(12, 50))).toBe(true)
      expect(hit(idx.pick(15, 50))).toBe(false)
      expect(hit(idx.pick(17, 50))).toBe(true)
    }
  })
  it('a line: its gaps on the SVG, whole on the canvas', () => {
    const r = both(line())
    expect(hit(r.svg.pick(12, 50))).toBe(true)
    expect(hit(r.svg.pick(15, 50))).toBe(false)
    expect(hit(r.svg.pick(17, 50))).toBe(true)
    expect(hit(r.canvas.pick(15, 50))).toBe(true)
  })
  it('a rule of no stroke opacity is not drawn, so not picked, on the canvas (marks/rule.js path)', () => {
    const r = both(view([{ type: 'rule', encode: { update: { x: { value: 10 }, y: { value: 50 }, x2: { value: 190 }, stroke: { value: 'black' }, strokeWidth: { value: 6 }, strokeOpacity: { value: 0 } } } }]))
    expect(hit(r.svg.pick(50, 50))).toBe(true)
    expect(hit(r.canvas.pick(50, 50))).toBe(false)
  })
})

describe('a path command with a number that is not one is ignored by a canvas and ends an SVG path', () => {
  // a line through (10, 10), (90, 10), (NaN, 50), (90, 90): the canvas leaves the third call out and goes on to the fourth from where it
  // was ("if any of the arguments are infinite or NaN, then return"), the browser draws up to the error. Vega's SVG text is `...LNaN,50...`.
  const spec = (): VgSpec => view([{
    type: 'line', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, stroke: { value: 'black' }, strokeWidth: { value: 8 } } },
  }], { data: [{ name: 't', values: [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 'NaN', y: 50 }, { x: 90, y: 90 }] }] })
  it('a point on the leg after the one left out', () => {
    const r = both(spec())
    expect(hit(r.canvas.pick(90, 60))).toBe(true)
    expect(hit(r.svg.pick(90, 60))).toBe(false)
    // before the error, both draw it
    expect(hit(r.canvas.pick(50, 10))).toBe(true)
    expect(hit(r.svg.pick(50, 10))).toBe(true)
  })
})

describe('what vega finds by its bounds alone, and what it finds in no area', () => {
  it('a canvas image is picked by its bounds, an edge that is not a number holds every point (pick() with no test after them)', () => {
    // (the mark's bounds, the union of its items', leave an edge that is not a number out: a second image gives the first its x extent)
    const r = both(view([{
      type: 'image', from: { data: 't' },
      encode: { update: { x: { value: 10 }, y: { field: 'y' }, width: { field: 'w' }, height: { value: 30 }, url: { value: 'x.png' } } },
    }], { data: [{ name: 't', values: [{ y: 10, w: Number.NaN }, { y: 60, w: 180 }] }] }))
    expect(hit(r.canvas.pick(150, 20))).toBe(true)
    expect(hit(r.canvas.pick(150, 50))).toBe(false)
    // an SVG image of a width that is no number is drawn with none (the browser reads the attribute as 0)
    expect(hit(r.svg.pick(150, 20))).toBe(false)
  })
  it('a filled shape of no area has nothing a fill test finds, not even on its edge', () => {
    const r = both(view([{ type: 'arc', encode: { update: { x: { value: 100 }, y: { value: 50 }, outerRadius: { value: 0 }, startAngle: { value: 0 }, endAngle: { value: 3 }, fill: { value: 'red' } } } }]))
    expect(hit(r.svg.pick(100, 50))).toBe(false)
    expect(hit(r.canvas.pick(100, 50))).toBe(false)
  })
  it('a symbol of no size with a butt-capped stroke paints nothing there', () => {
    const r = both(view([{ type: 'symbol', encode: { update: { x: { value: 100 }, y: { value: 50 }, size: { value: 0 }, stroke: { value: 'black' }, strokeWidth: { value: 4 } } } }]))
    expect(hit(r.svg.pick(100, 50))).toBe(false)
    expect(hit(r.canvas.pick(100, 50))).toBe(false)
  })
})
