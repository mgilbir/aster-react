// @vitest-environment jsdom
/**
 * One error channel (audit T5, C47, C46, C100, C157, C554, C630): every way a chart can fail -- a value that is not a spec,
 * a Vega-Lite spec without the compiler, a rejected spec promise, an evaluation error, `data` that is not datasets of rows,
 * a size prop that is not a size -- reaches the chart's error state INSIDE its own element and `onError` exactly once,
 * whatever re-renders it (an inline callback, a `signals` literal, StrictMode). Nothing is thrown to the host's tree.
 * The element is the same before, during and after an error, so what is bound to it (the wheel, the measurement) works
 * after the chart recovers.
 */
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { forEachVariant, type ChartComponent } from './testing/variants'
import { ChartStream } from './ChartStream'
import { ChartWorkerStream } from './ChartWorkerStream'
import { useChartStream } from './useChartStream'
import { useChartWorkerStream } from './useChartWorkerStream'

const good = {
  width: 200, height: 100, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [{ a: 1, b: 1 }, { a: 5, b: 3 }, { a: 10, b: 9 }] }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 10], range: 'width', zero: false, nice: false },
    { name: 'y', type: 'linear', domain: [0, 10], range: 'height', zero: false, nice: false },
  ],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'a' }, y: { scale: 'y', field: 'b' } } } }],
}
const vegaLite = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', data: { values: [{ a: 1 }] }, mark: 'point', encoding: { x: { field: 'a', type: 'quantitative' } } }

