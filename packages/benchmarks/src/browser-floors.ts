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
 *
 * A floor that compares with a number that is not there passes by accident (`undefined < 8` is false), so a check never compares first
 * and validates later: every measurement the run is supposed to have made is looked up and required to be a finite number before any
 * comparison, and a missing row, a missing comparison partner or a NaN is itself a failure (C197). The matrix of the run (which kinds,
 * embeds, engines, renderers, policies and sizes) is what the driver measured; a row the matrix names and the run lacks fails.
 *
 * The two aster embeds are two modes (`aster` = `<Chart incremental={false}>`, string mode; `asterDom` = the default incremental patcher)
 * and each has its own floors.
 */

export interface Summary { median: number; p95: number }
export interface FrameStats { median: number; p95: number; longShare: number; frames: number }

/** What `browser.bench.mjs` collects: `results[`${metric}:${kind}`][embed]`. */
export type BrowserResults = Record<string, Record<string, unknown> | undefined>

export interface DifferentialStages { diffEval: number[]; diffPatch: number[]; fullEval: number[]; fullPatch: number[] }

/** The four embeds of `bench:browser`: two modes of `<Chart>` and the two Vega embeds. */
export const BROWSER_EMBEDS = ['aster', 'asterDom', 'reactVega', 'embedHook'] as const
export const VEGA_EMBEDS = ['reactVega', 'embedHook'] as const
export const ASTER_EMBEDS = ['aster', 'asterDom'] as const

export const BROWSER_FLOORS = {
  /**
   * Time to first render and update of the default mode (`asterDom`) against the FASTER of the two Vega embeds (reactVega re-embeds on
   * every update, so the slower one is a soft baseline: an update 3x slower than vega-embed's `view.change` used to pass). Measured
   * 0.35 to 0.98 on line, scatter and bar at 1000 points (2026-11-23); the floor is a 50% margin over parity.
   */
  maxDomVsVegaEmbeds: 1.5,
  /** The same for string mode (`aster`): measured 0.58 to 1.31 (bar update 11.5 ms against vega-embed's 8.8). */
  maxStringVsVegaEmbeds: 2,
  /** The incremental patcher against string mode, same chart, update and first render (measured 0.57 to 0.88: patching is the faster mode). */
  maxDomVsString: 1.5,
  /**
   * Share of an aster mode's frames over 21 ms under a one-update-per-frame stream. Measured on an idle machine: default mode 0 to 2.8%,
   * string mode (which re-serializes the whole svg every frame) 0.6% on line, 2.2% on scatter, 64% on bar. On a loaded machine every
   * engine's frames lengthen together (a run at load 9 read 72% for the default mode and 56% for vega-embed's on bar), so the ceiling is
   * the larger of this share and the Vega embeds' own in the same run plus `longShareSlack`: the default mode is held to the FASTER
   * embed, string mode to the slower (it is the heavier mode; reactVega on bar drops 97% of its frames).
   */
  maxLongShare: 0.25,
  longShareSlack: 0.25,
  /** Differential update (about 1% of the points change) against a full re-encode, evaluate + patch (measured 3.7x to 5.5x at 1000 points). */
  minDifferentialSpeedup: 2,
  /** Retained heap after churn (mount, 30 updates, unmount, five times), MB. Measured -0.3 to 0.7 with a forced collection before each reading. */
  maxRetainedHeapMB: 10,
} as const

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const rowOf = (r: BrowserResults, key: string, embed: string): Record<string, unknown> | undefined => {
  const v = r[key]?.[embed]
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
}

/** What `checkBrowserBench` needs to know about the run. */
export interface BrowserRun {
  /** The run measured retained heap (`--memory=true`): every embed of every kind must then carry a finite `retainedMB`. The nightly runs it. */
  memory: boolean
}

/** Looks a finite number up and records why not when it is missing or NaN. */
function need(out: string[], where: string, row: Record<string, unknown> | undefined, field: string): number {
  if (row === undefined) { out.push(`${where}: no measurement`); return NaN }
  const v = row[field]
  if (!isNum(v)) { out.push(`${where}: ${field} is ${v === undefined ? 'missing' : String(v)}, not a number`); return NaN }
  return v
}

