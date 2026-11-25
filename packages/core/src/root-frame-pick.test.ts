import { describe, expect, it } from 'vitest'
import { compileChart, evaluateChart } from './index.js'
import { createCursorTracker } from './signals.js'
import { buildHitIndex } from './hit.js'
import type { SceneRoot } from './types.js'

/**
 * The view's frame is the root group item (C279): where nothing else is hit, vega's pick finds it when it is painted (a fill, a
 * `transparent` one too, or a stroke, along the stroke), and it carries the `cursor` of the view's `encode` -- the official example
 * interactive_line_brush_cursor shows its I-beam over the plot because of it. Against vega's own pick, in Chromium, over generated
 * points: conformance:signals (`fixed-root-frame-*` scenes of browser-signals-pick.mts).
 */
const scene = (paint: Record<string, unknown>, cursor: string | null = 'text'): SceneRoot =>
  evaluateChart(compileChart({
    width: 100, height: 80, padding: 10, autosize: 'none',
    encode: { update: { ...(cursor === null ? {} : { cursor: { value: cursor } }), ...paint } },
    marks: [{ type: 'rect', encode: { update: { x: { value: 40 }, y: { value: 30 }, width: { value: 20 }, height: { value: 20 }, fill: { value: 'steelblue' }, cursor: { value: 'pointer' } } } }],
  } as never))

for (const renderer of ['svg', 'canvas'] as const) {
  describe(`the root frame in the ${renderer} hit index`, () => {
    const index = (s: SceneRoot) => buildHitIndex(s, undefined, { renderer })
    // (the view's padding is 10: the frame is the box from (10, 10) to (110, 90))
    it('a filled frame is picked where no mark is, with the view encode\'s cursor; marks over it win', () => {
      const idx = index(scene({ fill: { value: '#eee' } }))
      expect((idx.pick(30, 30)?.item as { cursor?: string }).cursor).toBe('text')
      expect(idx.pick(30, 30)?.marktype).toBe('group')
      expect((idx.pick(60, 50)?.item as { cursor?: string }).cursor).toBe('pointer')
      expect(idx.pick(5, 5)).toBeNull()
      expect(idx.pick(150, 50)).toBeNull()
      // (only `pick` finds it: a query for what is drawn there says nothing)
      expect(idx.query(30, 30)).toBeNull()
      expect(idx.queryMark(30, 30)).toBeNull()
    })
    it('a transparent fill is picked, an unpainted frame is not, a stroked one is along its stroke', () => {
      expect(index(scene({ fill: { value: 'transparent' } })).pick(30, 30)).not.toBeNull()
      expect(index(scene({})).pick(30, 30)).toBeNull()
      const stroked = index(scene({ stroke: { value: '#333' }, strokeWidth: { value: 6 } }))
      expect(stroked.pick(30, 30)).toBeNull()
      expect(stroked.pick(11, 40)).not.toBeNull()
      expect(stroked.pick(8, 40)).not.toBeNull()
      expect(stroked.pick(5, 40)).toBeNull()
      // (a transparent stroke is a stroke to the pick, as it is to vega's)
      expect(index(scene({ stroke: { value: 'transparent' }, strokeWidth: { value: 6 } })).pick(11, 40)).not.toBeNull()
    })
    it('the cursor tracker shows the frame\'s cursor over the empty plot and the mark\'s over the mark', () => {
      const idx = index(scene({ fill: { value: '#eee' } }))
      const seen: Array<string | null> = []
      const t = createCursorTracker({ pick: (x, y) => idx.pick(x, y), user: () => undefined, onCursor: (c) => seen.push(c) })
      t.move(30, 30)
      t.move(60, 50)
      t.move(5, 5)
      expect(seen).toEqual(['text', 'pointer', 'default'])
    })
  })
}
