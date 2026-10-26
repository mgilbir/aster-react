/**
 * Timers: a port of d3-timer, the scheduler vega-view runs its `timer` event streams on
 * (vega-view `view.timer(callback, delay)` is `interval(tick, delay)` of d3-timer).
 *
 * Why a port and not `setInterval`: a Vega-Lite animation integrates the time between its ticks
 * (`anim_clock + (now() - last_tick_at)`), so WHEN the ticks happen decides every frame. d3-timer
 * runs all timers from one animation-frame loop, schedules an interval against its own start time
 * (`time + n * delay`, so a late tick does not push the next one back) and hands the callback the
 * elapsed time since the start; reproducing that schedule is what makes a controlled clock produce
 * vega's frames.
 *
 * Differences from d3-timer, all about deterministic testing and cleanup:
 *  - the clock (`now`, timeouts, intervals, animation frames) is a value (`TimerClock`) and
 *    `createTimers(clock)` builds an independent scheduler; `timers` is the shared default one, bound
 *    to the host's globals LAZILY (a fake clock installed after import is honoured);
 *  - `Timer.stop()` is idempotent; `pending()` reports the live timers, for leak checks. (As in d3-timer, the
 *    frame already requested when the last timer stops still runs once, finds nothing and releases the
 *    clock-skew poll: the scheduler then holds no timeout, interval or frame.)
 */

/** What the scheduler needs of the host: a monotonic clock and ways to wake up later. */
export interface TimerClock {
  /** ms, monotonic (`performance.now()`) */
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  /** run `fn` on the next animation frame (a 17ms timeout without a window) */
  requestFrame(fn: () => void): unknown
}

export interface Timer {
  /** (re)start with a callback `fn(elapsed)`, `delay` ms after `time` (default: now) */
  restart(fn: (elapsed: number) => void, delay?: number, time?: number): void
  stop(): void
}

export interface Timers {
  now(): number
  /** run `fn(elapsed)` every frame once `delay` ms have passed (d3 `timer`) */
  timer(fn: (elapsed: number) => void, delay?: number, time?: number): Timer
  /** run `fn(elapsed)` every `delay` ms, scheduled against the start time (d3 `interval`); without a delay, every frame */
  interval(fn: (elapsed: number) => void, delay?: number, time?: number): Timer
  /** run every due timer now (d3 `timerFlush`) */
  flush(): void
  /** timers started and not stopped */
  pending(): number
}

interface Task {
  _call: ((elapsed: number) => void) | null
  _time: number
  _next: Task | null
}

/** The host's globals, looked up at call time. */
const globalClock: TimerClock = {
  now: () => (typeof performance === 'object' && performance.now ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as never),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as never),
  requestFrame: (fn) => {
    const w = (globalThis as { window?: { requestAnimationFrame?: (cb: () => void) => unknown } }).window
    return w && typeof w.requestAnimationFrame === 'function' ? w.requestAnimationFrame(fn) : globalThis.setTimeout(fn, 17)
  },
}

let injected: TimerClock | null = null

/**
 * Drive the shared scheduler (and so every `timer` event stream) from `clock` instead of the host's globals; `null`
 * goes back to them. The determinism seam: a test, or a host that steps frames itself, installs a controlled clock.
 * Only swap it while no timer is live (a timer's pending wake-up belongs to the clock it was scheduled on).
 */
export function setTimerClock(clock: TimerClock | null): void {
  injected = clock
}

/** The clock the shared scheduler runs on: the injected one, else the host's globals (looked up at call time). */
export const hostClock: TimerClock = {
  now: () => (injected ?? globalClock).now(),
  setTimeout: (fn, ms) => (injected ?? globalClock).setTimeout(fn, ms),
  clearTimeout: (h) => (injected ?? globalClock).clearTimeout(h),
  setInterval: (fn, ms) => (injected ?? globalClock).setInterval(fn, ms),
  clearInterval: (h) => (injected ?? globalClock).clearInterval(h),
  requestFrame: (fn) => (injected ?? globalClock).requestFrame(fn),
}

