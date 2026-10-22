// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Chart, type ChartHandle } from './Chart'
import { useChart, type UseChartResult } from './useChart'

function mount(node: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(node) })
  return { container, root, rerender: (n: React.ReactElement) => act(() => { root.render(n) }) }
}

beforeEach(() => {
  ;(Element.prototype as unknown as Record<string, unknown>).setPointerCapture = vi.fn()
  ;(Element.prototype as unknown as Record<string, unknown>).releasePointerCapture = vi.fn()
})
afterEach(() => { document.body.innerHTML = '' })

const setInputValue = (input: HTMLInputElement, value: string): void => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('bound signal inputs (C66)', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 100, height: 50, padding: 0, autosize: 'none',
    signals: [
      { name: 'w', value: 10, bind: { input: 'range', min: 0, max: 100, step: 1 } },
      { name: 'pick', value: 20, bind: { input: 'select', options: [10, 20, 30], name: 'Pick' } },
      { name: 'flag', value: true, bind: { input: 'checkbox' } },
    ],
    data: [{ name: 't', values: [{ v: 1 }] }],
    marks: [{ type: 'rect', from: { data: 't' }, encode: { update: {
      x: { value: 0 }, y: { value: 0 }, height: { signal: 'pick' }, width: { signal: 'w' }, fill: { value: 'steelblue' },
    } } }],
  } as never

  it('notify onSignal and signalListeners, like the spec-driven event loop does', () => {
    const onSignal = vi.fn()
    const listener = vi.fn()
    const ref = React.createRef<ChartHandle>()
    const { container } = mount(<Chart ref={ref} spec={spec} width={100} height={50} onSignal={onSignal} signalListeners={{ w: listener }} />)
    const range = container.querySelector('input[type="range"]') as HTMLInputElement
    setInputValue(range, '70')
    expect(listener).toHaveBeenCalledWith('w', 70)
    expect(onSignal).toHaveBeenCalledWith('w', 70)
    expect(ref.current!.getSignals().w).toBe(70)
    const rect = ((ref.current!.getScene()!.items[0] as { items: Array<{ width: number }> }).items[0])!
    expect(rect.width).toBe(70)
  })

  it('notify listeners on the canvas renderer too (no SVG event loop)', () => {
    const onSignal = vi.fn()
    const ref = React.createRef<ChartHandle>()
    const { container } = mount(<Chart ref={ref} spec={spec} width={100} height={50} renderer="canvas" onSignal={onSignal} />)
    setInputValue(container.querySelector('input[type="range"]') as HTMLInputElement, '33')
    expect(onSignal).toHaveBeenCalledWith('w', 33)
    expect(ref.current!.getSignals().w).toBe(33)
  })

  it('a <select> keeps the option value type (number, not "30")', () => {
    const listener = vi.fn()
    const ref = React.createRef<ChartHandle>()
    const { container } = mount(<Chart ref={ref} spec={spec} width={100} height={50} signalListeners={{ pick: listener }} />)
    const select = container.querySelector('select') as HTMLSelectElement
    expect(select.selectedOptions[0]!.textContent).toBe('20')
    select.value = select.options[2]!.value
    act(() => { select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(listener).toHaveBeenCalledWith('pick', 30)
    expect(ref.current!.getSignals().pick).toBe(30)
    const rect = ((ref.current!.getScene()!.items[0] as { items: Array<{ height: number }> }).items[0])!
    expect(rect.height).toBe(30)
  })

  it('a checkbox reports a boolean', () => {
    const listener = vi.fn()
    const { container } = mount(<Chart spec={spec} width={100} height={50} signalListeners={{ flag: listener }} />)
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    act(() => { box.click() })
    expect(listener).toHaveBeenCalledWith('flag', false)
  })
})

