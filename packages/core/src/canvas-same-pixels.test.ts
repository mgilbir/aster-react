/**
 * `paintsSameAs`: a scene that paints exactly the pixels of the frame on the canvas needs no paint. The chart-bench survival chart's
 * pointer moves change only the tooltip of a transparent rect, and every move repainted the whole canvas (6,000 points of lines and
 * areas, about 460 ms of a 60-move sweep in Chromium).
 *
 * What it reads of a scene is checked against what the renderer draws: for every scene of a signal walk, whenever it says "the same",
 * the canvas commands a full repaint of the new scene records equal those of the scene painted before (the pixel oracle in
 * conformance, browser-canvas-dirty.mts, compares real Chromium pixels). Each kind of change that paints differently is told.
 */
import { describe, expect, it } from 'vitest'
import { createChartSession } from './session.js'
import { paintsSameAs, renderSceneToCanvas, snapshotCanvasScene } from './canvas.js'
import { canvasDirtyScenario } from './canvas-dirty-scenario.testlib.js'
import { makeRecorder } from './canvas-record.testlib.js'
import type { SceneRoot, VgSpec } from './types.js'

const record = (scene: SceneRoot): string => {
  const { ctx, records } = makeRecorder()
  renderSceneToCanvas(scene, ctx, { dpr: 1 })
  return JSON.stringify(records)
}

const SURVIVAL = {
  width: 300, height: 200, padding: 10, autosize: 'none',
  signals: [{ name: 'hoverX', value: null }, { name: 'hi', value: 'a' }, { name: 'background', value: 'white' }],
  data: [{ name: 't', values: Array.from({ length: 30 }, (_, i) => ({ k: 'abc'[i % 3], x: i, y: (i * 7) % 11 })) }],
  scales: [{ name: 'x', type: 'linear', domain: [0, 30], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 11], range: 'height' }],
  axes: [{ scale: 'x', orient: 'bottom' }],
  marks: [
    { type: 'group', from: { facet: { name: 'one', data: 't', groupby: 'k' } }, marks: [{ type: 'line', from: { data: 'one' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, stroke: { value: 'black' } } } }] },
    { type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, fill: { signal: "datum.k == hi ? 'red' : 'grey'" } } } },
    { type: 'rect', encode: { update: { x: { value: 0 }, x2: { signal: 'width' }, y: { value: 0 }, y2: { signal: 'height' }, fill: { value: 'transparent' }, tooltip: { signal: "'Day ' + hoverX" }, cursor: { signal: "hoverX > 10 ? 'pointer' : 'default'" } } } },
  ],
} as unknown as VgSpec

describe('a scene that paints the same pixels needs no paint', () => {
  it('a pointer move that changes only a tooltip and a cursor paints the same; a highlight, a background do not', () => {
    const session = createChartSession()
    let scene = session.evaluate(SURVIVAL, {})
    for (let i = 1; i <= 8; i++) {
      const next = session.evaluate(SURVIVAL, { signals: { hoverX: i * 3 } })
      expect(next).not.toBe(scene)
      expect(paintsSameAs(snapshotCanvasScene(scene), next)).toBe(true)
      scene = next
    }
    const highlighted = session.evaluate(SURVIVAL, { signals: { hoverX: 24, hi: 'b' } })
    expect(paintsSameAs(snapshotCanvasScene(scene), highlighted)).toBe(false)
    const dark = session.evaluate(SURVIVAL, { signals: { hoverX: 24, hi: 'b', background: 'black' } })
    expect(paintsSameAs(snapshotCanvasScene(highlighted), dark)).toBe(false)
  })

  it('whenever it says "the same", a full repaint of the new scene draws what the frame before drew', () => {
    let same = 0
    let differ = 0
    for (let seed = 1; seed <= 60; seed++) {
      let prev: SceneRoot | null = null
      for (const st of canvasDirtyScenario(seed, 12)) {
        if (prev !== null) {
          if (paintsSameAs(snapshotCanvasScene(prev), st.scene)) {
            same++
            expect(record(st.scene), `seed ${seed} step ${st.step} (${st.what})`).toBe(record(prev))
          } else if (record(st.scene) !== record(prev)) differ++
        }
        prev = st.scene
      }
    }
    // (the walk takes both roads)
    expect(same).toBeGreaterThan(20)
    expect(differ).toBeGreaterThan(20)
  })
})