/** An independent scheduler over `clock` (d3-timer's module state, as an object). */
export function createTimers(clock: TimerClock): Timers {
  let frame = 0 // is an animation frame pending?
  let timeout: unknown = 0 // is a timeout pending?
  let interval: unknown = 0 // are any timers active?
  const pokeDelay = 1000 // how frequently we check for clock skew
  let taskHead: Task | null = null
  let taskTail: Task | null = null
  let clockLast = 0
  let clockNow = 0
  let clockSkew = 0
  let live = 0

  function now(): number {
    return clockNow || (clock.requestFrame(clearNow), (clockNow = clock.now() + clockSkew))
  }

  function clearNow(): void {
    clockNow = 0
  }

  class TimerImpl implements Task, Timer {
    _call: ((elapsed: number) => void) | null = null
    _time = 0
    _next: Task | null = null

    restart(callback: (elapsed: number) => void, delay?: number, time?: number): void {
      if (typeof callback !== 'function') throw new TypeError('callback is not a function')
      const t = (time == null ? now() : +time) + (delay == null ? 0 : +delay)
      if (!this._next && taskTail !== this) {
        if (taskTail) taskTail._next = this
        else taskHead = this
        taskTail = this
      }
      if (!this._call) ++live
      this._call = callback
      this._time = t
      sleep()
    }

    stop(): void {
      if (this._call) {
        this._call = null
        this._time = Infinity
        --live
        sleep()
      }
    }
  }

  function timerFlush(): void {
    now() // Get the current time, if not already set.
    ++frame // Pretend we've set an alarm, if we haven't already.
    let t = taskHead
    while (t) {
      const e = clockNow - t._time
      if (e >= 0) t._call?.call(undefined, e)
      t = t._next
    }
    --frame
  }

  function wake(): void {
    clockNow = (clockLast = clock.now()) + clockSkew
    frame = 0
    timeout = 0
    try {
      timerFlush()
    } finally {
      frame = 0
      nap()
      clockNow = 0
    }
  }

  function poke(): void {
    const n = clock.now()
    const delay = n - clockLast
    if (delay > pokeDelay) {
      clockSkew -= delay
      clockLast = n
    }
  }

  function nap(): void {
    let t0: Task | null = null
    let t1 = taskHead
    let t2: Task | null
    let time = Infinity
    while (t1) {
      if (t1._call) {
        if (time > t1._time) time = t1._time
        t0 = t1
        t1 = t1._next
      } else {
        t2 = t1._next
        t1._next = null
        t1 = t0 ? (t0._next = t2) : (taskHead = t2)
      }
    }
    taskTail = t0
    sleep(time)
  }

  function sleep(time?: number): void {
    if (frame) return // Soonest alarm already set, or will be.
    if (timeout) timeout = void clock.clearTimeout(timeout)
    const delay = (time as number) - clockNow // Strictly less than if we recomputed clockNow (NaN without a time: wake on the next frame).
    if (delay > 24) {
      if ((time as number) < Infinity) timeout = clock.setTimeout(wake, (time as number) - clock.now() - clockSkew)
      if (interval) interval = void clock.clearInterval(interval)
    } else {
      if (!interval) {
        clockLast = clock.now()
        interval = clock.setInterval(poke, pokeDelay)
      }
      frame = 1
      clock.requestFrame(wake)
    }
  }

  function timer(callback: (elapsed: number) => void, delay?: number, time?: number): Timer {
    const t = new TimerImpl()
    t.restart(callback, delay, time)
    return t
  }

  function intervalTimer(callback: (elapsed: number) => void, delay?: number, time?: number): Timer {
    const t = new TimerImpl()
    let total = delay as number
    if (delay == null) {
      t.restart(callback, delay, time)
      return t
    }
    const base = t.restart.bind(t)
    t.restart = (cb: (elapsed: number) => void, d?: number, tm?: number): void => {
      const dd = +(d as number)
      const start = tm == null ? now() : +tm
      base(function tick(elapsed: number): void {
        elapsed += total
        base(tick, (total += dd), start)
        cb(elapsed)
      }, dd, start)
    }
    t.restart(callback, delay, time)
    return t
  }

  return { now, timer, interval: intervalTimer, flush: timerFlush, pending: () => live }
}

/** The shared scheduler (what vega's view uses d3-timer's one module-level scheduler for). */
export const timers: Timers = createTimers(hostClock)
