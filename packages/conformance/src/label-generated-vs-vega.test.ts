/**
 * Generated `label` specs against vega-label (label-cases.ts: the mark the labels belong to, the marks to avoid, anchors, offsets,
 * padding, method, lineAnchor, markIndex, sort, avoidBaseMark, sizes).
 *
 * Two runs of the same specs:
 *  - in Node, vega in a child process with the coverage-only canvas stand-in (the engine's own rasterizer on both sides), every
 *    label compared exactly: x, y, opacity, align, baseline. This tests everything but the rasterizer: the layout, the anchors, the
 *    scaler, the base-mark boundary, which marks are drawn and how, the sort, the padding, the text widths.
 *  - in Chromium, vega on its real canvas against `<Chart>` (runInline compares the pictures), which is what the rasterizer must
 *    reproduce: which pixels of the marks to avoid have any alpha.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import '@aster/core/transforms'
import { compileChart, datasetsOfScene, evaluateChart } from '@aster/core'
import { runInline, type InlineSpec } from './gallery/react.js'
import { labelCase, type LabelCase } from './label-cases.js'

interface Row { text: unknown; x: unknown; y: unknown; opacity: unknown; align: unknown; baseline: unknown }
type VegaOut = Record<string, { items?: Row[]; error?: string }>

const HERE = dirname(fileURLToPath(import.meta.url))
const SEEDS = Number(process.env.LABEL_SEEDS ?? 160)
const BROWSER_SEEDS = Number(process.env.LABEL_BROWSER_SEEDS ?? 40)

function runVega(cases: LabelCase[]): VegaOut {
  const input = JSON.stringify(cases.map((c) => ({ id: c.id, spec: c.spec, mark: c.mark, dataset: c.dataset })))
  const out = execFileSync(process.execPath, ['--import', join(HERE, 'label-canvas', 'register.mjs'), join(HERE, 'label-canvas', 'run-vega-batch.mjs')], { input, maxBuffer: 1 << 29 })
  return JSON.parse(out.toString()) as VegaOut
}

function engineRows(c: LabelCase): Row[] {
  const scene = evaluateChart(compileChart(structuredClone(c.spec) as never), {})
  if (c.dataset) return datasetsOfScene(scene).get(c.dataset) as unknown as Row[]
  let found: Row[] = []
  const visit = (n: { name?: string; marktype?: string; items?: unknown[] }): void => {
    if (n.marktype === 'text' && n.name === c.mark) found = n.items as Row[]
    for (const k of n.items ?? []) if (k && typeof k === 'object' && ((k as { marktype?: string }).marktype || (k as { items?: unknown }).items)) visit(k as never)
  }
  visit(scene as never)
  return found
}

// (vega's NaN comes through the child's JSON as null)
const missing = (v: unknown): boolean => v == null || Number.isNaN(v)
const same = (a: unknown, b: unknown): boolean => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9) || (missing(a) && missing(b))

describe('label: generated specs vs vega-label', () => {
  it(`${SEEDS} generated specs: every label the same x, y, opacity, align and baseline (Node, shared rasterizer)`, { timeout: 600_000 }, () => {
    const cases = Array.from({ length: SEEDS }, (_, i) => labelCase(i + 1))
    // a size that is not a pair: both log the error and leave the labels as they were
    for (const [id, size] of [['size-one', [100]], ['size-three', [100, 100, 100]]] as const) {
      const base = labelCase(2)
      const spec = structuredClone(base.spec) as { marks: Array<{ transform?: Array<Record<string, unknown>> }> }
      const label = spec.marks.at(-1)!.transform![0]!
      label.size = size
      cases.push({ ...base, id, spec: spec as never })
    }
    const vega = runVega(cases)
    const bad: string[] = []
    let labels = 0
    let placed = 0
    const kinds = new Set<string>()
    for (const c of cases) {
      const want = vega[c.id]!
      let got: Row[]
      try { got = engineRows(c) } catch (e) {
        if (want.error === undefined || want.error !== (e instanceof Error ? e.message : String(e))) bad.push(`${c.id} (${c.kind}): engine threw ${String(e)}, vega ${JSON.stringify(want)}`)
        continue
      }
      if (want.error !== undefined) { bad.push(`${c.id} (${c.kind}): vega threw ${want.error}`); continue }
      const w = want.items!
      if (w.length !== got.length) { bad.push(`${c.id} (${c.kind}): ${w.length} vega labels, ${got.length} engine`); continue }
      kinds.add(c.kind)
      w.forEach((x, i) => {
        const g = got[i]!
        labels++
        if (x.opacity === 1) placed++
        if (!(same(x.x, g.x) && same(x.y, g.y) && same(x.opacity, g.opacity) && same(x.align, g.align) && same(x.baseline, g.baseline))) {
          bad.push(`${c.id} (${c.kind}) #${i}: vega ${JSON.stringify(x)} engine ${JSON.stringify({ x: g.x, y: g.y, o: g.opacity, a: g.align, b: g.baseline })}`)
        }
      })
    }
    expect(bad.slice(0, 8)).toEqual([])
    // not vacuous: many labels, some placed and some not, every kind of base mark met
    expect(labels).toBeGreaterThan(2000)
    expect(placed).toBeGreaterThan(labels * 0.15)
    expect(placed).toBeLessThan(labels * 0.95)
    expect(kinds.size).toBe(11)
  })

  it(`${BROWSER_SEEDS} generated specs: about the same pictures as vega's, in Chromium (real canvas)`, { timeout: 900_000 }, async () => {
    const cases = Array.from({ length: BROWSER_SEEDS }, (_, i) => labelCase(1000 + i, true))
    const inputs: InlineSpec[] = cases.map((c) => ({ id: c.id, spec: c.spec, liveMs: 0 }))
    const out = await runInline(inputs, () => undefined, 4)
    const bad = out.filter((o) => o.status !== 'pass')
    const report = bad.slice(0, 4).map((o) => `${o.id}: ${o.status} ${o.reason ?? ''} ${o.first ?? ''}\n${JSON.stringify(cases.find((c) => c.id === o.id)!.spec)}`)
    // The coverage-only canvas agrees with a browser's on which pixels have any alpha except at the odd antialiased edge (that is
    // raster-vs-chromium.test.ts's to pin), and a layout is a cascade: one pixel moves a label, which moves the ones after it. So
    // this is a rate: 9-10% of the specs differ today, and a layout that went wrong (a bitmap layer, a mark not drawn, a boundary)
    // differs in nearly all of them.
    expect(bad.length / out.length, `${bad.length} of ${out.length} specs differ from vega:\n${report.join('\n\n')}`).toBeLessThanOrEqual(0.15)
  })
})
