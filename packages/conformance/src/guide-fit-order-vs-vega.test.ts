/**
 * An axis's ticks, labels and grid lines are keyed by `value` (vega-parser, `key: 'value'`), so vega-encode's DataJoin keeps an
 * item across dataflow passes: an autosize `fit` view runs its guides twice (at the declared size, then at the fitted one),
 * and the second pass's ticks that were also in the first update their items in place while the ticks it adds come after
 * all of them. A tick that falls out of the second pass leaves. The order of the items in the document is observable.
 * Each spec runs in real vega and in the engine; the picture, in order, must be equal.
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

const MONTHS = ['2019-10-01', '2019-11-01', '2019-12-01', '2020-01-01', '2020-02-01', '2020-03-01', '2020-04-01']
const rows = MONTHS.map((date, i) => ({ date, v: [4.29, 3.89, 4.32, 3.76, 3.62, 1.82, 0.26][i] }))

const timeSpec = (autosize: string | Spec, title: string): Spec => ({
  width: 500, height: 250, padding: 5, autosize,
  title: { text: title, anchor: 'start', frame: 'bounds' },
  data: [{ name: 't', values: rows, format: { type: 'json', parse: { date: 'date' } } }],
  scales: [
    { name: 'x', type: 'time', range: 'width', padding: 24, domain: { data: 't', field: 'date' } },
    { name: 'y', type: 'linear', range: 'height', nice: true, zero: true, domain: { data: 't', field: 'v' } },
  ],
  axes: [
    { orient: 'bottom', scale: 'x', format: '%b %Y', labelPadding: 10, grid: true },
    { orient: 'left', scale: 'y', grid: true, tickCount: 5 },
  ],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { enter: { x: { scale: 'x', field: 'date' }, y: { scale: 'y', field: 'v' } } } }],
})

const linearSpec = (autosize: string | Spec, lo: number, hi: number): Spec => ({
  width: 400, height: 200, padding: 5, autosize,
  title: { text: 'A title that is wide enough to push the view out of its frame', anchor: 'start', frame: 'bounds' },
  data: [{ name: 't', values: [{ x: lo }, { x: hi }] }],
  scales: [
    { name: 'x', type: 'linear', range: 'width', padding: 40, domain: { data: 't', field: 'x' } },
    { name: 'y', type: 'linear', range: 'height', domain: [0, 1] },
  ],
  axes: [{ orient: 'bottom', scale: 'x', grid: true }, { orient: 'right', scale: 'y' }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { value: 20 } } } }],
})

const CASES: Array<[string, Spec]> = [
  ['a time axis whose padded domain gains ticks at the fitted width (fit)', timeSpec('fit', 'Passenger Traffic at Seattle-Tacoma International Airport, One Year to the Next')],
  ['the same with the size containing the padding', timeSpec({ type: 'fit', contains: 'padding' }, 'Passenger Traffic at Seattle-Tacoma International Airport, One Year to the Next')],
  ['fit-x', timeSpec('fit-x', 'Passenger Traffic at Seattle-Tacoma International Airport, One Year to the Next')],
  ['a linear axis whose ticks change with the width (fit)', linearSpec('fit', 0, 100)],
  ['a linear axis over negative values (fit)', linearSpec('fit', -37, 61)],
  ['a linear axis with a small domain (fit-x)', linearSpec('fit-x', 3, 4.5)],
  ['autosize pad: one pass, the order is the ticks\'', linearSpec('pad', 0, 100)],
]

describe('guide items keep their place across the passes of a fit view (vs vega)', () => {
  for (const [name, spec] of CASES) {
    it(name, async () => {
      const want = await vegaSvg(spec)
      const got = renderSpec(structuredClone(spec) as never)
      expect(diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))).toEqual([])
    })
  }
})
