// @vitest-environment jsdom
import * as React from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Count hit-index builds without changing behaviour.
const hit = vi.hoisted(() => ({ builds: 0 }))
vi.mock('@aster/core/hit', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@aster/core/hit')>()
  return { ...mod, buildHitIndex: (...args: Parameters<typeof mod.buildHitIndex>) => { hit.builds++; return mod.buildHitIndex(...args) } }
})

import type { ChartHandle } from './Chart'
import { ChartStream, type ChartStreamHandle } from './ChartStream'
import { forEachVariant } from './testing/variants'

const RECT = { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) } as DOMRect

function barSpec(rows: Array<{ cat: string; v: number }>, extra: Record<string, unknown> = {}) {
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 100, height: 100, padding: 0, autosize: 'none',
    data: [{ name: 'table', values: rows }],
    scales: [
      { name: 'x', type: 'band', domain: { data: 'table', field: 'cat' }, range: [0, 100] },
      { name: 'y', type: 'linear', domain: [0, 10], range: [100, 0] },
    ],
    marks: [{
      type: 'rect', from: { data: 'table' },
      encode: { enter: {
        x: { scale: 'x', field: 'cat' }, width: { scale: 'x', band: 1 },
        y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 }, fill: { value: '#4c78a8' },
      } },
    }],
    ...extra,
  } as never
}

const dots = (n: number) => Array.from({ length: n }, (_, i) => ({ x: 10 + (i % 20) * 15, y: 10 + Math.floor(i / 20) * 8, k: `p${i}` }))
function dotSpec(rows: Array<{ x: number; y: number; k: string }>) {
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 400, height: 300, padding: 0, autosize: 'none',
    data: [{ name: 't', values: rows }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 400], range: [0, 400] },
      { name: 'y', type: 'linear', domain: [0, 300], range: [0, 300] },
    ],
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 30 } } } }],
  } as never
}

function mount(node: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(node) })
  const host = container.firstElementChild as HTMLElement
  host.getBoundingClientRect = () => RECT
  return { container, root, host, rerender: (n: React.ReactElement) => act(() => { root.render(n) }) }
}

beforeEach(() => {
  ;(Element.prototype as unknown as Record<string, unknown>).setPointerCapture = vi.fn()
  ;(Element.prototype as unknown as Record<string, unknown>).releasePointerCapture = vi.fn()
})
afterEach(() => { document.body.innerHTML = '' })

describe('renderer round trip (C29)', () => {
  const rows = [{ cat: 'a', v: 5 }, { cat: 'b', v: 7 }]
  forEachVariant(['svg', 'canvas'], (Chart) => {
    it('svg -> canvas -> svg refills the SVG host', () => {
      const spec = barSpec(rows)
      const { container, rerender } = mount(<Chart spec={spec} width={100} height={100} renderer="svg" />)
      expect(container.querySelectorAll('svg').length).toBe(1)
      rerender(<Chart spec={spec} width={100} height={100} renderer="canvas" />)
      expect(container.querySelectorAll('svg').length).toBe(0)
      expect(container.querySelector('canvas')).not.toBeNull()
      rerender(<Chart spec={spec} width={100} height={100} renderer="svg" />)
      expect(container.querySelectorAll('svg').length).toBe(1)
      expect(container.querySelectorAll('svg .mark-rect path').length).toBe(2)
    })
  })

  forEachVariant(['svg', 'canvas'], (Chart) => {
    it('canvas -> svg -> canvas repaints the new canvas element', () => {
      const paints: number[] = []
      const ctx = new Proxy({}, { get: (_t, p) => (p === 'canvas' ? {} : () => { if (p === 'fill' || p === 'stroke') paints.push(1) }), set: () => true })
      const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
      vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 1 })
      vi.stubGlobal('cancelAnimationFrame', () => {})
      try {
        // 300x150 is a fresh <canvas>'s default size, so only the element swap (not a resize) can trigger a repaint.
        const spec = barSpec(rows, { width: 300, height: 150 })
        const { rerender } = mount(<Chart spec={spec} width={300} height={150} renderer="canvas" />)
        const first = paints.length
        expect(first).toBeGreaterThan(0)
        rerender(<Chart spec={spec} width={300} height={150} renderer="svg" />)
        const mid = paints.length
        rerender(<Chart spec={spec} width={300} height={150} renderer="canvas" />)
        expect(paints.length).toBeGreaterThan(mid) // the fresh <canvas> was painted again
      } finally {
        spy.mockRestore()
        vi.unstubAllGlobals()
      }
    })
  })
})

