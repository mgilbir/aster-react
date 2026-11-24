// @vitest-environment node
/**
 * The view's own properties (`background`, `autosize`, `padding`, `width`, `height`) are signals of the view (vega-parser
 * `collectSignals`): the spec's property, else the config's; a `{signal}` there is the signal's update; a signal the spec declares
 * by the same name is merged over it. Each case renders as real vega renders it (canonical SVG, strict):
 *  - every property as a literal, a `{signal}` reading a literal, another signal, data, and from `config`;
 *  - a declared signal of the same name, alone and merged with the property (its `value` / `update` win);
 *  - what vega-view makes of the value: padding numbers and objects, autosize by `type` and `contains` only (a string, null or
 *    `{}` has no type: no layout), a size taken as `+v || 0`, a truthy background as its text;
 *  - a signal written by the host re-lays the view out as `view.signal(name, value)` does in vega, on one incremental chart;
 *  - Vega-Lite's `background` / `padding` as `{expr}` (compiled by vega-lite for vega, by @aster-charts/vl for Aster).
 *
 * These run against the built packages (the `build` gate precedes `test`).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import * as vegaLite from 'vega-lite'
import { compile } from '@aster-charts/vl'
import { compileChart, evaluateChart, renderSceneToSvg, renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Obj = Record<string, unknown>
type View = { runAsync(): Promise<unknown>; toSVG(): Promise<string>; signal(n: string, v: unknown): View; finalize(): void }
const newView = (spec: Obj): View => new (vega as unknown as { View: new (rt: unknown, o: unknown) => View }).View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })

async function oracleSvg(spec: Obj): Promise<string> {
  const view = newView(spec)
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}
const diff = (theirs: string, ours: string): string[] => diffCanonical(canonicalizeSvg(theirs), canonicalizeSvg(ours))

const rect = (x = 5, w = 20): Obj => ({ type: 'rect', encode: { update: { x: { value: x }, y: { value: 5 }, width: { value: w }, height: { value: 10 }, fill: { value: 'steelblue' } } } })
const base = (extra: Obj): Obj => ({ width: 60, height: 40, marks: [rect()], ...extra })
/** a mark that overflows the view on the left and right, so autosize and padding show */
const WIDE: Obj = { padding: 10, marks: [rect(-20, 120)] }
/** no size of its own */
const unsized = (extra: Obj): Obj => ({ marks: [rect()], ...extra })
const T3 = [{ name: 't', values: [1, 2, 3] }]

