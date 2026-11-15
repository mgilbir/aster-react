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
import { evaluateChart, compileChart, renderSceneToSvg } from '@aster-charts/core'
import type { RuntimeInput } from '@aster-charts/core'
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

// vega-lite's `width: "container", height: 200`: only the width reads the container, the height is a number (autosize fit-x)
const containerWidth: Spec = {
  ...body, height: 200, autosize: { type: 'fit-x', contains: 'padding' },
  signals: [{ name: 'width', init: 'isFinite(containerSize()[0]) ? containerSize()[0] : 300', on: [{ events: 'window:resize', update: 'isFinite(containerSize()[0]) ? containerSize()[0] : 300' }] }],
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
  // what vega is given for a view that fills the container: the spec with autosize fit (contains padding) on the filled dimensions
  const fills = (type: 'fit' | 'fit-x' | 'fit-y') => (spec: Spec): Spec => ({ ...spec, autosize: { type, contains: 'padding' } })
  const cases: Array<[string, Spec, (v: View, el: ReturnType<typeof containerEl>) => Promise<void> | void, RuntimeInput, { width: number; height: number }?, ((s: Spec) => Spec)?]> = [
    ['a spec that sizes itself: its own signal values', driven, () => {}, {}],
    ['a spec that sizes itself, the container measured: only containerSize() sees it', driven, () => {}, { measuredSize: { width: 700, height: 260 } }],
    ['a value written to the signal (a bound input)', driven, (v) => { v.signal('width', 250); v.signal('height', 140) }, { signals: { width: 250, height: 140 } }],
    ['a value written to the signal beats the measured container', driven, (v) => { v.signal('width', 250) }, { measuredSize: { width: 700, height: 260 }, signals: { width: 250 } }],
    ['a fixed size set on the view (view.width / view.height)', driven, (v) => { v.width(480); v.height(260) }, { width: 480, height: 260 }],
    // the measured container is the whole chart, as vega-lite's "container" is: vega with `fit` containing the padding (issue #128)
    ['a numeric size, the container measured (the chart fills it, guides and padding included)', fixed, (v) => { v.width(700); v.height(260) }, { measuredSize: { width: 700, height: 260 } }, undefined, fills('fit')],
    ['a numeric size, then a value written to the signal (only the height fills the container)', fixed, (v) => { v.height(260); v.signal('width', 250) }, { measuredSize: { width: 700, height: 260 }, signals: { width: 250 } }, undefined, fills('fit-y')],
    ['a composition (layout, no size): the container measured does not size it', composed, () => {}, { measuredSize: { width: 600, height: 400 } }],
    ['a composition, the host fixed the height: the width is still the layout\'s', composed, (v) => { v.height(250) }, { height: 250, measuredSize: { width: 600, height: 400 } }],
    ['a composition, a value written to the width signal beats the layout', composed, (v) => { v.signal('width', 520) }, { signals: { width: 520 }, measuredSize: { width: 600, height: 400 } }],
    // vega's container is the element the view is attached to; its size is read when the signals are computed
    ['a container-sized spec: the container is its size', container, () => {}, { containerSize: { width: 600, height: 240 } }, { width: 600, height: 240 }],
    ['a container-sized spec, the container measured', container, () => {}, { measuredSize: { width: 520, height: 200 } }, { width: 520, height: 200 }],
    // the measured height of a container that grows with the chart must not feed back into it (issue #128)
    ['a spec that sizes its width from the container keeps its numeric height', containerWidth, () => {}, { measuredSize: { width: 520, height: 900 } }, { width: 520, height: 900 }],
    ['a container-sized spec, a window:resize handler re-ran after the container changed', container, async (v, el) => {
      el.size = { width: 330, height: 210 }
      window.dispatchEvent(new Event('resize'))
      await v.runAsync()
    }, { containerSize: { width: 330, height: 210 }, signals: { width: 330, height: 210 } }, { width: 600, height: 240 }],
  ]
  for (const [name, spec, drive, input, el, asVega] of cases) {
    it(name, async () => {
      expect(same(await vegaSvg(asVega ? asVega(spec) : spec, drive, el), asterSvg(spec, input)).slice(0, 4)).toEqual([])
    })
  }
})

/**
 * The measured container over every autosize type and `contains`, and the spec's size given as a number, as a signal, or not
 * at all, and Vega-Lite's `"container"`. Vega's counterpart of each:
 *   - a spec whose autosize is `none` and whose size is a number: the spec as it is (vega: "the total size is determined solely
 *     by the provided width, height and padding"; vega-embed draws it at that size in any container);
 *   - a number with any other autosize: the host writes the container's size to the view and the chart fills it, padding and
 *     guides included (`fit` containing the padding, issue #128);
 *   - a signal, or no size at all: the spec as it is (it drives its size, or vega's 0 is grown to the content), the container
 *     reaching it only through `containerSize()`;
 *   - Vega-Lite's `"container"`: the spec as vega-lite compiles it, in a container element of the measured size.
 * Judged with the strict canonicalizer, against vega in the same process.
 */
describe('the measured container, over autosize types, contains and the ways a spec gives its size (vs vega)', () => {
  const measured = { width: 640, height: 300 }
  const TYPES = ['pad', 'fit', 'fit-x', 'fit-y', 'none'] as const
  const CONTAINS = ['content', 'padding'] as const
  const SIZES = ['number', 'signal', 'unsized'] as const
  for (const type of TYPES) {
    for (const contains of CONTAINS) {
      for (const size of SIZES) {
        const spec: Spec = {
          ...body, padding: { left: 40, top: 12, right: 18, bottom: 30 }, autosize: { type, contains },
          ...(size === 'number' ? { width: 420, height: 200 } : {}),
          ...(size === 'signal' ? { signals: [{ name: 'width', value: 360 }, { name: 'height', value: 170 }] } : {}),
        }
        it(`autosize ${type}, contains ${contains}, size ${size}`, async () => {
          const fillsContainer = size === 'number' && type !== 'none'
          const want = fillsContainer
            ? await vegaSvg({ ...spec, autosize: { type: 'fit', contains: 'padding' } }, (v) => { v.width(measured.width); v.height(measured.height) })
            : await vegaSvg(spec, () => {}, measured)
          expect(same(want, asterSvg(spec, { measuredSize: measured })).slice(0, 4)).toEqual([])
        })
      }
    }
  }
  it('autosize none containing the padding, with no size: the container does not size it', () => {
    const spec: Spec = { ...body, padding: { left: 40, top: 12, right: 18, bottom: 30 }, autosize: { type: 'none', contains: 'padding' } }
    expect(same(asterSvg(spec, {}), asterSvg(spec, { measuredSize: measured }))).toEqual([])
  })
  it('Vega-Lite `width: "container"`: the measured container sizes it as a container element of that size does vega\'s', async () => {
    const vl = await import('vega-lite')
    for (const [w, h] of [['container', 'container'], ['container', 180], [260, 'container']] as const) {
      const vg = (vl.compile as unknown as (s: unknown) => { spec: Spec })({
        width: w, height: h, padding: 5, data: { values: ROWS }, mark: 'bar',
        encoding: { x: { field: 'k', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } },
      }).spec
      const want = await vegaSvg(vg, () => {}, measured)
      expect(same(want, asterSvg(vg, { measuredSize: measured })).slice(0, 4), `width ${w}, height ${h}`).toEqual([])
    }
  })
})
