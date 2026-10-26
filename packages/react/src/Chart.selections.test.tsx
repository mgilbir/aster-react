// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import './vl'
import type { ChartHandle } from './Chart'
import { forEachVariant } from './testing/variants'

// A Vega-Lite spec-driven selection (`params`) on <Chart> and <SvgChart interaction>: a click writes the selection's
// signals through the event loop, the edited `<name>_store` is kept by the chart and is an input of the next
// evaluation, and it belongs to the spec it was made under.
forEachVariant(['svg'], (Chart, variant) => {
  const vlSpec = (extra: Record<string, unknown> = {}): never => ({
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: { values: [{ a: 1, b: 3, c: 'x' }, { a: 2, b: 5, c: 'y' }, { a: 3, b: 2, c: 'z' }] },
    width: 200, height: 100, autosize: 'none', padding: 10,
    params: [{ name: 'pick', select: 'point' }],
    mark: { type: 'point', size: 200 },
    encoding: {
      x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' },
      color: { condition: { param: 'pick', field: 'c', type: 'nominal' }, value: 'lightgray' },
    },
    ...extra,
  }) as never

  const strokes = (container: HTMLElement): string[] => Array.from(container.querySelectorAll('g.role-mark path')).map((p) => p.getAttribute('stroke') ?? '')

  /** A real click on the i-th mark: the pointer is put where the mark is drawn. */
  const clickMark = (container: HTMLElement, ref: React.RefObject<ChartHandle | null>, i: number, shift = false): void => {
    const svg = container.querySelector('svg')!
    const path = container.querySelectorAll('g.role-mark path')[i]!
    const m = /translate\(([-\d.e]+),([-\d.e]+)\)/.exec(path.getAttribute('transform') ?? '')!
    const pad = ref.current!.getScene()!.padding!
    const init = { bubbles: true, clientX: Number(m[1]) + pad.left, clientY: Number(m[2]) + pad.top, shiftKey: shift }
    act(() => { path.dispatchEvent(new MouseEvent('click', init)) })
    void svg
  }

  describe('Vega-Lite selections', () => {
    afterEach(() => { document.body.innerHTML = '' })

    variant.it(['signals'], 'a click selects: the param signal is reported, the marks show it, the store is kept across renders', () => {
      const listener = vi.fn()
      const ref = React.createRef<ChartHandle>()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      const render = (spec: never): void => { act(() => { root.render(<Chart ref={ref} spec={spec} signalListeners={{ pick: listener }} />) }) }
      render(vlSpec())
      const before = strokes(container)
      expect(new Set(before).size, 'with nothing selected every mark is coloured by its field').toBe(3)

      clickMark(container, ref, 1)
      expect(listener).toHaveBeenCalled()
      const resolved = listener.mock.calls.at(-1)![1] as { vlPoint?: { or: Array<{ _vgsid_: number }> } }
      expect(resolved.vlPoint?.or).toHaveLength(1)
      const after = strokes(container)
      expect(after.filter((s) => s === 'lightgray')).toHaveLength(2)
      expect(after[1]).toBe(before[1])

      // an unrelated re-render (a new, equal spec literal) keeps the selection: the store is an input the chart holds
      render(vlSpec())
      expect(strokes(container)).toEqual(after)

      // shift-click toggles a second mark in
      clickMark(container, ref, 2, true)
      expect(strokes(container).filter((s) => s === 'lightgray')).toHaveLength(1)

      // a different spec starts from its own (empty) store
      render(vlSpec({ width: 220 }))
      expect(new Set(strokes(container)).size).toBe(3)
      act(() => { root.unmount() })
    })

    variant.it(['signals'], 'a selection with an initial value starts selected, and a click on nothing clears it', () => {
      const ref = React.createRef<ChartHandle>()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => {
        root.render(<Chart ref={ref} spec={vlSpec({ params: [{ name: 'pick', select: { type: 'point', fields: ['c'] }, value: [{ c: 'y' }] }] })} />)
      })
      expect(strokes(container).filter((s) => s === 'lightgray')).toHaveLength(2)
      act(() => { root.unmount() })
    })
  })
})
