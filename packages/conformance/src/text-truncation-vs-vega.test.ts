// @vitest-environment jsdom
/**
 * Generated text marks against real vega: `limit` truncation (`ellipsis` set, empty or absent, `dir` ltr or rtl, font, size,
 * multi-line text), the polar offset (`radius` and `theta`), angle, align and baseline. Compared per spec on
 *  - the canonical SVG (the text each item draws, its transform, the view size the text bounds give);
 *  - the bounds of every text item and mark (vega's Bound pass against the engine's);
 *  - the lines the CANVAS renderer draws (fillText) against the lines vega's SVG draws.
 * Headless text metrics (vega's estimate, no canvas in jsdom) on both sides; the real-canvas metrics are the Chromium test below.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart, renderSpec } from '@aster/core'
import { renderSceneToCanvas, type CanvasLike } from '@aster/core/canvas'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { compareBounds } from './mark-bounds-oracle.js'
import { textCase } from './text-cases.js'

type Spec = Record<string, unknown>

async function oracleSvg(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  try { await view.runAsync(); return await view.toSVG() } finally { view.finalize() }
}

function svgLines(svg: string): string[] {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const out: string[] = []
  for (const t of Array.from(doc.querySelectorAll('text'))) {
    const spans = Array.from(t.querySelectorAll('tspan'))
    for (const s of spans.length ? spans : [t]) if (s.textContent) out.push(s.textContent)
  }
  return out
}

function canvasLines(spec: Spec): string[] {
  const out: string[] = []
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'fillText' ? (s: string) => { out.push(s) } : () => undefined) }) as unknown as CanvasLike
  renderSceneToCanvas(evaluateChart(compileChart(structuredClone(spec) as never), {}), ctx)
  return out
}

function paintsOnCanvas(spec: Spec): boolean {
  const size = ((spec.marks as Array<{ encode: { update: { fontSize?: { value: number } } } }>)[0]!.encode.update.fontSize)
  return size === undefined || size.value > 0
}

const SEEDS = Number(process.env.TEXT_SEEDS ?? 400)

describe('text truncation, polar offset and bounds against vega', () => {
  it('the cases that were wrong: an empty ellipsis, rtl, and the polar offset', async () => {
    const base = (u: Record<string, unknown>): Spec => ({ width: 200, height: 100, padding: 5, autosize: 'pad', marks: [{ type: 'text', encode: { update: { x: { value: 50 }, y: { value: 50 }, text: { value: 'The quick brown fox jumps over' }, ...u } } }] })
    for (const u of [
      { limit: { value: 40 }, ellipsis: { value: '' } },
      { limit: { value: 60 }, dir: { value: 'rtl' } },
      { limit: { value: 60 }, dir: { value: 'rtl' }, ellipsis: { value: '' } },
      { radius: { value: 30 }, theta: { value: 1 } },
    ]) {
      const spec = base(u)
      expect(diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(spec as never)))).toEqual([])
      expect(canvasLines(spec)).toEqual(svgLines(await oracleSvg(spec)))
    }
  })

  it('a polar text item keeps its anchor, radius and theta, as vega leaves them on the item', async () => {
    const spec: Spec = {
      width: 200, height: 100, padding: 5, autosize: 'pad',
      data: [{ name: 'd', values: [{ r: 10, t: 1 }, { r: 0, t: 2 }, { r: -5, t: 0.5 }, { r: 20, t: 3 }] }],
      marks: [{ type: 'text', from: { data: 'd' }, encode: { update: { x: { value: 60 }, y: { value: 40 }, text: { value: 'p' }, radius: { field: 'r' }, theta: { field: 't' } } } }],
    }
    const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; scenegraph(): { root: { items: Array<{ items: Array<{ items: Array<Record<string, unknown>> }> }> } }; finalize(): void } }).View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
    try {
      await view.runAsync()
      const want = view.scenegraph().root.items[0]!.items[0]!.items.map((i) => [i.x, i.y, i.radius, i.theta])
      const mine = (evaluateChart(compileChart(structuredClone(spec) as never), {}).items[0] as unknown as { items: Array<Record<string, unknown>> }).items.map((i) => [i.x, i.y, i.radius, i.theta])
      expect(mine).toEqual(want)
    } finally { view.finalize() }
  })

  it(`${SEEDS} generated text specs: SVG, item bounds and canvas lines the same as vega's`, { timeout: 300_000 }, async () => {
    const bad: string[] = []
    const seen = new Set<string>()
    let items = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { spec, features } = textCase(seed)
      features.forEach((f) => seen.add(f))
      const want = await oracleSvg(spec)
      const svg = diffCanonical(canonicalizeSvg(want), canonicalizeSvg(renderSpec(spec as never)))
      if (svg.length) bad.push(`seed ${seed}: svg ${svg[0]}`)
      const b = await compareBounds(spec)
      items += b.items
      if (b.diffs.length) bad.push(`seed ${seed}: bounds ${b.diffs[0]}`)
      const lines = svgLines(want)
      // (a canvas paints no text at a font size of 0 or less, which the SVG still writes)
      const drawn = canvasLines(spec)
      if (!paintsOnCanvas(spec)) continue
      if (JSON.stringify(lines) !== JSON.stringify(drawn)) bad.push(`seed ${seed}: canvas ${JSON.stringify(drawn)} vs vega svg ${JSON.stringify(lines)}`)
      if (bad.length > 12) break
    }
    expect(bad.slice(0, 6)).toEqual([])
    expect([...seen].sort()).toEqual(['array', 'dir', 'ellipsis', 'limit', 'lineBreak', 'radius'])
    expect(items).toBeGreaterThan(SEEDS)
  })
})
