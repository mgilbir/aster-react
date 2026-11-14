// @vitest-environment jsdom
/**
 * An append costs what was appended, not what was left alone: the DOM patcher's dense symbol chunks and the canvas append
 * path prove an engine-made items array unchanged from its `__editGen` stamp instead of reading every unchanged item's
 * `__gen` (the reads are counted), and the output stays the old implementation's.
 */
import { describe, expect, it } from 'vitest'
import { createChartStream } from './stream.js'
import { patchSceneDom, sceneToDomDesc } from './dom.js'
import { sceneToDomDesc as legacyDomDesc } from './legacy-dom.testlib.js'
import { renderSceneToCanvasAppend, snapshotCanvasScene } from './canvas.js'
import { renderSceneToCanvasAppend as legacyAppend, snapshotCanvasScene as legacySnapshot } from './legacy-canvas.testlib.js'
import { loggingContext } from './geometry-differential.testlib.js'
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'

const rows = (n: number, from = 0): Array<{ x: number; y: number }> =>
  Array.from({ length: n }, (_, i) => ({ x: ((from + i) % 997) / 997, y: (((from + i) * 7) % 100) / 10 }))

const symbols = (data: string, fill: string): Record<string, unknown> => ({
  type: 'symbol', from: { data },
  encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 8 }, fill: { value: fill } } },
})
const spec = (marks: Array<Record<string, unknown>>, data: string[]): Record<string, unknown> => ({
  width: 400, height: 300, padding: 0, autosize: 'none',
  data: data.map((name) => ({ name, values: [] })),
  scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 400] }, { name: 'y', type: 'linear', domain: [0, 10], range: [300, 0] }],
  marks,
})

/** Counts the reads of `__gen` on every item there is now; returns the counter. */
function countGenReads(items: readonly SceneItem[]): { n: number } {
  const counter = { n: 0 }
  for (const it of items) {
    const value = it.__gen
    Object.defineProperty(it, '__gen', { get: () => { counter.n++; return value }, configurable: true, enumerable: true })
  }
  return counter
}

const markOf = (scene: SceneRoot, i: number): SceneGroup => scene.items[i] as SceneGroup

describe('an append costs the appended items', () => {
  it('dense DOM chunks: no unchanged item is read, and the patch matches the old implementation', () => {
    const stream = createChartStream(spec([symbols('t', '#4c78a8')], ['t']) as never, { capacity: 8 })
    stream.push({ data: { t: rows(3000) } })
    let scene = stream.flush()!.scene
    // both implementations see the same history: the first scene, then each append (their chunk caches follow it)
    const o = { denseMarks: true }
    expect(JSON.stringify(sceneToDomDesc(scene, o))).toBe(JSON.stringify(legacyDomDesc(scene, o)))
    for (let k = 0; k < 6; k++) {
      stream.push({ append: { t: rows(1 + k, 3000 + k * 10) } })
      const prevItems = markOf(scene, 0).items as SceneItem[]
      const before = prevItems.slice()
      scene = stream.flush()!.scene
      const legacy = JSON.stringify(legacyDomDesc(scene, o))
      const reads = countGenReads(before)
      const desc = JSON.stringify(sceneToDomDesc(scene, o))
      expect(reads.n).toBe(0)
      expect(desc).toBe(legacy)
    }
    // and the DOM patch itself, append after append
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    document.body.appendChild(svg)
    patchSceneDom(svg, scene, o)
    stream.push({ append: { t: rows(2, 9000) } })
    scene = stream.flush()!.scene
    patchSceneDom(svg, scene, o)
    expect(svg.querySelectorAll('path').length).toBeGreaterThan(0)
  })

  it('canvas append: a mark left alone is not read, and the paint matches the old implementation', () => {
    const stream = createChartStream(spec([symbols('a', '#f58518'), symbols('t', '#4c78a8')], ['a', 't']) as never, { capacity: 8 })
    stream.push({ data: { a: rows(2000, 50000), t: rows(500) } })
    let scene = stream.flush()!.scene
    for (let k = 0; k < 4; k++) {
      const prev = scene
      const legacySnap = legacySnapshot(prev)
      const snap = snapshotCanvasScene(prev)
      const reads = countGenReads(markOf(prev, 0).items as SceneItem[])
      stream.push({ append: { t: rows(3, 600 + k * 3) } })
      scene = stream.flush()!.scene
      expect(markOf(scene, 0)).toBe(markOf(prev, 0))
      const a = loggingContext()
      const b = loggingContext()
      const okOld = legacyAppend(legacySnap, scene, a.ctx)
      reads.n = 0
      const okNew = renderSceneToCanvasAppend(snap, scene, b.ctx)
      expect(okNew).toBe(okOld)
      expect(okNew).toBe(true)
      expect(reads.n).toBe(0)
      expect(b.log).toEqual(a.log)
    }
  })
})