const CASES: Record<string, Obj> = {
  // background
  'background {signal} literal': base({ background: { signal: "'#ff0000'" } }),
  'background {signal} another signal': base({ background: { signal: 'c' }, signals: [{ name: 'c', value: '#0000ff' }] }),
  'background {signal} expression': base({ background: { signal: "w > 10 ? 'red' : 'blue'" }, signals: [{ name: 'w', value: 20 }] }),
  'background {signal} from config': base({ config: { background: { signal: "'#00ff00'" } } }),
  'background {signal} null': base({ background: { signal: 'null' } }),
  'background {signal} a number': base({ background: { signal: '5' } }),
  'background a number': base({ background: 5 }),
  'background from config': base({ config: { background: '#eee' } }),
  'background declared signal': base({ signals: [{ name: 'background', value: '#abcdef' }] }),
  'background declared update over the property': base({ background: 'red', signals: [{ name: 'background', update: "'#123456'" }] }),
  'background {signal} merged with a declared value': base({ background: { signal: "'red'" }, signals: [{ name: 'background', value: '#654321' }] }),
  'background declared with handlers only keeps the property': base({ background: '#eee', signals: [{ name: 'background', on: [{ events: 'click', update: "'red'" }] }] }),
  'background {signal} reading a config signal': base({ background: { signal: 'c' }, config: { signals: [{ name: 'c', value: 'pink' }] } }),
  // padding
  'padding {signal} another signal': base({ padding: { signal: 'p' }, signals: [{ name: 'p', value: 20 }] }),
  'padding {signal} object': base({ padding: { signal: '{top: 10, left: 30, right: 2, bottom: 4}' } }),
  'padding {signal} from config': base({ config: { padding: { signal: '12' } } }),
  'padding {signal} null': base({ padding: { signal: 'null' } }),
  'padding {signal} a string that is no number': base({ padding: { signal: "'x'" } }),
  'padding {signal} reading data': base({ data: T3, padding: { signal: "data('t').length * 5" } }),
  'padding {signal} reading data, autosize none': base({ autosize: 'none', data: T3, padding: { signal: "data('t').length * 5" } }),
  'padding declared signal': base({ signals: [{ name: 'padding', value: 15 }] }),
  'padding a numeric string': base({ padding: '7' }),
  'padding object with a numeric string': base({ padding: { top: '5', left: 3 } }),
  'padding from config': base({ config: { padding: 12 } }),
  'padding object from config': base({ config: { padding: { top: 3, left: 9 } } }),
  // autosize
  'autosize {signal} string none (no type)': base({ autosize: { signal: "'none'" }, ...WIDE }),
  'autosize {signal} string fit (no type)': base({ autosize: { signal: "'fit'" }, ...WIDE }),
  'autosize {signal} null (no type)': base({ autosize: { signal: 'null' }, ...WIDE }),
  'autosize {signal} {} (no type)': base({ autosize: { signal: '{}' }, ...WIDE }),
  'autosize {signal} contains only': base({ autosize: { signal: "{contains: 'padding'}" }, ...WIDE }),
  'autosize {signal} {type: none}': base({ autosize: { signal: "{type: 'none'}" }, ...WIDE }),
  'autosize {signal} {type: none, contains: padding}': base({ autosize: { signal: "{type: 'none', contains: 'padding'}" }, ...WIDE }),
  'autosize {signal} {type: pad, contains: padding}': base({ autosize: { signal: "{type: 'pad', contains: 'padding'}" }, ...WIDE }),
  'autosize {signal} {type: fit}': base({ autosize: { signal: "{type: 'fit'}" }, ...WIDE }),
  'autosize {signal} unknown type': base({ autosize: { signal: "{type: 'bogus'}" }, ...WIDE }),
  'autosize {signal} from config': base({ config: { autosize: { signal: "'none'" } }, marks: [rect(-20, 120)] }),
  'autosize {signal} reading data': base({ data: [{ name: 't', values: [1] }], autosize: { signal: "data('t').length > 0 ? {type: 'none'} : {type: 'pad'}" }, ...WIDE }),
  'autosize contains only': base({ autosize: { contains: 'padding' }, ...WIDE }),
  'autosize {}': base({ autosize: {}, ...WIDE }),
  'autosize empty string': base({ autosize: '', ...WIDE }),
  'autosize unknown type': base({ autosize: 'bogus', ...WIDE }),
  'autosize unknown type object': base({ autosize: { type: 'bogus' }, ...WIDE }),
  'autosize from config': base({ config: { autosize: 'none' }, marks: [rect(-20, 120)] }),
  'autosize object from config': base({ config: { autosize: { type: 'pad', contains: 'padding' } }, padding: 7, marks: [rect(-20, 120)] }),
  // width / height
  'width {signal} another signal': base({ width: { signal: 'w' }, signals: [{ name: 'w', value: 90 }] }),
  'width {signal} expression': base({ width: { signal: 'w * 2' }, signals: [{ name: 'w', value: 40 }] }),
  'height {signal} expression': base({ height: { signal: '10 + 20' } }),
  'width {signal} a signal with an update': base({ width: { signal: 'w' }, signals: [{ name: 'w', update: '40 + 40' }] }),
  'width {signal} reading data': base({ data: T3, width: { signal: 'w' }, signals: [{ name: 'w', update: "data('t').length * 30" }] }),
  'width {signal} null': base({ width: { signal: 'null' } }),
  'width {signal} a numeric string': base({ width: { signal: "'70'" } }),
  'width {signal} negative': base({ width: { signal: 'w' }, signals: [{ name: 'w', value: -30 }] }),
  'width {signal} negative expression': base({ width: { signal: 'w - 100' }, signals: [{ name: 'w', value: 70 }] }),
  'width {signal} under autosize fit': base({ autosize: 'fit', width: { signal: 'w * 2' }, signals: [{ name: 'w', value: 40 }], ...WIDE }),
  'width {signal}, autosize none containing the padding': base({ padding: 10, autosize: { type: 'none', contains: 'padding' }, width: { signal: 'w' }, signals: [{ name: 'w', value: 90 }] }),
  'width {signal} expression, autosize none containing the padding': base({ padding: 10, autosize: { type: 'none', contains: 'padding' }, width: { signal: 'w + 10' }, signals: [{ name: 'w', value: 90 }] }),
  'width {signal} read by a dataset': base({
    width: { signal: 'w * 2' }, signals: [{ name: 'w', value: 40 }],
    data: [{ name: 't', values: [{}], transform: [{ type: 'formula', as: 'x', expr: 'width' }] }],
    marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, width: { field: 'x' }, y: { value: 0 }, height: { value: 5 } } } }],
  }),
  'width {signal} merged with a declared value': base({ width: { signal: 'w' }, signals: [{ name: 'w', value: 40 }, { name: 'width', value: 99 }] }),
  'width declared value over the property': base({ signals: [{ name: 'width', value: 120 }] }),
  'width declared update over the property': base({ signals: [{ name: 'width', update: '33 + 33' }] }),
  'height declared value over the property': base({ signals: [{ name: 'height', value: 22 }] }),
  'width declared update reading data': base({ data: T3, signals: [{ name: 'width', update: "data('t').length * 30" }] }),
  'width declared update reading data, autosize none containing the padding': base({ padding: 10, autosize: { type: 'none', contains: 'padding' }, data: T3, signals: [{ name: 'width', update: "data('t').length * 30" }] }),
  'width / height from config': unsized({ config: { width: 77, height: 33 } }),
  'width from config, the spec wins': base({ config: { width: 77 } }),
  'width 0 in the spec beats config': base({ width: 0, config: { width: 77 } }),
  'width {signal} from config': unsized({ config: { width: { signal: '50 + 5' } } }),
}

