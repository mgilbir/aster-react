/**
 * LIVE differential for the timer scheduler: `@aster/core`'s port (core/src/timer.ts) and the real d3-timer vega-view
 * runs its `timer` event streams on, driven through the SAME virtual clock model and the same operations (start a
 * timer / interval with a delay and optional start time, restart it, stop it), must call back at the same instants
 * with the same `elapsed`. The oracle is imported fresh per scenario with the host globals (performance, timeouts,
 * intervals, animation frames) stubbed to its own virtual clock, because d3-timer captures them at import.
 *
 * A Vega-Lite animation integrates the time between ticks (`anim_clock + (now() - last_tick_at)`), so a scheduler that
 * ticks a frame early or late shifts every frame of the animation; this is the check that it does not.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTimers } from '../../core/src/timer.ts'
import { FakeClock } from '../../core/src/timer.testlib.ts'

// d3-timer is not a dependency of this package: it is the one vega-view (a dependency of vega) uses
const vegaPath = createRequire(import.meta.url).resolve('vega')
const vegaViewPath = createRequire(vegaPath).resolve('vega-view')
const d3TimerDir = join(dirname(createRequire(vegaViewPath).resolve('d3-timer')))
/** d3-timer's own source (timer.js + interval.js), as one module, so every scenario gets an instance with its own state. */
const d3TimerSource = readFileSync(join(d3TimerDir, 'timer.js'), 'utf8')
  + '\n' + readFileSync(join(d3TimerDir, 'interval.js'), 'utf8').replace(/^import .*$/m, '').replace('export default function', 'export function intervalOf')

/** Frames as a window-less page gets them: a 17 ms timeout (what d3-timer does without requestAnimationFrame). */
class TimeoutFrameClock extends FakeClock {
  override requestFrame(fn: () => void): number {
    return this.setTimeout(fn, 17)
  }
}

interface D3Timer { stop(): void; restart(cb: (e: number) => void, delay?: number, time?: number): void }
interface D3 {
  timer(cb: (e: number) => void, delay?: number, time?: number): D3Timer
  intervalOf(cb: (e: number) => void, delay?: number, time?: number): D3Timer
  now(): number
}

let counter = 0
async function d3On(clock: FakeClock, withWindow: boolean): Promise<D3> {
  vi.stubGlobal('performance', { now: () => clock.now() })
  vi.stubGlobal('setTimeout', (fn: () => void, ms: number) => clock.setTimeout(fn, ms))
  vi.stubGlobal('clearTimeout', (h: unknown) => clock.clearTimeout(h))
  vi.stubGlobal('setInterval', (fn: () => void, ms: number) => clock.setInterval(fn, ms))
  vi.stubGlobal('clearInterval', (h: unknown) => clock.clearInterval(h))
  if (withWindow) vi.stubGlobal('window', { requestAnimationFrame: (fn: () => void) => clock.requestFrame(fn) })
  else vi.stubGlobal('window', undefined)
  // a fresh module instance: d3-timer reads those globals once, when it loads
  const src = `${d3TimerSource}\n// scenario ${++counter}`
  return (await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)) as D3
}

afterEach(() => {
  vi.unstubAllGlobals()
})

type Op =
  | { at: number; op: 'start'; id: number; kind: 'timer' | 'interval'; delay?: number; time?: number }
  | { at: number; op: 'restart'; id: number; delay?: number }
  | { at: number; op: 'stop'; id: number }

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DELAYS = [undefined, 0, 1, 16.666666666666668, 20, 24, 25, 33.3, 100, 250, 500, 1000, 2500]

function scenario(seed: number): Op[] {
  const r = rng(seed)
  const ops: Op[] = []
  const n = 2 + Math.floor(r() * 4)
  for (let id = 0; id < n; id++) {
    const at = Math.floor(r() * 400)
    const delay = DELAYS[Math.floor(r() * DELAYS.length)]
    const kind = r() < 0.7 ? 'interval' : 'timer'
    ops.push({ at, op: 'start', id, kind, ...(delay !== undefined ? { delay } : {}), ...(r() < 0.2 ? { time: Math.floor(r() * at) } : {}) })
    if (r() < 0.4) ops.push({ at: at + 50 + Math.floor(r() * 2000), op: 'restart', id, delay: DELAYS[Math.floor(r() * DELAYS.length)] })
    if (r() < 0.6) ops.push({ at: at + 100 + Math.floor(r() * 4000), op: 'stop', id })
  }
  return ops.sort((a, b) => a.at - b.at)
}

interface Engine {
  start(id: number, kind: 'timer' | 'interval', delay: number | undefined, time: number | undefined, log: string[], now: () => number): void
  restart(id: number, delay: number | undefined, log: string[], now: () => number): void
  stop(id: number): void
}

function drive(clock: FakeClock, engine: Engine, ops: Op[]): string[] {
  const log: string[] = []
  const horizon = 8000
  for (const o of ops) {
    clock.advance(o.at - clock.now())
    if (o.op === 'start') engine.start(o.id, o.kind, o.delay, o.time, log, () => clock.now())
    else if (o.op === 'restart') engine.restart(o.id, o.delay, log, () => clock.now())
    else engine.stop(o.id)
  }
  clock.advance(horizon - clock.now())
  return log
}

function asterEngine(clock: FakeClock): Engine {
  const timers = createTimers(clock)
  const live = new Map<number, ReturnType<typeof timers.timer>>()
  const cb = (id: number, log: string[], now: () => number) => (e: number) => log.push(`${id}@${now()}:${e}`)
  return {
    start(id, kind, delay, time, log, now) { live.set(id, timers[kind](cb(id, log, now), delay, time)) },
    restart(id, delay, log, now) { live.get(id)?.restart(cb(id, log, now), delay) },
    stop(id) { live.get(id)?.stop() },
  }
}

function d3Engine(d3: D3): Engine {
  const live = new Map<number, D3Timer>()
  const cb = (id: number, log: string[], now: () => number) => (e: number) => log.push(`${id}@${now()}:${e}`)
  return {
    start(id, kind, delay, time, log, now) { live.set(id, (kind === 'interval' ? d3.intervalOf : d3.timer)(cb(id, log, now), delay, time)) },
    restart(id, delay, log, now) { live.get(id)?.restart(cb(id, log, now), delay) },
    stop(id) { live.get(id)?.stop() },
  }
}

for (const withWindow of [false, true]) {
  describe(`timer scheduler vs d3-timer (live), frames from ${withWindow ? 'requestAnimationFrame' : 'a 17 ms timeout'}`, () => {
    for (let k = 0; k < 150; k++) {
      const seed = 4000 + k * 13
      it(`scenario ${seed}`, async () => {
        const ops = scenario(seed)
        const clockD3 = new FakeClock(16)
        const d3 = await d3On(clockD3, withWindow)
        const want = drive(clockD3, d3Engine(d3), ops)
        // the port runs on its own virtual clock with the same frame model
        const clockMine = withWindow ? new FakeClock(16) : new TimeoutFrameClock(16)
        const got = drive(clockMine, asterEngine(clockMine), ops)
        expect(got).toEqual(want)
      })
    }
    it('the scenarios exercise ticks (a vacuous comparison would prove nothing)', async () => {
      let total = 0
      for (let k = 0; k < 30; k++) {
        const clock = new FakeClock(16)
        const d3 = await d3On(clock, withWindow)
        total += drive(clock, d3Engine(d3), scenario(4000 + k * 13)).length
      }
      expect(total).toBeGreaterThan(500)
    })
  })
}
