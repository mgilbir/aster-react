/**
 * Incremental append vs full re-evaluation (R13).
 *
 * Measures the per-update cost of appending a small batch to a live chart:
 *
 * - full: `evaluateChart` on a compiled chart with the new snapshot and no
 *   change information (the safe default; every mark re-encodes),
 * - incremental: `createChartStream` append + flush, which publishes an
 *   explicit pulse (index mapping + added range) and splices the scene.
 *
 * Domains are fixed so the comparison measures the pulse machinery rather than
 * a scale-domain change. A second case appends values that extend the y domain,
 * where the scale rebuild is expected and the win is smaller.
 *
 * A Vega baseline runs the *same* append workload through the documented
 * `view.change('t', changeset().insert(rows)).run()` path with `renderer: 'none'`,
 * so the table separates dataflow cost from paint (the browser runner covers
 * paint/frame pacing). It is informational: the pass/fail gate stays on aster's
 * own incremental vs full comparison.
 *
 * Gate floors (C86). At the calibrated shape (>= 10000 points and >= 30 updates, which is what
 * `pnpm check` runs) each path must beat its baseline by a MEASURED floor, not just by >1x, so a large
 * regression cannot pass. Seven sequential runs of `pnpm bench:incremental -- --points=10000 --reps=30`
 * on the development machine (2026-10-23), speedup of the median:
 *
 *   incremental append vs full evaluate   15.8x - 25.6x   floor 8x   (about half of the slowest run)
 *   session whole-array replace vs full   13.8x - 25.4x   floor 8x   (one run in seven was 13.8x: half the
 *                                                                      median, 12x, would have been too close)
 *   DOM patch vs full SVG serialization    3.3x -  5.8x   floor 1.6x  (about half of the slowest run)
 *
 * Every gated ratio is the MEDIAN OF PER-PAIR RATIOS, where the two members of a pair are timed back to back
 * in the same loop iteration (dense: in the same round). A ratio of two medians taken in separate phases let
 * machine load skew numerator and denominator differently (the dense ratio read 164x-198x under load against
 * 224x-303x idle with the floor at 200x); within a pair load cancels. The floors themselves are unchanged.
 *
 * Below the calibrated shape (speedup scales with the dataset) only the >1x check applies. Override with
 * --min-append=, --min-replace=, --min-dom= (used to prove the gate bites).
 *
 * Run: pnpm bench:incremental [--points=5000] [--batch=1] [--reps=100] [--vega=1]
 */
import { performance } from 'node:perf_hooks'
import { ensureBuilt } from './ensure-built.js'
import { summarize, pairedRatio, table, fmt } from './stats.js'

/** Dense append patch vs a full dense mount (same process). Set from measurements; see the notes at the call site. */
const DENSE_APPEND_FLOOR = 200