describe('tooltips read the current scene (C33)', () => {
  forEachVariant(['svg', 'canvas', 'interaction'], (Chart) => {
    it('canvas tooltip follows a data change', () => {
      const { host, rerender } = mount(<Chart spec={barSpec([{ cat: 'a', v: 5 }, { cat: 'b', v: 7 }])} width={100} height={100} renderer="canvas" tooltip />)
      const hover = (): string | undefined => {
        act(() => { host.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 80, bubbles: true })) })
        return host.querySelector('[data-testid="chart-tooltip"]')?.textContent ?? undefined
      }
      expect(hover()).toContain('a')
      rerender(<Chart spec={barSpec([{ cat: 'zzz', v: 5 }, { cat: 'b', v: 7 }])} width={100} height={100} renderer="canvas" tooltip />)
      expect(hover()).toContain('zzz')
    })
  })

  forEachVariant(['svg', 'interaction'], (Chart) => {
    it('SVG tooltip keeps working when a growing scene crosses the dense-marks threshold', () => {
      const { host, rerender } = mount(<Chart spec={dotSpec(dots(3))} width={400} height={300} tooltip a11y={false} />)
      const hoverFirst = (): string | undefined => {
        // Per-item DOM: the pointer is over the mark element. Batched DOM: it is over the svg.
        const target = host.querySelector('svg g.mark-symbol path') ?? host
        act(() => { target.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10, bubbles: true })) })
        return host.querySelector('[data-testid="chart-tooltip"]')?.textContent ?? undefined
      }
      expect(hoverFirst()).toContain('p0')
      rerender(<Chart spec={dotSpec(dots(700))} width={400} height={300} tooltip a11y={false} />)
      // 700 symbols are batched into chunked paths.
      expect(host.querySelectorAll('svg g.mark-symbol > path').length).toBeLessThan(20)
      expect(hoverFirst()).toContain('p0')
    })
  })
})

describe('hygiene (C92)', () => {
  forEachVariant(['svg'], (Chart) => {
    it('does not refire onError on re-renders while the same error persists', () => {
      const calls: Error[] = []
      const spec = barSpec([{ cat: 'a', v: 5 }])
      const render = (i: number): React.ReactElement => (
        <Chart spec={spec} width={100} height={100} limits={{ maxItems: 0 }} onError={(e) => { calls.push(e) }} ariaLabel={`render ${i}`} />
      )
      const { rerender, container } = mount(render(0))
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      expect(calls).toHaveLength(1)
      rerender(render(1))
      rerender(render(2))
      rerender(render(3))
      expect(calls).toHaveLength(1)
      // A genuinely new failure is reported again.
      rerender(<Chart spec={barSpec([{ cat: 'a', v: 5 }, { cat: 'b', v: 6 }])} width={100} height={100} limits={{ maxItems: 0 }} onError={(e) => { calls.push(e) }} />)
      expect(calls).toHaveLength(2)
    })
  })

  forEachVariant(['svg', 'signals'], (Chart) => {
    it('binds the signal event loop once, not on every render', () => {
      const spec = {
        ...(barSpec([{ cat: 'a', v: 5 }]) as Record<string, unknown>),
        signals: [{ name: 'n', value: 1, on: [{ events: 'click', update: 'n + 1' }] }],
      } as never
      const add = vi.spyOn(SVGSVGElement.prototype, 'addEventListener')
      const { rerender } = mount(<Chart spec={spec} width={100} height={100} ariaLabel="x" />)
      const afterMount = add.mock.calls.filter((c) => c[0] === 'click').length
      expect(afterMount).toBeGreaterThan(0)
      for (let i = 0; i < 4; i++) rerender(<Chart spec={spec} width={100} height={100} ariaLabel={`r${i}`} signalListeners={{ n: () => {} }} />)
      // `signalListeners` appearing adds at most one rebind; unrelated renders add none.
      const afterRenders = add.mock.calls.filter((c) => c[0] === 'click').length
      expect(afterRenders - afterMount).toBeLessThanOrEqual(afterMount)
      const before = afterRenders
      for (let i = 0; i < 4; i++) rerender(<Chart spec={spec} width={100} height={100} ariaLabel={`s${i}`} signalListeners={{ n: () => {} }} />)
      expect(add.mock.calls.filter((c) => c[0] === 'click').length).toBe(before)
      add.mockRestore()
    })
  })

  forEachVariant(['svg', 'interaction'], (Chart) => {
    it('builds the hit index once per scene, not once per click', () => {
      const onPointSelect = vi.fn()
      const { container, rerender } = mount(<Chart spec={barSpec([{ cat: 'a', v: 5 }, { cat: 'b', v: 7 }])} width={100} height={100} onPointSelect={onPointSelect} />)
      const overlay = container.querySelector('[data-testid="chart-brush-overlay"]')!
      hit.builds = 0
      const click = (): void => {
        act(() => { overlay.dispatchEvent(new PointerEvent('pointerdown', { clientX: 20, clientY: 80, pointerId: 1, bubbles: true })) })
        act(() => { overlay.dispatchEvent(new PointerEvent('pointerup', { clientX: 20, clientY: 80, pointerId: 1, bubbles: true })) })
      }
      click()
      for (let i = 0; i < 3; i++) {
        rerender(<Chart spec={barSpec([{ cat: 'a', v: 5 }, { cat: 'b', v: 7 }])} width={100} height={100} onPointSelect={onPointSelect} ariaLabel={`r${i}`} />)
        click()
      }
      expect(onPointSelect).toHaveBeenCalledTimes(4)
      expect(onPointSelect.mock.calls[0]![0]).toMatchObject({ cat: 'a' })
      expect(hit.builds).toBe(1)
    })
  })

  it('<ChartStream> server-renders its first frame (ADR 0003) and hydrates in place', async () => {
    const rows = [{ x: 10, y: 10, k: 'p0' }, { x: 20, y: 20, k: 'p1' }]
    const spec = dotSpec(rows)
    const html = renderToString(<ChartStream spec={spec} width={400} height={300} a11y={false} />)
    expect(html).toContain('<svg')
    expect(html).toContain('mark-symbol')
    const container = document.createElement('div')
    container.innerHTML = html
    document.body.appendChild(container)
    const ref = React.createRef<ChartStreamHandle>()
    let root: ReturnType<typeof hydrateRoot> | null = null
    await act(async () => { root = hydrateRoot(container, <ChartStream ref={ref} spec={spec} width={400} height={300} a11y={false} />) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelectorAll('svg g.mark-symbol path').length).toBe(2)
    await act(async () => { ref.current!.push({ append: { t: [{ x: 30, y: 30, k: 'p2' }] } }); ref.current!.flush(); await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelectorAll('svg g.mark-symbol path').length).toBe(3)
    await act(async () => { root!.unmount() })
  })
})

describe('the DOM the patcher owns is never rebuilt by React (C28 follow-up)', () => {
  forEachVariant(['svg'], (Chart) => {
    it('keeps the same <svg> element across re-renders', () => {
      const spec = barSpec([{ cat: 'a', v: 5 }, { cat: 'b', v: 7 }])
      const { container, rerender } = mount(<Chart spec={spec} width={100} height={100} />)
      const first = container.querySelector('svg')!
      for (let i = 0; i < 3; i++) {
        rerender(<Chart spec={spec} width={100} height={100} ariaLabel={`r${i}`} />)
        expect(container.querySelector('svg')).toBe(first)
      }
      // a scene change patches the same element in place
      rerender(<Chart spec={barSpec([{ cat: 'a', v: 9 }, { cat: 'b', v: 7 }])} width={100} height={100} />)
      expect(container.querySelector('svg')).toBe(first)
    })
  })

  forEachVariant(['svg', 'signals'], (Chart) => {
    it('signal.on mark events see their datum on the first render, with no datum attribute in the markup', () => {
      const spec = {
        ...(barSpec([{ cat: 'a', v: 5 }]) as Record<string, unknown>),
        signals: [{ name: 'picked', value: null, on: [{ events: 'click', update: 'datum.cat' }] }],
      } as never
      const listener = vi.fn()
      const { container } = mount(<Chart spec={spec} width={100} height={100} signalListeners={{ picked: listener }} />)
      const bar = container.querySelector('svg .mark-rect path')!
      expect(bar.hasAttribute('data-datum')).toBe(false)
      act(() => { bar.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50, clientY: 75 })) })
      expect(listener).toHaveBeenCalledWith('picked', 'a')
    })
  })
})

