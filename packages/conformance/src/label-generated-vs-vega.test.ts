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
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import '@aster-charts/core/transforms'
import { compileChart, datasetsOfScene, evaluateChart } from '@aster-charts/core'
import { runInline, type InlineSpec } from './gallery/react.js'
import { labelCase, type LabelCase } from './label-cases.js'

interface Row { text: unknown; x: unknown; y: unknown; opacity: unknown; align: unknown; baseline: unknown }
type VegaOut = Record<string, { items?: Row[]; error?: string }>

const HERE = dirname(fileURLToPath(import.meta.url))
const SEEDS = Number(process.env.LABEL_SEEDS ?? 160)
const AREA_SEEDS = Number(process.env.LABEL_AREA_SEEDS ?? 90)
const BROWSER_SEEDS = Number(process.env.LABEL_BROWSER_SEEDS ?? 40)

// (not execFileSync: the child runs for tens of seconds, and a worker that does not turn its event loop that long loses its RPC to vitest)
async function runVega(cases: LabelCase[]): Promise<VegaOut> {
  const input = JSON.stringify(cases.map((c) => ({ id: c.id, spec: c.spec, mark: c.mark, dataset: c.dataset })))
  const child = promisify(execFile)(process.execPath, ['--import', join(HERE, 'label-canvas', 'register.mjs'), join(HERE, 'label-canvas', 'run-vega-batch.mjs')], { maxBuffer: 1 << 29, encoding: 'buffer' })
  child.child.stdin!.end(input)
  return JSON.parse((await child).stdout.toString()) as VegaOut
}
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

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

/**
 * The generated specs (seed 1000 + n) whose picture differs from vega's on a real canvas, with what the first difference is.
 * Each is a live difference of the label layout (it is still compared every run). Not in ARCHITECTURE's "Deviations from Vega":
 * it is not intended behaviour, it is an open difference.
 *
 * label-1006: the cause is established (audit 2026-11-22, a33). The first label that diverges is dropped because pixel (56, 130), at the
 * tip of a DASHED ROUND-CAP rule (3 px wide, dash [40, 30], from (20.032, 132.04)), has alpha 1 in the engine and 0 in Chromium. A true circle
 * of radius 1.5 about the dash end covers a sliver of about 0.005 px^2 of that pixel, which the engine's inscribed 13-gon keeps (alpha 1);
 * Chromium's cap tip is asymmetric (smaller at the top, larger at the bottom), which no circle-like cap reproduces. Alphas at the tip:
 *   pixel    Chromium  engine (13-gon)  engine (conic-arc cap, tried)
 *   (56,130)    0           1                 6
 *   (56,133)   12           1                 6
 *   (55,130)   76          95                88
 *   (55,133)  102          97                88
 * Caps as conic arcs held the raster ratchet on all but four drawings and did not fix the pixel; walking curve quads from their top end
 * (as Skia does) improves the summed alpha by a sixth but worsens 22 drawings. Both are future work in raster-edges.ts.
 */
const KNOWN_BROWSER_DIFFERENCES: Record<string, string> = {
  'label-1006': "a rule base: vega places the label 'ff fff' at (92.69, 42.12), Aster leaves it out (opacity 0)",
}

describe('label: generated specs vs vega-label', () => {
  it(`${SEEDS} generated specs: every label the same x, y, opacity, align and baseline (Node, shared rasterizer)`, { timeout: 600_000 }, async () => {
    const cases = Array.from({ length: SEEDS }, (_, i) => labelCase(i + 1))
    // the searches for a label inside an area, which the spread above meets a few times: the cells a flood has visited are kept from
    // one label to the next, and whether an area's neighbour has been flooded into shows in one spec of about twelve
    for (let i = 0; i < AREA_SEEDS; i++) {
      for (const method of ['floodfill', 'reduced-search']) cases.push({ ...labelCase(5000 + i, false, { kind: 'group-area', method }), id: `area-${method}-${i}` })
    }
    // a size that is not a pair: vega lays nothing out and leaves the labels as they were (their text only), and so must the engine
    // (what each logs is not captured here: the rows are what is compared)
    for (const [id, size] of [['size-one', [100]], ['size-three', [100, 100, 100]]] as const) {
      const base = labelCase(2)
      const spec = structuredClone(base.spec) as { marks: Array<{ transform?: Array<Record<string, unknown>> }> }
      const label = spec.marks.at(-1)!.transform![0]!
      label.size = size
      cases.push({ ...base, id, spec: spec as never })
    }
    const vega = await runVega(cases)
    const bad: string[] = []
    let labels = 0
    let placed = 0
    const kinds = new Set<string>()
    for (const c of cases) {
      await yieldToLoop()
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
    expect(kinds.size).toBe(12)
  })

  it(`${BROWSER_SEEDS} generated specs: the same pictures as vega's, in Chromium (real canvas), but the pinned ones`, { timeout: 900_000 }, async () => {
    const cases = Array.from({ length: BROWSER_SEEDS }, (_, i) => labelCase(1000 + i, true))
    const inputs: InlineSpec[] = cases.map((c) => ({ id: c.id, spec: c.spec, liveMs: 0 }))
    const out = await runInline(inputs, () => undefined, 4)
    const bad = out.filter((o) => o.status !== 'pass')
    const report = (list: typeof out): string => list.slice(0, 4).map((o) => `${o.id}: ${o.status} ${o.reason ?? ''} ${o.first ?? ''}\n${JSON.stringify(cases.find((c) => c.id === o.id)!.spec)}`).join('\n\n')
    // This is the independent reference of the label differential (the Node run above shares Aster's rasterizer with the oracle):
    // vega on a real canvas against <Chart>. A layout is a cascade -- one pixel moves a label, which moves the ones after it -- so a
    // spec that differs is pinned BY NAME with what it shows (KNOWN_BROWSER_DIFFERENCES), never admitted by a rate: a new difference
    // fails here, and one that is fixed fails as FIXED-GAP until its entry is removed (the list can only shrink).
    const unexpected = bad.filter((o) => !(o.id in KNOWN_BROWSER_DIFFERENCES))
    expect(unexpected.length, `${unexpected.length} spec(s) differ from vega that are not pinned:\n${report(unexpected)}`).toBe(0)
    const fixed = Object.keys(KNOWN_BROWSER_DIFFERENCES).filter((id) => !bad.some((o) => o.id === id))
    expect(fixed, 'FIXED-GAP: these pinned specs now agree with vega: remove their entries').toEqual([])
    expect(out.length).toBe(BROWSER_SEEDS)
  })
})
