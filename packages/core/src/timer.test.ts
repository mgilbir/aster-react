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
    const first: Array<[number, number]> = []
    timers.timer((e) => first.push([clock.now(), e]), 50, 10)
    clock.advance(200)
    // due at time + delay = 60 (not at 50, which is what a `time` that is ignored gives): the wait wakes on a timeout exactly then
    expect(first[0]).toEqual([60, 0])
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
    // a timer runs on every frame once due: the restart moved it from 10 to 40, so the frames at 48, 64, 80 and 96
    expect(log).toEqual(['second', 'second', 'second', 'second'])
    expect(() => t.restart(undefined as never)).toThrowError(TypeError)
    t.stop()
  })

  it('a stall seen by a frame first is caught up at frame rate, one tick per frame, as d3-timer does', () => {
    for (const delay of [20, 100, 500]) {
      const { clock, timers } = setup()
      const ticks: number[] = []
      timers.interval(() => ticks.push(clock.now()), delay)
      clock.advance(delay * 2) // running normally
      const before = ticks.length
      clock.jump(10_000) // a stall: the frame that was already requested is the first thing to run, and it reads the new time
      clock.advance(1000)
      const caught = ticks.slice(before)
      // the missed ticks (10 s / delay of them) are run one per frame until the schedule has caught up: no tick is dropped
      // and none is doubled up on a frame (d3-timer gives 63 / 62 / 21 for the same clock)
      expect(caught.length).toBeGreaterThanOrEqual(Math.min(60, Math.floor(10_000 / delay)))
      expect(caught.length).toBeLessThanOrEqual(Math.ceil(1000 / 16) + 1)
      expect(new Set(caught).size).toBe(caught.length)
    }
  })

  describe('the 1 s poll (while a frame loop runs): a clock that jumps while no frame is delivered does not make an interval fire a burst', () => {
    // a clock whose animation frames can be held back, as a hidden tab does while its timeouts and intervals still run
    class HiddenTabClock extends FakeClock {
      hidden = false
      private held: Array<() => void> = []
      override requestFrame(fn: () => void): number {
        if (!this.hidden) return super.requestFrame(fn)
        this.held.push(fn)
        return -1
      }
      show(): void {
        this.hidden = false
        for (const fn of this.held.splice(0)) super.requestFrame(fn)
      }
    }

    /** a frame-driven timer keeps the frame loop (and its poll) alive; the interval is what a stall would burst */
    const run = (stall: boolean): { before: number; after: number } => {
      const clock = new HiddenTabClock(16)
      const timers = createTimers(clock)
      timers.timer(() => {})
      let n = 0
      timers.interval(() => n++, 100)
      clock.advance(200)
      const before = n
      clock.hidden = true // the tab goes to the background: no frame is delivered from here on
      clock.advance(32)
      if (stall) clock.jump(10_000) // suspended; the poll's interval is due the moment the machine wakes
      clock.advance(0)
      clock.show()
      clock.advance(1000)
      return { before, after: n - before }
    }

    it('after the jump the second the tab is shown ticks as a second does (the poll took the jump off the schedule)', () => {
      const { after } = run(true)
      // without the poll: one tick per frame for the whole 10 s backlog, about 62 in this second
      expect(after).toBeGreaterThanOrEqual(9)
      expect(after).toBeLessThanOrEqual(13)
    })

    it('with no jump the same second ticks the same (the control: what the stall changes is the poll)', () => {
      const { after } = run(false)
      expect(after).toBeGreaterThanOrEqual(9)
      expect(after).toBeLessThanOrEqual(13)
    })

    it('a clock that did not jump is left alone by five polls', () => {
      const clock = new HiddenTabClock(16)
      const timers = createTimers(clock)
      timers.timer(() => {})
      const ticks: number[] = []
      timers.interval((elapsed) => ticks.push(elapsed), 100)
      clock.advance(5050)
      expect(ticks).toHaveLength(50)
    })
  })
})
