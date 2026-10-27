// @vitest-environment jsdom
/**
 * The cursor the chart container shows (vega-view cursor.js): an item's `cursor` channel while the pointer is over it, the
 * spec's `cursor` signal over it unless that is 'default', 'default' otherwise. The cursor is React state rendered through the
 * container's `style`, set only when it changes. (The differential against a real vega view is
 * `packages/conformance/src/item-cursor-vs-vega.test.ts`; these tests pin the React side: renders, re-renders, the variants.)
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { compileChart, evaluateChart } from '@aster/core'
import { buildHitIndex } from '@aster/core/hit'
import { forEachVariant } from './testing/variants'

const spec = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 200, height: 120, padding: 8,
  data: [{ name: 'd', values: [{ k: 'a' }, { k: 'b' }] }],
  scales: [{ name: 'c', type: 'ordinal', domain: ['a', 'b'], range: 'category' }],
  legends: [{ fill: 'c', encode: { symbols: { interactive: true, update: { cursor: { value: 'alias' } } }, labels: { interactive: true, update: { cursor: { value: 'help' } } } } }],
  marks: [{ type: 'rect', from: { data: 'd' }, encode: { update: { x: { signal: 'datum.k == "a" ? 10 : 70' }, y: { value: 10 }, width: { value: 40 }, height: { value: 40 }, fill: { value: '#4c78a8' }, cursor: { value: 'pointer' } } } }],
  ...extra,
})

/** Points of the chart: over the first rect, over the second, over a legend label, over nothing. */
function points(s: Record<string, unknown>): { rect: [number, number]; rect2: [number, number]; label: [number, number]; none: [number, number] } {
  const scene = evaluateChart(compileChart(structuredClone(s) as never))
  const index = buildHitIndex(scene)
  let label: [number, number] | null = null
  for (let y = 0; y < scene.height && !label; y += 2) {
    for (let x = scene.width - 1; x > 0 && !label; x -= 2) {
      const hit = index.query(x, y)
      if (hit?.marktype === 'text') label = [x, y]
    }
  }
  return { rect: [30 + 8, 30 + 8], rect2: [90 + 8, 30 + 8], label: label!, none: [3, 110] }
}