/** Each way in, with what the props are and what the reported message says. */
const FAILURES: Array<[string, () => Record<string, unknown>, RegExp]> = [
  ['spec={null}', () => ({ spec: null }), /spec must be a Vega or Vega-Lite spec object; got null/],
  ['spec={undefined}', () => ({ spec: undefined }), /spec must be a Vega or Vega-Lite spec object; got undefined/],
  ['a JSON string as the spec', () => ({ spec: JSON.stringify(good) }), /got a string \(parse JSON text/],
  ['an array as the spec', () => ({ spec: [good] }), /got an array/],
  ['a Vega-Lite spec without the compiler', () => ({ spec: vegaLite }), /import '@aster-charts\/react\/vl'/],
  ['an evaluation error', () => ({ spec: { ...good, marks: [{ type: 'rect', from: { data: 'nope' } }] } }), /nope/],
  ['data that is not an object', () => ({ spec: good, data: 'rows' }), /data must be an object of datasets/],
  ['a dataset of null', () => ({ spec: good, data: { t: null } }), /data\["t"\] must be an array of rows; got null/],
  ['a dataset that is a string', () => ({ spec: good, data: { t: 'abc' } }), /data\["t"\] must be an array of rows; got "abc"/],
  ['a dataset that is an object', () => ({ spec: good, data: { t: {} } }), /data\["t"\] must be an array of rows; got an object/],
  ['a dataset that is a number', () => ({ spec: good, data: { t: 5 } }), /data\["t"\] must be an array of rows; got 5/],
  ['width={NaN}', () => ({ spec: good, width: NaN }), /width must be a finite number/],
  ['width={Infinity}', () => ({ spec: good, width: Infinity }), /width must be a finite number/],
  ['width={-50}', () => ({ spec: good, width: -50 }), /width must be a finite number/],
  ["width='300'", () => ({ spec: good, width: '300' }), /width must be a finite number.*got "300"/],
  ['height={NaN}', () => ({ spec: good, height: NaN }), /height must be a finite number/],
]

let roots: Array<{ root: Root; el: HTMLElement }> = []
afterEach(() => {
  act(() => { for (const r of roots) r.root.unmount() })
  for (const r of roots) r.el.remove()
  roots = []
})

function mount(): { el: HTMLElement; render: (node: React.ReactNode) => void } {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  roots.push({ root, el })
  return { el, render: (node) => act(() => { root.render(node) }) }
}

forEachVariant(['svg'], (Chart: ChartComponent) => {
  describe('every failure reaches the error state and onError once', () => {
    for (const [name, props, message] of FAILURES) {
      it(name, () => {
        const m = mount()
        const errors: Error[] = []
        const el = (extra: Record<string, unknown> = {}): React.ReactElement => (
          // (a new inline onError and signals literal each render: neither may report the same error again)
          <Chart {...(props() as { spec: never })} className="host" ariaLabel="sales" style={{ outline: '1px solid red' }}
            onError={(e) => errors.push(e)} signals={{ k: 1 }} a11y={false} {...extra} />
        )
        expect(() => m.render(el())).not.toThrow()
        m.render(el())
        m.render(el({ className: 'host' }))
        expect(errors.map((e) => e.message)).toHaveLength(1)
        expect(errors[0]!.message).toMatch(message)
        // the alert is inside the chart's own element, which keeps the host's class, label and style
        const chart = m.el.firstElementChild as HTMLElement
        expect(chart.className).toBe('host')
        expect(chart.getAttribute('aria-label')).toBe('sales')
        expect(chart.style.outline).toBe('1px solid red')
        expect(chart.querySelector(':scope > [role="alert"]')).not.toBeNull()
        expect(chart.querySelector('svg')).toBeNull()
      })
    }

    it('a rejected spec promise', async () => {
      const m = mount()
      const errors: Error[] = []
      const rejected = Promise.reject(new Error('spec fetch failed'))
      rejected.catch(() => {})
      await act(async () => {
        m.render(<React.Suspense fallback={<i>loading</i>}><Chart spec={rejected as never} onError={(e) => errors.push(e)} a11y={false} /></React.Suspense>)
      })
      await act(async () => { await Promise.resolve() })
      expect(errors.map((e) => e.message)).toEqual(['spec fetch failed'])
      expect(m.el.querySelector('[role="alert"]')).not.toBeNull()
    })

    it('once under StrictMode, and once more only for a different error after a success', () => {
      const m = mount()
      const errors: string[] = []
      const at = (spec: unknown): React.ReactElement => (
        <React.StrictMode><Chart spec={spec as never} onError={(e) => errors.push(e.message)} a11y={false} /></React.StrictMode>
      )
      m.render(at(null))
      m.render(at(null))
      expect(errors).toHaveLength(1)
      m.render(at(good))
      expect(m.el.querySelector('svg')).not.toBeNull()
      m.render(at(null))
      m.render(at('x'))
      expect(errors).toHaveLength(3)
    })

    it('undefined rows are rows not given: the spec draws its own values', () => {
      const m = mount()
      const errors: Error[] = []
      m.render(<Chart spec={good as never} data={{ t: undefined as never }} onError={(e) => errors.push(e)} a11y={false} />)
      expect(errors).toEqual([])
      expect(m.el.querySelectorAll('.mark-symbol path')).toHaveLength(3)
      m.render(<Chart spec={good as never} data={{ t: [{ a: 2, b: 2 }] }} onError={(e) => errors.push(e)} a11y={false} />)
      expect(m.el.querySelectorAll('.mark-symbol path')).toHaveLength(1)
    })

    it('the element is the same through an error, so the wheel zooms after the chart recovers', () => {
      const m = mount()
      const views: unknown[] = []
      const at = (data: unknown): React.ReactElement => (
        <Chart spec={good as never} data={data as never} zoom onViewChange={(v) => views.push(v)} a11y={false} onError={() => {}} />
      )
      m.render(at({ t: null }))
      const failed = m.el.firstElementChild
      expect(failed!.querySelector('[role="alert"]')).not.toBeNull()
      m.render(at({ t: [{ a: 1, b: 1 }, { a: 9, b: 9 }] }))
      expect(m.el.firstElementChild).toBe(failed)
      expect(failed!.querySelector('svg')).not.toBeNull()
      const wheel = new WheelEvent('wheel', { deltaY: -100, clientX: 100, clientY: 50, bubbles: true, cancelable: true })
      act(() => { failed!.dispatchEvent(wheel) })
      expect(wheel.defaultPrevented).toBe(true)
      expect(views).toHaveLength(1)
    })
  })
})

describe('the streaming components and hooks take a spec that does not normalize as an error, not a throw', () => {
  const NOT_SPECS: Array<[string, unknown, RegExp]> = [
    ['null', null, /got null/],
    ['a JSON string', '{"width":10}', /got a string/],
    ['a Vega-Lite spec without the compiler', vegaLite, /@aster-charts\/react\/vl/],
  ]
  for (const [name, spec, message] of NOT_SPECS) {
    it(`<ChartStream> and <ChartWorkerStream>: ${name}`, async () => {
      for (const Stream of [ChartStream, ChartWorkerStream]) {
        const m = mount()
        const errors: Error[] = []
        await act(async () => {
          m.render(<Stream spec={spec as never} width={200} height={100} onStreamError={(e) => errors.push(e)} />)
        })
        await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
        expect(errors.map((e) => e.message)).toHaveLength(1)
        expect(errors[0]!.message).toMatch(message)
        expect(m.el.querySelector('[role="alert"]')).not.toBeNull()
      }
    })
    it(`useChartStream / useChartWorkerStream: ${name}`, async () => {
      const seen: Record<string, string | undefined> = {}
      function Probe(): null {
        seen.local = useChartStream(spec as never).error?.message
        seen.worker = useChartWorkerStream(spec as never).error?.message
        return null
      }
      const m = mount()
      await act(async () => { m.render(<Probe />) })
      await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
      expect(seen.local).toMatch(message)
      expect(seen.worker).toMatch(message)
    })
  }
})
