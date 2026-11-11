// @vitest-environment jsdom
// (the player draws frames from requestAnimationFrame, which only a DOM environment has)
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { compileChart, evaluateChart } from './index.js'
import { Bounds } from './bounds.js'
import { createScenePlayer, drawsSame } from './transition.js'
import type { SceneGroup, SceneRoot, VgSpec } from './types.js'

// Two bars over a fixed y scale, and a signal `tick` that nothing drawn reads (a Vega-Lite `time` animation's clock between
// two frames), next to `w`, the bars' width.
const spec = (rows: Array<{ x: number; v: number }>): VgSpec => ({
  width: 100, height: 100, padding: 0, autosize: 'none',
  signals: [{ name: 'tick', value: 0 }, { name: 'w', value: 10 }],
  data: [{ name: 't', values: rows }],
  scales: [{ name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
  marks: [{
    type: 'rect', from: { data: 't' },
    encode: { update: { x: { field: 'x' }, width: { signal: 'w' }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 }, fill: { value: 'steelblue' } } },
  }],
})
const A = [{ x: 0, v: 2 }, { x: 20, v: 4 }]
const B = [{ x: 0, v: 8 }, { x: 60, v: 4 }]
// every evaluation compiles afresh: no object is shared between two scenes
const scene = (rows: typeof A, signals: Record<string, unknown> = {}): SceneRoot => evaluateChart(compileChart(spec(rows)), { signals })
const firstMark = (s: SceneRoot): SceneGroup => s.items.find((g) => g.marktype === 'rect') as SceneGroup

describe('drawsSame', () => {
  it('two evaluations that draw alike are the same, though they share no object and differ in what is not drawn', () => {
    const a = scene(B)
    const b = scene(B, { tick: 7 })
    expect(firstMark(a)).not.toBe(firstMark(b))
    expect((a as unknown as { signalParams: Record<string, unknown> }).signalParams.tick).not.toBe((b as unknown as { signalParams: Record<string, unknown> }).signalParams.tick)
    expect(drawsSame(a, b)).toBe(true)
    expect(drawsSame(a, a)).toBe(true)
  })

  it('a change to anything drawn is not the same: an item\'s geometry, an item more, the view', () => {
    const b = scene(B)
    expect(drawsSame(b, scene(B, { w: 11 }))).toBe(false)
    expect(drawsSame(b, scene([...B, { x: 80, v: 1 }]))).toBe(false)
    expect(drawsSame(b, scene(A))).toBe(false)
    const wider = { ...b, width: b.width + 1 }
    expect(drawsSame(b, wider)).toBe(false)
    // a key only one of them has, in either order
    const fewer: Record<string, unknown> = { ...b }
    delete fewer.width
    expect('width' in b).toBe(true)
    expect(drawsSame(fewer as unknown as SceneRoot, b)).toBe(false)
    expect(drawsSame(b, fewer as unknown as SceneRoot)).toBe(false)
  })
})

describe('drawsSame: the values a node holds', () => {
  const withValue = (v: unknown): SceneRoot => ({ ...scene(B), meta: v } as unknown as SceneRoot)
  const bounds = (x2: number): Bounds => { const b = new Bounds(); b.x1 = 0; b.y1 = 0; b.x2 = x2; b.y2 = 5; return b }

  it('compares nested plain data, class instances and maps by what they hold', () => {
    const deep = (n: number): unknown => ({ a: [{ b: { c: { d: [n] } } }] })
    expect(drawsSame(withValue(deep(1)), withValue(deep(1)))).toBe(true)
    expect(drawsSame(withValue(deep(1)), withValue(deep(2)))).toBe(false)
    expect(drawsSame(withValue(bounds(3)), withValue(bounds(3)))).toBe(true)
    expect(drawsSame(withValue(bounds(3)), withValue(bounds(4)))).toBe(false)
    // the same fields in a plain object are not a Bounds
    expect(drawsSame(withValue({ x1: 0, y1: 0, x2: 3, y2: 5 }), withValue(bounds(3)))).toBe(false)
    expect(drawsSame(withValue(new Map([['k', [1]]])), withValue(new Map([['k', [1]]])))).toBe(true)
    expect(drawsSame(withValue(new Map([['k', [1]]])), withValue(new Map([['k', [2]]])))).toBe(false)
  })

  it('is not the same for what it cannot look into (a built-in object), for a cycle, or past its budget', () => {
    expect(drawsSame(withValue(new Date(1)), withValue(new Date(1)))).toBe(false)
    expect(drawsSame(withValue(new Date(1)), withValue(new Date(2)))).toBe(false)
    const cyclic = (): Record<string, unknown> => { const o: Record<string, unknown> = { n: 1 }; o.self = o; return o }
    expect(drawsSame(withValue(cyclic()), withValue(cyclic()))).toBe(false)
    // 90,000 objects to look into: past the budget
    const huge = (): Array<Array<{ v: number }>> => Array.from({ length: 300 }, () => Array.from({ length: 300 }, () => ({ v: 1 })))
    expect(drawsSame(withValue(huge()), withValue(huge()))).toBe(false)
  })
})

describe('createScenePlayer: a scene that draws like the end of the running transition', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] }) })
  afterEach(() => { vi.useRealTimers() })

  const play = (): { painted: SceneRoot[]; player: ReturnType<typeof createScenePlayer<string>> } => {
    const painted: SceneRoot[] = []
    const player = createScenePlayer<string>((_t, s) => { painted.push(s) }, (e) => { throw e }, scene(A))
    player.draw('svg', scene(B), { duration: 300, easing: 'linear' })
    return { painted, player }
  }

  it('keeps the plan (the same frame scene, moving on the same clock) and settles on the new scene object', () => {
    const { painted, player } = play()
    vi.advanceTimersByTime(100)
    const frame = painted.at(-1)!
    const end = scene(B, { tick: 1 })
    player.draw('svg', end, null)
    vi.advanceTimersByTime(50)
    // `at(t)` rewrites one frame scene in place: the same object is still being drawn, so the plan was kept
    expect(painted.at(-1)).toBe(frame)
    vi.advanceTimersByTime(300)
    expect(painted.at(-1)).toBe(end)
  })

  it('a scene that draws differently is planned again, from where the transition started', () => {
    const { painted, player } = play()
    vi.advanceTimersByTime(100)
    const frame = painted.at(-1)!
    const end = scene(B, { w: 20 })
    player.draw('svg', end, null)
    expect(painted.at(-1)).not.toBe(frame)
    vi.advanceTimersByTime(400)
    expect(painted.at(-1)).toBe(end)
  })
})
