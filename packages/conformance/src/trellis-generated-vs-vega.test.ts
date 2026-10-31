/**
 * Generated grids of groups against real Vega (guide-cases.ts `trellisCase`): a facet of cells (wrapped or crossed) and its
 * column / row headers, footers and titles, over `layout` with align all / each / none (and per row and column), bounds full /
 * flush, center, padding, columns, header / footer / title bands, anchors and offsets, with axes, legends, nested groups and
 * titles inside the cells. The strict canonicalizer judges the documents; a failing case is named by its seed and replays
 * with TRELLIS_SEED=<n>.
 */
import { describe, expect, it } from 'vitest'
import { trellisCase } from './guide-cases.js'
import { compareToVega } from './guide-compare.js'

const CASES = Number(process.env.TRELLIS_CASES ?? 500)
const ONLY = process.env.TRELLIS_SEED === undefined ? undefined : Number(process.env.TRELLIS_SEED)

describe('generated trellis layouts vs vega', () => {
  it(`${CASES} generated grids render the vega document`, { timeout: 900_000 }, async () => {
    const bad: string[] = []
    let refused = 0
    let compared = 0
    const kinds = new Set<string>()
    const seeds = ONLY === undefined ? Array.from({ length: CASES }, (_, i) => i + 1) : [ONLY]
    for (const seed of seeds) {
      const c = trellisCase(seed)
      const out = await compareToVega(c.spec)
      if (out.refused !== undefined) { refused++; if (ONLY !== undefined) console.log(out.refused); continue }
      compared++
      kinds.add(c.kind)
      if (out.diffs.length) bad.push(`${c.id} (${c.kind}): ${out.diffs.slice(0, 3).join(' | ')}`)
      if (compared % 25 === 0) await new Promise((resolve) => setImmediate(resolve))
    }
    expect(bad.slice(0, 6)).toEqual([])
    if (ONLY === undefined) { expect(compared).toBeGreaterThan(CASES * 0.9); expect(kinds.size).toBe(2) }
  })

  // Seeds past the default sweep that each need a behaviour the 500 rarely draw: the second layout of a fit view starts from the places of
  // the first (a track edge on a whole pixel), and a header beyond the columns leaves the bounds of the view and its title.
  it('fit grids whose second layout rounds a track the other way render the vega document', { timeout: 120_000 }, async () => {
    const bad: string[] = []
    for (const seed of [1240, 2376, 671, 935, 1734]) {
      const c = trellisCase(seed)
      const out = await compareToVega(c.spec)
      if (out.refused === undefined && out.diffs.length) bad.push(`${c.id}: ${out.diffs.slice(0, 2).join(' | ')}`)
    }
    expect(bad).toEqual([])
  })
})
