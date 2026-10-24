// @vitest-environment jsdom
/**
 * Guides driven by signals, against real Vega (the guide/layout lane of the signals sweep: sweep-signals).
 *
 * Every property of a guide may be a signal, and a signal may hold anything (a word where a number goes, null, a
 * list). Each block pins one class of defect over the whole value set the sweep writes, comparing a FRESH vega view
 * whose signal starts at the value with the engine (the engine is a pure function of its inputs; vega's own second
 * render retains state, which the sweep classifies separately). The strict canonicalizer judges the documents.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec, evaluateChart, compileChart } from '@aster/core'
import { renderSceneToDomElement } from '@aster/core/dom'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracleSvg(spec: Spec): Promise<string> {
  const log = console.error
  console.error = () => {}
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(vega.parse(spec as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    console.error = log
    view.finalize()
  }
}
const compare = async (spec: Spec): Promise<string[]> => diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(spec as never)))

const ROWS = [{ k: 'a', v: 28 }, { k: 'b', v: 55 }, { k: 'c', v: 43 }, { k: 'd', v: 91 }]
const base = (extra: Spec): Spec => ({ width: 200, height: 120, padding: 5, data: [{ name: 't', values: ROWS }], ...extra })
const withSignal = (spec: Spec, name: string, value: unknown): Spec => ({ ...spec, signals: [{ name, value }] })

/** One chart per value of one signal, fresh. */
function sweepValues(label: string, signal: string, values: unknown[], make: () => Spec): void {
  describe(label, () => {
    for (const v of values) {
      it(`${signal} = ${JSON.stringify(v)}`, async () => {
        expect(await compare(withSignal(make(), signal, v))).toEqual([])
      })
    }
  })
}

sweepValues('a title that is a signal', 'heading', ['Revenue', '', 'A much longer heading than the chart is wide', 0, null, ['two', 'lines'], 1e21], () => base({
  title: { text: { signal: 'heading' } },
  scales: [{ name: 'y', type: 'linear', domain: [0, 100], range: 'height' }],
  axes: [{ orient: 'left', scale: 'y', tickCount: 4 }],
  marks: [],
}))

describe('titles as vega parses them', () => {
  const chart = (title: unknown): Spec => base({ title, scales: [{ name: 'y', type: 'linear', domain: [0, 100], range: 'height' }], axes: [{ orient: 'left', scale: 'y', tickCount: 3 }], marks: [] })
  for (const [label, title] of [
    ['an object with empty text is a title with empty text', { text: '' }],
    ['a list of lines', { text: ['two', 'lines'] }],
    ['an empty string is no title (vega: if (spec.title))', ''],
    ['a number', { text: 42 }],
    ['a subtitle under empty text', { text: '', subtitle: 'sub' }],
  ] as const) {
    it(label, async () => { expect(await compare(chart(title))).toEqual([]) })
  }
})

sweepValues('a legend title that is a signal', 'legendTitle', ['Series', ['two', 'lines'], '', null, 0, 1e21], () => base({
  scales: [{ name: 'colour', type: 'ordinal', domain: { data: 't', field: 'k' }, range: 'category' }],
  legends: [{ fill: 'colour', title: { signal: 'legendTitle' } }],
  marks: [],
}))

describe('legend titles as vega parses them', () => {
  const chart = (title: unknown, extra: Spec = {}): Spec => base({
    scales: [{ name: 'colour', type: 'ordinal', domain: { data: 't', field: 'k' }, range: 'category' }],
    legends: [{ fill: 'colour', title, ...extra }],
    marks: [],
  })
  for (const [label, title] of [
    ['an empty string is a title with empty text', ''],
    ['null is no title', null],
    ['a list is lines', ['two', 'lines']],
  ] as const) {
    it(label, async () => { expect(await compare(chart(title))).toEqual([]) })
  }
})

