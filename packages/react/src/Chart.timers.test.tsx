// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { ChartHandle } from './Chart'
import { forEachVariant } from './testing/variants'

// A `timer` event stream is the view's, not a render's: it keeps ticking across the re-renders its own updates cause,
// and it must be gone when the chart unmounts. Time is virtual (vitest fake timers over the host's clock and frames).
forEachVariant(['svg'], (Chart, variant) => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 200, height: 50, padding: 0, autosize: 'none',
    signals: [{ name: 'n', value: 1, on: [{ events: { type: 'timer', throttle: 100 }, update: 'n + 1' }] }],
    data: [{ name: 't', values: [{ v: 1 }] }],
    marks: [{
      type: 'rect', from: { data: 't' },
      encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { signal: 'n * 10' }, height: { value: 10 }, fill: { value: 'steelblue' } } },
    }],
  } as never

  describe('timer event streams on the chart', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] })
    })
    afterEach(() => {
      vi.useRealTimers()
      document.body.innerHTML = ''
    })

    const mount = (node: React.ReactElement) => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(node) })
      return { container, root }
    }
    const drain = () => { act(() => { vi.advanceTimersByTime(1000) }) }

    variant.it(['signals'], 'ticks across its own re-renders and re-draws with the signal', () => {
      const ref = React.createRef<ChartHandle>()
      const { container, root } = mount(<Chart ref={ref} spec={spec} width={200} height={50} />)
      const width = (): string => container.querySelector('.mark-rect path')!.getAttribute('d')!
      expect(ref.current!.getSignals().n ?? 1).toBe(1)
      const first = width()
      act(() => { vi.advanceTimersByTime(350) })
      expect(ref.current!.getSignals().n).toBe(4)
      expect(width()).not.toBe(first)
      act(() => { vi.advanceTimersByTime(100) })
      expect(ref.current!.getSignals().n).toBe(5) // the schedule survived four re-binds: one tick per 100 ms
      act(() => { root.unmount() })
      drain()
    })

    variant.it(['signals'], 'unmount stops the timer: nothing is left scheduled and no tick arrives', () => {
      const onSignal = vi.fn()
      const { container, root } = mount(<Chart spec={spec} width={200} height={50} onSignal={onSignal} />)
      act(() => { vi.advanceTimersByTime(250) })
      expect(onSignal).toHaveBeenCalledTimes(2)
      const svg = container.querySelector('svg')!
      act(() => { root.unmount() })
      // a host that keeps the svg around (and in the document) is not what stops the timer: unmount releases it
      document.body.appendChild(svg)
      onSignal.mockClear()
      act(() => { vi.advanceTimersByTime(50) }) // d3-timer's already requested frame runs once and finds nothing
      expect(vi.getTimerCount()).toBe(0)
      act(() => { vi.advanceTimersByTime(2000) })
      expect(onSignal).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })

    variant.it(['signals'], 'strict mode (mount, unmount, mount) leaves one timer, and unmount ends it', () => {
      const onSignal = vi.fn()
      const { root } = mount(<React.StrictMode><Chart spec={spec} width={200} height={50} onSignal={onSignal} /></React.StrictMode>)
      act(() => { vi.advanceTimersByTime(250) })
      expect(onSignal).toHaveBeenCalledTimes(2) // not doubled by the strict-mode remount
      act(() => { root.unmount() })
      act(() => { vi.advanceTimersByTime(50) })
      expect(vi.getTimerCount()).toBe(0)
    })

    variant.it(['signals'], 'a chart replaced by another (a new svg) does not keep the old one ticking', () => {
      const onSignal = vi.fn()
      const { root } = mount(<Chart key="a" spec={spec} width={200} height={50} onSignal={onSignal} />)
      act(() => { vi.advanceTimersByTime(250) })
      act(() => { root.render(<Chart key="b" spec={spec} width={200} height={50} onSignal={onSignal} />) })
      onSignal.mockClear()
      act(() => { vi.advanceTimersByTime(250) })
      expect(onSignal).toHaveBeenCalledTimes(2) // one stream, not two
      act(() => { root.unmount() })
      act(() => { vi.advanceTimersByTime(50) })
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
