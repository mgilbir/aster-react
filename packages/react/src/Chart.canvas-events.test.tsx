// @vitest-environment jsdom
/**
 * The spec's event loop on `<Chart renderer="canvas">`: `signal.on` streams, `event.item`, `setSignal` with its dependent
 * updates, and the way vega's canvas renderer hands events over (the hovered item, the out / over of an item change, a click
 * only on the item pressed), across the re-renders the chart makes after each signal change.
 *
 * jsdom has no layout: a canvas's client point is its own pixel (the bounding box is at 0, 0), so the events are sent at scene
 * coordinates. Real vega in Chromium is the oracle of the browser gates (`pnpm conformance:signals`, `conformance:selections`,
 * the react gate); this pins the React wiring and the state that has to survive a re-render.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import type { ChartHandle } from './Chart'
import { forEachVariant } from './testing/variants'

const ROWS = [{ k: 'a', x: 0 }, { k: 'b', x: 50 }, { k: 'c', x: 100 }]
/** Three 40 x 40 bars at x = 0, 50, 100 (padding 0): their centres are (20, 20), (70, 20), (120, 20). */
const bars = (signals: unknown[], fill: unknown = { value: 'steelblue' }, extra: Record<string, unknown> = {}): never => ({
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 160, height: 60, padding: 0, autosize: 'none',
  data: [{ name: 't', values: ROWS }],
  signals,
  marks: [{ type: 'rect', name: 'bars', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { value: 0 }, width: { value: 40 }, height: { value: 40 }, fill } } }],
  ...extra,
}) as never

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = (x: number, y: number): MouseEventInit => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })

