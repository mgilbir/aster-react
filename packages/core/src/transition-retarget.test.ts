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
    // the new plan runs from where the transition STARTED (A) to the new end, a third of the way (the old one was a third in): the
    // bars are at A + (end - A) / 3, not at the frame that was on screen (whose first bar is at y 60.8, which is where the old plan
    // had got to by the clock of its own easing)
    const geometry = (s: SceneRoot): number[][] => (firstMark(s).items as unknown as Array<{ x: number; y: number; width: number; height: number }>).map((i) => [i.x, i.y, i.width, i.height])
    const planned = geometry(painted.at(-1)!)
    const expected = [[0, 60, 40 / 3, 40], [100 / 3, 60, 40 / 3, 40]]
    expect(planned).toHaveLength(2)
    planned.forEach((row, i) => row.forEach((v, j) => expect(v).toBeCloseTo(expected[i]![j]!, 6)))
    expect(geometry(frame)[0]![1]).toBeCloseTo(60.8, 6)
    vi.advanceTimersByTime(400)
    expect(painted.at(-1)).toBe(end)
  })
})

describe('createScenePlayer: what the audit found (C146, C487)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] }) })
  afterEach(() => { vi.useRealTimers() })
  const xOf = (s: SceneRoot): number => (firstMark(s).items![1] as unknown as { x: number }).x

  it('C146: a new end that draws like the start moves back from the frame on screen, in the time left, without a jump', () => {
    const painted: SceneRoot[] = []
    const player = createScenePlayer<string>((_t, s) => { painted.push(s) }, (e) => { throw e }, scene(A))
    player.draw('svg', scene(B), { duration: 300, easing: 'linear' })
    vi.advanceTimersByTime(150)
    const mid = xOf(painted.at(-1)!)
    expect(mid).toBeGreaterThan(20)
    expect(mid).toBeLessThan(60)
    player.draw('svg', scene(A), null)
    // (the first frame after the retarget is where the marks were, then they move back towards x = 20)
    vi.advanceTimersByTime(20)
    const next = xOf(painted.at(-1)!)
    expect(next).toBeLessThanOrEqual(mid)
    expect(next).toBeGreaterThan(20)
    vi.advanceTimersByTime(200)
    expect(xOf(painted.at(-1)!)).toBe(20)
  })

  it.each([Infinity, 1e300, NaN, -5])('C487: a duration of %s requests no frames for ever', (duration) => {
    const painted: SceneRoot[] = []
    const player = createScenePlayer<string>((_t, s) => { painted.push(s) }, (e) => { throw e }, scene(A))
    const end = scene(B)
    player.draw('svg', end, { duration, easing: 'linear' })
    vi.advanceTimersByTime(61_000)
    expect(painted.at(-1)).toBe(end)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('C487: a first frame that fails is reported, nothing escapes draw, and the new scene is drawn', () => {
    const errors: Error[] = []
    const painted: SceneRoot[] = []
    let calls = 0
    const player = createScenePlayer<string>((_t, s) => { if (++calls === 1) throw new Error('paint failed'); painted.push(s) }, (e) => { errors.push(e) }, scene(A))
    const end = scene(B)
    expect(() => player.draw('svg', end, { duration: 300 })).not.toThrow()
    expect(errors.map((e) => e.message)).toEqual(['paint failed'])
    expect(painted.at(-1)).toBe(end)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('C487: an easing that answers NaN is reported and the change is drawn at once, never NaN coordinates', () => {
    const errors: Error[] = []
    const painted: SceneRoot[] = []
    const player = createScenePlayer<string>((_t, s) => { painted.push(s) }, (e) => { errors.push(e) }, scene(A))
    const end = scene(B)
    player.draw('svg', end, { duration: 300, easing: () => NaN })
    vi.advanceTimersByTime(400)
    expect(errors[0]?.message).toMatch(/easing answered NaN/)
    expect(painted.every((s) => Number.isFinite(xOf(s)))).toBe(true)
    expect(painted.at(-1)).toBe(end)
  })
})
