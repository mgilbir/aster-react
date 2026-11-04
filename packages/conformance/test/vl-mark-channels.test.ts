// @vitest-environment node
/**
 * The channels a mark does not draw are dropped, as vega-lite 6.4.3's initEncoding drops them (a size on an area, an x on a geoshape,
 * a url on anything but an image): every mark x every channel x a field, a value and a condition that vega-lite drops (its output is
 * the output without the channel), compiled by vega-lite and by @aster/vl. The compiled scales, axes and legends, the scales as they
 * run, the rows and the SVG must be the same (vl-ranged-compare.ts).
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { silent } from './vl-time-helpers.js'
import { collect } from './vl-ranged-compare.js'

type Obj = Record<string, unknown>

const square = (x: number, y: number): Obj => ({ type: 'Polygon', coordinates: [[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]] })
const ROWS: Obj[] = [
  { k: 'a', v: 1, w: 2, u: 'data:image/png;base64,' },
  { k: 'b', v: 2, w: 5, u: 'data:image/png;base64,' },
  { k: 'c', v: 3, w: 3, u: 'data:image/png;base64,' },
]
const K = { field: 'k', type: 'nominal' }
const V = { field: 'v', type: 'quantitative' }
const W = { field: 'w', type: 'quantitative' }

const MARKS = ['point', 'circle', 'square', 'tick', 'bar', 'rect', 'rule', 'line', 'area', 'trail', 'text', 'arc', 'image', 'geoshape']

/** The data and the encoding a mark draws with. */
function base(mark: string): Obj {
  if (mark === 'geoshape') return { data: { values: ROWS.map((r, i) => ({ type: 'Feature', geometry: square(i * 2, 0), ...r })) }, projection: { type: 'identity' }, encoding: {} }
  const enc: Obj = mark === 'arc' ? { theta: V } : mark === 'bar' ? { x: K, y: V } : { x: V, y: W }
  if (mark === 'text') enc.text = K
  if (mark === 'image') enc.url = { field: 'u' }
  return { data: { values: ROWS }, encoding: enc }
}

/** Each channel as a field, a value and a condition. */
const CHANNELS: Array<[string, Obj[]]> = [
  ['x', [W, { value: 10 }]], ['y', [V, { value: 10 }]], ['x2', [W, { value: 10 }]], ['y2', [V, { value: 10 }]],
  ['xOffset', [K]], ['yOffset', [K]], ['theta', [W]], ['radius', [W, { value: 30 }]],
  ['size', [W, { value: 50 }, { condition: { test: 'datum.v > 1', value: 30 }, value: 60 }]],
  ['angle', [W, { value: 30 }]], ['strokeDash', [K, { value: [2, 2] }]], ['strokeWidth', [W, { value: 3 }]],
  ['shape', [{ value: 'square' }, { condition: { test: 'datum.v > 1', value: 'diamond' }, value: 'cross' }]],
  ['url', [{ field: 'u' }, { value: 'data:image/png;base64,' }]],
  ['text', [K, { value: 'z' }]],
]

const vegaLite = (spec: Obj): string => JSON.stringify((vl as any).compile(JSON.parse(JSON.stringify(spec)), { logger: silent }).spec)

/** The channels vega-lite drops from `mark` (compiled, the spec is the spec without the channel). */
function* cases(mark: string): Generator<[string, Obj]> {
  const b = base(mark)
  const without = vegaLite({ ...b, mark })
  for (const [ch, defs] of CHANNELS) {
    if (ch in (b.encoding as Obj)) continue
    for (const [i, def] of defs.entries()) {
      const spec = { ...b, mark, encoding: { ...(b.encoding as Obj), [ch]: def } }
      if (vegaLite(spec) === without) yield [`${mark} ${ch} #${i}`, spec]
    }
  }
}

describe('a mark drops the channels vega-lite drops', () => {
  for (const mark of MARKS) {
    it(`${mark}: every channel as a field, a value and a condition`, async () => {
      const all = [...cases(mark)]
      const bad = await collect(all)
      expect(bad.slice(0, 8), `${bad.length} of ${all.length} differ`).toEqual([])
      // (every mark has channels it does not draw)
      expect(all.length).toBeGreaterThan(0)
    }, 240_000)
  }
})