describe('an axis tick count that is a signal', () => {
  const chart = (): Spec => base({
    scales: [{ name: 'y', type: 'linear', domain: [0, 100], range: 'height' }],
    axes: [{ orient: 'left', scale: 'y', tickCount: { signal: 'ticks' } }],
    marks: [],
  })
  for (const v of [4, 0, 1, 40, -3, 2.5, null]) {
    it(`ticks = ${JSON.stringify(v)}`, async () => { expect(await compare(withSignal(chart(), 'ticks', v))).toEqual([]) })
  }
  it('a word on a linear scale is an error in the dataflow: the axis is logged and not drawn (literal domain)', async () => {
    const errors: unknown[] = []
    const spec = withSignal(chart(), 'ticks', 'four')
    expect(diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(spec as never, { logger: { error: (...a) => errors.push(a[0]), warn: () => {} } })))).toEqual([])
    expect(String(errors[0])).toMatch(/Only time and utc scales accept interval strings/)
  })
  it('over a data-driven domain vega cannot even serialize the half-built axis: a refusal on both sides', async () => {
    const spec = withSignal(base({
      scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width' }],
      axes: [{ orient: 'bottom', scale: 'x', tickCount: { signal: 'ticks' } }],
      marks: [],
    }), 'ticks', 'day')
    await expect(oracleSvg(spec)).rejects.toThrow(/marktype/)
    expect(() => renderSpec(spec as never)).toThrow(/half-built axis/)
  })
})

describe('an axis number format that is a signal', () => {
  const chart = (): Spec => base({
    scales: [{ name: 'y', type: 'linear', domain: [0, 1], range: 'height' }],
    axes: [{ orient: 'left', scale: 'y', tickCount: 3, format: { signal: 'fmt' } }],
    marks: [],
  })
  for (const v of ['.2f', '', '%', '.99f', null, 42]) {
    it(`fmt = ${JSON.stringify(v)}`, async () => { expect(await compare(withSignal(chart(), 'fmt', v))).toEqual([]) })
  }
  it('a static numeric format is its digits (d3 reads the specifier through a regular expression)', async () => {
    const spec = chart()
    ;(spec.axes as Spec[])[0]!.format = 42
    expect(await compare(spec)).toEqual([])
  })
  it('a string that is no specifier fails the ticks like vega: logged, axis not drawn', async () => {
    const errors: unknown[] = []
    const spec = withSignal(chart(), 'fmt', 'not a format')
    expect(diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(spec as never, { logger: { error: (...a) => errors.push(a[0]), warn: () => {} } })))).toEqual([])
    expect(String(errors[0])).toMatch(/invalid format/)
  })
})

describe('an axis orient that is a signal', () => {
  const chart = (axis: Spec = {}): Spec => base({
    scales: [{ name: 'y', type: 'linear', domain: [0, 100], range: 'height' }],
    axes: [{ orient: { signal: 'side' }, scale: 'y', tickCount: 3, ...axis }],
    marks: [],
  })
  for (const v of ['left', 'right', 'top', 'bottom', '', null, 'sideways']) {
    it(`side = ${JSON.stringify(v)}`, async () => { expect(await compare(withSignal(chart(), 'side', v))).toEqual([]) })
  }
  it('with config.axisX / axisY / axisTop picked by the value', async () => {
    const cfg = { axisX: { tickColor: 'red' }, axisY: { tickColor: 'green' }, axisTop: { domainColor: 'blue' } }
    // (the config blocks named for an orient are null for every other value in vega -- an orient signal's `ifOrient`
    // ends in `(null)` -- which the engine does not model; 'sideways' is left out of this one)
    for (const v of ['top', 'bottom', 'left', 'right']) {
      expect(await compare({ ...withSignal(chart(), 'side', v), config: cfg }), String(v)).toEqual([])
    }
  })
  it('any orient but the four is a vertical axis at the origin whose layout never runs (static)', async () => {
    const spec = base({ scales: [{ name: 'y', type: 'linear', domain: [0, 100], range: 'height' }], axes: [{ orient: 'sideways', scale: 'y', tickCount: 3, grid: true, title: 'T' }], marks: [] })
    expect(await compare(spec)).toEqual([])
  })
})

