/**
 * The floors of the browser benchmarks (`bench:browser`, `bench:browser-stream`): what makes the nightly step fail.
 *
 * A benchmark that only prints cannot fail, so a regression in it is found by someone reading a table. These checks turn the
 * measured claims of docs/PERFORMANCE.md into pass/fail. They are chosen to hold on a loaded shared runner, where absolute
 * times move by several times (a measured run of `bench:browser` took 3x longer on a busy machine and the ratios stayed put):
 *
 *  - RATIOS between engines measured in the same run (aster against the Vega embeds), not milliseconds;
 *  - COUNTS and INVARIANTS (DOM mutations of a no-op re-render, DOM nodes of a dense render, appends that completed, a page
 *    error), which do not depend on the speed of the machine;
 *  - no absolute median or p95 frame time: a frame is vsync-bound (16.7 ms) and on a loaded machine every engine's frames lengthen together
 *    (a measured run took 40 ms per frame for aster AND vega at 10,000 points), so frames are compared with vega's in the same run.
 *    The one absolute figure is `maxLongShare`, a cap on the share of frames over 21 ms, set far above the measured value.
 *
 * Each floor sits well below the measured value (the measured value is in the comment next to it), so noise does not trip it
 * and a real regression -- an engine that stopped being incremental, batching that stopped batching, a leak into the DOM --
 * does. `browser-floors.test.ts` feeds each check a result that crosses its floor and requires the failure.
 */

export interface Summary { median: number; p95: number }
export interface FrameStats { median: number; p95: number; longShare: number; frames: number }

/** What `browser.bench.mjs` collects: `results[`${metric}:${kind}`][embed]`. */
export type BrowserResults = Record<string, Record<string, unknown> | undefined>

export interface DifferentialStages { diffEval: number[]; diffPatch: number[]; fullEval: number[]; fullPatch: number[] }

export const BROWSER_FLOORS = {
  /** aster against the slower of the two Vega embeds, first render and update (measured 0.4 to 0.97; the floor is a 50% margin over parity). */
  maxVsVegaEmbeds: 1.5,
  /** Share of aster's frames over 21 ms under a one-update-per-frame stream (measured 0 to 0.6%). */
  maxLongShare: 0.25,
  /** Differential update (about 1% of the points change) against a full re-encode, evaluate + patch (measured 5.5x at 1000 points). */
  minDifferentialSpeedup: 2,
  /** Retained heap after churn, MB (measured with `--memory=true` only). */
  maxRetainedHeapMB: 30,
} as const

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
const embedOf = (r: BrowserResults, key: string, embed: string): Record<string, unknown> | undefined => r[key]?.[embed] as Record<string, unknown> | undefined

