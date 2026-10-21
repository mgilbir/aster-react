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
 * Run: pnpm bench:incremental [--points=5000] [--batch=1] [--reps=100]
 */
import { performance } from 'node:perf_hooks'
import { ensureBuilt } from './ensure-built.js'
import { summarize, table, fmt } from './stats.js'

async function main(): Promise<void> {
  ensureBuilt()
  const argv = process.argv.slice(2)
  const arg = (name: string, dflt: string): string =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt
  const points = Number(arg('points', '5000'))
  const batch = Math.max(1, Number(arg('batch', '1')))
  const reps = Math.max(5, Number(arg('reps', '100')))

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
  }

  const full = summarize(fullTimes)
  const inc = summarize(incTimes)
  const ratio = full.median / Math.max(inc.median, 1e-9)
  console.log(
    table(
      `incremental append vs full re-evaluation — ${points} pts, +${batch}/update, ${reps} updates (ms)`,
      ['path', 'median', 'p95', 'max'],
      [
        ['full evaluateChart (no pulse)', fmt(full.median), fmt(full.p95), fmt(full.max)],
        ['stream append + explicit pulse', fmt(inc.median), fmt(inc.p95), fmt(inc.max)],
        ['speedup (median)', `${ratio.toFixed(2)}x`, '—', '—'],
      ],
    ),
  )
  if (!(inc.median < full.median)) {
    console.error('\n[incremental] FAIL: incremental append is not cheaper than full re-evaluation')
    process.exitCode = 1
    return
  }
  console.log(`\n[incremental] pass: append is ${ratio.toFixed(2)}x cheaper (median), final rows ${svgRows}`)

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
  const patch = summarize(patchTimes)
  const serialize = summarize(serializeTimes)
  console.log(
    table(
      `streaming DOM — ${domPoints} pts, +${batch}/update, ${domReps} updates (ms)`,
      ['path', 'median', 'p95', 'max'],
      [
        ['renderSceneToSvg (full string)', fmt(serialize.median), fmt(serialize.p95), fmt(serialize.max)],
        ['patchSceneDom (persistent <svg>)', fmt(patch.median), fmt(patch.p95), fmt(patch.max)],
        ['speedup (median)', `${(serialize.median / Math.max(patch.median, 1e-9)).toFixed(2)}x`, '—', '—'],
      ],
    ),
  )
  if (!(patch.median < serialize.median)) {
    console.error('\n[incremental] FAIL: DOM patching is not cheaper than full SVG serialization')
    process.exitCode = 1
  } else {
    console.log(`\n[incremental] DOM pass: patching is ${(serialize.median / Math.max(patch.median, 1e-9)).toFixed(2)}x cheaper`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
