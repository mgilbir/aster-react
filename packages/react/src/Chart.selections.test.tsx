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

    // A selection in a composition: the unit's signals are its group's (a vega group scope); the store is shared by the views.
    variant.it(['signals'], 'in a concat view a click in one view recolours another that reads the selection, and the scope\'s state is kept', () => {
      const listener = vi.fn()
      const ref = React.createRef<ChartHandle>()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      const unit = (extra: Record<string, unknown>): Record<string, unknown> => ({
        width: 120, height: 80, mark: { type: 'point', size: 200 },
        encoding: { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' }, color: { condition: { param: 'pick', field: 'c', type: 'nominal' }, value: 'lightgray' } },
        ...extra,
      })
      const spec = {
        $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
        data: { values: [{ a: 1, b: 3, c: 'x' }, { a: 2, b: 5, c: 'y' }, { a: 3, b: 2, c: 'z' }] },
        padding: 10, autosize: 'none',
        hconcat: [unit({ params: [{ name: 'pick', select: 'point' }] }), unit({})],
      } as never
      act(() => { root.render(<Chart ref={ref} spec={spec} signalListeners={{ pick: listener }} />) })
      const scene = ref.current!.getScene()!
      const views = scene.items.filter((g) => g.role === 'scope')
      expect(views).toHaveLength(2)
      const marksOf = (view: number): string[] => Array.from(container.querySelectorAll('g.role-scope')[view]!.querySelectorAll('g.role-mark path')).map((p) => p.getAttribute('stroke') ?? '')
      expect(new Set(marksOf(1)).size).toBe(3)
      // the unit's signals belong to its group: a scope, in the scene, with the store key the loop writes
      const scope = views[0]!.scopeSignals!
      expect(scope.defs.some((d) => d.name === 'pick_tuple')).toBe(true)
      expect(views[1]!.scopeSignals).toBeUndefined()

      // a click on the 2nd mark of the first view
      const mark = (views[0]!.items!.find((c) => (c as { marktype?: string }).marktype === 'symbol') as unknown as { items: Array<{ x: number; y: number }> }).items[1]!
      const pad = scene.padding!
      const path = container.querySelectorAll('g.role-scope')[0]!.querySelectorAll('g.role-mark path')[1]!
      act(() => { path.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: pad.left + views[0]!.x! + mark.x, clientY: pad.top + views[0]!.y! + mark.y })) })
      expect(listener).toHaveBeenCalled()
      // the other view shows the selection: its marks (not selected there, since the selection is of the one datum) are grey but the one
      expect(marksOf(1).filter((c) => c === 'lightgray')).toHaveLength(2)
      expect(marksOf(0).filter((c) => c === 'lightgray')).toHaveLength(2)
      // a re-render with an equal spec keeps it: the scope's state and the store are inputs the chart holds
      act(() => { root.render(<Chart ref={ref} spec={JSON.parse(JSON.stringify(spec)) as never} signalListeners={{ pick: listener }} />) })
      expect(marksOf(1).filter((c) => c === 'lightgray')).toHaveLength(2)
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
