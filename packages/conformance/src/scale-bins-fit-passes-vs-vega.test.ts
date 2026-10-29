/**
 * vega's Scale operator keeps its scale between dataflow passes. A scale given `bins` leaves the zero out of its default
 * domain (`includeZero` reads `scale.bins`), but only a pass that finds the bins of the pass before it: the first pass of a
 * scale includes the zero, the pass an autosize `fit` view makes at its fitted size does not -- when the scale's parameters
 * changed, which is when the operator runs again. Each spec runs in real vega and in the engine; the picture must be equal.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function vegaSvg(spec: Spec): Promise<string> {
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally { view.finalize() }
}

const VALUES = [3.2, 4.1, 4.4, 5.9, 6.3, 6.4, 7.7, 8.8, 9.1, 9.9, 5.5, 5.1].map((v) => ({ v }))

const spec = (autosize: string | Spec, range: unknown, extra: Spec = {}): Spec => ({
  width: 400, height: 200, padding: 5, autosize,
  title: { text: 'A title that is wide enough to push the view out of its frame', anchor: 'start', frame: 'bounds' },
  signals: [{ name: 'maxbins', value: 10 }],
  data: [
    { name: 'table', values: VALUES, transform: [{ type: 'extent', field: 'v', signal: 'extent' }, { type: 'bin', signal: 'bins', field: 'v', extent: { signal: 'extent' }, maxbins: { signal: 'maxbins' } }] },
    { name: 'counts', source: 'table', transform: [{ type: 'aggregate', groupby: ['bin0', 'bin1'] }] },
  ],
  scales: [
    { name: 'x', type: 'linear', range, round: true, domain: { signal: '[bins.start, bins.stop]' }, bins: { signal: 'bins' }, ...extra },
    { name: 'y', type: 'linear', range: 'height', nice: true, zero: true, domain: { data: 'counts', field: 'count' } },
  ],
  axes: [{ orient: 'bottom', scale: 'x' }, { orient: 'left', scale: 'y' }],
  marks: [{
    type: 'rect', from: { data: 'counts' },
    encode: { update: { x: { scale: 'x', field: 'bin0', offset: 1 }, x2: { scale: 'x', field: 'bin1' }, y: { scale: 'y', field: 'count' }, y2: { scale: 'y', value: 0 }, fill: { value: 'steelblue' } } },
  }],
})

const CASES: Array<[string, Spec]> = [
  ['a bins scale ranged on the width, fit: the second pass leaves the zero out', spec('fit', 'width')],
  ['the same with fit-x', spec('fit-x', 'width')],
  ['a bins scale whose range does not change between the passes keeps the zero', spec('fit', [0, 300])],
  ['a bins scale ranged on the height under fit-x (only the width changes)', spec('fit-x', 'height')],
  ['a bins scale with the zero asked for explicitly', spec('fit', 'width', { zero: true })],
  ['one pass (autosize pad): the zero is in', spec('pad', 'width')],
]

describe('a scale with bins across the passes of a fit view (vs vega)', () => {
  for (const [name, s] of CASES) {
    it(name, async () => {
      const want = await vegaSvg(s)
      const got = renderSpec(structuredClone(s) as never)
      expect(diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))).toEqual([])
    })
  }
  it('the cases tell the two outcomes apart', async () => {
    const fit = await vegaSvg(spec('fit', 'width'))
    const pad = await vegaSvg(spec('pad', 'width'))
    expect(fit).toContain('values from 3 to 10')
    expect(pad).toContain('values from 0 to 10')
  })
})
