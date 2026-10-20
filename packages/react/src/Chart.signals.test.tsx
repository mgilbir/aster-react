// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Chart, type ChartHandle } from './Chart'

const spec = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 100, height: 100, padding: 0, autosize: 'none',
  signals: [{ name: 'n', value: 10, on: [{ events: 'click', update: 'n + 1' }] }],
  data: [{ name: 't', values: [{ v: 1 }] }],
  marks: [{
    type: 'rect', from: { data: 't' },
    encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { signal: 'n' }, height: { value: 10 }, fill: { value: 'steelblue' } } },
  }],
} as never

describe('event-driven signals as React state (R10.4)', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('routes signal.on through useSyncExternalStore and re-renders', () => {
    const onSignal = vi.fn()
    const listener = vi.fn()
    const ref = React.createRef<ChartHandle>()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(<Chart ref={ref} spec={spec} width={100} height={100} onSignal={onSignal} signalListeners={{ n: listener }} />)
    })
    const svg = container.querySelector('svg')!
    const before = svg.querySelector('.mark-rect path')?.getAttribute('d')
    act(() => { svg.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(ref.current!.getSignals().n).toBe(11)
    expect(onSignal).toHaveBeenCalledWith('n', 11)
    expect(listener).toHaveBeenCalledWith('n', 11)
    const after = container.querySelector('.mark-rect path')?.getAttribute('d')
    expect(after).not.toBe(before)
    act(() => { root.unmount() })
  })

  it('supports the imperative setSignal path on a spec without signal.on', () => {
    const specNoStreams = {
      ...(spec as Record<string, unknown>),
      signals: [{ name: 'n', value: 10 }],
    }
    const ref = React.createRef<ChartHandle>()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(<Chart ref={ref} spec={specNoStreams as never} width={100} height={100} />) })
    act(() => { ref.current!.setSignal('n', 22) })
    expect(ref.current!.getSignals().n).toBe(22)
    act(() => { root.unmount() })
  })

  it('supports the imperative setSignal path', () => {
    const ref = React.createRef<ChartHandle>()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(<Chart ref={ref} spec={spec} width={100} height={100} />) })
    act(() => { ref.current!.setSignal('n', 40) })
    expect(ref.current!.getSignals().n).toBe(40)
    act(() => { root.unmount() })
  })
})