describe('dataChanges validation (C66)', () => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 100, height: 100, padding: 0, autosize: 'none',
    data: [{ name: 't' }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 10], range: [0, 100] },
      { name: 'y', type: 'linear', domain: [0, 10], range: [100, 0] },
    ],
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'a' }, y: { scale: 'y', field: 'b' } } } }],
  } as never
  const rows = (v: number) => [{ a: 1, b: 1 }, { a: 2, b: v }, { a: 3, b: 3 }]
  const yOfRow = (ref: React.RefObject<ChartHandle | null>, i: number): number =>
    ((ref.current!.getScene()!.items[0] as { items: Array<{ y: number }> }).items[i]!).y

  it('a valid changeset still takes the differential path', () => {
    const ref = React.createRef<ChartHandle>()
    const onError = vi.fn()
    const { rerender } = mount(<Chart ref={ref} spec={spec} data={{ t: rows(2) }} width={100} height={100} onError={onError} />)
    rerender(<Chart ref={ref} spec={spec} data={{ t: rows(8) }} dataChanges={{ t: [1] }} width={100} height={100} onError={onError} />)
    expect(yOfRow(ref, 1)).toBeCloseTo(20, 6)
    expect(onError).not.toHaveBeenCalled()
  })

  it.each([
    ['an out-of-range index', { t: [7] }],
    ['a fractional index', { t: [0.5] }],
    ['an unknown dataset', { nope: [0] }],
  ])('%s is reported and the update is still correct', (_label, changes) => {
    const ref = React.createRef<ChartHandle>()
    const onError = vi.fn<(e: Error) => void>()
    const { rerender } = mount(<Chart ref={ref} spec={spec} data={{ t: rows(2) }} width={100} height={100} onError={onError} />)
    rerender(<Chart ref={ref} spec={spec} data={{ t: rows(8) }} dataChanges={changes} width={100} height={100} onError={onError} />)
    expect(yOfRow(ref, 1)).toBeCloseTo(20, 6) // y(8) with domain 0..10 over 100px: the new value, not the stale one
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0].message).toMatch(/dataChanges/)
  })

  it('a row-count change is rejected (changesets need an unchanged length)', () => {
    const ref = React.createRef<ChartHandle>()
    const onError = vi.fn<(e: Error) => void>()
    const { rerender } = mount(<Chart ref={ref} spec={spec} data={{ t: rows(2) }} width={100} height={100} onError={onError} />)
    rerender(<Chart ref={ref} spec={spec} data={{ t: [...rows(8), { a: 4, b: 4 }] }} dataChanges={{ t: [1] }} width={100} height={100} onError={onError} />)
    expect(onError.mock.calls[0]![0].message).toMatch(/row count changed/)
    expect((ref.current!.getScene()!.items[0] as { items: unknown[] }).items).toHaveLength(4)
  })
})

describe('useChart memo covers every input (C66)', () => {
  const spec = {
    width: 100, height: 50, padding: 0, autosize: 'none', title: { text: 'Hello there' },
    marks: [],
  } as never

  it('re-evaluates when textMetrics changes', () => {
    const a: string[] = []
    const b: string[] = []
    const pa = { measure: (t: string) => { a.push(t); return 5 } }
    const pb = { measure: (t: string) => { b.push(t); return 5 } }
    let result: UseChartResult | null = null
    function Probe({ tm }: { tm: typeof pa }): React.ReactElement { result = useChart(spec, { textMetrics: tm }); return <div /> }
    const { rerender } = mount(<Probe tm={pa} />)
    expect(a).toContain('Hello there')
    rerender(<Probe tm={pb} />)
    expect(b).toContain('Hello there')
    expect(result!.error).toBeNull()
  })

  it.each([
    ['changedDatasets', { changedDatasets: ['t'] }],
    ['autoChanges', { autoChanges: false }],
    ['dataPulse', { dataPulse: { t: { changed: [0] } } }],
  ])('re-evaluates when %s changes', (_name, extra) => {
    const dataSpec = { width: 100, height: 50, padding: 0, autosize: 'none', data: [{ name: 't' }], marks: [] } as never
    const data = { t: [{ a: 1 }] }
    let session: UseChartResult['session'] | null = null
    function Probe({ inputs }: { inputs: Record<string, unknown> }): React.ReactElement {
      const r = useChart(dataSpec, { data, serialize: false, ...inputs })
      session = r.session
      return <div />
    }
    const { rerender } = mount(<Probe inputs={{}} />)
    const evaluate = vi.spyOn(session!, 'evaluate')
    rerender(<Probe inputs={{}} />)
    expect(evaluate).toHaveBeenCalledTimes(0) // nothing changed: the memo holds
    rerender(<Probe inputs={extra} />)
    expect(evaluate).toHaveBeenCalledTimes(1)
  })
})