/** The failures of one `bench:browser` run (an empty list is a pass). */
export function checkBrowserBench(results: BrowserResults, kinds: string[], pageErrors: string[], differential: DifferentialStages | undefined, run: BrowserRun = { memory: false }): string[] {
  const out: string[] = []
  for (const e of pageErrors.slice(0, 3)) out.push(`the benchmark page threw: ${e}`)
  if (kinds.length === 0) out.push('no chart kind was measured')
  for (const kind of kinds) {
    const bad = (msg: string): void => { out.push(`${kind}: ${msg}`) }
    // 1) every measurement of every embed is there and finite, before anything is compared
    const t: Record<string, Record<string, { median: number; p95: number }>> = { mount: {}, update: {} }
    for (const embed of BROWSER_EMBEDS) {
      for (const metric of ['mount', 'update'] as const) {
        const row = rowOf(results, `${metric}:${kind}`, embed)
        const sub: string[] = []
        const median = need(sub, `${embed} ${metric}`, row, 'median')
        const p95 = need(sub, `${embed} ${metric}`, row, 'p95')
        for (const m of sub) bad(m)
        if (sub.length === 0 && !(median > 0)) bad(`${embed} ${metric} median is ${median} ms: no timing`)
        t[metric]![embed] = { median, p95 }
      }
      const fps = rowOf(results, `fps:${kind}`, embed)
      const sub: string[] = []
      need(sub, `${embed} frame pacing`, fps, 'median'); need(sub, `${embed} frame pacing`, fps, 'p95')
      const long = need(sub, `${embed} frame pacing`, fps, 'longShare')
      const frames = need(sub, `${embed} frame pacing`, fps, 'frames')
      for (const m of sub) bad(m)
      if (sub.length === 0) {
        if (!(frames > 0)) bad(`${embed} painted no frames under the update stream`)
        else if (long < 0 || long > 1) bad(`${embed} frame pacing: longShare ${long} is not a share`)
        else if (embed === 'aster' || embed === 'asterDom') {
          const vegaLong = VEGA_EMBEDS.map((e) => rowOf(results, `fps:${kind}`, e)?.longShare).filter(isNum)
          // a Vega embed without a usable share is reported on its own row above; here it only fails to loosen the ceiling
          const reference = vegaLong.length === 0 ? 0 : embed === 'aster' ? Math.max(...vegaLong) : Math.min(...vegaLong)
          const ceiling = Math.min(1, Math.max(BROWSER_FLOORS.maxLongShare, reference + BROWSER_FLOORS.longShareSlack))
          if (long > ceiling) bad(`${embed} drops ${(long * 100).toFixed(1)}% of its frames under the update stream; ceiling ${(ceiling * 100).toFixed(0)}% (${(BROWSER_FLOORS.maxLongShare * 100).toFixed(0)}%, or the Vega embeds' share plus ${BROWSER_FLOORS.longShareSlack * 100}%)`)
        }
      }
      const follow = rowOf(results, `autoResize:${kind}`, embed)
      const fsub: string[] = []
      const total = follow === undefined ? NaN : need(fsub, `${embed} container resize`, follow, 'total')
      const resized = follow === undefined ? NaN : need(fsub, `${embed} container resize`, follow, 'resized')
      if (follow === undefined) bad(`${embed} has no container-resize measurement`)
      for (const m of fsub) bad(m)
      if (follow !== undefined && fsub.length === 0) {
        if (!(total > 0)) bad(`${embed} has no container-resize measurement`)
        else if (resized !== total) bad(`${embed} followed ${resized} of ${total} container resizes; it must follow every one`)
      }
      const stable = rowOf(results, `stable:${kind}`, embed) as { mutations?: unknown } | undefined
      const muts = stable?.mutations
      if (!Array.isArray(muts) || muts.length === 0) bad(`${embed} has no stable-content re-render measurement`)
      else if (!muts.every(isNum)) bad(`${embed} stable-content re-render: a mutation count is missing or not a number (${muts.join(', ')})`)
      else if (muts.some((m) => m !== 0)) bad(`${embed} wrote to the DOM on an identical-content re-render (${muts.join(', ')} mutations); it must write none`)
      if (run.memory) {
        const heap = rowOf(results, `heap:${kind}`, embed)
        const hsub: string[] = []
        const retained = need(hsub, `${embed} heap after churn`, heap, 'retainedMB')
        for (const m of hsub) bad(m)
        if (hsub.length === 0 && retained > BROWSER_FLOORS.maxRetainedHeapMB) bad(`${embed} retains ${retained.toFixed(1)} MB after churn; ceiling ${BROWSER_FLOORS.maxRetainedHeapMB} MB`)
      }
    }
    // 2) the comparisons (a partner that is missing or has no timing is a failure, not a skipped comparison)
    for (const metric of ['mount', 'update'] as const) {
      const vegas = VEGA_EMBEDS.map((e) => t[metric]![e]!.median)
      if (!vegas.every((v) => v > 0)) { bad(`the Vega embeds produced no ${metric} timings to compare with`); continue }
      const fastest = Math.min(...vegas)
      for (const embed of ASTER_EMBEDS) {
        const a = t[metric]![embed]!.median
        if (!(a > 0)) continue
        const floor = embed === 'aster' ? BROWSER_FLOORS.maxStringVsVegaEmbeds : BROWSER_FLOORS.maxDomVsVegaEmbeds
        const ratio = a / fastest
        if (ratio > floor) bad(`${embed} ${metric} is ${ratio.toFixed(2)}x the faster Vega embed (${a.toFixed(1)} ms against ${fastest.toFixed(1)} ms); floor ${floor}x`)
      }
      const dom = t[metric]!.asterDom!.median
      const str = t[metric]!.aster!.median
      if (dom > 0 && str > 0 && dom / str > BROWSER_FLOORS.maxDomVsString) bad(`asterDom ${metric} is ${(dom / str).toFixed(2)}x string mode (${dom.toFixed(1)} ms against ${str.toFixed(1)} ms): the incremental patcher must not be the slower mode; floor ${BROWSER_FLOORS.maxDomVsString}x`)
    }
  }
  if (differential === undefined) {
    out.push('no differential staging measurement')
  } else {
    const arrays: Array<keyof DifferentialStages> = ['fullEval', 'fullPatch', 'diffEval', 'diffPatch']
    let valid = true
    for (const k of arrays) {
      const xs = differential[k] as unknown
      if (!Array.isArray(xs) || xs.length === 0 || !xs.every(isNum)) { out.push(`the differential staging has no usable ${k} timings`); valid = false }
    }
    if (valid) {
      const med = (xs: number[]): number => { const s = [...xs].sort((p, q) => p - q); return s[Math.floor(s.length / 2)] ?? NaN }
      const full = med(differential.fullEval) + med(differential.fullPatch)
      const diff = Math.max(med(differential.diffEval) + med(differential.diffPatch), 0.05)
      const speedup = full / diff
      if (!(speedup >= BROWSER_FLOORS.minDifferentialSpeedup)) out.push(`the differential update is ${Number.isFinite(speedup) ? speedup.toFixed(1) : 'unmeasured'}x cheaper than a full re-encode (evaluate + patch); floor ${BROWSER_FLOORS.minDifferentialSpeedup}x`)
    }
  }
  return out
}

