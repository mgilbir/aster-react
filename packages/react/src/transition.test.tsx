// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { compileChart, evaluateChart, type SceneRoot } from '@aster-charts/core'
import { createSceneAnimator, loadTransitions, resolveTransition } from './transition'
import { ChartStream, type ChartStreamHandle } from './ChartStream'

const spec = (v: number): SceneRoot => evaluateChart(compileChart({
  width: 100, height: 100, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [{ v }] }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, width: { value: 10 }, y: { field: 'v' }, y2: { value: 100 }, fill: { value: 'red' } } } }],
}), {})

describe('the scene animator', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // (this file's module state is its own: nothing has loaded the interpolation yet)
  it('draws a change at once while the interpolation module has not loaded, and animates once it has', async () => {
    const drawn: SceneRoot[] = []
    const animator = createSceneAnimator((_svg, scene) => { drawn.push(scene) }, (e) => { throw e })
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const [a, b, c] = [spec(10), spec(50), spec(90)]
    const options = resolveTransition(true)!
    animator.reset(a)
    animator.draw(svg, b, options)
    expect(drawn).toEqual([b])
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
    await loadTransitions()
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    animator.draw(svg, c, options)
    expect(drawn.at(-1)).not.toBe(c) // the first frame: b's picture, not c
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(400)
    expect(drawn.at(-1)).toBe(c)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resolves the prop: off, the defaults, and given options', () => {
    expect(resolveTransition(undefined)).toBeNull()
    expect(resolveTransition(false)).toBeNull()
    expect(resolveTransition(true)).toEqual({ duration: 300, easing: 'cubic-in-out', reducedMotion: 'user', maxItems: 1000 })
    expect(resolveTransition({ duration: 120, easing: 'linear', reducedMotion: 'never', maxItems: 50 })).toEqual({ duration: 120, easing: 'linear', reducedMotion: 'never', maxItems: 50 })
    expect(resolveTransition({ maxItems: -1 })!.maxItems).toBe(1000)
    expect(resolveTransition({ duration: -5 })!.duration).toBe(300)
  })
})

describe('<ChartStream transition>', () => {
  const streamSpec = {
    width: 100, height: 100, padding: 0, autosize: 'none',
    data: [{ name: 't', values: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }],
    scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' }, { name: 'y', type: 'linear', domain: [0, 4], range: 'height' }],
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 20 } } } }],
  } as never
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  const mount = async (transition: boolean): Promise<{ host: HTMLElement; ref: React.RefObject<ChartStreamHandle | null>; unmount(): void }> => {
    const ref = React.createRef<ChartStreamHandle>()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<ChartStream ref={ref} spec={streamSpec} width={100} height={100} streamOptions={{ autoFlush: false }} {...(transition ? { transition: { duration: 300, easing: 'linear' } } : {})} />)
      await vi.advanceTimersByTimeAsync(20)
    })
    return { host, ref, unmount: () => act(() => root.unmount()) }
  }
  const append = async (ref: React.RefObject<ChartStreamHandle | null>): Promise<void> => {
    await act(async () => {
      ref.current!.push({ append: { t: [{ x: 2, y: 3 }] } })
      ref.current!.flush()
      await vi.advanceTimersByTimeAsync(20)
    })
  }

  it('passes it to the chart: an appended scene animates (the x scale grows) and settles on the stream\'s scene', async () => {
    await loadTransitions()
    const animated = await mount(true)
    const plain = await mount(false)
    await append(animated.ref)
    await append(plain.ref)
    const svg = (h: HTMLElement): string => h.querySelector('svg')!.outerHTML
    expect(svg(animated.host)).not.toBe(svg(plain.host))
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(svg(animated.host)).toBe(svg(plain.host))
    animated.unmount()
    plain.unmount()
  })
})