forEachVariant(['canvas', 'signals'], (Chart) => {
  describe('the event loop on the canvas renderer', () => {
    let root: ReturnType<typeof createRoot> | null = null
    afterEach(() => {
      if (root) act(() => root!.unmount())
      root = null
      document.body.innerHTML = ''
    })
    const mount = (spec: never, props: Record<string, unknown> = {}): { canvas: HTMLCanvasElement; ref: React.RefObject<ChartHandle | null> } => {
      const ref = React.createRef<ChartHandle>()
      const container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      act(() => { root!.render(<Chart ref={ref} spec={spec} width={160} height={60} renderer="canvas" {...props} />) })
      const canvas = container.querySelector('canvas')
      expect(canvas).not.toBeNull()
      return { canvas: canvas!, ref }
    }
    const send = (el: Element, type: string, x: number, y: number): void => {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent
      act(() => { el.dispatchEvent(new Ctor(type, at(x, y))) })
    }
    /** A mouse move as the browser sends it: a pointermove, then a mousemove. */
    const moveTo = (el: Element, x: number, y: number): void => { send(el, 'pointermove', x, y); send(el, 'mousemove', x, y) }
    /** A click as the browser sends it, at the point the pointer already is. */
    const clickAt = (el: Element, x: number, y: number): void => {
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) send(el, t, x, y)
    }

    it('runs signal.on streams with the item the pointer is over, and re-renders', () => {
      const { canvas, ref } = mount(bars([
        { name: 'picked', value: 'none', on: [{ events: '@bars:click', update: 'datum.k' }] },
        { name: 'clicks', value: 0, on: [{ events: 'click', update: 'clicks + 1' }] },
      ], { signal: 'picked === datum.k ? "red" : "steelblue"' }))
      moveTo(canvas, 70, 20)
      clickAt(canvas, 70, 20)
      expect(ref.current!.getSignals().picked).toBe('b')
      expect(ref.current!.getSignals().clicks).toBe(1)
      const items = (ref.current!.getScene()!.items[0] as unknown as { items: Array<{ fill: string }> }).items
      expect(items.map((i) => i.fill)).toEqual(['steelblue', 'red', 'steelblue'])
    })

    it('setSignal runs the dependent updates, as an event would', () => {
      const { ref } = mount(bars([
        { name: 'n', value: 1 },
        { name: 'twice', update: 'n * 2' },
        { name: 'echo', value: -1, on: [{ events: { signal: 'n' }, update: 'n + 100' }] },
      ]), { signalListeners: {} })
      act(() => { ref.current!.setSignal('n', 5) })
      expect(ref.current!.getSignals().n).toBe(5)
      expect((ref.current!.getScene() as unknown as { signalParams: Record<string, unknown> }).signalParams.twice).toBe(10)
      expect(ref.current!.getSignals().echo).toBe(105)
    })

    it('every pointermove is a mousemove too; an item change is the out of one item and the over of the next', () => {
      const { canvas, ref } = mount(bars([
        { name: 'moves', value: 0, on: [{ events: 'mousemove', update: 'moves + 1' }] },
        { name: 'overs', value: '', on: [{ events: 'mouseover', update: 'overs + (item().mark ? datum.k : "-")' }] },
        { name: 'outs', value: '', on: [{ events: 'mouseout', update: 'outs + (item().mark ? datum.k : "-")' }] },
      ]))
      send(canvas, 'pointermove', 20, 20)
      send(canvas, 'pointermove', 25, 25)
      send(canvas, 'pointermove', 70, 20)
      send(canvas, 'pointermove', 70, 50)
      expect(ref.current!.getSignals().moves).toBe(4)
      expect(ref.current!.getSignals().overs).toBe('ab-')
      expect(ref.current!.getSignals().outs).toBe('-ab')
    })

    it('the hovered item stays hovered through the re-render its own signal change makes', () => {
      // the fill reads `hover`, so every change re-evaluates the marks: their items are new objects, the same items
      const { canvas, ref } = mount(bars([
        { name: 'hover', value: 'none', on: [{ events: '@bars:mouseover', update: 'datum.k' }, { events: '@bars:mouseout', update: '"none"' }] },
        { name: 'overs', value: 0, on: [{ events: 'mouseover', update: 'overs + 1' }] },
        { name: 'outs', value: 0, on: [{ events: 'mouseout', update: 'outs + 1' }] },
      ], { signal: 'hover === datum.k ? "red" : "steelblue"' }))
      const before = ref.current!.getScene()
      send(canvas, 'pointermove', 20, 20)
      expect(ref.current!.getSignals().hover).toBe('a')
      expect(ref.current!.getScene()).not.toBe(before)
      send(canvas, 'pointermove', 22, 22)
      send(canvas, 'pointermove', 24, 24)
      expect(ref.current!.getSignals().overs).toBe(1)
      expect(ref.current!.getSignals().outs).toBe(1)
      send(canvas, 'pointermove', 70, 20)
      expect(ref.current!.getSignals().hover).toBe('b')
      expect(ref.current!.getSignals().overs).toBe(2)
      expect(ref.current!.getSignals().outs).toBe(2)
    })

    it('a click counts only on the item the button went down on, across the re-render the press makes', () => {
      const { canvas, ref } = mount(bars([
        { name: 'downs', value: 0, on: [{ events: 'mousedown', update: 'downs + 1' }] },
        { name: 'clicks', value: '', on: [{ events: 'click', update: 'clicks + datum.k' }] },
      ], { signal: 'downs % 2 ? "red" : "steelblue"' }))
      moveTo(canvas, 20, 20)
      send(canvas, 'pointerdown', 20, 20)
      send(canvas, 'mousedown', 20, 20)
      moveTo(canvas, 22, 22)
      send(canvas, 'pointerup', 22, 22)
      send(canvas, 'mouseup', 22, 22)
      send(canvas, 'click', 22, 22)
      expect(ref.current!.getSignals().clicks).toBe('a')
      // pressed on a, released on b: no click
      send(canvas, 'pointerdown', 22, 22)
      send(canvas, 'mousedown', 22, 22)
      moveTo(canvas, 70, 20)
      send(canvas, 'pointerup', 70, 20)
      send(canvas, 'mouseup', 70, 20)
      send(canvas, 'click', 70, 20)
      expect(ref.current!.getSignals().downs).toBe(2)
      expect(ref.current!.getSignals().clicks).toBe('a')
    })

    it('an item that leaves the scene is not left by a pointerout', () => {
      // a click hides the bar it is on; the pointer then moves off where it was
      const { canvas, ref } = mount(bars([
        { name: 'hide', value: 'none', on: [{ events: '@bars:click', update: 'datum.k' }] },
        { name: 'outs', value: '', on: [{ events: 'mouseout', update: 'outs + (item().mark ? datum.k : "-")' }] },
      ], { value: 'steelblue' }, {
        data: [{ name: 't', values: ROWS, transform: [{ type: 'filter', expr: 'datum.k !== hide' }] }],
      }))
      moveTo(canvas, 70, 20)
      clickAt(canvas, 70, 20)
      expect(ref.current!.getSignals().hide).toBe('b')
      moveTo(canvas, 70, 50)
      expect(ref.current!.getSignals().outs).toBe('-')
    })

    it('stops listening to the canvas when the chart unmounts', () => {
      const { canvas, ref } = mount(bars([{ name: 'moves', value: 0, on: [{ events: 'mousemove', update: 'moves + 1' }] }]))
      send(canvas, 'pointermove', 20, 20)
      const handle = ref.current!
      expect(handle.getSignals().moves).toBe(1)
      act(() => root!.unmount())
      root = null
      send(canvas, 'pointermove', 22, 20)
      expect(handle.getSignals().moves).toBe(1)
    })
  })
})
