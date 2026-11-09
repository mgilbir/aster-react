import { describe, it, expect } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg } from './index.js'
import { createChartSession } from './addon-dom.js'
import { createSceneTransition, easingFunction, EASING_NAMES } from './transition.js'
import type { SceneGroup, SceneItem, SceneRoot, VgSpec } from './types.js'

type Row = Record<string, unknown>

/** Every data mark of a type, depth first. */
function marksOf(scene: SceneRoot, type: string): SceneGroup[] {
  const out: SceneGroup[] = []
  const walk = (nodes: readonly SceneItem[] | undefined): void => {
    for (const n of nodes ?? []) {
      const g = n as SceneGroup
      if (g.marktype === type && g.role === 'mark') out.push(g)
      if (Array.isArray(g.items)) walk(g.items as SceneItem[])
    }
  }
  walk(scene.items as SceneItem[])
  return out
}
const itemsOf = (scene: SceneRoot, type: string): Row[] => marksOf(scene, type).flatMap((g) => (g.items ?? []) as unknown as Row[])
const byKey = (items: Row[], k: string): Row => {
  const found = items.find((it) => (it.datum as Row | undefined)?.k === k)
  if (!found) throw new Error(`no item ${k}`)
  return found
}

/** Bars at fixed pixel positions (x from the row) over a fixed y scale: the baseline is y = 100. */
function bars(rows: Row[], opts: { key?: boolean; fill?: string } = {}): VgSpec {
  return {
    width: 100, height: 100, padding: 0, autosize: 'none',
    data: [{ name: 't', values: rows }],
    scales: [{ name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
    marks: [{
      type: 'rect', from: { data: 't' }, ...(opts.key === false ? {} : { key: 'k' }),
      encode: { update: { x: { field: 'x' }, width: { value: 10 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 }, fill: opts.fill ? { field: opts.fill } : { value: 'steelblue' } } },
    }],
  }
}
const evaluate = (spec: VgSpec): SceneRoot => evaluateChart(compileChart(spec), {})

const A = [{ k: 'a', x: 0, v: 1 }, { k: 'b', x: 20, v: 2 }, { k: 'c', x: 40, v: 3 }]
const B = [{ k: 'b', x: 0, v: 4 }, { k: 'c', x: 20, v: 5 }, { k: 'd', x: 40, v: 6 }]

describe('createSceneTransition', () => {
  it('pairs the items of a keyed mark by key: b continues from where b was, d enters, a leaves', () => {
    const from = evaluate(bars(A))
    const to = evaluate(bars(B))
    const tr = createSceneTransition(from, to, { easing: 'linear' })
    expect(tr.moves).toBe(true)
    const f0 = itemsOf(tr.at(0), 'rect')
    expect(f0).toHaveLength(4) // three of `to`, and `a` on its way out
    expect(byKey(f0, 'b').x).toBe(20)
    expect(byKey(f0, 'b').height).toBeCloseTo(20)
    expect(byKey(f0, 'c').x).toBe(40)
    expect(byKey(f0, 'a').x).toBe(0)
    const half = itemsOf(tr.at(0.5), 'rect')
    expect(byKey(half, 'b').x).toBeCloseTo(10)
    expect(byKey(half, 'b').height).toBeCloseTo(30) // 20 -> 40
  })

  it('without a key, items are paired by their index in the mark (vega\'s fallback)', () => {
    const from = evaluate(bars(A, { key: false }))
    const to = evaluate(bars(B, { key: false }))
    const f0 = itemsOf(createSceneTransition(from, to, { easing: 'linear' }).at(0), 'rect')
    expect(f0).toHaveLength(3) // nothing enters or leaves: three and three
    // the first item (b in `to`) starts where the first item of `from` (a) was
    expect((f0[0]!.datum as Row).k).toBe('b')
    expect(f0[0]!.x).toBe(0)
    expect(f0[0]!.height).toBeCloseTo(10)
  })

  it('an entering rect grows out of the shared baseline and a leaving one shrinks into it', () => {
    const from = evaluate(bars(A))
    const to = evaluate(bars(B))
    const tr = createSceneTransition(from, to, { easing: 'linear' })
    const d0 = byKey(itemsOf(tr.at(0), 'rect'), 'd')
    expect(d0.y).toBeCloseTo(100)
    expect(d0.height).toBe(0)
    expect(d0.opacity).toBeUndefined() // it grows, it does not fade
    const dHalf = byKey(itemsOf(tr.at(0.5), 'rect'), 'd')
    expect(dHalf.height).toBeCloseTo(30) // 0 -> 60
    expect(dHalf.y).toBeCloseTo(70)
    const aLate = byKey(itemsOf(tr.at(0.75), 'rect'), 'a')
    expect(aLate.height).toBeCloseTo(2.5) // 10 -> 0
    expect(aLate.y).toBeCloseTo(97.5) // its top goes down to the baseline
    expect(itemsOf(tr.at(1), 'rect')).toHaveLength(3) // gone at the end
  })

  it('rects with no common baseline (the rows of a heatmap meet at an edge, they do not sit on one) fade in and out instead', () => {
    const cells = (rows: Row[]): VgSpec => ({
      width: 100, height: 100, padding: 0, autosize: 'none',
      data: [{ name: 't', values: rows }],
      marks: [{ type: 'rect', from: { data: 't' }, key: 'k', encode: { update: { x: { field: 'x' }, y: { field: 'y' }, width: { value: 10 }, height: { value: 10 }, fill: { value: 'red' } } } }],
    })
    // a 2 x 2 grid: a b / c d; `from` has a, b, c and `to` has b, c, d
    const from = evaluate(cells([{ k: 'a', x: 0, y: 0 }, { k: 'b', x: 10, y: 0 }, { k: 'c', x: 0, y: 10 }]))
    const to = evaluate(cells([{ k: 'b', x: 10, y: 0 }, { k: 'c', x: 0, y: 10 }, { k: 'd', x: 10, y: 10 }]))
    const tr = createSceneTransition(from, to, { easing: 'linear' })
    const frame = itemsOf(tr.at(0.25), 'rect')
    const d = byKey(frame, 'd')
    expect([d.x, d.y, d.height, d.width]).toEqual([10, 10, 10, 10])
    expect(d.opacity).toBeCloseTo(0.25)
    const a = byKey(frame, 'a')
    expect([a.x, a.y, a.height]).toEqual([0, 0, 10])
    expect(a.opacity).toBeCloseTo(0.75)
  })

  it('symbols fade: an entering one from transparent, a leaving one to transparent', () => {
    const dots = (rows: Row[]): VgSpec => ({
      width: 100, height: 100, padding: 0, autosize: 'none',
      data: [{ name: 't', values: rows }],
      marks: [{ type: 'symbol', from: { data: 't' }, key: 'k', encode: { update: { x: { field: 'x' }, y: { value: 50 }, size: { value: 100 }, fill: { value: 'red' } } } }],
    })
    const from = evaluate(dots([{ k: 'a', x: 10 }, { k: 'b', x: 20 }]))
    const to = evaluate(dots([{ k: 'b', x: 60 }, { k: 'c', x: 90 }]))
    const tr = createSceneTransition(from, to, { easing: 'linear' })
    const f0 = itemsOf(tr.at(0), 'symbol')
    expect(byKey(f0, 'c').opacity).toBe(0)
    expect(byKey(f0, 'c').x).toBe(90) // in place, only transparent
    expect(byKey(f0, 'a').opacity).toBe(1)
    const mid = itemsOf(tr.at(0.5), 'symbol')
    expect(byKey(mid, 'c').opacity).toBeCloseTo(0.5)
    expect(byKey(mid, 'a').opacity).toBeCloseTo(0.5)
    expect(byKey(mid, 'b').x).toBeCloseTo(40)
    expect(byKey(mid, 'b').opacity).toBeUndefined() // a paired item that stays opaque is not given an opacity
  })

  it('fill and stroke colours mix in RGB; what does not parse (a gradient) is the target from the start', () => {
    const from = evaluate(bars([{ k: 'a', x: 0, v: 1, c: '#ff0000' }, { k: 'b', x: 20, v: 1, c: 'red' }], { fill: 'c' }))
    const to = evaluate(bars([{ k: 'a', x: 0, v: 1, c: '#0000ff' }, { k: 'b', x: 20, v: 1, c: 'none' }], { fill: 'c' }))
    const tr = createSceneTransition(from, to, { easing: 'linear' })
    expect(byKey(itemsOf(tr.at(0), 'rect'), 'a').fill).toBe('#ff0000') // the first frame draws the colour as it was written
    const mid = itemsOf(tr.at(0.5), 'rect')
    expect(byKey(mid, 'a').fill).toBe('rgb(128,0,128)')
    expect(byKey(mid, 'b').fill).toBe('none')
    expect(renderSceneToSvg(tr.at(0.5))).toContain('fill="rgb(128,0,128)"')
  })

  it('a line moves point by point when the point count is the same, and is drawn as the target has it when it changes', () => {
    const line = (ys: number[]): VgSpec => ({
      width: 100, height: 100, padding: 0, autosize: 'none',
      data: [{ name: 't', values: ys.map((y, i) => ({ i, y })) }],
      marks: [{ type: 'line', from: { data: 't' }, encode: { update: { x: { field: 'i', mult: 10 }, y: { field: 'y' }, stroke: { value: 'black' } } } }],
    })
    const from = evaluate(line([0, 10, 20]))
    const same = evaluate(line([20, 30, 40]))
    const mid = itemsOf(createSceneTransition(from, same, { easing: 'linear' }).at(0.5), 'line')
    expect(mid.map((p) => p.y)).toEqual([10, 20, 30])
    const more = evaluate(line([20, 30, 40, 50]))
    const tr = createSceneTransition(from, more, { easing: 'linear' })
    expect(marksOf(tr.at(0.5), 'line')[0]).toBe(marksOf(more, 'line')[0]) // the series itself, not a copy
  })

  it('axis grid lines, ticks and labels pair by tick value: shared ticks slide, new ones fade in, gone ones fade out', () => {
    const axisSpec = (max: number): VgSpec => ({
      width: 100, height: 100, padding: 0, autosize: 'none',
      data: [{ name: 't', values: [{ v: 0 }, { v: max }] }],
      scales: [{ name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height', nice: true }],
      axes: [{ scale: 'y', orient: 'left', grid: true }],
    })
    const from = evaluate(axisSpec(5)) // ticks 0, 0.5, 1, ..., 5
    const to = evaluate(axisSpec(10)) // ticks 0, 1, ..., 10
    const labels = (s: SceneRoot): Row[] => {
      const axis = (s.items as SceneGroup[]).find((g) => g.role === 'axis' && g.orient === 'left' && (g.items ?? []).some((l) => (l as SceneItem)._part === 'label'))!
      return (axis.items as unknown as Row[]).filter((l) => l._part === 'label')
    }
    const at = (rows: Row[], text: string): Row => rows.find((l) => l.text === text)!
    const tr = createSceneTransition(from, to, { easing: 'linear' })
    const yOf = (s: SceneRoot, text: string): number => at(labels(s), text).y as number
    // (a frame is rewritten by the next one: read it before asking for another)
    const start = labels(tr.at(0))
    expect(at(start, '2').y).toBeCloseTo(yOf(from, '2.0'))
    expect(at(start, '7').opacity).toBe(0)
    const mid = labels(tr.at(0.5))
    // the tick at 2 is in both: it slides from where it was to where it goes
    expect(at(mid, '2').y).toBeCloseTo((yOf(from, '2.0') + yOf(to, '2')) / 2)
    expect(at(mid, '2').opacity).toBe(1)
    // 7 is new: in its place, fading in; 0.5 is gone: in its old place, fading out
    expect(at(mid, '7').opacity).toBeCloseTo(0.5)
    expect(at(mid, '7').y).toBeCloseTo(yOf(to, '7'))
    expect(at(mid, '0.5').opacity).toBeCloseTo(0.5)
    expect(at(mid, '0.5').y).toBeCloseTo(yOf(from, '0.5'))
    expect(labels(tr.at(1)).map((l) => l.text)).toEqual(labels(to).map((l) => l.text))
  })

  it('t = 0 draws the first scene, t = 1 is the second scene itself, and neither scene is written', () => {
    const fromSpec = bars([{ k: 'a', x: 0, v: 1 }, { k: 'b', x: 20, v: 2 }])
    const from = evaluate(fromSpec)
    const to = evaluate(bars([{ k: 'a', x: 30, v: 7 }, { k: 'b', x: 60, v: 9 }]))
    const before = [renderSceneToSvg(from), renderSceneToSvg(to)]
    const tr = createSceneTransition(from, to)
    expect(renderSceneToSvg(tr.at(0))).toBe(before[0])
    renderSceneToSvg(tr.at(0.3))
    expect(tr.at(1)).toBe(to)
    expect(tr.at(2)).toBe(to)
    expect([renderSceneToSvg(from), renderSceneToSvg(to)]).toEqual(before)
  })

  it('two scenes that draw alike do not move', () => {
    const s = createChartSession()
    const a = s.evaluate(bars(A), {})
    const b = evaluate(bars(A))
    const tr = createSceneTransition(a, b)
    expect(tr.moves).toBe(false)
    expect(tr.at(0)).toBe(b)
  })

  it('an interrupted transition is the start of the next: it starts from the frame on screen', () => {
    const from = evaluate(bars(A))
    const mid = evaluate(bars(B))
    const next = evaluate(bars([{ k: 'b', x: 80, v: 10 }]))
    const first = createSceneTransition(from, mid, { easing: 'linear' })
    const shown = first.at(0.5)
    const bShown = byKey(itemsOf(shown, 'rect'), 'b')
    const [x, height] = [bShown.x, bShown.height]
    const second = createSceneTransition(shown, next, { easing: 'linear' })
    first.at(0.9) // the old transition's frame is rewritten after the next one was made from it: no effect on it
    const b0 = byKey(itemsOf(second.at(0), 'rect'), 'b')
    expect(b0.x).toBeCloseTo(x as number)
    expect(b0.height).toBeCloseTo(height as number)
    // c and d were in the frame (c moving, d growing) and are not in `next`: they leave from where they were
    const c0 = byKey(itemsOf(second.at(0), 'rect'), 'c')
    expect(c0.height).toBeCloseTo(40)
    expect(second.at(1)).toBe(next)
  })

  it('group items of a facet are paired by the facet key', () => {
    const faceted = (series: string[]): VgSpec => ({
      width: 100, height: 100, padding: 0, autosize: 'none',
      data: [{ name: 't', values: series.flatMap((s, i) => [{ s, x: 0, y: i * 10 }, { s, x: 50, y: i * 10 + 5 }]) }],
      marks: [{
        type: 'group', from: { facet: { name: 'f', data: 't', groupby: 's' } },
        marks: [{ type: 'line', from: { data: 'f' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, stroke: { value: 'black' } } } }],
      }],
    })
    const from = evaluate(faceted(['p', 'q']))
    const to = evaluate(faceted(['n', 'p', 'q']))
    const groups = (s: SceneRoot): SceneGroup[] => (s.items as SceneGroup[]).filter((g) => g.marktype === 'group' && !g.role?.startsWith('axis'))
    expect(groups(to)[0]!.__keyFields).toEqual(['s'])
    const f0 = createSceneTransition(from, to, { easing: 'linear' }).at(0)
    const series = groups(f0).map((g) => {
      const line = ((g.items ?? []) as SceneGroup[]).find((m) => m.marktype === 'line')!
      return { s: (g.datum as Row).s, y0: ((line.items ?? [])[0] as SceneItem).y, o: ((line.items ?? [])[0] as SceneItem).opacity }
    })
    // p continues from p (y 0), q from q (y 10); n is new and fades in
    expect(series).toEqual([{ s: 'n', y0: 0, o: 0 }, { s: 'p', y0: 0, o: undefined }, { s: 'q', y0: 10, o: undefined }])
  })

  it('easings: the named curves end where they start and finish, and an unknown name is refused', () => {
    for (const name of EASING_NAMES) {
      const fn = easingFunction(name)
      expect(fn(0)).toBeCloseTo(0)
      expect(fn(1)).toBeCloseTo(1)
    }
    expect(easingFunction('cubic-in-out')(0.25)).toBeCloseTo(0.0625)
    expect(easingFunction()(0.25)).toBeCloseTo(0.0625)
    const own = (t: number): number => t
    expect(easingFunction(own)).toBe(own)
    expect(() => easingFunction('bounce' as never)).toThrow(/unknown easing/)
  })
})
