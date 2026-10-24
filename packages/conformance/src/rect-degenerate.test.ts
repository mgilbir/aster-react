/**
 * Rect items whose geometry is not a clean number (the signals sweep found these: a scale whose
 * domain/range was written to something degenerate): vega's rect renderer reads every coordinate
 * as `item.x || 0` / `item.width || 0` and every corner radius with unary plus, so such a rect is
 * still a path, at the origin it can keep, in zeros or -- for a non-numeric radius -- in NaNs.
 * Judged against real vega with the strict canonicalizer.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracleSvg(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(spec as never),
    { renderer: 'none' },
  )
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

const sig = (signal: string) => ({ signal })
const rect = (update: Record<string, unknown>): Spec => ({
  width: 120, height: 60, padding: 5, autosize: 'none',
  data: [{ name: 't', values: [{ a: 1 }, { a: 2 }] }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { fill: { value: 'tomato' }, ...update } } }],
})

const CASES: Array<[string, Record<string, unknown>]> = [
  ['NaN y and y2 with a width', { x: { field: 'a', mult: 20 }, width: { value: 10 }, y: sig('NaN'), y2: sig('NaN') }],
  ['valid y, NaN y2', { x: { field: 'a', mult: 20 }, width: { value: 10 }, y: { value: 12 }, y2: sig('NaN') }],
  ['NaN y, valid y2', { x: { field: 'a', mult: 20 }, width: { value: 10 }, y: sig('NaN'), y2: { value: 30 } }],
  ['NaN x2 with a height', { x: { value: 8 }, x2: sig('NaN'), y: { field: 'a', mult: 10 }, height: { value: 6 } }],
  ['undefined y, undefined y2', { x: { field: 'a', mult: 20 }, width: { value: 10 }, y: sig('datum.nope'), y2: sig('datum.nope') }],
  ['no height, no y2', { x: { field: 'a', mult: 20 }, width: { value: 10 }, y: { value: 4 } }],
  ['no width at all', { x: { value: 7 }, y: { value: 4 }, height: { value: 9 } }],
  ['string corner radius', { x: { field: 'a', mult: 20 }, width: { value: 10 }, y: { value: 3 }, height: { value: 10 }, cornerRadius: { value: 'round' } }],
  ['NaN corner radius on one corner', { x: { field: 'a', mult: 20 }, width: { value: 10 }, y: { value: 3 }, height: { value: 10 }, cornerRadiusTopLeft: sig('NaN') }],
  ['numeric corner radius', { x: { field: 'a', mult: 20 }, width: { value: 10 }, y: { value: 3 }, height: { value: 10 }, cornerRadius: { value: 3 } }],
  ['negative corner radius', { x: { field: 'a', mult: 20 }, width: { value: 10 }, y: { value: 3 }, height: { value: 10 }, cornerRadius: { value: -3 } }],
  ['radius larger than the rect', { x: { field: 'a', mult: 20 }, width: { value: 10 }, y: { value: 3 }, height: { value: 10 }, cornerRadius: { value: 99 } }],
  ['per-corner radii', { x: { field: 'a', mult: 20 }, width: { value: 10 }, y: { value: 3 }, height: { value: 10 }, cornerRadiusTopLeft: { value: 4 }, cornerRadiusBottomRight: { value: 2 } }],
]

describe('degenerate rect geometry renders like vega', () => {
  it.each(CASES)('%s', async (_name, update) => {
    const spec = rect(update)
    expect(diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(spec as never)))).toEqual([])
  })
  it('the NaN-origin case really draws something (an empty comparison would pass anything)', () => {
    expect(renderSpec(rect(CASES[0]![1]) as never)).toMatch(/<path d="M[-\d.]+,0h10v0h-10Z" fill="tomato"\/>/)
  })
})
