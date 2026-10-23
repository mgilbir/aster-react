// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Chart } from './Chart'

/**
 * `<Chart logger>` is the observable channel for recovered errors (C90): an expression that throws is reported
 * there, from evaluation and from `signal.on` events, instead of being swallowed or escaping the DOM listener.
 */
const spec = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 100, height: 60, padding: 0, autosize: 'none',
  signals: [
    { name: 'bad', value: 'init', on: [{ events: 'click', update: 'datum.nope.x' }] },
    { name: 'good', value: 0, on: [{ events: 'mousemove', update: 'good + 1' }] },
  ],
  data: [{ name: 't', values: [{ a: 1, o: { x: 1 } }, { a: 2 }] }],
  marks: [{
    type: 'rect', from: { data: 't' },
    encode: { update: { x: { signal: 'datum.o.x * 10' }, y: { value: 0 }, width: { value: 5 }, height: { value: 5 }, fill: { value: 'steelblue' } } },
  }],
} as never

describe('<Chart logger>', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('receives evaluation errors and event-handler errors; the chart keeps working', () => {
    const errors: unknown[] = []
    const logger = { error: (...a: unknown[]) => { errors.push(a[0]) }, warn: () => {} }
    const goodListener = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(<Chart spec={spec} width={100} height={60} logger={logger} signalListeners={{ good: goodListener }} />) })
    const evalErrors = errors.length
    expect(evalErrors).toBeGreaterThan(0) // the second row has no `o`
    const svg = container.querySelector('svg')!
    expect(() => act(() => { svg.dispatchEvent(new MouseEvent('click', { bubbles: true })) })).not.toThrow()
    expect(errors.length).toBeGreaterThan(evalErrors) // the click handler's TypeError
    act(() => { svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })) })
    expect(goodListener).toHaveBeenCalledWith('good', 1)
    act(() => root.unmount())
  })

  it('an inline logger object does not re-evaluate the chart on every render', () => {
    const calls: number[] = []
    const Host = ({ n }: { n: number }): React.ReactElement => (
      <Chart spec={spec} width={100} height={60} logger={{ error: () => { calls.push(n) }, warn: () => {} }} />
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(<Host n={1} />) })
    const first = calls.length
    act(() => { root.render(<Host n={2} />) })
    expect(calls.length).toBe(first)
    act(() => root.unmount())
  })
})