/** The failures of one `bench:browser` run (an empty list is a pass). */
export function checkBrowserBench(results: BrowserResults, kinds: string[], pageErrors: string[], differential?: DifferentialStages): string[] {
  const out: string[] = []
  for (const e of pageErrors.slice(0, 3)) out.push(`the benchmark page threw: ${e}`)
  if (kinds.length === 0) out.push('no chart kind was measured')
  for (const kind of kinds) {
    const aster = embedOf(results, `update:${kind}`, 'aster') as unknown as Summary | undefined
    if (!aster || !(num(aster.median) > 0)) { out.push(`${kind}: aster produced no update timings`); continue }
    for (const metric of ['mount', 'update'] as const) {
      const a = embedOf(results, `${metric}:${kind}`, 'aster') as unknown as Summary | undefined
      const vegas = ['reactVega', 'embedHook'].map((e) => num((embedOf(results, `${metric}:${kind}`, e) as unknown as Summary | undefined)?.median))
      const slowest = vegas.reduce((m, v) => (v > m ? v : m), 0)
      if (!a || !(num(a.median) > 0)) { out.push(`${kind}: aster ${metric} has no timing`); continue }
      if (!(slowest > 0)) { out.push(`${kind}: the Vega embeds produced no ${metric} timings to compare with`); continue }
      const ratio = a.median / slowest
      if (ratio > BROWSER_FLOORS.maxVsVegaEmbeds) out.push(`${kind}: aster ${metric} is ${ratio.toFixed(2)}x the slower Vega embed (${a.median.toFixed(1)} ms against ${slowest.toFixed(1)} ms); floor ${BROWSER_FLOORS.maxVsVegaEmbeds}x`)
    }
    for (const embed of ['aster', 'asterDom']) {
      const fps = embedOf(results, `fps:${kind}`, embed) as unknown as FrameStats | undefined
      if (!fps || !(fps.frames > 0)) out.push(`${kind}: ${embed} painted no frames under the update stream`)
      else if (fps.longShare > BROWSER_FLOORS.maxLongShare) out.push(`${kind}: ${embed} drops ${(fps.longShare * 100).toFixed(1)}% of its frames under the update stream; ceiling ${BROWSER_FLOORS.maxLongShare * 100}%`)
      const follow = embedOf(results, `autoResize:${kind}`, embed) as unknown as { resized?: number; total?: number } | undefined
      if (!follow || !(num(follow.total) > 0)) out.push(`${kind}: ${embed} has no container-resize measurement`)
      else if (follow.resized !== follow.total) out.push(`${kind}: ${embed} followed ${follow.resized} of ${follow.total} container resizes; it must follow every one`)
      const stable = embedOf(results, `stable:${kind}`, embed) as unknown as { mutations?: number[] } | undefined
      if (!stable?.mutations?.length) out.push(`${kind}: ${embed} has no stable-content re-render measurement`)
      else if (stable.mutations.some((m) => m !== 0)) out.push(`${kind}: ${embed} wrote to the DOM on an identical-content re-render (${stable.mutations.join(', ')} mutations); it must write none`)
      const heap = embedOf(results, `heap:${kind}`, embed) as unknown as { retainedMB?: number } | undefined
      if (heap && num(heap.retainedMB) > BROWSER_FLOORS.maxRetainedHeapMB) out.push(`${kind}: ${embed} retains ${num(heap.retainedMB).toFixed(1)} MB after churn; ceiling ${BROWSER_FLOORS.maxRetainedHeapMB} MB`)
    }
  }
  if (differential) {
    const med = (xs: number[]): number => { const s = [...xs].sort((p, q) => p - q); return s[Math.floor(s.length / 2)] ?? NaN }
    const full = med(differential.fullEval) + med(differential.fullPatch)
    const diff = Math.max(med(differential.diffEval) + med(differential.diffPatch), 0.05)
    const speedup = full / diff
    if (!(speedup >= BROWSER_FLOORS.minDifferentialSpeedup)) out.push(`the differential update is ${Number.isFinite(speedup) ? speedup.toFixed(1) : 'unmeasured'}x cheaper than a full re-encode (evaluate + patch); floor ${BROWSER_FLOORS.minDifferentialSpeedup}x`)
  }
  return out
}

export interface StreamRow {
  points: number; engine: string; renderer: string; policy: string; dense: string
  median: number; p95: number; longShare: number; frames: number; updates: number; mutations: number; nodes: number
}

export const STREAM_FLOORS = {
  /** Appends that completed per frame painted (one append is issued per frame: measured 0.96 to 1.0, also on a loaded machine, where every engine's frames lengthen). */
  minAppendsPerFrame: 0.3,
  /** Appends completed at sizes where a frame cannot keep up (100,000 points: measured 18 to 19 per-item, 78 to 88 dense in 3 s; 5 per-item on a machine at load 12, hence a floor of "a couple"). */
  minAppendsHeavy: 2,
  /** DOM mutations per append of the SVG renderer (measured 1.0; Vega's `view.change` writes 242 at 10,000 points). */
  maxMutationsPerAppend: 10,
  /** aster's SVG stream against vega's `view.change` + `run` in the same run: appends completed (measured 1.0 to 1.1x) and median frame (0.9 to 1.0x). */
  minAppendsVsVega: 0.6,
  maxFrameVsVega: 1.5,
  /** `denseMarks` against per-item marks at the same size: DOM nodes (measured 0.4%), median frame (0.2x) and appends (4.3 to 4.6x). */
  maxDenseNodeShare: 0.05,
  maxDenseFrameRatio: 0.6,
  minDenseAppendRatio: 2,
} as const

