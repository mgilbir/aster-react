// @vitest-environment jsdom
/**
 * The view size is a signal (vega: `view.width(w)` is `view.signal('width', w)`, and the later write wins).
 *
 * The engine takes the size a host gives it from three places: a fixed `width` / `height` (the `<Chart>` props), a value
 * written to the signal (a bound input, an event handler) and the container a host measured (`measuredSize`, which only
 * sizes a spec that does not drive the signal itself). Each case here is a size vega reaches by a signal write, compared
 * with a vega view on the whole document: scales, axes and grid, layout and the svg size must all read the one value.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { evaluateChart, compileChart, renderSceneToSvg } from '@aster/core'
import type { RuntimeInput } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>
type View = { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void; width(w?: number): unknown; height(h?: number): unknown; signal(n: string, v: unknown): unknown }

/** A container element as a browser lays it out: `containerSize()` reads its `clientWidth` / `clientHeight`. */
function containerEl(size: { width: number; height: number }): HTMLElement & { size: { width: number; height: number } } {
  const el = document.createElement('div') as unknown as HTMLElement & { size: { width: number; height: number } }
  el.size = size
  Object.defineProperty(el, 'clientWidth', { get: () => el.size.width })
  Object.defineProperty(el, 'clientHeight', { get: () => el.size.height })
  return el
}

async function vegaSvg(spec: Spec, drive: (view: View, el: ReturnType<typeof containerEl>) => Promise<void> | void, container?: { width: number; height: number }): Promise<string> {
  const log = console.error
  console.error = () => {}
  const el = containerEl(container ?? { width: 0, height: 0 })
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => View }).View(vega.parse(spec as never), container ? { renderer: 'svg', container: el } : { renderer: 'none' })
  try {
    await drive(view, el)
    await view.runAsync()
    return await view.toSVG()
  } finally {
    console.error = log
    view.finalize()
  }
}
const asterSvg = (spec: Spec, input: RuntimeInput): string => renderSceneToSvg(evaluateChart(compileChart(structuredClone(spec) as never), input))
const same = (a: string, b: string): string[] => diffCanonical(canonicalizeSvg(a), canonicalizeSvg(b))

const ROWS = [{ k: 'a', v: 28 }, { k: 'b', v: 55 }, { k: 'c', v: 43 }, { k: 'd', v: 91 }]
const body = {
  padding: 5, data: [{ name: 't', values: ROWS }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.1 },
    { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height', nice: true, zero: true },
  ],
  axes: [{ orient: 'bottom', scale: 'x', grid: false }, { orient: 'left', scale: 'y', grid: true }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'k' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 }, fill: { value: 'steelblue' } } } }],
}
// the spec sizes itself: its own `width` / `height` signals (a literal each, as a bound input starts)
const driven: Spec = { ...body, signals: [{ name: 'width', value: 300 }, { name: 'height', value: 180 }] }
const fixed: Spec = { ...body, width: 400, height: 220 }
// vega-lite's `width: "container"`: the signals read the container and fall back to 300
const container: Spec = {
  ...body, autosize: { type: 'fit', contains: 'padding' },
  signals: ['width', 'height'].map((n, i) => {
    const e = `isFinite(containerSize()[${i}]) ? containerSize()[${i}] : 300`
    return { name: n, init: e, on: [{ events: 'window:resize', update: e }] }
  }),
}

// a composition (what vega-lite makes of a facet / concat / repeat): `layout` at the top, no size of its own. Vega sizes the
// view from the laid-out groups (the `width` / `height` signals are outputs there, 0 until then), so a container does not
// size it; a size the host does give (a prop, a signal write) still does
const cell = (i: number): Spec => ({
  type: 'group', name: `cell${i}`,
  encode: { update: { width: { value: 90 + 20 * (i % 2) }, height: { value: 60 + 15 * i }, stroke: { value: '#999' } } },
  scales: [{ name: 'cx', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.1 }, { name: 'cy', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height', nice: true, zero: true }],
  axes: [{ orient: 'bottom', scale: 'cx' }, { orient: 'left', scale: 'cy' }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'cx', field: 'k' }, width: { scale: 'cx', band: 1 }, y: { scale: 'cy', field: 'v' }, y2: { scale: 'cy', value: 0 }, fill: { value: 'steelblue' } } } }],
})
const composed: Spec = {
  padding: 5, data: [{ name: 't', values: ROWS }],
  layout: { padding: 20, columns: 2, bounds: 'full', align: 'all' },
  marks: [0, 1, 2, 3].map(cell),
}

describe('the view size, against vega (a signal write, the later one wins)', () => {
  const cases: Array<[string, Spec, (v: View, el: ReturnType<typeof containerEl>) => Promise<void> | void, RuntimeInput, { width: number; height: number }?]> = [
    ['a spec that sizes itself: its own signal values', driven, () => {}, {}],
    ['a spec that sizes itself, the container measured: only containerSize() sees it', driven, () => {}, { measuredSize: { width: 700, height: 260 } }],
    ['a value written to the signal (a bound input)', driven, (v) => { v.signal('width', 250); v.signal('height', 140) }, { signals: { width: 250, height: 140 } }],
    ['a value written to the signal beats the measured container', driven, (v) => { v.signal('width', 250) }, { measuredSize: { width: 700, height: 260 }, signals: { width: 250 } }],
    ['a fixed size set on the view (view.width / view.height)', driven, (v) => { v.width(480); v.height(260) }, { width: 480, height: 260 }],
    ['a numeric size, the container measured (the chart fills it)', fixed, (v) => { v.width(700); v.height(260) }, { measuredSize: { width: 700, height: 260 } }],
    ['a numeric size, then a value written to the signal', fixed, (v) => { v.height(260); v.signal('width', 250) }, { measuredSize: { width: 700, height: 260 }, signals: { width: 250 } }],
    ['a composition (layout, no size): the container measured does not size it', composed, () => {}, { measuredSize: { width: 600, height: 400 } }],
    ['a composition, the host fixed the height: the width is still the layout\'s', composed, (v) => { v.height(250) }, { height: 250, measuredSize: { width: 600, height: 400 } }],
    ['a composition, a value written to the width signal beats the layout', composed, (v) => { v.signal('width', 520) }, { signals: { width: 520 }, measuredSize: { width: 600, height: 400 } }],
    // vega's container is the element the view is attached to; its size is read when the signals are computed
    ['a container-sized spec: the container is its size', container, () => {}, { containerSize: { width: 600, height: 240 } }, { width: 600, height: 240 }],
    ['a container-sized spec, the container measured', container, () => {}, { measuredSize: { width: 520, height: 200 } }, { width: 520, height: 200 }],
    ['a container-sized spec, a window:resize handler re-ran after the container changed', container, async (v, el) => {
      el.size = { width: 330, height: 210 }
      window.dispatchEvent(new Event('resize'))
      await v.runAsync()
    }, { containerSize: { width: 330, height: 210 }, signals: { width: 330, height: 210 } }, { width: 600, height: 240 }],
  ]
  for (const [name, spec, drive, input, el] of cases) {
    it(name, async () => {
      expect(same(await vegaSvg(spec, drive, el), asterSvg(spec, input)).slice(0, 4)).toEqual([])
    })
  }
})