describe('the view properties render as vega renders them', () => {
  for (const [name, spec] of Object.entries(CASES)) {
    it(name, async () => {
      expect(diff(await oracleSvg(spec), renderSpec(spec as never))).toEqual([])
    })
  }
})

describe('a view signal the host writes re-lays the view out as vega does', () => {
  /** vega's view with the signal written before its first run: what it renders for that value from the start */
  async function freshWith(spec: Obj, signal: string, value: unknown): Promise<string> {
    const view = newView(spec)
    try {
      view.signal(signal, value)
      await view.runAsync()
      return await view.toSVG()
    } finally {
      view.finalize()
    }
  }
  // [spec, the signal written, the values written in turn, whether vega's running view re-lays itself out too]
  // A running vega view lays itself out again when its width, height or padding signal changes (vega-view `initializeResize`), not
  // when its autosize does: it keeps the layout of the value before until something resizes it. The engine is a pure function of its
  // inputs, so it renders what vega renders for the value from the start (as the signals sweep does for every retained case).
  const RUNS: Array<[string, Obj, string, unknown[], boolean]> = [
    ['background', base({ background: { signal: 'c' }, signals: [{ name: 'c', value: 'red' }] }), 'c', ['blue', null, '#abc', 'red'], true],
    ['padding', base({ padding: { signal: 'p' }, signals: [{ name: 'p', value: 5 }], marks: [rect(-20, 120)] }), 'p', [20, { top: 30, left: 2 }, 0, 5], true],
    ['autosize', base({ autosize: { signal: 'a' }, signals: [{ name: 'a', value: { type: 'pad' } }], ...WIDE }), 'a', [{ type: 'none' }, { type: 'none', contains: 'padding' }, 'fit', { type: 'fit' }, { type: 'pad' }], false],
    ['width', base({ width: { signal: 'w * 2' }, signals: [{ name: 'w', value: 30 }] }), 'w', [50, 10, 0, 30], true],
    ['width, autosize none containing the padding', base({ padding: 10, autosize: { type: 'none', contains: 'padding' }, width: { signal: 'w + 10' }, signals: [{ name: 'w', value: 90 }] }), 'w', [40, 140, 90], true],
  ]
  for (const [what, spec, signal, values, relays] of RUNS) {
    it(what, async () => {
      const view = newView(spec)
      const chart = compileChart(spec as never)
      try {
        await view.runAsync()
        expect(diff(await view.toSVG(), renderSceneToSvg(evaluateChart(chart, {}))), 'initial').toEqual([])
        for (const v of values) {
          const ours = renderSceneToSvg(evaluateChart(chart, { signals: { [signal]: v } }))
          expect(diff(await freshWith(spec, signal, v), ours), JSON.stringify(v)).toEqual([])
          await view.signal(signal, v).runAsync()
          if (relays) expect(diff(await view.toSVG(), ours), `running view, ${JSON.stringify(v)}`).toEqual([])
        }
      } finally {
        view.finalize()
      }
    })
  }

  it('a padding that reads data follows the data on one incremental chart, as a fresh evaluation does', async () => {
    const spec = base({ data: [{ name: 't', values: [] }], padding: { signal: "data('t').length * 5" }, marks: [rect(-20, 120)] })
    const chart = compileChart(spec as never)
    for (const n of [1, 3, 0, 6]) {
      const rows = Array.from({ length: n }, (_, i) => ({ i }))
      const ours = renderSceneToSvg(evaluateChart(chart, { data: { t: rows } }))
      expect(ours, `${n} rows`).toBe(renderSceneToSvg(evaluateChart(compileChart(spec as never), { data: { t: rows } })))
      expect(diff(await oracleSvg({ ...spec, data: [{ name: 't', values: rows }] }), ours), `${n} rows`).toEqual([])
    }
  })
})

describe('Vega-Lite: background and padding as {expr}', () => {
  const unit = (extra: Obj): Obj => ({
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 80, height: 50, data: { values: [{ a: 1, b: 2 }, { a: 2, b: 3 }] }, mark: 'point',
    encoding: { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' } }, ...extra,
  })
  const VL: Record<string, Obj> = {
    'background {expr}': unit({ background: { expr: "'#ffeeaa'" } }),
    'background {expr} reading a param': unit({ params: [{ name: 'c', value: '#aabbcc' }], background: { expr: 'c' } }),
    'config.background {expr}': unit({ config: { background: { expr: "'#ccddee'" } } }),
    'padding {expr}': unit({ padding: { expr: '20' } }),
    'padding {expr} reading a param': unit({ params: [{ name: 'p', value: 15 }], padding: { expr: 'p' } }),
    'config.padding {expr}': unit({ config: { padding: { expr: '12' } } }),
  }
  for (const [name, spec] of Object.entries(VL)) {
    it(name, async () => {
      const ours = renderSpec(compile(spec as never) as never)
      expect(ours).not.toContain('[object Object]')
      expect(diff(await oracleSvg(vegaLite.compile(spec as never).spec as Obj), ours)).toEqual([])
    })
  }
})
