/**
 * Generated axes and legends against real Vega (guide-cases.ts): every orient, every label / tick / grid / domain / title
 * property, labelOverlap / labelBound / labelFlush, number and time formats, offset / position / translate / zindex, and
 * the three legend types over color, size, shape, opacity and dash scales with direction, columns, entry padding, clip height,
 * gradient length and thickness, title orient / anchor / align / baseline / limit, and every legend orient (the four corners
 * and `none` too), several legends to a chart. The strict canonicalizer judges the documents (so positions, offsets, bounds
 * and the view size they decide are all compared; the titles are the view's own, with subtitles, on all four edges); a failing case is named by its seed and replays with GUIDE_SEED=<n>.
 */
import { describe, expect, it } from 'vitest'
import { axisCase, legendCase, titleCase, type GuideCase } from './guide-cases.js'
import { compareToVega } from './guide-compare.js'

const AXES = Number(process.env.GUIDE_AXES ?? 500)
const LEGENDS = Number(process.env.GUIDE_LEGENDS ?? 500)
const TITLES = Number(process.env.GUIDE_TITLES ?? 400)
const ONLY = process.env.GUIDE_SEED === undefined ? undefined : Number(process.env.GUIDE_SEED)

async function sweep(make: (seed: number) => GuideCase, count: number): Promise<{ bad: string[]; refused: number; compared: number }> {
  const bad: string[] = []
  let refused = 0
  let compared = 0
  const seeds = ONLY === undefined ? Array.from({ length: count }, (_, i) => i + 1) : [ONLY]
  for (const seed of seeds) {
    const c = make(seed)
    const out = await compareToVega(c.spec)
    if (out.refused !== undefined) { refused++; continue }
    compared++
    if (out.diffs.length) bad.push(`${c.id} (${c.kind}): ${out.diffs.slice(0, 3).join(' | ')}`)
    if (compared % 25 === 0) await new Promise((resolve) => setImmediate(resolve))
  }
  return { bad, refused, compared }
}

describe('generated guides vs vega', () => {
  it(`${AXES} generated axis charts render the vega document`, { timeout: 900_000 }, async () => {
    const { bad, refused, compared } = await sweep(axisCase, AXES)
    expect(bad.slice(0, 6)).toEqual([])
    // not vacuous: the oracle takes nearly every case
    if (ONLY === undefined) { expect(compared).toBeGreaterThan(AXES * 0.9); expect(refused).toBeLessThan(AXES * 0.1) }
  })

  it(`${LEGENDS} generated legend charts render the vega document`, { timeout: 900_000 }, async () => {
    const { bad, refused, compared } = await sweep(legendCase, LEGENDS)
    expect(bad.slice(0, 6)).toEqual([])
    if (ONLY === undefined) { expect(compared).toBeGreaterThan(LEGENDS * 0.9); expect(refused).toBeLessThan(LEGENDS * 0.1) }
  })

  it(`${TITLES} generated titles with subtitles, on every edge, render the vega document`, { timeout: 900_000 }, async () => {
    const { bad, refused, compared } = await sweep(titleCase, TITLES)
    expect(bad.slice(0, 6)).toEqual([])
    if (ONLY === undefined) { expect(compared).toBeGreaterThan(TITLES * 0.9); expect(refused).toBeLessThan(TITLES * 0.1) }
  })

  // Seeds past the default sweep that each need a behaviour the 500 rarely draw: the second arrangement of a legend by the second pass of
  // a fit view (its title's width, rounded up from a box carried to its place).
  it('fit legends whose title width falls on a whole pixel on the second pass render the vega document', { timeout: 60_000 }, async () => {
    const bad: string[] = []
    for (const seed of [594, 1715, 3711]) {
      const c = legendCase(seed)
      const out = await compareToVega(c.spec)
      if (out.refused === undefined && out.diffs.length) bad.push(`${c.id}: ${out.diffs.slice(0, 2).join(' | ')}`)
    }
    expect(bad).toEqual([])
  })

  // Every chart as a fit view: its guides enter, update and exit between the two passes (a scale or tick set that the first pass's size
  // changes), and the paint order of what is left must be vega's.
  it('legend and axis charts forced to fit, 300 each, render the vega document', { timeout: 300_000 }, async () => {
    const bad: string[] = []
    const modes = ['fit', 'fit-x', 'fit-y']
    for (const [make, tag] of [[legendCase, 'legend'], [axisCase, 'axis']] as const) {
      for (let seed = 1; seed <= 300; seed++) {
        const c = make(seed)
        const spec = { ...c.spec, autosize: modes[seed % 3] }
        const out = await compareToVega(spec)
        if (out.refused === undefined && out.diffs.length) bad.push(`${tag}-${seed}: ${out.diffs.slice(0, 2).join(' | ')}`)
      }
    }
    expect(bad.slice(0, 6)).toEqual([])
  })
  it('the axis chart whose labels the second pass paints in vega order renders the vega document', { timeout: 60_000 }, async () => {
    const c = axisCase(1225)
    const out = await compareToVega(c.spec)
    expect(out.diffs).toEqual([])
  })
})
