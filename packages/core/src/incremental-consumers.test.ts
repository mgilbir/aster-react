// @vitest-environment jsdom
/**
 * Hot consumers of a streamed scene must never read a SUPERSEDED group: its
 * `items` is a lazy snapshot, and reading it materialises an O(n) copy. In
 * steady state (one-row appends) the canvas append paint, the DOM patch, the
 * hit index and the stream itself must advance the materialisation counter by
 * exactly zero.
 */
import { describe, it, expect } from 'vitest'
import { createChartStream } from './stream.js'
import { renderSceneToCanvasAppend, snapshotCanvasScene } from './canvas.js'
import { patchSceneDom } from './addon-dom.js'
import { buildHitIndex } from './hit.js'
import { supersededMaterializations, evaluateChart } from './runtime.js'
import { compileChart } from './compiler.js'

const spec = {
  width: 400, height: 300, padding: 0, autosize: 'none', data: [{ name: 't', values: [] }],
  scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 400] }, { name: 'y', type: 'linear', domain: [0, 10], range: [300, 0] }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 8 } } } }],
}
const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ x: ((from + i) % 1000) / 1000, y: (((from + i) * 7) % 100) / 10 }))
const noop = (): void => {}
const ctx = new Proxy({ globalAlpha: 1, lineWidth: 1 } as Record<string, unknown>, {
  get: (t, k: string) => (k in t ? t[k] : noop),
  set: (t, k: string, v) => ((t[k] = v), true),
}) as never

describe('steady-state consumers never materialise a superseded scene', () => {
  const run = (frames: number, paint: (scene: ReturnType<ReturnType<typeof createChartStream>['scene']> & object, prevSnap: ReturnType<typeof snapshotCanvasScene> | null) => boolean) => {
    const N = 2000
    const s = createChartStream(spec as never, { initial: { data: { t: rows(N) } } })
    let scene = s.flush()!.scene
    let snap = snapshotCanvasScene(scene)
    let painted = 0
    const before = { v: -1 }
    for (let i = 0; i < frames; i++) {
      s.push({ append: { t: rows(1, N + i) } })
      if (i === 3) before.v = supersededMaterializations()
      scene = s.flush()!.scene
      if (i >= 3 && paint(scene, snap)) painted++
      else if (i < 3) paint(scene, snap)
      snap = snapshotCanvasScene(scene)
    }
    return { delta: supersededMaterializations() - before.v, painted }
  }

  it('canvas append paint', () => {
    const r = run(20, (scene, snap) => renderSceneToCanvasAppend(snap!, scene, ctx, { dpr: 1 }))
    expect(r.painted).toBe(17) // the append path engaged every frame (no full-repaint fallback)
    expect(r.delta).toBe(0)
  })

  it('DOM patch, hit index', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as unknown as Element
    document.body.appendChild(svg)
    const r = run(20, (scene) => {
      patchSceneDom(svg, scene)
      buildHitIndex(scene)
      return true
    })
    expect(r.delta).toBe(0)
  })

  it('the counter is live: reading an old scene does materialise', () => {
    const s = createChartStream(spec as never, { initial: { data: { t: rows(50) } } })
    const first = s.flush()!.scene
    s.push({ append: { t: rows(1, 50) } })
    s.flush()
    const before = supersededMaterializations()
    const g = first.items.find((x) => x.role === 'mark')!
    expect(g.items).toHaveLength(50)
    expect(supersededMaterializations()).toBe(before + 1)
  })

  it('an in-place edit of an existing item is not painted as a pure append', () => {
    const chart = compileChart(spec as never)
    const a = evaluateChart(chart, { data: { t: rows(10) } })
    const snap = snapshotCanvasScene(a)
    const next = [...rows(10)]
    next[2] = { x: 0.9, y: 9 }
    next.push(...rows(1, 10))
    const b = evaluateChart(chart, { data: { t: next }, dataPulse: { t: { changed: [2], appendOnly: true, baseLength: 10, added: [[10, 11]] } } })
    expect(renderSceneToCanvasAppend(snap, b, ctx, { dpr: 1 })).toBe(false)
    // and a pure append right after is painted incrementally again
    const snap2 = snapshotCanvasScene(b)
    const c = evaluateChart(chart, { data: { t: [...next, ...rows(1, 11)] }, dataPulse: { t: { changed: [], appendOnly: true, baseLength: 11, added: [[11, 12]] } } })
    expect(renderSceneToCanvasAppend(snap2, c, ctx, { dpr: 1 })).toBe(true)
  })
})
