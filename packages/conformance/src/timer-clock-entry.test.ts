// @vitest-environment jsdom
/**
 * `setTimerClock` is part of the `@aster-charts/core/signals` entry: a consumer installs a controlled clock through the
 * package export (the built `dist/signals.js`, not a source path) and the `timer` event streams follow it.
 */
import { afterEach, expect, it } from 'vitest'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { renderSceneToDomElement } from '@aster-charts/core/dom'
import { bindSceneSignals, setTimerClock, type TimerClock } from '@aster-charts/core/signals'

/** A clock a consumer writes by hand: time moves only when `advance` says so, and nothing runs on its own. */
function manualClock(): TimerClock & { advance(ms: number): void; live(): number } {
  let t = 0
  let next = 1
  const jobs = new Map<number, { at: number; every: number; fn: () => void }>()
  const add = (ms: number, fn: () => void, every = 0): number => {
    jobs.set(next, { at: t + ms, every, fn })
    return next++
  }
  const del = (h: unknown): void => void jobs.delete(h as number)
  return {
    now: () => t,
    setTimeout: (fn, ms) => add(ms, fn),
    clearTimeout: del,
    setInterval: (fn, ms) => add(ms, fn, ms),
    clearInterval: del,
    requestFrame: (fn) => add(16, fn),
    live: () => jobs.size,
    advance(ms) {
      const end = t + ms
      for (;;) {
        let due: [number, { at: number; every: number; fn: () => void }] | undefined
        for (const e of jobs) if (e[1].at <= end && (!due || e[1].at < due[1].at)) due = e
        if (!due) break
        const [id, job] = due
        t = job.at
        if (job.every) job.at += job.every
        else jobs.delete(id)
        job.fn()
      }
      t = end
    },
  }
}

afterEach(() => {
  setTimerClock(null)
  document.body.innerHTML = ''
})

it('a clock installed through @aster-charts/core/signals drives a timer stream deterministically', () => {
  const clock = manualClock()
  setTimerClock(clock)
  const scene = evaluateChart(compileChart({
    width: 40,
    height: 40,
    signals: [{ name: 'n', value: 0, on: [{ events: { type: 'timer', throttle: 100 }, update: 'n + 1' }] }],
    marks: [{ type: 'rect', encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 10 }, height: { value: 10 } } } }],
  } as never))
  const svg = renderSceneToDomElement(scene) as unknown as SVGSVGElement
  document.body.appendChild(svg)
  const seen: number[] = []
  const binding = bindSceneSignals(svg, scene, {}, { onSignal: (_n, v) => seen.push(v as number) })
  expect(seen).toEqual([]) // nothing runs until the injected clock moves
  clock.advance(350)
  expect(seen).toEqual([1, 2, 3])
  binding.release()
  clock.advance(1000)
  expect(seen).toEqual([1, 2, 3]) // released: no more ticks
  expect(clock.live()).toBe(0)
})