describe('ChartHandle.setSignal is portable (C64)', () => {
  const sigSpec = {
    ...(barSpec([{ cat: 'a', v: 5 }]) as Record<string, unknown>),
    signals: [{ name: 'w', value: 20 }],
    marks: [{
      type: 'rect', from: { data: 'table' },
      encode: { update: { x: { value: 0 }, y: { value: 0 }, height: { value: 10 }, width: { signal: 'w' }, fill: { value: 'red' } } },
    }],
  } as never

  forEachVariant(['svg', 'canvas'], (Chart) => {
    it('on the canvas renderer the value is applied and listeners fire', () => {
      const ref = React.createRef<ChartHandle>()
      const listener = vi.fn()
      mount(<Chart ref={ref} spec={sigSpec} width={100} height={100} renderer="canvas" signalListeners={{ w: listener }} />)
      act(() => { ref.current!.setSignal('w', 60) })
      expect(ref.current!.getSignals().w).toBe(60)
      expect(listener).toHaveBeenCalledWith('w', 60)
      const scene = ref.current!.getScene()!
      const rect = ((scene.items[0] as { items: Array<{ width: number }> }).items[0])!
      expect(rect.width).toBe(60)
    })
  })

  forEachVariant(['svg'], (Chart) => {
    it('also works with interactive={false} on SVG', () => {
      const ref = React.createRef<ChartHandle>()
      mount(<Chart ref={ref} spec={sigSpec} width={100} height={100} interactive={false} />)
      act(() => { ref.current!.setSignal('w', 45) })
      const rect = ((ref.current!.getScene()!.items[0] as { items: Array<{ width: number }> }).items[0])!
      expect(rect.width).toBe(45)
    })
  })
})