describe('any axis property may be a signal', () => {
  const cases: Array<[string, string, unknown[]]> = [
    ['labelLimit', 'lim', [0, 12, 1, 1e6, -5, null, 'wide']],
    ['labelAngle', 'turn', [0, 45, -90, 360, 0.5, null]],
    ['labelFontSize', 'fs', [10, 0, 24, -3, null]],
    ['tickSize', 'ts', [5, 0, 12, -4, null]],
    ['domainColor', 'dc', ['red', '', null, 7]],
    ['labelPadding', 'pad', [2, 0, 20, -3, null]],
  ]
  for (const [prop, sig, values] of cases) {
    describe(prop, () => {
      for (const v of values) {
        it(`${sig} = ${JSON.stringify(v)}`, async () => {
          const spec = withSignal(base({
            scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.1 }],
            axes: [{ orient: 'bottom', scale: 'x', [prop]: { signal: sig } }],
            marks: [],
          }), sig, v)
          expect(await compare(spec)).toEqual([])
        })
      }
    })
  }
  it('a legend property too', async () => {
    for (const v of [10, 0, 30, null]) {
      const spec = withSignal(base({
        scales: [{ name: 'colour', type: 'ordinal', domain: { data: 't', field: 'k' }, range: 'category' }],
        legends: [{ fill: 'colour', symbolSize: { signal: 'sz' }, orient: { signal: 'o' } }],
        marks: [],
        signals: [{ name: 'sz', value: v }, { name: 'o', value: 'left' }],
      }), 'sz', v)
      ;(spec.signals as Spec[]) = [{ name: 'sz', value: v }, { name: 'o', value: 'left' }]
      expect(await compare(spec), String(v)).toEqual([])
    }
  })
})

describe('the view width that is a signal', () => {
  const chart = (): Spec => base({
    width: { signal: 'w' },
    scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.1 }],
    axes: [{ orient: 'bottom', scale: 'x' }],
    marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'k' }, width: { scale: 'x', band: 1 }, y: { value: 0 }, y2: { value: 60 } } } }],
  })
  // a negative width: vega lays the first pass out on the signal as written and keeps that view size and padding
  // when the signal is clamped to 0 and the content is encoded again
  for (const v of [200, 0, 40, -100, 1e5, null, 'wide', -3, '50']) {
    it(`w = ${JSON.stringify(v)}`, async () => { expect(await compare(withSignal(chart(), 'w', v))).toEqual([]) })
  }
  it('a negative declared height (the same two passes)', async () => {
    for (const h of [-4, -50, -200]) {
      const spec = base({
        height: h,
        scales: [{ name: 'y', type: 'linear', domain: [0, 100], range: 'height' }],
        axes: [{ orient: 'left', scale: 'y' }],
        marks: [],
      })
      expect(await compare(spec), String(h)).toEqual([])
    }
  })
})

describe('text angle', () => {
  it('a word is written as vega writes it: rotate(word), in the string and the DOM renderer alike', () => {
    const spec = { width: 60, height: 40, padding: 2, autosize: 'none', marks: [{ type: 'text', encode: { update: { x: { value: 10 }, y: { value: 20 }, text: { value: 'hi' }, angle: { value: 'sideways' } } } }] }
    expect(renderSpec(spec as never)).toContain('rotate(sideways)')
    const dom = renderSceneToDomElement(evaluateChart(compileChart(spec as never)), document)
    expect(new XMLSerializer().serializeToString(dom as unknown as Node)).toContain('rotate(sideways)')
  })
  it('a word that is markup stays text', () => {
    const spec = { width: 60, height: 40, padding: 2, autosize: 'none', marks: [{ type: 'text', encode: { update: { x: { value: 10 }, y: { value: 20 }, text: { value: 'hi' }, angle: { value: '"><script>x</script>' } } } }] }
    const svg = renderSpec(spec as never)
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('rotate(&quot;&gt;&lt;script&gt;x&lt;/script&gt;)')
  })
})
