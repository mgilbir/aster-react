/**
 * Browser benchmark API, bundled by scripts/browser.bench.mjs and driven by
 * Playwright through window.__bench. Measures what jsdom cannot: real paint
 * (time-to-first-render), frame pacing under an update stream, and
 * container-driven resize.
 */
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { compileChart, evaluateChart, renderSceneToSvg, type SceneRoot } from '@aster/core'
import { patchSceneDom, sceneToDomDesc } from '@aster/core/dom'
import { BenchEmbed, type EmbedName } from './embeds.js'
import { buildSpec, genValues, type ChartKind } from './fixtures.js'
import { timeWork, waitForSettle, waitForSvg } from './settle.js'

const h = React.createElement

export interface BenchApi {
  mounts(embed: EmbedName, kind: ChartKind, points: number): Promise<number>
  updates(embed: EmbedName, kind: ChartKind, points: number, reps: number): Promise<number[]>
  fps(embed: EmbedName, kind: ChartKind, points: number, seconds: number): Promise<{ frameTimes: number[]; updates: number }>
  resize(embed: EmbedName, kind: ChartKind, points: number, reps: number): Promise<number[]>
  autoResize(embed: EmbedName, kind: ChartKind, points: number, widths: number[]): Promise<number[]>
  stages(kind: ChartKind, points: number, reps: number): Promise<{ evaluate: number[]; desc: number[]; patch: number[]; swap: number[]; stringPath: number[]; noopPatch: number[] }>
  stableRerenders(embed: EmbedName, kind: ChartKind, points: number, reps: number): Promise<{ ms: number[]; mutations: number[] }>
  differentialUpdates(embed: EmbedName, points: number, reps: number): Promise<number[]>
  domNodes(): number
  reset(): void
}

interface Session {
  host: HTMLElement
  root: Root
  responsive: boolean
}

let session: Session | null = null

function teardown(): void {
  if (!session) return
  session.root.unmount()
  session.host.remove()
  session = null
}

function mountSession(embed: EmbedName, spec: Record<string, unknown>, responsive = false): Session {
  // (session.responsive is recorded below; mismatched callers remount)
  teardown()
  const host = document.createElement('div')
  host.style.width = '600px'
  document.body.appendChild(host)
  const root = createRoot(host)
  // A spec with numeric width/height is authoritative in both engines; for
  // container-driven sizing the spec must omit them so runtime/view sizes win.
  const mountSpec = responsive ? (() => { const { width: _w, height: _h, ...rest } = spec; return rest })() : spec
  root.render(h(BenchEmbed, {
    name: embed,
    spec: mountSpec,
    width: Number(spec.width),
    height: Number(spec.height),
    responsive,
  }))
  session = { host, root, responsive }
  return session
}

/** Time from render() to a painted chart svg: one rAF past quiescence. */
async function firstRenderMs(embed: EmbedName, kind: ChartKind, points: number): Promise<number> {
  const t0 = performance.now()
  const s = mountSession(embed, buildSpec(kind, genValues(kind, points, 1), 600, 400))
  // work = time of the last DOM mutation; paint follows on the next frame.
  return timeWork(s.host, { quietFrames: 1, t0, requireSvg: true })
}

/** Warm the embed (lazy init, JIT) so mount numbers reflect steady state. */
async function warmup(embed: EmbedName, kind: ChartKind, points: number): Promise<void> {
  const s = mountSession(embed, buildSpec(kind, genValues(kind, points, 99), 600, 400))
  await waitForSvg(s.host)
  await waitForSettle(s.host, { quietFrames: 2 })
}

async function ensureSession(embed: EmbedName, kind: ChartKind, points: number, responsive = false): Promise<Session> {
  let s = session
  if (!s || s.responsive !== responsive) {
    s = mountSession(embed, buildSpec(kind, genValues(kind, points, 1), 600, 400), responsive)
    await waitForSvg(s.host)
  }
  await waitForSettle(s.host, { quietFrames: 2 })
  return s
}

