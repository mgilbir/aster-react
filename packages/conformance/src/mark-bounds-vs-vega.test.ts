// @vitest-environment jsdom
/**
 * Generated marks (mark-cases.ts) against real vega: arcs (cornerRadius, padAngle, angle, padRadius, radii), trails, lines and
 * areas of every interpolate (tension, orient, holes), paths (null paths among them) and symbols, with strokes, caps, joins and
 * miter limits. For each spec: the bounds vega's Bound pass leaves on every item and on the mark, and the canonical SVG (which
 * carries the view size the bounds give: autosize pad).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { compareBounds } from './mark-bounds-oracle.js'
import { INTERPOLATES, MARK_KINDS, markCase, type MarkKind } from './mark-cases.js'

const SEEDS = Number(process.env.MARK_SEEDS ?? 600)
const TOL = 1e-9

async function oracleSvg(spec: Record<string, unknown>): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  try { await view.runAsync(); return await view.toSVG() } finally { view.finalize() }
}

describe('mark bounds against vega', () => {
  for (const kind of MARK_KINDS) {
    it(`${kind}: generated specs, item and mark bounds and the view size`, { timeout: 300_000 }, async () => {
      const bad: string[] = []
      let marks = 0
      const per = Math.ceil(SEEDS / MARK_KINDS.length)
      for (let seed = 1; seed <= per; seed++) {
        const { spec } = markCase(seed, kind as MarkKind)
        const b = await compareBounds(spec, TOL)
        marks += b.marks
        if (b.diffs.length) bad.push(`seed ${seed}: ${b.diffs[0]}`)
        const svg = diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(structuredClone(spec) as never)))
        if (svg.length) bad.push(`seed ${seed}: svg ${svg[0]}`)
        if (bad.length >= 8) break
      }
      expect(bad.slice(0, 6), JSON.stringify(markCase(1, kind as MarkKind).spec)).toEqual([])
      expect(marks).toBeGreaterThan(0)
    })
  }

  it('every curve interpolate is drawn by the generator', () => {
    const seen = new Set<string>()
    for (let seed = 1; seed <= 400; seed++) {
      for (const kind of ['line', 'area'] as const) {
        const m = /"interpolate":\{"value":"([^"]+)"\}/.exec(JSON.stringify(markCase(seed, kind).spec))
        if (m) seen.add(m[1]!)
      }
    }
    expect([...seen].sort()).toEqual([...INTERPOLATES].sort())
  })
})