/** The failures of one `bench:browser-stream` run. */
export function checkStreamBench(rows: StreamRow[], pageErrors: string[]): string[] {
  const out: string[] = []
  for (const e of pageErrors.slice(0, 3)) out.push(`the benchmark page threw: ${e}`)
  const aster = rows.filter((r) => r.engine === 'aster')
  if (aster.length === 0) out.push('no aster row was measured')
  const label = (r: StreamRow): string => `aster/${r.renderer}/${r.policy}${r.dense === '1' ? '/dense' : ''} @ ${r.points}`
  for (const r of aster) {
    if (!(r.frames > 0)) { out.push(`${label(r)}: no frames were painted`); continue }
    if (r.points <= 10_000) {
      if (r.updates < r.frames * STREAM_FLOORS.minAppendsPerFrame) out.push(`${label(r)}: only ${r.updates} appends in ${r.frames} frames; floor ${STREAM_FLOORS.minAppendsPerFrame} per frame`)
    } else if (r.updates < STREAM_FLOORS.minAppendsHeavy) {
      out.push(`${label(r)}: only ${r.updates} appends completed; floor ${STREAM_FLOORS.minAppendsHeavy}`)
    }
    const perAppend = r.mutations / Math.max(1, r.updates)
    if (r.renderer === 'svg' && perAppend > STREAM_FLOORS.maxMutationsPerAppend) out.push(`${label(r)}: ${perAppend.toFixed(1)} DOM mutations per append; ceiling ${STREAM_FLOORS.maxMutationsPerAppend} (an append must patch, not rebuild)`)
  }
  // the SVG stream against vega's own `view.change` + `run` on the same rows, when the run measured both (same machine, same moment)
  for (const r of aster.filter((x) => x.renderer === 'svg' && x.dense === '0' && x.frames > 0)) {
    const v = rows.find((x) => x.engine === 'vega' && x.renderer === 'svg' && x.policy === 'run' && x.points === r.points && x.frames > 0)
    if (!v) continue
    if (r.updates < v.updates * STREAM_FLOORS.minAppendsVsVega) out.push(`${label(r)}: ${r.updates} appends against ${v.updates} for vega view.change; floor ${STREAM_FLOORS.minAppendsVsVega}x`)
    if (r.median > v.median * STREAM_FLOORS.maxFrameVsVega) out.push(`${label(r)}: median frame ${r.median.toFixed(1)} ms against ${v.median.toFixed(1)} ms for vega view.change; ceiling ${STREAM_FLOORS.maxFrameVsVega}x`)
  }
  // dense marks against per-item marks, same size, same policy
  for (const dense of aster.filter((r) => r.renderer === 'svg' && r.dense === '1')) {
    const plain = aster.find((r) => r.renderer === 'svg' && r.dense === '0' && r.points === dense.points && r.policy === dense.policy)
    if (!plain) continue
    if (dense.nodes > plain.nodes * STREAM_FLOORS.maxDenseNodeShare) out.push(`${label(dense)}: ${dense.nodes} DOM nodes against ${plain.nodes} per-item; batching must leave under ${STREAM_FLOORS.maxDenseNodeShare * 100}%`)
    if (dense.median > plain.median * STREAM_FLOORS.maxDenseFrameRatio) out.push(`${label(dense)}: median frame ${dense.median.toFixed(1)} ms against ${plain.median.toFixed(1)} ms per-item; batching must cut it below ${STREAM_FLOORS.maxDenseFrameRatio}x`)
    if (dense.updates < plain.updates * STREAM_FLOORS.minDenseAppendRatio) out.push(`${label(dense)}: ${dense.updates} appends against ${plain.updates} per-item; batching must at least ${STREAM_FLOORS.minDenseAppendRatio}x them`)
  }
  return out
}
