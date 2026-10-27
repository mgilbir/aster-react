// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import './vl' // Vega-Lite is opt-in: this registers the compiler
import type { ChartHandle } from './Chart'
import { forEachVariant } from './testing/variants'

// A Vega-Lite 6 animation end to end through the component: the `time` channel's timer selection ticks, `modify` writes the
// frame to the selection store, the chart reads the store as data, and the marks of the current frame are what is drawn.
const rows = [1990, 1991, 1992].flatMap((year) => ['a', 'b'].map((c, i) => ({ year, c, x: year - 1990 + i, y: i })))
const vl = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 200, height: 100, padding: 0, autosize: 'none',
  data: { values: rows },
  params: [{ name: 'anim', select: { type: 'point', on: 'timer', fields: ['year'] } }],
  transform: [{ filter: { param: 'anim' } }],
  mark: 'point',
  encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' }, time: { field: 'year', type: 'ordinal' } },
} as never

forEachVariant(['svg'], (Chart, variant) => {
  describe('animated Vega-Lite spec', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] })
    })
    afterEach(() => {
      // the shared scheduler (like d3-timer's) keeps one pending wake-up; let it fire on this test's clock before the clock goes
      vi.advanceTimersByTime(2000)
      vi.useRealTimers()
      document.body.innerHTML = ''
    })

    const items = (container: HTMLElement): number => container.querySelectorAll('.mark-symbol path').length
    const mount = (node: React.ReactElement) => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(node) })
      return { container, root }
    }

    variant.it(['signals'], 'draws every row until the first tick, then one year per frame, and wraps around', () => {
      const ref = React.createRef<ChartHandle>()
      const { container, root } = mount(<Chart ref={ref} spec={vl} width={200} height={100} />)
      expect(items(container)).toBe(6) // the store is empty: the whole data
      // 2 fps: a frame is 500 ms; the 60 fps clock ticks every ~17 ms, so 100 ms in, the first tuple is the first year
      act(() => { vi.advanceTimersByTime(100) })
      expect(items(container)).toBe(2)
      expect((ref.current!.getSignals().anim_tuple as { values: unknown[] }).values).toEqual([1990])
      act(() => { vi.advanceTimersByTime(500) })
      expect((ref.current!.getSignals().anim_tuple as { values: unknown[] }).values).toEqual([1991])
      expect(items(container)).toBe(2)
      act(() => { vi.advanceTimersByTime(500) })
      expect((ref.current!.getSignals().anim_tuple as { values: unknown[] }).values).toEqual([1992])
      act(() => { vi.advanceTimersByTime(500) }) // past the third frame (1500 ms): the clock wraps to the first
      expect((ref.current!.getSignals().anim_tuple as { values: unknown[] }).values).toEqual([1990])
      act(() => { root.unmount() })
      act(() => { vi.advanceTimersByTime(100) })
      expect(vi.getTimerCount()).toBe(0)
    })

    variant.it(['signals'], 'the chart reads the store the loop writes: it is not a copy the host has to keep in step', () => {
      const ref = React.createRef<ChartHandle>()
      const { container, root } = mount(<Chart ref={ref} spec={vl} width={200} height={100} />)
      act(() => { vi.advanceTimersByTime(600) })
      const first = Array.from(container.querySelectorAll('.mark-symbol path')).map((p) => p.getAttribute('transform'))
      act(() => { vi.advanceTimersByTime(500) })
      const second = Array.from(container.querySelectorAll('.mark-symbol path')).map((p) => p.getAttribute('transform'))
      expect(first).toHaveLength(2)
      expect(second).toHaveLength(2)
      expect(second).not.toEqual(first) // another year's rows
      act(() => { root.unmount() })
    })
  })
})
