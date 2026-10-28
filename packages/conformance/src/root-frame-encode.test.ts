/**
 * The root group's own `encode.update` (what Vega-Lite's `view` background compiles to) and a `transparent` frame stroke, judged against
 * real vega with the strict canonicalizer: the frame takes its fill / stroke / opacity from the encode over its style, `null` unsets a
 * value, and a transparent stroke still insets the frame by half a pixel (it is a stroke to vega) without painting.
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

const V = (value: unknown) => ({ value })
const frame = (update: Record<string, unknown> | undefined, style: Record<string, unknown> = { stroke: '#ddd' }, styleName: string | undefined = 'cell'): Spec => ({
  width: 60, height: 40, padding: 5,
  ...(styleName ? { style: styleName } : {}),
  config: { style: { cell: style } },
  ...(update ? { encode: { update } } : {}),
  marks: [{ type: 'rect', encode: { update: { x: V(2), y: V(2), width: V(20), height: V(10), fill: V('tomato') } } }],
})

const CASES: Array<[string, Spec]> = [
  ['no encode (the cell style)', frame(undefined)],
  ['a fill over the style', frame({ fill: V('yellow') })],
  ['a null stroke unsets the style stroke', frame({ stroke: V(null) })],
  ['a transparent stroke over the style stroke', frame({ stroke: V('transparent') })],
  ['a transparent stroke in the style', frame(undefined, { stroke: 'transparent' })],
  ['a transparent stroke and a fill', frame({ stroke: V('transparent'), fill: V('#eee') })],
  ['a stroke width, opacity and dash', frame({ stroke: V('red'), strokeWidth: V(3), opacity: V(0.5), strokeDash: V([4, 2]) })],
  ['a corner radius', frame({ fill: V('#eee'), cornerRadius: V(8) })],
  ['fill and stroke opacity', frame({ fill: V('#eee'), stroke: V('blue'), fillOpacity: V(0.4), strokeOpacity: V(0.6) })],
  ['an encode on a view without the cell style', frame({ fill: V('#eee'), stroke: V('red') }, {}, undefined)],
]

describe('the root frame matches vega', () => {
  it.each(CASES)('%s', async (_n, spec) => {
    expect(diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(spec as never)))).toEqual([])
  })
  it('a filled frame really draws (an empty comparison would pass anything)', () => {
    expect(renderSpec(frame({ fill: V('yellow') }) as never)).toMatch(/fill="yellow"/)
  })
})
