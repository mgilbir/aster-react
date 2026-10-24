/**
 * Non-string paint values (a number a scale returned, a boolean, an object...) on every mark type, against real
 * vega: vega-scenegraph writes whatever `fill` / `stroke` holds as the attribute (a falsy one is no paint at all),
 * it does not reinterpret it. Found by the signals sweep: a colour scale with no scheme returned 0.43 and vega drew
 * `fill="0.43"` where the engine drew black.
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
const GEOM: Record<string, Record<string, unknown>> = {
  rect: { x: V(10), y: V(10), width: V(30), height: V(20) },
  symbol: { x: V(30), y: V(30), size: V(400) },
  text: { x: V(10), y: V(30), text: V('hi'), fontSize: V(14) },
  line: { x: { field: 'a', mult: 30 }, y: { field: 'b', mult: 10 }, strokeWidth: V(3) },
  area: { x: { field: 'a', mult: 30 }, y: { field: 'b', mult: 10 }, y2: V(60) },
  rule: { x: V(10), x2: V(80), y: V(30), strokeWidth: V(3) },
  arc: { x: V(40), y: V(40), outerRadius: V(30), startAngle: V(0), endAngle: V(3) },
  trail: { x: { field: 'a', mult: 30 }, y: { field: 'b', mult: 10 }, size: V(6) },
  path: { x: V(10), y: V(10), path: V('M0,0L30,0L15,25Z'), strokeWidth: V(2) },
  group: { x: V(5), y: V(5), width: V(60), height: V(50), strokeWidth: V(3) },
}
const PAINT_VALUES: Array<[string, unknown]> = [
  ['a fraction', 0.43], ['zero', 0], ['one', 1], ['a negative', -2], ['true', true], ['false', false],
  ['a name', 'steelblue'], ['an empty string', ''], ['a hex', '#336699'], ['rgb()', 'rgb(10,20,30)'],
  ['a numeric string', '0.43'], ['an invalid colour name', 'not-a-colour'],
]

const spec = (type: string, channel: string, value: unknown): Spec => ({
  width: 100, height: 70, padding: 5, autosize: 'none',
  data: [{ name: 't', values: [{ a: 1, b: 2 }, { a: 2, b: 5 }, { a: 3, b: 1 }] }],
  marks: [{ type, ...(type === 'group' ? {} : { from: { data: 't' } }), encode: { update: { ...GEOM[type], [channel]: V(value) } } }],
})

describe('non-string paints render as vega writes them', () => {
  const cases = Object.keys(GEOM).flatMap((type) => ['fill', 'stroke'].flatMap((ch) => PAINT_VALUES.map(([name, v]) => [`${type} ${ch}: ${name}`, type, ch, v] as const)))
  it.each(cases)('%s', async (_n, type, ch, v) => {
    const s = spec(type, ch, v)
    expect(diffCanonical(canonicalizeSvg(await oracleSvg(s)), canonicalizeSvg(renderSpec(s as never)))).toEqual([])
  })
})
