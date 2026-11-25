/**
 * A running view across signal writes, against a running vega view (C766).
 *
 * vega's view keeps state from one run to the next: an axis joins its tick items by value, so the ticks it still shows keep their
 * order and new ones come after them; and its autosize sizes the view on the first run, and again only when the `width`, `height`
 * or `padding` signal changes (or `autosize.resize`). An Aster evaluation continues a view when given its scene (`retainFrom`; a
 * session made with `runningView`, as `<Chart>`'s is, passes its last scene). Where the rows a mark is drawn from changed, vega's
 * item order is its join's, which an evaluation cannot tell from the rows: Aster then renders the step, and every step after it, as vega
 * renders it fresh (rows appended after the others are joined after them by both: the view goes on).
 *
 * Generated: specs whose x domain, y domain and size follow signals, axes on both scales (some with a grid), labels that change the
 * padding, `autosize` pad (with and without `resize`) and none, and walks of signal writes; a dataset replaced now and then. Every
 * step equals vega's running view (or, where the rows changed, vega's fresh render of the same state), and the session's scene equals
 * a fresh evaluation given the same scene to continue (the incremental guarantee).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart, renderSceneToSvg, type SceneRoot } from '@aster-charts/core'
import { createChartSession } from '@aster-charts/core/dom'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

function stream(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function caseOf(seed: number): { spec: Spec; steps: Array<{ signals?: Record<string, number>; rows?: unknown[] }> } {
  const r = stream(seed * 2654435761)
  const rows = (k: number): unknown[] => Array.from({ length: 5 }, (_, i) => ({ x: i * 7 + k, y: (i * 13 + k * 3) % 40 }))
  const autosize = [{ type: 'pad' }, { type: 'pad', resize: true }, 'none'][seed % 3]
  const spec: Spec = {
    width: 200, height: 120, padding: 5, autosize,
    signals: [{ name: 'lo', value: 0 }, { name: 'hi', value: 40 }, { name: 'ylo', value: 0 }, { name: 'yhi', value: 50 }, { name: 'w', value: 200 }],
    data: [{ name: 't', values: rows(0) }],
    scales: [
      { name: 'x', type: 'linear', domain: { signal: '[lo, hi]' }, range: [0, { signal: 'w' }], nice: false, zero: false },
      { name: 'y', type: 'linear', domain: { signal: '[ylo, yhi]' }, range: 'height', nice: false, zero: false },
    ],
    axes: [{ scale: 'x', orient: 'bottom', grid: r() < 0.5 }, { scale: 'y', orient: 'left', title: r() < 0.5 ? 'Y title' : undefined }],
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 40 } } } }],
  }
  const steps: Array<{ signals?: Record<string, number>; rows?: unknown[] }> = []
  const at = { lo: 0, hi: 40, ylo: 0, yhi: 50, w: 200 }
  for (let k = 0; k < 8; k++) {
    const u = r()
    if (u < 0.55) { const d = Math.round((r() - 0.5) * 30); at.lo += d; at.hi += d + Math.round((r() - 0.5) * 20); if (at.hi <= at.lo + 2) at.hi = at.lo + 10 }
    else if (u < 0.75) { at.ylo = Math.round(r() * 20 - 10); at.yhi = at.ylo + 10 + Math.round(r() * 2000) }
    else if (u < 0.85) at.w = 150 + Math.round(r() * 100)
    else { steps.push({ rows: rows(k + 1) }); continue }
    steps.push({ signals: { ...at } })
  }
  return { spec, steps }
}

async function vegaFresh(spec: Spec, signals: Record<string, number>, rows: unknown[]): Promise<string> {
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  try {
    for (const [k, v] of Object.entries(signals)) view.signal(k, v)
    view.data('t', structuredClone(rows))
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

describe('a running view across signal writes (C766)', () => {
  it("every step equals vega's running view (or, where the rows changed, its fresh render), and the session equals a fresh evaluation that continues the same scene", async () => {
    const bad: string[] = []
    let retainedDiffers = 0
    for (let seed = 0; seed < 24; seed++) {
      const c = caseOf(seed)
      const view = new vega.View(vega.parse(structuredClone(c.spec) as never), { renderer: 'none' })
      await view.runAsync()
      const session = createChartSession({ runningView: true })
      const chart = compileChart(structuredClone(c.spec) as never)
      let signals: Record<string, number> = {}
      let rows = (c.spec.data as Array<{ values: unknown[] }>)[0]!.values
      let prev: SceneRoot = session.evaluate(structuredClone(c.spec) as never, {})
      // (once rows came or went the two renders' item orders part: from there on the view is rendered as vega renders it fresh)
      let parted = false
      for (const [k, step] of c.steps.entries()) {
        if (step.signals) { signals = step.signals; for (const [n, v] of Object.entries(signals)) view.signal(n, v) }
        if (step.rows) { rows = step.rows; view.data('t', structuredClone(rows)) }
        await view.runAsync()
        const running = await view.toSVG()
        const scene = session.evaluate(structuredClone(c.spec) as never, { signals, data: { t: rows } })
        const mine = renderSceneToSvg(scene)
        if (step.rows) parted = true
        const want = parted ? await vegaFresh(c.spec, signals, rows) : running
        const d = diffCanonical(canonicalizeSvg(want), canonicalizeSvg(mine))
        if (d.length) { bad.push(`seed ${seed} step ${k}: ${d[0]}`); break }
        if (!parted && diffCanonical(canonicalizeSvg(running), canonicalizeSvg(await vegaFresh(c.spec, signals, rows))).length) retainedDiffers++
        // (the incremental guarantee: a fresh evaluation of a fresh compile, given the same scene to continue, is the same scene)
        const fresh = renderSceneToSvg(evaluateChart(compileChart(structuredClone(c.spec) as never), { signals, data: { t: rows }, retainFrom: prev }))
        if (fresh !== mine) { bad.push(`seed ${seed} step ${k}: the session is not the fresh evaluation that continues the same scene`); break }
        void chart
        prev = scene
      }
      view.finalize()
    }
    expect(bad).toEqual([])
    // (not vacuous: vega's running view differs from its fresh render at many of these steps)
    expect(retainedDiffers).toBeGreaterThan(20)
  }, 180_000)

  it("an ordinal scale given no domain keeps the categories it was asked for, as vega's scale object does (C70)", async () => {
    const bad: string[] = []
    let kept = 0
    const labels = (svg: string): string => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join(',')
    for (let seed = 0; seed < 12; seed++) {
      const r = stream(seed * 97 + 5)
      const cats = ['USA', 'Japan', 'Europe', 'Asia', 'Mars'].slice(0, 2 + Math.floor(r() * 4))
      const spec: Spec = {
        width: 120, height: 80, padding: 5, signals: [{ name: 'sel', value: null }],
        data: [{ name: 't', values: cats.map((k, i) => ({ k, x: i * 10 })) }],
        scales: [{ name: 'c', type: 'ordinal', range: 'category' }],
        legends: [{ fill: 'c' }],
        marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { value: 20 }, fill: [{ test: 'sel === null || datum.k === sel', scale: 'c', field: 'k' }, { value: 'gray' }] } } }],
      }
      const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
      await view.runAsync()
      const session = createChartSession({ runningView: true })
      session.evaluate(structuredClone(spec) as never, {})
      for (let k = 0; k < 4; k++) {
        const sel = r() < 0.25 ? null : cats[Math.floor(r() * cats.length)]!
        view.signal('sel', sel)
        await view.runAsync()
        const want = await view.toSVG()
        const got = renderSceneToSvg(session.evaluate(structuredClone(spec) as never, { signals: { sel } }))
        const d = diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))
        if (d.length) { bad.push(`seed ${seed} step ${k}: ${d[0]}`); break }
        if (sel !== null && labels(want).split(',').length > 1) kept++
      }
      view.finalize()
    }
    expect(bad).toEqual([])
    expect(kept).toBeGreaterThan(10)
  })
})