export interface StreamRow {
  points: number; engine: string; renderer: string; policy: string; dense: string
  median: number; p95: number; longShare: number; frames: number; updates: number; mutations: number; nodes: number
}

/** The options of a `bench:browser-stream` run that decide which rows exist. */
export interface StreamMatrix {
  points: number[]
  engines: string[]
  renderers: string[]
  /** Flush policies per engine (`aster`: microtask, raf; `vega`: run, runAsync). */
  policies: Record<string, string[]>
  /** `denseMarks` settings of the aster SVG rows (`'0'`, `'1'`). */
  dense: string[]
}

export interface StreamCell { points: number; engine: string; renderer: string; policy: string; dense: string }

/** The rows a run with these options measures, in the order it measures them: the driver iterates this, and the check requires every one. */
export function streamCells(m: StreamMatrix): StreamCell[] {
  const cells: StreamCell[] = []
  for (const points of m.points) for (const engine of m.engines) for (const renderer of m.renderers) {
    for (const policy of m.policies[engine] ?? []) for (const dense of engine === 'aster' && renderer === 'svg' ? m.dense : ['0']) {
      cells.push({ points, engine, renderer, policy, dense })
    }
  }
  return cells
}

export const STREAM_FLOORS = {
  /** Appends that completed per frame painted (one append is issued per frame: measured 0.96 to 1.0, also on a loaded machine, where every engine's frames lengthen). */
  minAppendsPerFrame: 0.3,
  /** Appends completed at sizes where a frame cannot keep up, per-item SVG at 100,000 points (measured 18 to 19 in 3 s, 5 on a machine at load 12). */
  minAppendsHeavy: 4,
  /** The same for `denseMarks` rows at 100,000 points (measured 78 to 88 in 3 s). */
  minAppendsHeavyDense: 20,
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

const STREAM_FIELDS = ['points', 'median', 'p95', 'longShare', 'frames', 'updates', 'mutations', 'nodes'] as const

/**
 * The failures of one `bench:browser-stream` run. `matrix` is the run's options: every row it names must be there (and finite), and
 * every comparison between two rows (aster against vega, dense against per-item) must have both rows, or the run fails instead of
 * skipping the comparison.
 */
export function checkStreamBench(rows: StreamRow[], pageErrors: string[], matrix?: StreamMatrix): string[] {
  const out: string[] = []
  for (const e of pageErrors.slice(0, 3)) out.push(`the benchmark page threw: ${e}`)
  const label = (r: { renderer: string; policy: string; dense: string; points: number; engine?: string }): string => `${r.engine ?? 'aster'}/${r.renderer}/${r.policy}${r.dense === '1' ? '/dense' : ''} @ ${r.points}`
  // 1) every row is complete: a field that is missing or NaN would pass every `<` comparison below
  const valid: StreamRow[] = []
  for (const r of rows) {
    const bad = STREAM_FIELDS.filter((f) => !isNum((r as unknown as Record<string, unknown>)[f]))
    if (bad.length) out.push(`${label(r)}: ${bad.map((f) => `${f} is ${String((r as unknown as Record<string, unknown>)[f])}`).join(', ')}; every field of a row must be a number`)
    else valid.push(r)
  }
  // 2) every row the run's options name is there
  if (matrix) {
    for (const c of streamCells(matrix)) {
      if (!rows.some((r) => r.points === c.points && r.engine === c.engine && r.renderer === c.renderer && r.policy === c.policy && r.dense === c.dense)) {
        out.push(`${label(c)}: the run was asked for this row and has none`)
      }
    }
  }
  const aster = valid.filter((r) => r.engine === 'aster')
  if (aster.length === 0) out.push('no aster row was measured')
  for (const r of aster) {
    if (!(r.frames > 0)) { out.push(`${label(r)}: no frames were painted`); continue }
    if (r.points <= 10_000) {
      if (r.updates < r.frames * STREAM_FLOORS.minAppendsPerFrame) out.push(`${label(r)}: only ${r.updates} appends in ${r.frames} frames; floor ${STREAM_FLOORS.minAppendsPerFrame} per frame`)
    } else {
      const floor = r.dense === '1' ? STREAM_FLOORS.minAppendsHeavyDense : STREAM_FLOORS.minAppendsHeavy
      if (r.updates < floor) out.push(`${label(r)}: only ${r.updates} appends completed; floor ${floor}`)
    }
    const perAppend = r.mutations / Math.max(1, r.updates)
    if (r.renderer === 'svg' && perAppend > STREAM_FLOORS.maxMutationsPerAppend) out.push(`${label(r)}: ${perAppend.toFixed(1)} DOM mutations per append; ceiling ${STREAM_FLOORS.maxMutationsPerAppend} (an append must patch, not rebuild)`)
  }
  // 3) the SVG stream against vega's own `view.change` + `run` on the same rows: asked for (the matrix has vega) means both rows must be usable
  const wantsVega = matrix ? matrix.engines.includes('vega') : rows.some((r) => r.engine === 'vega')
  if (wantsVega) {
    for (const r of aster.filter((x) => x.renderer === 'svg' && x.dense === '0')) {
      const v = valid.find((x) => x.engine === 'vega' && x.renderer === 'svg' && x.policy === 'run' && x.points === r.points)
      if (!v || !(v.frames > 0)) {
        if (matrix?.policies.vega?.includes('run') ?? true) out.push(`${label(r)}: no usable vega view.change row at ${r.points} points to compare with`)
        continue
      }
      if (!(r.frames > 0)) continue
      if (r.updates < v.updates * STREAM_FLOORS.minAppendsVsVega) out.push(`${label(r)}: ${r.updates} appends against ${v.updates} for vega view.change; floor ${STREAM_FLOORS.minAppendsVsVega}x`)
      if (r.median > v.median * STREAM_FLOORS.maxFrameVsVega) out.push(`${label(r)}: median frame ${r.median.toFixed(1)} ms against ${v.median.toFixed(1)} ms for vega view.change; ceiling ${STREAM_FLOORS.maxFrameVsVega}x`)
    }
  }
  // 4) dense marks against per-item marks, same size, same policy: both rows or a failure
  for (const dense of aster.filter((r) => r.renderer === 'svg' && r.dense === '1')) {
    const plain = aster.find((r) => r.renderer === 'svg' && r.dense === '0' && r.points === dense.points && r.policy === dense.policy)
    if (!plain) { out.push(`${label(dense)}: no per-item row at ${dense.points} points to compare batching with (run with --dense=0,1)`); continue }
    if (dense.nodes > plain.nodes * STREAM_FLOORS.maxDenseNodeShare) out.push(`${label(dense)}: ${dense.nodes} DOM nodes against ${plain.nodes} per-item; batching must leave under ${STREAM_FLOORS.maxDenseNodeShare * 100}%`)
    if (dense.median > plain.median * STREAM_FLOORS.maxDenseFrameRatio) out.push(`${label(dense)}: median frame ${dense.median.toFixed(1)} ms against ${plain.median.toFixed(1)} ms per-item; batching must cut it below ${STREAM_FLOORS.maxDenseFrameRatio}x`)
    if (dense.updates < plain.updates * STREAM_FLOORS.minDenseAppendRatio) out.push(`${label(dense)}: ${dense.updates} appends against ${plain.updates} per-item; batching must at least ${STREAM_FLOORS.minDenseAppendRatio}x them`)
  }
  return out
}
