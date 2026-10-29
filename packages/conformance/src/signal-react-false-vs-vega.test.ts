/**
 * A signal with `react: false` is evaluated when the dataflow starts and never again because a signal it reads changed
 * (vega-dataflow does not register it as a target of its parameters). What it reads in that first pass depends on the
 * operator ranks: a signal that reads a scale is ranked after the scale, and when that scale reads the `react: false`
 * signal back (the cycle `react: false` exists to break) the reader runs first and sees the other signal's initial value.
 * An ordinal scale whose domain signal is then undefined keeps vega's implicit domain: the values the marks look up.
 * Each spec runs in real vega and in the engine; the picture must be equal.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import * as vl from 'vega-lite'
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

const ROWS = [{ o: 'USA', x: 1, y: 3 }, { o: 'Japan', x: 2, y: 1 }, { o: 'Europe', x: 3, y: 2 }, { o: 'USA', x: 4, y: 4 }]
const base = (extra: Spec): Spec => ({
  width: 200, height: 120, padding: 5,
  data: [{ name: 'src', values: ROWS }],
  scales: [
    { name: 'x', type: 'linear', domain: { data: 'src', field: 'x' }, range: 'width' },
    { name: 'y', type: 'linear', domain: { data: 'src', field: 'y' }, range: 'height' },
  ],
  marks: [{
    type: 'symbol', from: { data: 'src' },
    encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, fill: { scale: 'c', field: 'o' } } },
  }],
  legends: [{ fill: 'c' }],
  ...extra,
})
const scaleC = { name: 'c', type: 'ordinal', domain: { signal: 'color_domain' }, range: 'category' }

const CASES: Array<[string, Spec]> = [
  ['the reader of a signal that reads the scale it feeds sees the initial value: the domain stays implicit', base({
    signals: [
      { name: 'computed_domain', update: "domain('c')" },
      { name: 'color_domain', react: false, update: 'computed_domain' },
    ],
    scales: [
      ...(base({}).scales as Spec[]), scaleC,
    ],
  })],
  ['without the cycle the reader sees the value the other signal computed', base({
    signals: [
      { name: 'computed_domain', update: "domain('fixed')" },
      { name: 'color_domain', react: false, update: 'computed_domain' },
    ],
    scales: [
      ...(base({}).scales as Spec[]),
      { name: 'fixed', type: 'ordinal', domain: ['Europe', 'USA'], range: [0, 1] },
      scaleC,
    ],
  })],
  ['react: false on a signal that reads only plain signals', base({
    signals: [
      { name: 'a', value: ['Japan', 'USA'] },
      { name: 'color_domain', react: false, update: 'a' },
    ],
    scales: [...(base({}).scales as Spec[]), scaleC],
  })],
]

const vlSpec = (): Spec => ({
  data: { values: ROWS },
  params: [
    { name: 'color_selection', select: { type: 'point', encodings: ['color'] }, bind: 'legend' },
    { name: 'computed_domain', expr: "domain('color')" },
    { name: 'color_domain', react: false, expr: 'computed_domain' },
  ],
  transform: [{ filter: { param: 'color_selection' } }],
  mark: { type: 'point', filled: true },
  encoding: {
    color: { field: 'o', type: 'nominal', scale: { domain: { expr: 'color_domain' } } },
    x: { field: 'x', type: 'quantitative' },
    y: { field: 'y', type: 'quantitative' },
  },
})

describe('signal react: false (vs vega)', () => {
  for (const [name, spec] of CASES) {
    it(name, async () => {
      const want = await vegaSvg(spec)
      const got = renderSpec(structuredClone(spec) as never)
      expect(diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))).toEqual([])
    })
  }
  it("vega-lite's own Vega for the point_constant_legend_domain pattern", async () => {
    const spec = vl.compile(vlSpec() as never).spec as unknown as Spec
    const want = await vegaSvg(spec)
    expect(want).toContain('Europe')
    const got = renderSpec(structuredClone(spec) as never)
    expect(diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))).toEqual([])
  })
})
