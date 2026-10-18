/**
 * DOM quiescence helpers shared by the jsdom and browser benchmark runners.
 *
 * A chart update is considered "settled" when, after the first DOM mutation
 * triggered by the operation, no further mutations occur for `quietFrames`
 * consecutive animation frames. The same protocol is applied to every embed,
 * so the measurement is embed-agnostic.
 */

export interface SettleStats {
  /** ms from start() to first mutation (proxy for "first paint of result") */
  firstMutation: number
  /** ms from start() to last observed mutation (proxy for compute span) */
  lastMutation: number
  /** ms from start() to quiescence (full settle, includes quiet-frame window) */
  settled: number
  mutations: number
}

function frame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

const now = (): number => performance.now()

const hasRenderedSvg = (target: Node): boolean => {
  const svg = (target as HTMLElement).querySelector?.('svg') ?? null
  return svg != null && svg.childElementCount > 0
}

export async function waitForSettle(
  target: Node,
  opts: { quietFrames?: number; timeoutMs?: number; t0?: number; requireSvg?: boolean; trigger?: () => void } = {},
): Promise<SettleStats> {
  const quietFrames = opts.quietFrames ?? 3
  const timeoutMs = opts.timeoutMs ?? 10_000
  const t0 = opts.t0 ?? now()

  let mutations = 0
  let firstAt = 0
  let lastAt = 0
  const observer = new MutationObserver((records) => {
    const t = now()
    if (mutations === 0) firstAt = t
    mutations += records.length
    lastAt = t
  })
  observer.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  })

  // Kick off the measured work only after the observer is watching, so
  // synchronous commits (e.g. React re-render + innerHTML swap) are captured.
  // Without this, observe-after-trigger misses all mutations and the caller
  // silently degrades to frame-quantized `settled` timings.
  opts.trigger?.()

  try {
    let quiet = 0
    while (quiet < quietFrames) {
      if (now() - t0 > timeoutMs) break
      const before = mutations
      await frame()
      // With requireSvg, don't start the quiet window until the chart exists.
      const ready = !opts.requireSvg || hasRenderedSvg(target)
      quiet = ready && mutations === before ? quiet + 1 : 0
    }
  } finally {
    observer.disconnect()
  }

  return {
    firstMutation: firstAt ? firstAt - t0 : NaN,
    lastMutation: lastAt ? lastAt - t0 : NaN,
    settled: now() - t0,
    mutations,
  }
}

/** Poll until the container holds an <svg> with at least one rendered child. */
export async function waitForSvg(target: HTMLElement, timeoutMs = 10_000): Promise<number> {
  const t0 = now()
  for (;;) {
    const svg = target.querySelector('svg')
    if (svg && svg.childElementCount > 0) return now() - t0
    if (now() - t0 > timeoutMs) throw new Error('timed out waiting for <svg> in benchmark container')
    await frame()
  }
}

/** Work-complete time: timestamp of the last DOM mutation (frame-quantization free). */
export async function timeWork(
  target: Node,
  opts: { quietFrames?: number; timeoutMs?: number; t0?: number; requireSvg?: boolean; trigger?: () => void } = {},
): Promise<number> {
  const stats = await waitForSettle(target, opts)
  return Number.isFinite(stats.lastMutation) ? stats.lastMutation : stats.settled
}
