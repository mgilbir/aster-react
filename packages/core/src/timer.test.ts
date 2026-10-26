import { describe, it, expect } from 'vitest'
import { createTimers } from './timer.js'
import { FakeClock } from './timer.testlib.js'

const setup = (frameMs = 16) => {
  const clock = new FakeClock(frameMs)
  return { clock, timers: createTimers(clock) }
}

describe('timer (d3-timer port)', () => {
  it('a long interval wakes on a timeout at its due time and ticks against its start time: no drift', () => {
    const { clock, timers } = setup()
    const ticks: Array<[number, number]> = []
    timers.interval((elapsed) => ticks.push([clock.now(), elapsed]), 100)
    clock.advance(520)
    expect(ticks).toEqual([[100, 100], [200, 200], [300, 300], [400, 400], [500, 500]])
  })

  it('a short interval runs on animation frames: the first frame at or after k * delay, and late ticks do not push the next', () => {
    const { clock, timers } = setup()
    const ticks: Array<[number, number]> = []
    timers.interval((elapsed) => ticks.push([clock.now(), Math.round(elapsed)]), 50 / 3)
    clock.advance(130)
    expect(ticks.map(([t]) => t)).toEqual([32, 48, 64, 80, 96, 112, 128])
    // elapsed is the time since the start, whichever frame it ran on
    expect(ticks.map(([, e]) => e)).toEqual([32, 48, 64, 80, 96, 112, 128])
  })

  it('an interval without a delay ticks every animation frame', () => {
    const { clock, timers } = setup()
    const at: number[] = []
    timers.interval(() => at.push(clock.now()))
    clock.advance(100)
    expect(at).toEqual([16, 32, 48, 64, 80, 96])
  })

  it('a timer starts after its delay, measured from `time` when given', () => {
    const { clock, timers } = setup()
    const first: number[] = []
    timers.timer((e) => first.push(e), 50, 10)
    clock.advance(200)
    expect(first[0]).toBe(0) // due at 60: the long wait wakes on a timeout exactly then
  })

  it('stop is idempotent, ends the ticks, and a stopped scheduler holds nothing once its last frame has run', () => {
    const { clock, timers } = setup()
    let n = 0
    const t = timers.interval(() => n++, 100)
    clock.advance(250)
    expect(n).toBe(2)
    expect(timers.pending()).toBe(1)
    t.stop()
    t.stop()
    expect(timers.pending()).toBe(0)
    clock.advance(16) // d3-timer's already requested frame runs once, finds no timer
    expect(clock.active()).toEqual({ timeouts: 0, intervals: 0, frames: 0 })
    clock.advance(1000)
    expect(n).toBe(2)
  })

  it('a callback may stop its own timer, and the interval does not restart it', () => {
    const { clock, timers } = setup()
    let n = 0
    const t = timers.interval(() => {
      if (++n === 3) t.stop()
    }, 50)
    clock.advance(1000)
    expect(n).toBe(3)
    expect(timers.pending()).toBe(0)
    expect(clock.active()).toEqual({ timeouts: 0, intervals: 0, frames: 0 })
  })

  it('a long wait sleeps on a timeout, not on frames, and stopping cancels it', () => {
    const { clock, timers } = setup()
    const t = timers.timer(() => {}, 5000)
    clock.advance(16) // the frame requested at start runs and goes back to sleep
    const idle = clock.active()
    expect(idle.timeouts).toBe(1)
    expect(idle.frames).toBe(0)
    expect(idle.intervals).toBe(0)
    t.stop()
    clock.advance(16)
    expect(clock.active()).toEqual({ timeouts: 0, intervals: 0, frames: 0 })
  })

  it('timers share one frame loop and run in the order they were started', () => {
    const { clock, timers } = setup()
    const order: string[] = []
    timers.interval(() => order.push('a'), 32)
    timers.interval(() => order.push('b'), 32)
    clock.advance(40)
    expect(order).toEqual(['a', 'b'])
    expect(clock.active().frames).toBeLessThanOrEqual(1)
  })

  it('restart reuses a timer; a callback that is not a function throws', () => {
    const { clock, timers } = setup()
    const log: string[] = []
    const t = timers.timer(() => log.push('first'), 10)
    t.restart(() => log.push('second'), 40)
    clock.advance(100)
    expect(log).toEqual(['second', 'second', 'second', 'second', 'second', 'second'].slice(0, log.length))
    expect(log.every((x) => x === 'second')).toBe(true)
    expect(() => t.restart(undefined as never)).toThrowError(TypeError)
    t.stop()
  })

  it('a clock that jumps forward does not make an interval fire a burst', () => {
    const { clock, timers } = setup()
    let n = 0
    timers.interval(() => n++, 100)
    clock.advance(16)
    // a 10 s stall in one step: one tick, then the schedule continues from there
    clock.advance(10_000)
    expect(n).toBeGreaterThan(0)
    const before = n
    clock.advance(1000)
    expect(n - before).toBeLessThanOrEqual(11)
  })
})
