/**
 * Timers for the `timer` event streams of the signal event loop, driven by one scheduler per clock.
 *
 * WHEN a tick happens decides what a Vega-Lite animation draws (its clock adds the time between ticks), so the schedule
 * is fixed by what the reference scheduler (d3-timer, which vega-view runs on) does, not left free:
 *   - all timers share one wake-up: a frame, when something is due within 24 ms, otherwise a timeout for the earliest
 *     due time; ticks that are due run in the order the timers were first started;
 *   - a timer is due at `time + delay`, and the elapsed time its callback gets is measured from `time`; an interval is
 *     scheduled against its start (`start + k * delay`), so a late tick does not push the next one back;
 *   - time is read once per frame, so every callback of a frame sees the same instant;
 *   - while a frame loop runs, a 1 s poll notices a clock that jumped (a suspended laptop) and shifts the schedule by the
 *     jump instead of firing a burst.
 * Everything else is free: the clock is a value (`TimerClock`), a scheduler is an object, and the shared one reads the
 * host's globals at call time, so a test can install a controlled clock after the module loaded.
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
  /** run `fn(elapsed)` every frame once `delay` ms have passed */
  timer(fn: (elapsed: number) => void, delay?: number, time?: number): Timer
  /** run `fn(elapsed)` every `delay` ms, scheduled against the start time; without a delay, every frame */
  interval(fn: (elapsed: number) => void, delay?: number, time?: number): Timer
  /** run every due timer now */
  flush(): void
  /** timers started and not stopped */
  pending(): number
}

type Callback = (elapsed: number) => void

/** One scheduled callback. It stays in the scheduler's list, stopped or not, until the next sweep. */
interface Task {
  callback: Callback | null
  dueAt: number
  listed: boolean
}

/** Frames this soon are waited for; a later wake-up is a timeout. */
const FRAME_WINDOW = 24
/** How often the poll looks for a jump of the clock. */
const POLL_MS = 1000

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

class Scheduler implements Timers {
  /** tasks in the order they were first listed */
  private tasks: Task[] = []
  /** the instant the current frame reads as; 0 outside a frame, when the next read starts one */
  private frameTime = 0
  /** the clock's own reading at the last wake-up or poll, and what the poll has taken off for jumps */
  private lastReading = 0
  private skew = 0
  /** non-zero while a frame is requested or callbacks are running: nothing else needs to wake the scheduler */
  private frame = 0
  private wakeTimeout: unknown
  private poll: unknown
  private live = 0

  constructor(private readonly clock: TimerClock) {}

  now(): number {
    if (!this.frameTime) {
      this.clock.requestFrame(() => {
        this.frameTime = 0
      })
      this.frameTime = this.clock.now() + this.skew
    }
    return this.frameTime
  }

  pending(): number {
    return this.live
  }

  timer(callback: Callback, delay?: number, time?: number): Timer {
    const handle = new Handle(this, null)
    handle.restart(callback, delay, time)
    return handle
  }

  interval(callback: Callback, delay?: number, time?: number): Timer {
    const handle = new Handle(this, delay == null ? null : { ticked: delay })
    handle.restart(callback, delay, time)
    return handle
  }

  /** (Re)arm `task` to call `callback` at `time + delay`, with `time` defaulting to now. */
  arm(task: Task, callback: Callback, delay?: number, time?: number): void {
    if (typeof callback !== 'function') throw new TypeError('callback is not a function')
    const dueAt = (time == null ? this.now() : +time) + (delay == null ? 0 : +delay)
    if (!task.listed) {
      task.listed = true
      this.tasks.push(task)
    }
    if (!task.callback) this.live++
    task.callback = callback
    task.dueAt = dueAt
    this.reschedule()
  }

  disarm(task: Task): void {
    if (!task.callback) return
    task.callback = null
    task.dueAt = Infinity
    this.live--
    this.reschedule()
  }

  flush(): void {
    this.now()
    // a frame is as good as requested while callbacks run: arming from a callback must not schedule another wake-up
    this.frame++
    // a callback may add tasks; the loop reaches them when they are already due
    for (let i = 0; i < this.tasks.length; i++) {
      const task = this.tasks[i]!
      const elapsed = this.frameTime - task.dueAt
      if (elapsed >= 0) task.callback?.(elapsed)
    }
    this.frame--
  }

  /** The wake-up: read the clock, run what is due, then sweep and plan the next wake-up. */
  private wake = (): void => {
    this.frameTime = (this.lastReading = this.clock.now()) + this.skew
    this.frame = 0
    this.wakeTimeout = undefined
    try {
      this.flush()
    } finally {
      this.frame = 0
      this.sweep()
      this.frameTime = 0
    }
  }

  /** The poll: a reading far ahead of the last one means the clock jumped; take the jump off the schedule. */
  private checkJump = (): void => {
    const reading = this.clock.now()
    const gap = reading - this.lastReading
    if (gap > POLL_MS) {
      this.skew -= gap
      this.lastReading = reading
    }
  }

  /** Drop stopped tasks from the list and sleep until the earliest remaining one. */
  private sweep(): void {
    let earliest = Infinity
    this.tasks = this.tasks.filter((task) => {
      if (!task.callback) {
        task.listed = false
        return false
      }
      if (task.dueAt < earliest) earliest = task.dueAt
      return true
    })
    this.reschedule(earliest)
  }

  /**
   * Plan the next wake-up for the task due at `dueAt` (none given: as soon as possible, which is the next frame): a
   * frame when it is within the window, otherwise a timeout, with no frame loop or poll running in between.
   */
  private reschedule(dueAt?: number): void {
    if (this.frame) return
    if (this.wakeTimeout) this.wakeTimeout = void this.clock.clearTimeout(this.wakeTimeout)
    if (dueAt! - this.frameTime > FRAME_WINDOW) {
      if (dueAt! < Infinity) this.wakeTimeout = this.clock.setTimeout(this.wake, dueAt! - this.clock.now() - this.skew)
      if (this.poll) this.poll = void this.clock.clearInterval(this.poll)
    } else {
      if (!this.poll) {
        this.lastReading = this.clock.now()
        this.poll = this.clock.setInterval(this.checkJump, POLL_MS)
      }
      this.frame = 1
      this.clock.requestFrame(this.wake)
    }
  }
}

/**
 * What the caller holds. A plain timer is one task; an interval re-arms itself from its own ticks. `interval` is non-null
 * for an interval with a delay, and `ticked` is the offset of the next tick from the start: it keeps counting through
 * restarts (a restarted interval's `elapsed` includes what the earlier runs accumulated).
 */
class Handle implements Timer {
  private readonly task: Task = { callback: null, dueAt: 0, listed: false }

  constructor(
    private readonly scheduler: Scheduler,
    private readonly interval: { ticked: number } | null,
  ) {}

  restart(callback: Callback, delay?: number, time?: number): void {
    const interval = this.interval
    if (!interval) {
      this.scheduler.arm(this.task, callback, delay, time)
      return
    }
    const step = +delay!
    const start = time == null ? this.scheduler.now() : +time
    const tick: Callback = (elapsed) => {
      const sinceStart = elapsed + interval.ticked
      interval.ticked += step
      this.scheduler.arm(this.task, tick, interval.ticked, start)
      callback(sinceStart)
    }
    this.scheduler.arm(this.task, tick, step, start)
  }

  stop(): void {
    this.scheduler.disarm(this.task)
  }
}

/** An independent scheduler over `clock`. */
export function createTimers(clock: TimerClock): Timers {
  return new Scheduler(clock)
}

/** The shared scheduler, on the host's clock. */
export const timers: Timers = createTimers(hostClock)