async function updateLatencies(embed: EmbedName, kind: ChartKind, points: number, reps: number): Promise<number[]> {
  const out: number[] = []
  const s = await ensureSession(embed, kind, points)
  for (let i = 0; i < reps; i++) {
    const spec = buildSpec(kind, genValues(kind, points, i + 2), 600, 400)
    const t0 = performance.now()
    s.root.render(h(BenchEmbed, { name: embed, spec, width: 600, height: 400 }))
    out.push(await timeWork(s.host, { quietFrames: 2, t0 }))
  }
  return out
}

/** One update per animation frame for `seconds`; report frame pacing. */
async function framePacing(embed: EmbedName, kind: ChartKind, points: number, seconds: number): Promise<{ frameTimes: number[]; updates: number }> {
  const s = await ensureSession(embed, kind, points)
  const frameTimes: number[] = []
  let updates = 0
  const end = performance.now() + seconds * 1000
  let prev = performance.now()
  let seed = 100
  await new Promise<void>((resolve) => {
    const loop = (): void => {
      const t = performance.now()
      if (t >= end) {
        resolve()
        return
      }
      frameTimes.push(t - prev)
      prev = t
      updates++
      const spec = buildSpec(kind, genValues(kind, points, ++seed), 600, 400)
      s.root.render(h(BenchEmbed, { name: embed, spec, width: 600, height: 400 }))
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })
  await waitForSettle(s.host, { quietFrames: 2 })
  return { frameTimes: frameTimes.slice(1), updates }
}

/** Prop-driven resize: new width passed straight to the embed. */
async function resizeLatencies(embed: EmbedName, kind: ChartKind, points: number, reps: number): Promise<number[]> {
  const out: number[] = []
  const s = await ensureSession(embed, kind, points)
  const widths = [750, 500, 650, 550]
  for (let i = 0; i < reps; i++) {
    const w = widths[i % widths.length]!
    const spec = buildSpec(kind, genValues(kind, points, 1), w, 400)
    const t0 = performance.now()
    s.root.render(h(BenchEmbed, { name: embed, spec, width: w, height: 400 }))
    out.push(await timeWork(s.host, { quietFrames: 2, t0 }))
  }
  return out
}

/**
 * Container-driven resize (what a responsive app really does): change the
 * host element's CSS width and time how long the chart svg takes to follow.
 * aster reacts via its built-in ResizeObserver; the vega paths do not
 * auto-resize on their own, so their lag reflects the missing plumbing —
 * which is itself the finding.
 */
async function autoResize(embed: EmbedName, kind: ChartKind, points: number, widths: number[]): Promise<number[]> {
  const out: number[] = []
  const s = await ensureSession(embed, kind, points, true)
  const svg = (): SVGSVGElement | null => s.host.querySelector('svg')
  // SVG width = plot width + padding for every renderer, so compare the svg's
  // *change* against the container's change rather than absolute numbers.
  let prevHost = s.host.clientWidth
  for (const w of widths) {
    const prevRect = svg()?.getBoundingClientRect().width ?? 0
    const t0 = performance.now()
    s.host.style.width = `${w}px`
    const target = Math.abs(w - prevHost)
    let done = false
    for (;;) {
      await new Promise((r) => requestAnimationFrame(r))
      if (performance.now() - t0 > 3000) break
      const rect = svg()?.getBoundingClientRect().width ?? 0
      if (Math.abs(rect - prevRect) >= Math.max(5, target * 0.5)) {
        done = true
        break
      }
    }
    prevHost = w
    out.push(done ? performance.now() - t0 : -1)
  }
  s.host.style.width = ''
  return out
}

/** Per-update stage decomposition for aster's own pipeline (no React). */
async function stages(kind: ChartKind, points: number, reps: number) {
  teardown()
  const specs = Array.from({ length: reps }, (_, i) => buildSpec(kind, genValues(kind, points, i + 2), 600, 400))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const t: number[] = []
  const d: number[] = []
  const p: number[] = []
  const sw: number[] = []
  let scene: SceneRoot | undefined
  // warmup
  {
    const sc = evaluateChart(compileChart(specs[0] as never))
    host.innerHTML = renderSceneToSvg(sc)
    patchSceneDom(host.querySelector('svg')!, evaluateChart(compileChart(specs[0] as never)))
  }
  const stringPath: number[] = []
  const noopPatch: number[] = []
  for (const spec of specs) {
    {
      // first patch of THIS scene = data changed vs last iteration: walk + writes
      const same = evaluateChart(compileChart(spec as never))
      const tn = performance.now()
      patchSceneDom(host.querySelector('svg')!, same)
      noopPatch.push(performance.now() - tn)
    }
    const t0 = performance.now()
    const chart = compileChart(spec as never)
    scene = evaluateChart(chart)
    const t1 = performance.now()
    const desc = sceneToDomDesc(scene!)
    const t2 = performance.now()
    void desc
    patchSceneDom(host.querySelector('svg')!, scene!)
    const t3 = performance.now()
    // reference: what the string mode costs end-to-end in-browser
    host.innerHTML = renderSceneToSvg(evaluateChart(compileChart(spec as never)))
    const t4 = performance.now()
    t.push(t1 - t0)
    d.push(t2 - t1)
    p.push(t3 - t2)
    sw.push(t4 - t3)
    stringPath.push(t4 - t3)
  }
  void sw
  host.remove()
  return { evaluate: t, desc: d, patch: p, swap: sw, stringPath, noopPatch }
}

/** Re-render with an identical spec (stable data): work should collapse to ~0. */
async function stableRerenders(embed: EmbedName, kind: ChartKind, points: number, reps: number) {
  const s = await ensureSession(embed, kind, points, false)
  const spec = buildSpec(kind, genValues(kind, points, 1), 600, 400)
  s.root.render(h(BenchEmbed, { name: embed, spec, width: 600, height: 400 }))
  await waitForSettle(s.host, { quietFrames: 3 })
  const ms: number[] = []
  const mutations: number[] = []
  for (let i = 0; i < reps; i++) {
    let muts = 0
    const obs = new MutationObserver((r) => { muts += r.length })
    obs.observe(s.host, { childList: true, subtree: true, attributes: true, characterData: true })
    const t0 = performance.now()
    // fresh spec object each render (React-inline-literal pattern) over a
    // STABLE values array: content is identical, identity is not.
    s.root.render(h(BenchEmbed, { name: embed, spec: { ...spec }, width: 600, height: 400 }))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    ms.push(performance.now() - t0)
    obs.disconnect()
    mutations.push(muts)
  }
  return { ms, mutations }
}

/** Stable-update differential probe: a fixed-scale symbol chart where only ~1% of
 * points change per update, so the reactive dataflow reuses unchanged items and
 * DOM subtrees. Measures the per-datum update latency for the aster path. */
async function differentialUpdates(embed: EmbedName, points: number, reps: number): Promise<number[]> {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 600,
    height: 400,
    autosize: 'none',
    data: [{ name: 'table', values: Array.from({ length: points }, (_, i) => ({ x: i % 100, y: i % 100 })) }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 100], range: 'width' },
      { name: 'y', type: 'linear', domain: [0, 100], range: 'height' },
    ],
    marks: [{ type: 'symbol', from: { data: 'table' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 40 } } } }],
  }
  const rows = (spec.data[0] as { values: Array<{ x: number; y: number }> }).values
  const s = mountSession(embed, spec)
  await waitForSvg(s.host)
  const changed = Array.from({ length: Math.max(1, Math.floor(points / 100)) }, (_, i) => (i * 997) % points)
  const out: number[] = []
  for (let i = 0; i < reps; i++) {
    const next = rows.map((r, j) => (changed.includes(j) ? { x: r.x, y: (r.y + 1) % 100 } : r))
    const t0 = performance.now()
    s.root.render(h(BenchEmbed, { name: embed, spec, width: 600, height: 400, data: { table: next }, dataChanges: { table: changed } }))
    out.push(await timeWork(s.host, { quietFrames: 2, t0 }))
  }
  return out
}

const api: BenchApi = {
  mounts: firstRenderMs,
  updates: updateLatencies,
  fps: framePacing,
  resize: resizeLatencies,
  autoResize,
  stages,
  stableRerenders,
  differentialUpdates,
  domNodes: () => (session ? session.host.querySelectorAll('*').length : 0),
  reset: teardown,
}

// warmup runs first from the driver, then reset() clears state for each metric.
;(window as unknown as Record<string, unknown>).__bench = api
;(window as unknown as Record<string, unknown>).__benchWarmup = warmup
