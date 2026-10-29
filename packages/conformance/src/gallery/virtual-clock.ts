/**
 * The page's clock, replaceable per spec. IMPORT THIS FIRST in the page bundle: d3-timer (what vega's `timer` event streams run on)
 * binds `requestAnimationFrame` when it loads, so the shim has to be on `window` before vega is evaluated.
 *
 * Real mode (the default) is the browser's own clock, untouched. Virtual mode is a deterministic one for BOTH engines at once:
 * `Date.now`, `performance.now`, `setTimeout` / `setInterval` / `requestAnimationFrame` (and their clears) read and schedule on a
 * clock that only moves when `advance(ms)` says so, firing due callbacks in time order (ties in scheduling order) and letting the
 * promises they start settle in between. vega's d3-timer and Aster's timer port (core/src/timer.ts, which looks the host's
 * globals up at call time) are driven by the same ticks that way, and a spec that reads `now()` sees the same instant.
 *
 * The harness itself (settling loops, deadlines) uses `realSleep` / `realNow`, which the shim never touches.
 */
type Fn = (...args: unknown[]) => void
interface Task { id: number; time: number; seq: number; fn: Fn; args: unknown[]; every?: number }

const w = window as unknown as Record<string, unknown> & Window
const real = {
  setTimeout: w.setTimeout.bind(w),
  clearTimeout: w.clearTimeout.bind(w),
  setInterval: w.setInterval.bind(w),
  clearInterval: w.clearInterval.bind(w),
  requestAnimationFrame: w.requestAnimationFrame.bind(w),
  cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
  dateNow: Date.now.bind(Date),
  perfNow: performance.now.bind(performance),
}
export const realSleep = (ms: number): Promise<void> => new Promise((r) => real.setTimeout(r, ms))
export const realNow = (): number => real.perfNow()

/** The instant virtual time starts at (2023-11-14T22:13:20Z), and what `performance.now()` reads then. */
export const VIRTUAL_EPOCH_MS = 1_700_000_000_000
export const VIRTUAL_PERFORMANCE_MS = 1_000
/** A frame is 16 ms of virtual time: `requestAnimationFrame` callbacks run on its boundaries. */
export const FRAME_MS = 16

let virtual = false
let elapsed = 0
let seq = 0
let nextId = 1
let tasks: Task[] = []
const isVirtualId = (id: unknown): boolean => typeof id === 'number' && id >= VIRTUAL_ID_BASE
const VIRTUAL_ID_BASE = 1e9

function schedule(fn: Fn, delay: number, args: unknown[], every?: number): number {
  const id = VIRTUAL_ID_BASE + nextId++
  // (browsers clamp a timeout to 1 ms at least; a callback that re-arms itself at 0 would never let time move)
  const time = elapsed + Math.max(1, Number(delay) || 0)
  tasks.push({ id, time, seq: seq++, fn, args, ...(every !== undefined ? { every: Math.max(1, Number(every) || 1) } : {}) })
  return id
}
const cancel = (id: unknown): void => { tasks = tasks.filter((t) => t.id !== id) }

w.setTimeout = ((fn: Fn, delay?: number, ...args: unknown[]) => (virtual ? schedule(fn, delay ?? 0, args) : real.setTimeout(fn, delay, ...args))) as never
w.setInterval = ((fn: Fn, delay?: number, ...args: unknown[]) => (virtual ? schedule(fn, delay ?? 0, args, delay ?? 0) : real.setInterval(fn, delay, ...args))) as never
w.clearTimeout = ((id?: number) => { if (isVirtualId(id)) cancel(id); else real.clearTimeout(id) }) as never
w.clearInterval = ((id?: number) => { if (isVirtualId(id)) cancel(id); else real.clearInterval(id) }) as never
w.requestAnimationFrame = ((cb: (t: number) => void) => {
  if (!virtual) return real.requestAnimationFrame(cb)
  const next = (Math.floor(elapsed / FRAME_MS) + 1) * FRAME_MS
  return schedule(() => cb(VIRTUAL_PERFORMANCE_MS + next), next - elapsed, [])
}) as never
w.cancelAnimationFrame = ((id: number) => { if (isVirtualId(id)) cancel(id); else real.cancelAnimationFrame(id) }) as never
Date.now = () => (virtual ? VIRTUAL_EPOCH_MS + elapsed : real.dateNow())
performance.now = () => (virtual ? VIRTUAL_PERFORMANCE_MS + elapsed : real.perfNow())

/** Let the promises a callback started (vega's `runAsync`, React's renders) settle before the next one fires. */
const settle = async (): Promise<void> => { await realSleep(2) }

export const clock = {
  /**
   * Start the virtual clock at time zero. d3-timer keeps module state across views (a frame it believes is pending, the time it
   * cached for the current frame): let the frames a previous spec left in flight run out on the real clock first, so this run starts
   * from an idle scheduler and every callback it asks for is a virtual one.
   */
  async begin(): Promise<void> {
    await realSleep(60)
    virtual = true
    elapsed = 0
    tasks = []
  },
  /**
   * Back to the browser's clock. The callbacks the run left pending (a stopped timer's last wake-up, which d3-timer waits for before
   * it goes idle) run out on the virtual clock first, and whatever is then left is dropped.
   */
  async end(): Promise<void> {
    if (virtual) await clock.advance(200)
    virtual = false
    elapsed = 0
    tasks = []
  },
  /** Move virtual time forward by `ms`, firing every due callback in order. */
  async advance(ms: number): Promise<void> {
    if (!virtual) throw new Error('virtual clock is not running')
    const target = elapsed + ms
    for (let fired = 0; ; fired++) {
      if (fired > 100_000) throw new Error('virtual clock: more than 100000 callbacks in one advance')
      const due = tasks.filter((t) => t.time <= target).sort((a, b) => a.time - b.time || a.seq - b.seq)[0]
      if (!due) break
      elapsed = Math.max(elapsed, due.time)
      if (due.every !== undefined) { due.time += due.every; due.seq = seq++ } else tasks = tasks.filter((t) => t !== due)
      try { due.fn(...due.args) } catch (e) { real.setTimeout(() => { throw e }) }
      await settle()
    }
    elapsed = target
    await settle()
  },
}
