/**
 * Test-only virtual clock for timer.ts: deterministic time, no real timers. Frames run at the next multiple of
 * `frameMs` (a browser's animation frames, vsync-aligned); timeouts and intervals run at their due time; jobs due
 * at the same instant run in the order they were queued. Excluded from the published build.
 */
import type { TimerClock } from './timer.js'

interface Job {
  id: number
  at: number
  seq: number
  fn: () => void
  every?: number
  kind: 'timeout' | 'interval' | 'frame'
}

export class FakeClock implements TimerClock {
  t = 0
  private seq = 0
  private nextId = 1
  private jobs: Job[] = []

  constructor(readonly frameMs = 16) {}

  now(): number {
    return this.t
  }

  private add(kind: Job['kind'], at: number, fn: () => void, every?: number): number {
    const job: Job = { id: this.nextId++, at, seq: this.seq++, fn, kind, ...(every !== undefined ? { every } : {}) }
    this.jobs.push(job)
    return job.id
  }

  setTimeout(fn: () => void, ms: number): number {
    return this.add('timeout', this.t + Math.max(0, ms), fn)
  }

  setInterval(fn: () => void, ms: number): number {
    const every = Math.max(1, ms)
    return this.add('interval', this.t + every, fn, every)
  }

  requestFrame(fn: () => void): number {
    return this.add('frame', (Math.floor(this.t / this.frameMs) + 1) * this.frameMs, fn)
  }

  clearTimeout(id: unknown): void {
    this.jobs = this.jobs.filter((j) => j.id !== id)
  }

  clearInterval(id: unknown): void {
    this.clearTimeout(id)
  }

  /** What is still scheduled, by kind: a stopped scheduler holds none of it (the leak check). */
  active(): { timeouts: number; intervals: number; frames: number } {
    const count = (k: Job['kind']): number => this.jobs.filter((j) => j.kind === k).length
    return { timeouts: count('timeout'), intervals: count('interval'), frames: count('frame') }
  }

  /** Run everything due up to `t + ms`, advancing time job by job. */
  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      const due = this.jobs.filter((j) => j.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
      if (!due) break
      this.t = Math.max(this.t, due.at)
      if (due.every !== undefined) {
        due.at += due.every
        due.seq = this.seq++
      } else this.jobs = this.jobs.filter((j) => j !== due)
      due.fn()
    }
    this.t = end
  }
}