async function main(): Promise<void> {
  ensureBuilt()
  const argv = process.argv.slice(2)
  const arg = (name: string, dflt: string): string =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt
  const points = Number(arg('points', '5000'))
  const batch = Math.max(1, Number(arg('batch', '1')))
  const reps = Math.max(5, Number(arg('reps', '100')))
  const calibrated = points >= 10000 && reps >= 30
  const floorOf = (name: string, calibratedFloor: number): number => Number(arg(name, String(calibrated ? calibratedFloor : 1)))
  const minAppend = floorOf('min-append', 8)
  const minReplace = floorOf('min-replace', 8)
  const minDom = floorOf('min-dom', 1.6)

  const { compileChart, evaluateChart, createChartStream, renderSceneToSvg } = await import('@aster/core')

  const rows = (n: number, from = 0): Array<{ x: number; y: number }> =>
    Array.from({ length: n }, (_, i) => {
      const k = from + i
      return { x: (k % 1000) / 1000, y: ((k * 7) % 100) / 10 }
    })

  const spec = {
    width: 800, height: 500, padding: 0, autosize: 'none',
    data: [{ name: 't', values: rows(points) }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 1], range: [0, 800] },
      { name: 'y', type: 'linear', domain: [0, 10], range: [500, 0] },
    ],
    marks: [{
      type: 'symbol', from: { data: 't' },
      encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 8 } } },
    }],
  }

  const chart = compileChart(spec as never)
  const fullTimes: number[] = []
  const incTimes: number[] = []
  let svgRows = points

  // Warmup both paths.
  evaluateChart(chart, { data: { t: rows(points) } })
  const warm = createChartStream(spec as never, { capacity: 8 })
  warm.push({ data: { t: rows(points) } })
  warm.flush()
  for (let i = 0; i < 3; i++) {
    warm.push({ append: { t: rows(batch, points + i * batch) } })
    warm.flush()
  }

  // One long-lived stream: the first append may copy the base snapshot once,
  // later appends are O(appended). This is the shape a live feed has.
  const stream = createChartStream(spec as never, { capacity: 8 })
  stream.push({ data: { t: rows(points) } })
  stream.flush()

  // Direct Vega baseline: identical spec, identical append per update, through
  // the documented streaming API. renderer 'none' keeps this compute-only (no
  // SVG/canvas paint) so it lines up with `evaluateChart`. --vega=0 disables it.
  const useVega = arg('vega', '1') !== '0'
  type VegaView = { change: (name: string, cs: unknown) => VegaView; run: () => VegaView; data: (name: string) => unknown[]; finalize: () => void }
  let vegaView: VegaView | null = null
  let vegaInsert: (rows: unknown[]) => unknown = () => undefined
  if (useVega) {
    try {
      const vega = await import('vega')
      const vegaSpec = { ...spec, data: [{ name: 't', values: rows(points) }] }
      vegaView = new vega.View(vega.parse(vegaSpec as never), { renderer: 'none', logLevel: 0 }).run() as unknown as VegaView
      vegaInsert = (batchRows: unknown[]) => vega.changeset().insert(batchRows as never)
      // Warm the dataflow (parse/lazy operators) before timing.
      vegaView.change('t', vegaInsert(rows(batch, points))).run()
    } catch (err) {
      console.error('[incremental] vega baseline unavailable:', (err as Error).message)
      vegaView = null
    }
  }
  const vegaTimes: number[] = []

  for (let i = 0; i < reps; i++) {
    const appended = rows(batch, points + i * batch)
    const next = [...rows(points + i * batch), ...appended]
    svgRows += batch

    const t0 = performance.now()
    evaluateChart(chart, { data: { t: next } })
    fullTimes.push(performance.now() - t0)

    const t1 = performance.now()
    stream.push({ append: { t: appended } })
    const flush = stream.flush()
    incTimes.push(performance.now() - t1)
    if (!flush) throw new Error('stream flush produced no scene')

    if (vegaView) {
      const t2 = performance.now()
      vegaView.change('t', vegaInsert(appended)).run()
      vegaTimes.push(performance.now() - t2)
    }
  }

  const full = summarize(fullTimes)
  const inc = summarize(incTimes)
  // Paired: each update times full and incremental back to back, so load cancels in the per-update ratio.
  const ratio = pairedRatio(fullTimes, incTimes).median
  const vega = vegaTimes.length ? summarize(vegaTimes) : null
  const expectedVegaRows = points + batch * (reps + 1) // includes the warmup append
  const vegaRows = vegaView ? vegaView.data('t').length : 0
  if (vegaView && vegaRows !== expectedVegaRows) {
    console.error(`[incremental] vega dataset has ${vegaRows} rows, expected ${expectedVegaRows}`)
  }
  vegaView?.finalize()
  console.log(
    table(
      `incremental append vs full re-evaluation — ${points} pts, +${batch}/update, ${reps} updates (ms)`,
      ['path', 'median', 'p95', 'max'],
      [
        ['full evaluateChart (no pulse)', fmt(full.median), fmt(full.p95), fmt(full.max)],
        ['aster stream append + pulse', fmt(inc.median), fmt(inc.p95), fmt(inc.max)],
        ...(vega
          ? ([['vega view.change + run', fmt(vega.median), fmt(vega.p95), fmt(vega.max)],
              ['aster vs vega (median)', `${(vega.median / Math.max(inc.median, 1e-9)).toFixed(2)}x`, '—', '—']] as string[][])
          : []),
        ['speedup vs full (median of per-update ratios)', `${ratio.toFixed(2)}x`, '—', '—'],
      ],
    ),
  )
  // Whole-array replacement (the `<Chart data={next}>` path): the host passes a
  // brand-new array with no explicit changes, and the session infers the pulse
  // by diffing rows. This is the common React data-prop shape, so gate it too.
  const { createChartSession } = await import('@aster/core/dom')
  const session = createChartSession()
  let current = rows(points)
  session.evaluate(spec as never, { data: { t: current } })
  const replaceTimes: number[] = []
  const replaceAppendTimes: number[] = []
  const replaceFullTimes: number[] = []
  for (let i = 0; i < reps; i++) {
    // Same length, one row replaced; every row object is new (as a fetch yields).
    const next = current.slice()
    next[i % next.length] = { x: 0.5, y: 5 }
    // Paired full evaluation of the same snapshot, timed adjacent to the session call.
    const tf = performance.now()
    evaluateChart(chart, { data: { t: next } })
    replaceFullTimes.push(performance.now() - tf)
    const t0 = performance.now()
    session.evaluate(spec as never, { data: { t: next } })
    replaceTimes.push(performance.now() - t0)
    current = next
    // Append a row: the diff yields a length-changing pulse (from/to + added).
    const appended = [...current, ...rows(batch, points + i * batch)]
    const t1 = performance.now()
    session.evaluate(spec as never, { data: { t: appended } })
    replaceAppendTimes.push(performance.now() - t1)
    current = appended
  }
  const replace = summarize(replaceTimes)
  const replaceAppend = summarize(replaceAppendTimes)
  const replaceFull = summarize(replaceFullTimes)
  const replaceRatio = pairedRatio(replaceFullTimes, replaceTimes).median
  console.log(
    table(
      `whole-array replacement through a session (no explicit changes) — ${points} pts, ${reps} updates (ms)`,
      ['path', 'median', 'p95', 'max'],
      [
        ['full evaluateChart (same snapshot)', fmt(replaceFull.median), fmt(replaceFull.p95), fmt(replaceFull.max)],
        ['session, same-length replace', fmt(replace.median), fmt(replace.p95), fmt(replace.max)],
        ['session, append row', fmt(replaceAppend.median), fmt(replaceAppend.p95), fmt(replaceAppend.max)],
        ['speedup (median of per-update ratios)', `${replaceRatio.toFixed(2)}x`, '—', '—'],
      ],
    ),
  )
  if (!(replaceRatio > 1) || replaceRatio < minReplace) {
    console.error(`\n[incremental] FAIL: whole-array replacement is ${replaceRatio.toFixed(2)}x cheaper than a full evaluation; floor ${minReplace}x`)
    process.exitCode = 1
  }

  if (!(ratio > 1) || ratio < minAppend) {
    console.error(`\n[incremental] FAIL: incremental append is ${ratio.toFixed(2)}x cheaper than full re-evaluation; floor ${minAppend}x`)
    process.exitCode = 1
    return
  }
  console.log(`\n[incremental] pass: append is ${ratio.toFixed(2)}x cheaper (median, floor ${minAppend}x), final rows ${svgRows}`)

  // DOM path: patch the persistent <svg> vs re-serialize/replace the full SVG.
  // jsdom patching is slower than a browser, but the relative cost is the point.
  const { setupJsdom } = await import('./jsdom-env.js')
  const { patchSceneDom } = await import('@aster/core/dom')
  setupJsdom()
  const domPoints = Math.min(points, 4000)
  const domReps = Math.min(reps, 30)
  const domStream = createChartStream(spec as never, { capacity: 8 })
  domStream.push({ data: { t: rows(domPoints) } })
  const first = domStream.flush()
  const host = document.createElement('div')
  document.body.appendChild(host)
  host.innerHTML = '<svg></svg>'
  const svg = host.firstElementChild as Element
  if (first) patchSceneDom(svg, first.scene)
  const patchTimes: number[] = []
  const serializeTimes: number[] = []
  for (let i = 0; i < domReps; i++) {
    domStream.push({ append: { t: rows(batch, domPoints + i * batch) } })
    const flush = domStream.flush()
    if (!flush) continue
    const t0 = performance.now()
    patchSceneDom(svg, flush.scene)
    patchTimes.push(performance.now() - t0)
    const t1 = performance.now()
    renderSceneToSvg(flush.scene)
    serializeTimes.push(performance.now() - t1)
  }
  const domRatio = pairedRatio(serializeTimes, patchTimes).median
  const patch = summarize(patchTimes)
  const serialize = summarize(serializeTimes)
  console.log(
    table(
      `streaming DOM — ${domPoints} pts, +${batch}/update, ${domReps} updates (ms)`,
      ['path', 'median', 'p95', 'max'],
      [
        ['renderSceneToSvg (full string)', fmt(serialize.median), fmt(serialize.p95), fmt(serialize.max)],
        ['patchSceneDom (persistent <svg>)', fmt(patch.median), fmt(patch.p95), fmt(patch.max)],
        ['speedup (median of per-update ratios)', `${domRatio.toFixed(2)}x`, '—', '—'],
      ],
    ),
  )
  if (!(domRatio > 1) || domRatio < minDom) {
    console.error(`\n[incremental] FAIL: DOM patching is ${domRatio.toFixed(2)}x cheaper than full SVG serialization; floor ${minDom}x`)
    process.exitCode = 1
  } else {
    console.log(`\n[incremental] DOM pass: patching is ${domRatio.toFixed(2)}x cheaper (floor ${minDom}x)`)
  }

  // Dense SVG streaming at scale: the per-append DOM work of a 100k-symbol chart
  // (`denseMarks`, the `<ChartStream>` default path) against mounting the same
  // scene from nothing, both timed in this process so machine speed cancels. The
  // browser bench cannot see this regression class cheaply (frames are raster-bound
  // there); an append that re-scans or rebuilds the whole mark instead of the tail
  // chunk shows up here as a collapsed ratio.
  const denseN = Math.max(5000, Number(arg('dense-points', '100000')))
  const denseStream = createChartStream(spec as never, { capacity: 8 })
  denseStream.push({ data: { t: rows(denseN) } })
  const denseFirst = denseStream.flush()
  if (!denseFirst) throw new Error('dense stream produced no scene')
  // INTERLEAVED rounds: each round times one mount of the full scene and, right next to it, a few
  // append patches; the round's ratio is mount / median(its patches). A mount is ~300 ms and a patch
  // ~1 ms, so load, GC and frequency changes that last longer than a patch but shorter than the whole
  // run hit the two very unequally if they are measured in separate phases (a ratio of two medians
  // taken minutes apart measured 164x-198x under load against 224x-303x idle); inside a round they
  // see the same machine state and cancel. The gate statistic is the median over rounds.
  const denseRounds = Math.max(10, Math.min(12, Math.floor(reps / 2)))
  const patchesPerRound = 5
  const mountOnce = (): number => {
    const fresh = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    host.appendChild(fresh)
    const tm = performance.now()
    patchSceneDom(fresh, denseFirst.scene, { denseMarks: true })
    const dt = performance.now() - tm
    fresh.remove()
    return dt
  }
  for (let m = 0; m < 2; m++) mountOnce() // warm the mount path (JIT); not measured
  const denseSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  host.appendChild(denseSvg)
  patchSceneDom(denseSvg, denseFirst.scene, { denseMarks: true })
  let denseAppended = 0
  const appendPatch = (): number => {
    denseStream.push({ append: { t: rows(batch, denseN + denseAppended * batch) } })
    denseAppended++
    const f = denseStream.flush()
    if (!f) throw new Error('dense stream flush produced no scene')
    const t0 = performance.now()
    patchSceneDom(denseSvg, f.scene, { denseMarks: true })
    return performance.now() - t0
  }
  for (let i = 0; i < 3; i++) appendPatch() // first appends (JIT, first chunk split); not measured
  const mountTimes: number[] = []
  const denseTimes: number[] = [] // per-round median patch
  const roundRatios: number[] = []
  for (let r = 0; r < denseRounds; r++) {
    const round: number[] = []
    // Alternate the order so a GC triggered by the mount does not always land on the patches (or vice versa).
    if (r % 2 === 0) mountTimes.push(mountOnce())
    for (let k = 0; k < patchesPerRound; k++) round.push(appendPatch())
    if (r % 2 === 1) mountTimes.push(mountOnce())
    const patchMedian = summarize(round).median
    denseTimes.push(patchMedian)
    roundRatios.push((mountTimes[r] as number) / Math.max(patchMedian, 1e-9))
  }
  const dMount = summarize(mountTimes)
  const dPatch = summarize(denseTimes)
  const dRatio = summarize(roundRatios).median
  const denseReps = denseRounds * patchesPerRound
  console.log(
    table(
      `dense SVG stream DOM — ${denseN} symbols, +${batch}/update, ${denseRounds} rounds x (1 mount + ${patchesPerRound} patches), ${denseReps} updates (ms)`,
      ['path', 'median', 'p95', 'max'],
      [
        ['mount (patchSceneDom into empty <svg>)', fmt(dMount.median), fmt(dMount.p95), fmt(dMount.max)],
        ['append patch (patchSceneDom, dense; per-round median)', fmt(dPatch.median, 2), fmt(dPatch.p95, 2), fmt(dPatch.max, 2)],
        ['speedup (median of per-round ratios)', `${dRatio.toFixed(1)}x`, '—', '—'],
      ],
    ),
  )
  if (!(dRatio >= DENSE_APPEND_FLOOR)) {
    console.error(`\n[incremental] FAIL: a dense append patch is only ${dRatio.toFixed(1)}x cheaper than a full mount (floor ${DENSE_APPEND_FLOOR}x)`)
    process.exitCode = 1
  } else {
    console.log(`\n[incremental] dense DOM pass: append patch is ${dRatio.toFixed(1)}x cheaper than a mount (floor ${DENSE_APPEND_FLOOR}x)`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
