// @vitest-environment jsdom
/**
 * The chart's gestures and gesture props at their edges:
 * - keys and double-clicks inside a bound input are the input's, never a pan, zoom, reset or selection clear (C71);
 * - `select` is `selection`'s alias everywhere; a click that reports `onSelect(null)` clears the drawn interval; a controlled
 *   `brush={null}` draws nothing (C293);
 * - a controlled `view`, `brush` or interval that is not a pair of finite, different numbers is reported through `onError` and
 *   ignored, and the persisted rectangle is clipped to the plot (C243, C490);
 * - a chart that brushes takes touch drags (`touch-action: none`) (C491);
 * - an accessible node id with selector characters is found (C389);
 * - a handle kept past unmount neither notifies nor returns the old scene (C489).
 */
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChartHandle } from './chart-types'
import { forEachVariant } from './testing/variants'

const W = 200
const H = 100
const scatter = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  width: W, height: H, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [{ a: 1, b: 1 }, { a: 5, b: 3 }, { a: 10, b: 9 }] }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 10], range: 'width', zero: false, nice: false },
    { name: 'y', type: 'linear', domain: [0, 10], range: 'height', zero: false, nice: false },
  ],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'a' }, y: { scale: 'y', field: 'b' } } } }],
  ...extra,
})
const withBinds = scatter({
  signals: [
    { name: 'r', value: 5, bind: { input: 'range', min: 0, max: 10, step: 1 } },
    { name: 'q', value: 'abc', bind: { input: 'text' } },
  ],
})

let roots: Array<{ root: Root; el: HTMLElement }> = []
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  for (const k of ['setPointerCapture', 'releasePointerCapture']) (Element.prototype as unknown as Record<string, unknown>)[k] = vi.fn()
})
afterEach(() => {
  act(() => { for (const r of roots) r.root.unmount() })
  for (const r of roots) r.el.remove()
  roots = []
})
function mount(): { el: HTMLElement; root: Root; render: (node: React.ReactNode) => void; chart: () => HTMLElement } {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  roots.push({ root, el })
  const chart = (): HTMLElement => {
    const c = el.firstElementChild as HTMLElement
    for (const e of [c, c.querySelector('svg')]) {
      if (e) e.getBoundingClientRect = () => ({ left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0, toJSON() {} }) as DOMRect
    }
    return c
  }
  return { el, root, render: (node) => act(() => { root.render(node) }), chart }
}
const fire = (target: Element, ev: Event): Event => { act(() => { target.dispatchEvent(ev) }); return ev }
const key = (k: string): KeyboardEvent => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
const pointer = (type: string, x: number, y: number, buttons: number): PointerEvent =>
  new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons, pointerId: 1, pointerType: 'mouse' })
const rects = (c: Element): string[] =>
  [...c.querySelectorAll<HTMLElement>('[data-testid="chart-brush-overlay"] > div')].map((d) => `${d.style.left},${d.style.top},${d.style.width},${d.style.height}`)

