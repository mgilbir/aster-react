/**
 * The paint recorder behind the append, same-pixels and regression oracles has to SEE every property of a paint: an oracle that
 * compares two recordings is only as strong as what they record. Each pair below paints one thing differently, and must
 * compare unequal both ways the oracles compare (the multiset diff and the serialised sequence); the control pairs are the
 * differences the recorder always saw.
 */
import { describe, expect, it } from 'vitest'
import { renderSceneToCanvas } from './canvas.js'
import { diffPaintMultisets, makeRecorder } from './canvas-record.testlib.js'
import type { SceneRoot } from './types.js'

const sceneOf = (marktype: string, item: Record<string, unknown>, mark: Record<string, unknown> = {}): SceneRoot =>
  ({ width: 100, height: 100, items: [{ marktype, ...mark, items: [item] }] }) as unknown as SceneRoot

const paint = (scene: SceneRoot): ReturnType<typeof makeRecorder>['records'] => {
  const { ctx, records } = makeRecorder()
  renderSceneToCanvas(scene, ctx, { batchSymbols: false })
  return records
}

const bitmap = { width: 20, height: 20, complete: true }
const text = (extra: Record<string, unknown>): SceneRoot => sceneOf('text', { x: 20, y: 20, text: 'hi', fill: '#000', fontSize: 12, ...extra })
const rect = (extra: Record<string, unknown>): SceneRoot => sceneOf('rect', { x: 5, y: 5, width: 40, height: 30, fill: '#336', ...extra })
const line = (extra: Record<string, unknown>): SceneRoot => sceneOf('line', { x: 5, y: 5, stroke: '#000', strokeWidth: 2, strokeDash: [4, 2], ...extra })

const PAIRS: Array<[string, SceneRoot, SceneRoot]> = [
  ['text angle', text({ angle: 0 }), text({ angle: 30 })],
  ['text blend', text({}), text({ blend: 'multiply' })],
  ['text stroke', text({}), text({ stroke: '#f00' })],
  ['text stroke width', text({ stroke: '#f00', strokeWidth: 1 }), text({ stroke: '#f00', strokeWidth: 3 })],
  ['text stroke dash offset', text({ stroke: '#f00', strokeDash: [2, 1] }), text({ stroke: '#f00', strokeDash: [2, 1], strokeDashOffset: 1 })],
  ['rect blend', rect({}), rect({ blend: 'screen' })],
  ['stroke dash offset', line({ strokeDashOffset: 0 }), line({ strokeDashOffset: 3 })],
  ['image present', sceneOf('image', { x: 5, y: 5, width: 20, height: 20, image: bitmap }), sceneOf('image', { x: 5, y: 5, width: 20, height: 20 })],
  ['image position', sceneOf('image', { x: 5, y: 5, width: 20, height: 20, image: bitmap }), sceneOf('image', { x: 6, y: 5, width: 20, height: 20, image: bitmap })],
  ['image blend', sceneOf('image', { x: 5, y: 5, width: 20, height: 20, image: bitmap }), sceneOf('image', { x: 5, y: 5, width: 20, height: 20, image: bitmap, blend: 'multiply' })],
  // controls: the differences the recorder has always seen
  ['control: fill colour', rect({ fill: '#336' }), rect({ fill: '#633' })],
  ['control: stroke cap', line({ strokeCap: 'butt' }), line({ strokeCap: 'round' })],
  ['control: stroke join', line({ strokeJoin: 'miter' }), line({ strokeJoin: 'bevel' })],
  ['control: symbol angle', sceneOf('symbol', { x: 20, y: 20, size: 200, shape: 'square', fill: '#000', angle: 0 }), sceneOf('symbol', { x: 20, y: 20, size: 200, shape: 'square', fill: '#000', angle: 40 })],
]

describe('the paint recorder sees what a paint is made of', () => {
  it.each(PAIRS)('%s', (_name, a, b) => {
    const ra = paint(a)
    const rb = paint(b)
    expect(ra.length, 'the scene painted something').toBeGreaterThan(0)
    expect(diffPaintMultisets(ra, rb), 'multiset (the append oracle)').not.toBeNull()
    expect(JSON.stringify(ra), 'sequence (the same-pixels oracle)').not.toBe(JSON.stringify(rb))
  })

  it('and records the same paint twice the same (no state of its own leaks into a record)', () => {
    for (const [, a] of PAIRS) {
      expect(diffPaintMultisets(paint(a), paint(a))).toBeNull()
      expect(JSON.stringify(paint(a))).toBe(JSON.stringify(paint(a)))
    }
  })
})
