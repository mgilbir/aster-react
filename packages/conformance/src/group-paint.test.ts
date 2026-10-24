/**
 * Group items paint like vega-scenegraph's marks/group.js: a background rectangle of the item's own
 * width/height (corner radii, stroke offset) with its fill/stroke, an optional stroke foreground, and
 * `clip` -- a boolean or a `{signal}` -- clipping the contents. Every case is judged against real
 * vega with the strict canonicalizer (this replaces a test that pinned the missing background).
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
const group = (update: Record<string, unknown>, markProps: Record<string, unknown> = {}, scoped = false): Spec => ({
  width: 120, height: 80, padding: 5, autosize: 'none',
  signals: [{ name: 'clipped', value: true }, { name: 'sw', value: 3 }],
  ...(scoped ? {} : {}),
  marks: [{
    type: 'group', ...markProps,
    ...(scoped ? { scales: [{ name: 'lx', type: 'linear', domain: [0, 10], range: 'width' }] } : {}),
    encode: { update: { x: V(10), y: V(8), width: V(60), height: V(40), ...update } },
    marks: [{ type: 'rect', encode: { update: { x: V(-5), y: V(10), width: V(120), height: V(14), fill: V('tomato') } } }],
  }],
})

const CASES: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ['no paint', {}, {}],
  ['fill', { fill: V('#eee') }, {}],
  ['stroke 1', { stroke: V('#888') }, {}],
  ['stroke 1.4 (offset 0.1)', { stroke: V('#888'), strokeWidth: V(1.4) }, {}],
  ['stroke 2 (no offset)', { stroke: V('#888'), strokeWidth: V(2) }, {}],
  ['stroke width from a signal', { stroke: V('#888'), strokeWidth: { signal: 'sw' } }, {}],
  ['fill + stroke + opacity', { fill: V('#eee'), stroke: V('#888'), opacity: V(0.5) }, {}],
  ['fillOpacity / strokeOpacity', { fill: V('#eee'), stroke: V('#888'), fillOpacity: V(0.4), strokeOpacity: V(0.6) }, {}],
  ['stroke dash', { stroke: V('#888'), strokeDash: V([4, 2]) }, {}],
  ['strokeOffset', { stroke: V('#888'), strokeOffset: V(2) }, {}],
  ['cornerRadius', { fill: V('#eee'), stroke: V('#888'), cornerRadius: V(8) }, {}],
  ['per-corner radii', { fill: V('#eee'), cornerRadiusTopLeft: V(10), cornerRadiusBottomRight: V(4) }, {}],
  ['strokeForeground', { fill: V('#eee'), stroke: V('#c00'), strokeWidth: V(2), strokeForeground: V(true) }, {}],
  ['no size at all', { width: undefined, height: undefined, fill: V('#eee') }, {}],
  ['item clip channel + stroke (the stroke is outside the clip)', { fill: V('#eee'), stroke: V('#888'), strokeWidth: V(4), clip: V(true) }, {}],
  ['item clip + corner radius', { fill: V('#eee'), stroke: V('#888'), cornerRadius: V(9), clip: V(true) }, {}],
  ['item clip + strokeForeground', { fill: V('#eee'), stroke: V('#c00'), strokeWidth: V(3), strokeForeground: V(true), clip: V(true) }, {}],
  ['item clip from a signal', { fill: V('#eee'), clip: { signal: 'clipped' } }, {}],
  ['item clip and mark clip together', { fill: V('#eee'), clip: V(true) }, { clip: true }],
  ['clip true', { fill: V('#eee') }, { clip: true }],
  ['clip false', { fill: V('#eee') }, { clip: false }],
  ['clip signal (true)', { fill: V('#eee') }, { clip: { signal: 'clipped' } }],
  ['clip signal expression (false)', { fill: V('#eee') }, { clip: { signal: '!clipped' } }],
]

describe('group backgrounds, foregrounds and clips match vega', () => {
  it.each(CASES)('%s', async (_n, update, markProps) => {
    for (const scoped of [false, true]) {
      const clean = Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined))
      const spec = group(clean, markProps, scoped)
      expect(diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(spec as never))), scoped ? 'scoped' : 'plain').toEqual([])
    }
  })
  it('a filled, stroked group really draws its background (an empty comparison would pass anything)', () => {
    const svg = renderSpec(group({ fill: V('#eee'), stroke: V('#888') }) as never)
    expect(svg).toMatch(/fill="#eee"/)
    expect(svg).toMatch(/stroke="#888"/)
  })
})