forEachVariant(['svg'], (Chart, variant) => {
  describe('gestures and gesture props at their edges', () => {
    it('keys and double-clicks inside bound inputs are the inputs\' (C71)', () => {
      const m = mount()
      const views: unknown[] = []
      const selects: unknown[] = []
      m.render(<Chart spec={withBinds as never} panZoom onViewChange={(v) => views.push(v)} onSelect={(v) => selects.push(v)} view={{ x: [2, 4] }} />)
      const c = m.chart()
      const range = c.querySelector<HTMLInputElement>('[data-signal="r"] input')!
      const text = c.querySelector<HTMLInputElement>('[data-signal="q"] input')!
      for (const [input, keys] of [[range, ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'Home', 'End', '0']], [text, ['-', '+', '=', '0', 'Home', 'Escape', 'ArrowLeft']]] as const) {
        for (const k of keys) {
          const ev = fire(input, key(k))
          expect(ev.defaultPrevented, `${k} on ${input.type}`).toBe(false)
        }
      }
      fire(text, new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      expect(views).toEqual([])
      expect(selects).toEqual([])
      // the same keys on the chart itself are the chart's
      const ev = fire(c, key('ArrowRight'))
      expect(ev.defaultPrevented).toBe(true)
      expect(views).toHaveLength(1)
      fire(c, new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      expect(views.at(-1)).toBeNull()
    })

    variant.it(['interaction'], '`select` is the selection alias for the drawn interval too (C293 a)', () => {
      for (const prop of ['selection', 'select'] as const) {
        const m = mount()
        m.render(<Chart spec={scatter() as never} {...{ [prop]: { type: 'interval', interval: { x: [2, 4] } } }} />)
        expect(rects(m.chart()), prop).toEqual(['40px,0px,40px,100px'])
      }
    })

    it('a click that reports onSelect(null) clears the drawn interval; brush={null} draws none (C293 b, c)', () => {
      const m = mount()
      const calls: unknown[] = []
      m.render(<Chart spec={scatter() as never} onSelect={(v) => calls.push(v)} />)
      let c = m.chart()
      fire(c, pointer('pointerdown', 20, 20, 1))
      fire(c, pointer('pointermove', 80, 60, 1))
      fire(c, pointer('pointerup', 80, 60, 0))
      expect(calls.at(-1)).toEqual({ x: [1, 4], y: [4, 8] })
      expect(rects(c)).toHaveLength(1)
      fire(c, pointer('pointerdown', 150, 50, 1))
      fire(c, pointer('pointerup', 150, 50, 0))
      expect(calls.at(-1)).toBeNull()
      expect(rects(c)).toEqual([])
      // a controlled brush of null wins over the interval of the last drag
      m.render(<Chart spec={scatter() as never} onSelect={(v) => calls.push(v)} brush={null} />)
      c = m.chart()
      fire(c, pointer('pointerdown', 20, 20, 1))
      fire(c, pointer('pointermove', 80, 60, 1))
      fire(c, pointer('pointerup', 80, 60, 0))
      expect(rects(c)).toEqual([])
    })

    it('a brush-only chart takes touch drags (C491)', () => {
      const m = mount()
      m.render(<Chart spec={scatter() as never} onSelect={() => {}} />)
      expect(m.chart().style.touchAction).toBe('none')
      const plain = mount()
      plain.render(<Chart spec={scatter() as never} />)
      expect(plain.chart().style.touchAction).toBe('')
    })

    it('a controlled view or interval that is not two finite, different numbers is reported and ignored (C243, C490)', () => {
      const BAD: unknown[] = [[5, 5], [NaN, 3], ['a', 'b'], [1], [1, 2, 3], [Infinity, 2], null as unknown]
      const base = mount()
      base.render(<Chart spec={scatter() as never} />)
      const unzoomed = [...base.chart().querySelectorAll('.mark-symbol path')].map((p) => p.getAttribute('transform'))
      for (const bad of BAD) {
        if (bad === null) continue
        for (const prop of variant.has(['interaction']) ? ['view', 'brush', 'selection'] as const : ['view', 'brush'] as const) {
          const m = mount()
          const errors: string[] = []
          const value = prop === 'view' ? { x: bad } : prop === 'brush' ? { x: bad } : { type: 'interval', interval: { x: bad } }
          const at = (): React.ReactElement => <Chart spec={scatter() as never} {...{ [prop]: value }} onError={(e) => errors.push(e.message)} />
          m.render(at())
          m.render(at())
          const where = `${prop} x ${JSON.stringify(bad)}`
          expect(errors, where).toHaveLength(1)
          expect(errors[0], where).toMatch(new RegExp(`${prop === 'selection' ? 'selection' : prop}\\.x must be two finite, different numbers`))
          const c = m.chart()
          expect(rects(c).join(' '), where).not.toMatch(/NaN|^,/)
          if (prop === 'view') {
            expect(c.getAttribute('data-aster-view'), where).toBe('base')
            expect([...c.querySelectorAll('.mark-symbol path')].map((p) => p.getAttribute('transform')), where).toEqual(unzoomed)
          }
        }
      }
    })

    it('the persisted rectangle is clipped to the plot (C490)', () => {
      const m = mount()
      m.render(<Chart spec={scatter() as never} brush={{ x: [20, 40] }} />)
      expect(rects(m.chart())).toEqual([])
      m.render(<Chart spec={scatter() as never} brush={{ x: [5, 40], y: [-5, 5] }} />)
      expect(rects(m.chart())).toEqual(['100px,50px,100px,50px'])
    })

    variant.it(['interaction'], 'an accessible node id with selector characters is focusable by the arrow keys (C389)', () => {
      for (const name of ['color', 'col"or', 'a\\b', "it's]"]) {
        const m = mount()
        const spec = scatter({
          scales: [...(scatter().scales as unknown[]), { name, type: 'ordinal', domain: ['p', 'q'], range: ['red', 'blue'] }],
          legends: [{ fill: name }],
        })
        m.render(<Chart spec={spec as never} width={300} />)
        const entries = [...m.chart().querySelectorAll<HTMLElement>('[data-a11y-kind="legend-entry"]')]
        expect(entries, name).toHaveLength(2)
        act(() => entries[0]!.focus())
        expect(() => fire(entries[0]!, key('ArrowRight')), name).not.toThrow()
        expect(document.activeElement, name).toBe(entries[1])
      }
    })

    it('a handle kept past unmount neither notifies nor returns the old scene (C489)', () => {
      const m = mount()
      const ref = React.createRef<ChartHandle>()
      const seen: unknown[] = []
      m.render(<Chart ref={ref} spec={withBinds as never} onSignal={(n, v) => seen.push([n, v])} />)
      const handle = ref.current!
      expect(handle.getScene()).not.toBeNull()
      act(() => m.root.unmount())
      roots = roots.filter((r) => r.root !== m.root)
      handle.setSignal('r', 2)
      expect(seen).toEqual([])
      expect(handle.getScene()).toBeNull()
      expect(handle.getSvg()).toBeNull()
      expect(handle.getChartInfo()).toBeNull()
    })
  })
})
