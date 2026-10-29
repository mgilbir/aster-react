/**
 * LIVE differential for the order signals resolve in: vega ranks its dataflow by dependency, so a signal that reads one declared
 * AFTER it still sees that signal's value for this run, however long the chain of such reads is (the donut-chart-labelled gallery
 * spec chains `shiftArray` <- `leftRightCount` <- `leftRightCountArray` <- a dataset, declared in the opposite order). Evaluating in
 * declaration order lags one link per fixed-point pass, so a long enough chain showed the value of an earlier pass.
 *
 * Real Vega and Aster render the same spec; the numbers are written into text marks and the two SVGs must be equal.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

type Spec = Record<string, unknown>

async function vegaSvg(spec: Spec): Promise<string> {
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

const show = (name: string, y: number): Spec => ({ type: 'text', encode: { update: { text: { signal: name }, x: { value: 5 }, y: { value: y } } } })
const spec = (signals: Spec[], extra: Spec = {}): Spec => ({
  width: 120, height: 120, padding: 5,
  data: [{ name: 'd', values: [{ v: 1 }, { v: 2 }, { v: 3 }] }],
  signals,
  marks: signals.filter((s) => !s.hidden).map((s, i) => show(s.name as string, 14 * (i + 1))),
  ...extra,
})

describe('signals resolve in dependency order (Aster vs Vega)', () => {
  const same = async (s: Spec): Promise<string> => {
    const oracle = canonicalizeSvg(await vegaSvg(s))
    const svg = renderSpec(structuredClone(s) as never)
    expect(diffCanonical(oracle, canonicalizeSvg(svg))).toEqual([])
    return svg
  }

  it('a chain declared against its direction, fed by a dataset', async () => {
    const svg = await same(spec([
      { name: 's6', update: 's5 * 2' },
      { name: 's5', update: 's4 + 1' },
      { name: 's4', update: 's3 * 2' },
      { name: 's3', update: 's2 + 1' },
      { name: 's2', update: 's1 * 2' },
      { name: 's1', update: "length(data('d')) + 1" },
    ]))
    // (the end of the chain is the value of one complete pass: 4, 8, 9, 18, 19, 38)
    expect(svg).toContain('>38<')
  })

  it('signals that do not read each other keep their declaration order (a stream drawn in order)', async () => {
    await same(spec([{ name: 'a', update: '1' }, { name: 'b', update: 'a + 1' }, { name: 'c', update: '5' }]))
  })

  it('setdata puts a signal\'s rows into a dataset that sorts them, and signals read the result in the same run', async () => {
    const svg = await same({
      width: 120, height: 60, padding: 5,
      data: [{ name: 'dec', values: [], transform: [{ type: 'collect', sort: { field: 'i' } }] }],
      signals: [
        { name: 'first', update: "data('dec')[0].d" },
        { name: 'prefs', update: "setdata('dec', [{d: 'b', i: 2}, {d: 'c', i: 3}, {d: 'a', i: 1}])" },
        { name: 'count', update: "length(data('dec')) + prefs" },
      ],
      marks: [
        { type: 'text', encode: { update: { text: { signal: 'first' }, x: { value: 5 }, y: { value: 14 } } } },
        { type: 'text', encode: { update: { text: { signal: 'count' }, x: { value: 5 }, y: { value: 28 } } } },
      ],
    })
    expect(svg).toContain('>a<')
    expect(svg).toContain('>4<')
  })

  it('setdata from a signal that is ranked after the dataset is lost in the first run (vega enqueues an operator once per run)', async () => {
    const svg = await same({
      width: 120, height: 60, padding: 5,
      data: [{ name: 'dec', values: [], transform: [{ type: 'collect', sort: { field: 'i' } }] }],
      signals: [
        // reads the dataset it fills: ranked after the dataset's input, which has already run when setdata pulses it
        { name: 'prefs', update: "setdata('dec', [{d: 'b', i: 2}, {d: 'a', i: 1}]) + 0 * length(data('dec'))" },
        { name: 'first', update: "length(data('dec')) ? data('dec')[0].d : 'none'" },
      ],
      marks: [{ type: 'text', encode: { update: { text: { signal: 'first' }, x: { value: 5 }, y: { value: 14 } } } }],
    })
    expect(svg).toContain('>none<')
  })
})