forEachVariant(['svg'], (Chart, variant) => {
  const mounted: Array<() => void> = []
  afterEach(() => { while (mounted.length) mounted.pop()!(); document.body.innerHTML = '' })

  function mount(props: Record<string, unknown>): { container: HTMLElement; rerender(p: Record<string, unknown>): void; move(p: [number, number]): void; renders(): number } {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let renders = 0
    let current = props
    const render = (): void => { act(() => { root.render(<React.Profiler id="c" onRender={() => { renders++ }}>{React.createElement(Chart as never, current)}</React.Profiler>) }) }
    render()
    mounted.push(() => act(() => root.unmount()))
    const container = host.firstElementChild as HTMLElement
    container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 216, bottom: 136, width: 216, height: 136 } as DOMRect)
    return {
      container,
      rerender(p) { current = { ...current, ...p }; render() },
      move([x, y]) { act(() => { container.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y })) }) },
      renders: () => renders,
    }
  }

  describe('the container cursor', () => {
    it('is the default before the pointer has moved (vega writes it at start)', () => {
      expect(mount({ spec: spec() }).container.style.cursor).toBe('default')
    })

    variant.it(['interaction'], 'is the cursor of the item under the pointer, and resets off the items', () => {
      const s = spec()
      const p = points(s)
      const m = mount({ spec: s })
      m.move(p.rect)
      expect(m.container.style.cursor).toBe('pointer')
      m.move(p.none)
      expect(m.container.style.cursor).toBe('default')
      m.move(p.label)
      expect(m.container.style.cursor).toBe('help')
      m.move(p.rect2)
      expect(m.container.style.cursor).toBe('pointer')
    })

    variant.it(['interaction'], 'is kept by a re-render, and moves over the same item cost no render', () => {
      const s = spec()
      const p = points(s)
      const m = mount({ spec: s })
      m.move(p.rect)
      expect(m.container.style.cursor).toBe('pointer')
      m.rerender({ className: 'x' })
      m.rerender({ style: { background: 'white' } })
      expect(m.container.style.cursor).toBe('pointer')
      const before = m.renders()
      for (let i = 0; i < 25; i++) m.move(p.rect)
      m.move(p.rect2)
      expect(m.renders() - before, 'renders for moves between items with the same cursor').toBe(0)
      m.move(p.none)
      expect(m.renders() - before, 'one render for the move off the items').toBe(1)
      for (let i = 0; i < 25; i++) m.move(p.none)
      expect(m.renders() - before).toBe(1)
    })

    it('is the spec cursor signal while it is not default, over an item or not (every variant: no hit testing needed)', () => {
      const s = spec({ signals: [{ name: 'cursor', value: 'wait' }] })
      const m = mount({ spec: s })
      expect(m.container.style.cursor).toBe('wait')
      const p = points(s)
      m.move(p.rect)
      expect(m.container.style.cursor).toBe('wait')
      m.move(p.none)
      expect(m.container.style.cursor).toBe('wait')
    })

    it('follows a host-set cursor signal, and the item wins again when it goes back to default', () => {
      const s = spec()
      const p = points(s)
      const m = mount({ spec: s })
      m.rerender({ signals: { cursor: 'move' } })
      expect(m.container.style.cursor).toBe('move')
      m.rerender({ signals: { cursor: 'default' } })
      expect(m.container.style.cursor).toBe('default')
      if (variant.has(['interaction'])) {
        m.move(p.rect)
        expect(m.container.style.cursor).toBe('pointer')
        m.rerender({ signals: { cursor: 'crosshair' } })
        expect(m.container.style.cursor).toBe('crosshair')
        m.rerender({ signals: { cursor: 'default' } })
        expect(m.container.style.cursor).toBe('pointer')
      }
    })

    it('leaves a host style.cursor alone where the chart says default, and shows an item cursor over it', () => {
      const s = spec()
      const p = points(s)
      const m = mount({ spec: s, style: { cursor: 'crosshair' } })
      expect(m.container.style.cursor).toBe('crosshair')
      if (variant.has(['interaction'])) {
        m.move(p.rect)
        expect(m.container.style.cursor).toBe('pointer')
        m.move(p.none)
        expect(m.container.style.cursor).toBe('crosshair')
      }
    })

    variant.it(['interaction'], 'measures the container once, not per move, and again after a scroll, a resize, a pointer entering or a commit', () => {
      const s = spec()
      const p = points(s)
      const m = mount({ spec: s })
      let reads = 0
      let left = 0
      m.container.getBoundingClientRect = () => { reads++; return { left, top: 0, right: left + 216, bottom: 136, width: 216, height: 136 } as DOMRect }
      m.move(p.rect)
      expect(reads, 'the first move').toBe(1)
      // (the cursor changed: that commit forgets the measure once)
      m.move(p.rect)
      reads = 0
      for (let i = 0; i < 30; i++) m.move(p.rect)
      expect(reads, 'reads for 30 more moves').toBe(0)
      expect(m.container.style.cursor).toBe('pointer')
      // the page scrolls / an ancestor is moved: the same client point is now off the item
      left = 100
      act(() => { window.dispatchEvent(new Event('scroll')) })
      m.move(p.rect)
      expect(m.container.style.cursor, 'after a scroll').toBe('default')
      left = 0
      act(() => { window.dispatchEvent(new Event('resize')) })
      m.move(p.rect)
      expect(m.container.style.cursor, 'after a resize').toBe('pointer')
      left = 100
      act(() => { m.container.dispatchEvent(new Event('pointerenter')) })
      m.move(p.rect)
      expect(m.container.style.cursor, 'after the pointer entered (a transformed ancestor)').toBe('default')
      left = 0
      m.rerender({ className: 'y' })
      m.move(p.rect)
      expect(m.container.style.cursor, 'after a commit').toBe('pointer')
    })

    it('listens to the pointer only when an item has a cursor or a cursor signal exists', () => {
      const added: string[] = []
      const orig = HTMLElement.prototype.addEventListener
      HTMLElement.prototype.addEventListener = function (this: HTMLElement, type: string, ...rest: never[]) { if (type === 'pointermove' && this.hasAttribute('data-aster-view')) added.push(type); return (orig as (...a: unknown[]) => void).call(this, type, ...rest) } as never
      try {
        const plain = spec({ legends: [], marks: [{ type: 'rect', encode: { update: { x: { value: 10 }, y: { value: 10 }, width: { value: 40 }, height: { value: 40 }, fill: { value: '#4c78a8' } } } }] })
        mount({ spec: plain })
        expect(added, 'a chart with nothing to show').toEqual([])
        const withSignal = mount({ spec: { ...plain, signals: [{ name: 'cursor', value: 'wait' }] } })
        expect(withSignal.container.style.cursor).toBe('wait')
        if (variant.has(['interaction'])) {
          expect(added.length, 'a cursor signal').toBe(1)
          mount({ spec: spec() })
          expect(added.length, 'item cursors').toBe(2)
        }
      } finally { HTMLElement.prototype.addEventListener = orig }
    })

    it('stays the default under a pointer that moves over a chart whose items have no cursor', () => {
      const s = spec({ legends: [], marks: [{ type: 'rect', encode: { update: { x: { value: 10 }, y: { value: 10 }, width: { value: 40 }, height: { value: 40 }, fill: { value: '#4c78a8' } } } }] })
      const m = mount({ spec: s })
      m.move([30, 30])
      expect(m.container.style.cursor).toBe('default')
    })
  })
})
