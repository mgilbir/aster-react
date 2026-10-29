/**
 * A view dimension the spec gives no value (no number, no `width` / `height` signal) is 0 in vega, and the autosize pass grows it to
 * the content. A <Chart> that measured its container must not fill it instead (the gallery's `vega/arc-diagram`: `width: 770`, no
 * height, text hanging below the axis). The host's measured container (`measuredSize`) only sizes a dimension the spec leaves to the
 * host, never one that vega's own view leaves to the content. Judged against real vega with the strict canonicalizer, over the
 * autosize types and the combinations of given / missing sizes.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracleSvg(spec: Spec): Promise<string> {
  const view = new vega.View(vega.parse(spec as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

const MEASURED = { width: 600, height: 400 }
/** What a <Chart> in a 600 x 400 host is given when the app passes the spec's own numeric sizes as the size props (the gallery's react path does). */
const asChart = (spec: Spec): Record<string, unknown> => ({
  ...(typeof spec.width === 'number' ? { width: spec.width } : {}),
  ...(typeof spec.height === 'number' ? { height: spec.height } : {}),
  measuredSize: MEASURED, containerSize: MEASURED,
})
const marks = [
  { type: 'rect', encode: { update: { x: { value: 10 }, y: { value: 10 }, width: { value: 80 }, height: { value: 700 }, fill: { value: 'tomato' } } } },
  { type: 'text', encode: { update: { x: { value: 20 }, y: { value: 7 }, angle: { value: -90 }, align: { value: 'right' }, text: { value: 'a long hanging label' } } } },
]
const sizes: Array<[string, Spec]> = [
  ['a width only', { width: 300 }],
  ['a height only', { height: 200 }],
  ['neither', {}],
  ['both', { width: 300, height: 200 }],
]
const autosizes: Array<[string, unknown]> = [
  ['default', undefined], ['pad', 'pad'], ['none', 'none'], ['fit', 'fit'], ['fit-x', 'fit-x'], ['fit-y', 'fit-y'],
  ['pad, resize', { type: 'pad', resize: true }], ['pad, contains padding', { type: 'pad', contains: 'padding' }],
]

describe('a view dimension the spec leaves unsized is not the measured container', () => {
  for (const [sn, size] of sizes) {
    for (const [an, autosize] of autosizes) {
      it(`${sn}, autosize ${an}`, async () => {
        const spec: Spec = { ...size, padding: 5, ...(autosize !== undefined ? { autosize } : {}), marks }
        const oracle = canonicalizeSvg(await oracleSvg(spec))
        expect(diffCanonical(oracle, canonicalizeSvg(renderSpec(spec as never, asChart(spec))))).toEqual([])
      })
    }
  }
  it('the comparison is not empty (the unsized dimension really grows to the content)', () => {
    const svg = renderSpec({ width: 300, padding: 5, marks } as never, asChart({ width: 300 }))
    expect(svg).toMatch(/height="7\d\d"/)
  })
})
