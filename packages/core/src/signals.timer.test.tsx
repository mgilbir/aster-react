// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg } from './index.js'
import { bindSceneSignals as bindRaw, type SignalBinding } from './signals.js'
import { setTimerClock, timers } from './timer.js'
import { FakeClock } from './timer.testlib.js'
import type { VgSpec } from './types.js'

const spec = (signals: unknown[]): VgSpec => ({
  width: 100,
  height: 60,
  signals,
  data: [{ name: 't', values: [{ x: 1 }] }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 5 }, width: { value: 20 }, y: { value: 5 }, height: { value: 20 }, fill: { value: '#4c78a8' } } } }],
}) as unknown as VgSpec

function mount(signals: unknown[]): { host: HTMLElement; svg: SVGSVGElement; scene: ReturnType<typeof evaluateChart> } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const scene = evaluateChart(compileChart(spec(signals)))
  host.innerHTML = renderSceneToSvg(scene)
  return { host, svg: host.querySelector('svg') as SVGSVGElement, scene }
}

/** Every binding a test makes is released afterwards, so one failing test cannot leak its timers into the next. */
const opened: SignalBinding[] = []
const bindSceneSignals: typeof bindRaw = (...args) => {
  const b = bindRaw(...args)
  opened.push(b)
  return b
}

let clock: FakeClock
beforeEach(() => {
  clock = new FakeClock(16)
  setTimerClock(clock)
})
afterEach(() => {
  for (const b of opened.splice(0)) b.release()
  clock.advance(10_000)
  expect(timers.pending()).toBe(0) // no test leaves a timer running
  clock.advance(100)
  expect(clock.active()).toEqual({ timeouts: 0, intervals: 0, frames: 0 })
  setTimerClock(null)
  document.body.innerHTML = ''
})

const sig = (name: string, events: unknown, update: string, value: unknown = 0) => ({ name, value, on: [{ events, update }] })

describe('timer event streams', () => {
  it('{type: "timer", throttle} ticks every throttle ms against the start (vega-view: d3-timer interval)', () => {
    const { svg, scene } = mount([sig('n', { type: 'timer', throttle: 100 }, 'n + 1')])
    const seen: number[] = []
    const b = bindSceneSignals(svg, scene, {}, { onSignal: (_n, v) => seen.push(v as number) })
    clock.advance(1050)
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    b.release()
  })

  it('the selector form `timer{100}` is the same stream, and a tick carries { timestamp, elapsed }', () => {
    const { svg, scene } = mount([sig('e', 'timer{100}', 'event.elapsed'), sig('hasStamp', 'timer{100}', 'isNumber(event.timestamp) ? 1 : 0')])
    const b = bindSceneSignals(svg, scene, {}, {})
    const store: Record<string, unknown> = {}
    b.release()
    const b2 = bindSceneSignals(svg, scene, store, { onSignal: (n, v) => { store[n] = v } })
    clock.advance(350)
    expect(store.e).toBe(300)
    expect(store.hasStamp).toBe(1)
    b2.release()
  })

  it('without a throttle the stream ticks on every animation frame', () => {
    const { svg, scene } = mount([sig('n', 'timer', 'n + 1')])
    const b = bindSceneSignals(svg, scene, {}, {})
    const store: Record<string, unknown> = {}
    b.release()
    const b2 = bindSceneSignals(svg, scene, store, { onSignal: (n, v) => { store[n] = v } })
    clock.advance(100)
    expect(store.n).toBe(6)
    b2.release()
  })

  it('a filter sees the tick: timer[event.elapsed > 250]{100}', () => {
    const { svg, scene } = mount([sig('n', 'timer[event.elapsed > 250]{100}', 'n + 1')])
    const store: Record<string, unknown> = {}
    const b = bindSceneSignals(svg, scene, store, { onSignal: (n, v) => { store[n] = v } })
    clock.advance(600)
    expect(store.n).toBe(4) // the ticks at 300, 400, 500 and 600 (the ones at 100 and 200 are filtered out)
    b.release()
  })

  it('detach keeps the timer running (a host re-binds after every render); the old binding hears nothing more', () => {
    const { svg, scene } = mount([sig('n', { type: 'timer', throttle: 100 }, 'n + 1')])
    const first: number[] = []
    const second: number[] = []
    const b1 = bindSceneSignals(svg, scene, {}, { onSignal: (_n, v) => first.push(v as number) })
    clock.advance(250)
    b1.detach()
    expect(timers.pending()).toBe(1)
    const b2 = bindSceneSignals(svg, scene, { n: 2 }, { onSignal: (_n, v) => second.push(v as number) })
    expect(timers.pending()).toBe(1) // the same timer: the schedule is not restarted
    clock.advance(250)
    expect(first).toEqual([1, 2])
    expect(second).toEqual([3, 4, 5]) // the ticks at 300, 400 and 500 continue the schedule
    b2.release()
  })

  it('release stops every timer of the svg, is idempotent, and a later binding starts a fresh timer', () => {
    const { svg, scene } = mount([sig('n', { type: 'timer', throttle: 100 }, 'n + 1'), sig('m', { type: 'timer', throttle: 70 }, 'm + 1')])
    const store: Record<string, unknown> = {}
    const b = bindSceneSignals(svg, scene, store, { onSignal: (n, v) => { store[n] = v } })
    expect(timers.pending()).toBe(2)
    clock.advance(250)
    b.release()
    b.release()
    expect(timers.pending()).toBe(0)
    const before = { ...store }
    clock.advance(1000)
    expect(store).toEqual(before)
    // a new binding is a new view of the svg: its timers start now
    const b2 = bindSceneSignals(svg, scene, {}, { onSignal: (n, v) => { store[n] = v } })
    clock.advance(100)
    expect(store.n).toBe(1)
    b2.release()
  })

  it('a svg that has left the document stops its timers at the next tick, even when the host never released', () => {
    const { host, svg, scene } = mount([sig('n', { type: 'timer', throttle: 100 }, 'n + 1')])
    const seen: number[] = []
    bindSceneSignals(svg, scene, {}, { onSignal: (_n, v) => seen.push(v as number) })
    clock.advance(150)
    expect(seen).toEqual([1])
    host.remove()
    clock.advance(150)
    expect(seen).toEqual([1])
    expect(timers.pending()).toBe(0)
  })

  it('timers of different svgs are independent', () => {
    const a = mount([sig('n', { type: 'timer', throttle: 100 }, 'n + 1')])
    const b = mount([sig('n', { type: 'timer', throttle: 100 }, 'n + 1')])
    const sa: number[] = []
    const sb: number[] = []
    const ba = bindSceneSignals(a.svg, a.scene, {}, { onSignal: (_n, v) => sa.push(v as number) })
    const bb = bindSceneSignals(b.svg, b.scene, {}, { onSignal: (_n, v) => sb.push(v as number) })
    clock.advance(250)
    expect(timers.pending()).toBe(2)
    ba.release()
    expect(timers.pending()).toBe(1)
    clock.advance(200)
    expect(sa).toEqual([1, 2])
    expect(sb).toEqual([1, 2, 3, 4])
    bb.release()
  })

  it('a binding of a spec with no timer stream creates none', () => {
    const { svg, scene } = mount([sig('c', 'click', 'c + 1')])
    const b = bindSceneSignals(svg, scene, {}, {})
    expect(timers.pending()).toBe(0)
    b.release()
  })
})
