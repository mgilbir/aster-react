// @vitest-environment jsdom
/**
 * Where the built-in tooltip renders and where it is placed (issue #152), as vega-tooltip does it: in a `position: fixed` box
 * in the document's body (not inside the chart's element, so no ancestor that clips or scrolls can cut it off or grow its
 * scroll area), 10px right of and below the pointer's client point, flipped to the other side of the pointer where it would
 * leave the viewport (bottom-right, then bottom-left, top-right, top-left; top-left when none fits).
 *
 * jsdom has no layout: the tooltip's size and the viewport are stubbed. The real-browser half (clipping ancestors, scroll
 * sizes, the viewport edge, long values wrapping inside the box, a scrolled page) is in scripts/browser-interaction.mts.
 */
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { forEachVariant, type ChartComponent } from './testing/variants'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const spec = {
  width: 400, height: 300, padding: 0, autosize: 'none',
  data: [{ name: 'table', values: [{ x: 1, y: 2, label: 'a' }, { x: 7, y: 6, label: 'c' }] }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 10], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
  ],
  marks: [
    { type: 'symbol', from: { data: 'table' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 400 }, tooltip: { signal: 'datum.label' } } } },
  ],
}
// symbol `a` sits at (40, 240) in the chart's element, `c` at (280, 120)
const A = { x: 40, y: 240 }
const C = { x: 280, y: 120 }

const tips = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="chart-tooltip"]')]
/** The one tooltip on the page (null when none shows); two would be a leak. */
const tip = (): HTMLElement | null => {
  const all = tips()
  expect(all.length).toBeLessThanOrEqual(1)
  return all[0] ?? null
}

interface Mounted { host: HTMLElement; root: Root; rerender: (el: React.ReactElement) => void; unmount: () => void }
const mounted: Mounted[] = []
function mount(el: React.ReactElement, parent: HTMLElement = document.body): Mounted {
  const container = document.createElement('div')
  parent.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(el) })
  let live = true
  const m: Mounted = {
    // (the chart's element: a new one when the spec changes to another chart)
    get host() { return container.firstElementChild as HTMLElement },
    root,
    rerender: (next) => { act(() => { root.render(next) }) },
    unmount: () => { if (live) { live = false; act(() => { root.unmount() }) } container.remove() },
  }
  mounted.push(m)
  return m
}

/**
 * A pointer move at a client point. The chart's element is stubbed at the origin of the viewport, so a client point is the point in
 * the chart: the tests move the pointer by moving the element's stubbed rect instead (see `placeAt`).
 */
const move = (host: HTMLElement, x: number, y: number): void => {
  const target = host.querySelector('svg .mark-symbol path') ?? host
  act(() => { target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y })) })
}
const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
/** Puts the chart's element at (left, top) in the viewport: its marks then sit there plus their place in the chart. */
const placeAt = (host: HTMLElement, left: number, top: number): void => {
  host.getBoundingClientRect = () => rect(left, top, 400, 300)
  const svg = host.querySelector('svg')
  if (svg) (svg as unknown as HTMLElement).getBoundingClientRect = () => rect(left, top, 400, 300)
  // (the chart moved, as when the page scrolls: the chart measures where it is again)
  window.dispatchEvent(new Event('scroll'))
}

/**
 * The tooltip's box as a browser would measure it: `size`, at the left/top its style says, offset by `origin` (a containing block
 * that is not the viewport). Records the style the box had when it was measured.
 */
function stubTooltipBox(size: { width: number; height: number }, origin = { x: 0, y: 0 }): { measured: Array<{ left: string; top: string; visibility: string }> } {
  const measured: Array<{ left: string; top: string; visibility: string }> = []
  const real = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid !== 'chart-tooltip') return real.call(this)
    measured.push({ left: this.style.left, top: this.style.top, visibility: this.style.visibility })
    return rect((parseFloat(this.style.left) || 0) + origin.x, (parseFloat(this.style.top) || 0) + origin.y, size.width, size.height)
  })
  return { measured }
}

afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

forEachVariant(['svg', 'interaction'], (Chart: ChartComponent) => {
  describe('the tooltip renders in a fixed box in the body, at the pointer, as vega-tooltip does', () => {
    it('is portalled into the body, not inside the chart element, fixed at the client point plus 10px', () => {
      const scroller = document.createElement('div')
      scroller.style.cssText = 'max-height: 100px; overflow: auto'
      document.body.appendChild(scroller)
      const { host } = mount(<Chart spec={spec} width={400} height={300} tooltip />, scroller)
      placeAt(host, 100, 50)
      move(host, 100 + A.x, 50 + A.y)
      const box = tip()!
      expect(box.textContent).toBe('a')
      expect(box.parentElement).toBe(document.body)
      expect(host.contains(box)).toBe(false)
      expect(scroller.contains(box)).toBe(false)
      expect(box.style.position).toBe('fixed')
      expect(box.style.pointerEvents).toBe('none')
      expect(box.style.visibility).toBe('')
      expect([box.style.left, box.style.top]).toEqual([`${100 + A.x + 10}px`, `${50 + A.y + 10}px`])
      // it follows the pointer, in client coordinates
      move(host, 100 + C.x, 50 + C.y)
      expect(tip()!.textContent).toBe('c')
      expect([tip()!.style.left, tip()!.style.top]).toEqual([`${100 + C.x + 10}px`, `${50 + C.y + 10}px`])
    })

    it('is measured hidden at the origin of its containing block, then shown where it goes (before paint: one commit later)', () => {
      const { measured } = stubTooltipBox({ width: 120, height: 40 })
      const { host } = mount(<Chart spec={spec} width={400} height={300} tooltip />)
      placeAt(host, 0, 0)
      move(host, A.x, A.y)
      expect(measured).toEqual([{ left: '0px', top: '0px', visibility: 'hidden' }])
      expect(tip()!.style.visibility).toBe('')
      expect([tip()!.style.left, tip()!.style.top]).toEqual([`${A.x + 10}px`, `${A.y + 10}px`])
      // one measurement per move, none while it does not move
      move(host, C.x, C.y)
      expect(measured.length).toBe(2)
      move(host, C.x, C.y)
      expect(measured.length).toBe(2)
    })

    it('flips to the left of the pointer at the right edge of the viewport, above it at the bottom edge', () => {
      stubTooltipBox({ width: 200, height: 50 })
      const { host } = mount(<Chart spec={spec} width={400} height={300} tooltip />)
      const { innerWidth: vw, innerHeight: vh } = window
      // right edge: the pointer 100px from it, a 200px box does not fit to its right
      placeAt(host, vw - 100 - C.x, 100 - C.y)
      move(host, vw - 100, 100)
      expect([tip()!.style.left, tip()!.style.top]).toEqual([`${vw - 100 - 200 - 10}px`, `${100 + 10}px`])
      // bottom edge: above the pointer
      placeAt(host, 100 - C.x, vh - 40 - C.y)
      move(host, 100, vh - 40)
      expect([tip()!.style.left, tip()!.style.top]).toEqual([`${100 + 10}px`, `${vh - 40 - 50 - 10}px`])
      // the corner: above and to the left
      placeAt(host, vw - 100 - C.x, vh - 40 - C.y)
      move(host, vw - 100, vh - 40)
      expect([tip()!.style.left, tip()!.style.top]).toEqual([`${vw - 100 - 200 - 10}px`, `${vh - 40 - 50 - 10}px`])
      // exactly fitting to the right still opens to the right (the box may touch the edge)
      placeAt(host, vw - 210 - C.x, 100 - C.y)
      move(host, vw - 210, 100)
      expect(tip()!.style.left).toBe(`${vw - 200}px`)
    })

    it('a box that fits on neither side goes to the top-left of the pointer, as vega-tooltip does', () => {
      stubTooltipBox({ width: window.innerWidth + 50, height: 50 })
      const { host } = mount(<Chart spec={spec} width={400} height={300} tooltip />)
      placeAt(host, 300 - C.x, 300 - C.y)
      move(host, 300, 300)
      expect([tip()!.style.left, tip()!.style.top]).toEqual([`${300 - (window.innerWidth + 50) - 10}px`, `${300 - 50 - 10}px`])
    })

    it("the viewport is the document element's client box where it is smaller (a classic scrollbar is not room)", () => {
      stubTooltipBox({ width: 200, height: 50 })
      Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => window.innerWidth - 15 })
      Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: () => window.innerHeight - 15 })
      try {
        const { host } = mount(<Chart spec={spec} width={400} height={300} tooltip />)
        // fits beside the pointer in innerWidth x innerHeight, not in the client box
        const x = window.innerWidth - 215
        const y = window.innerHeight - 65
        placeAt(host, x - C.x, y - C.y)
        move(host, x, y)
        expect([tip()!.style.left, tip()!.style.top]).toEqual([`${x - 210}px`, `${y - 60}px`])
      } finally {
        delete (document.documentElement as { clientWidth?: number }).clientWidth
        delete (document.documentElement as { clientHeight?: number }).clientHeight
      }
    })

    it('a containing block that is not the viewport (a transformed ancestor) is measured and made up for', () => {
      stubTooltipBox({ width: 100, height: 30 }, { x: 37, y: -12 })
      const { host } = mount(<Chart spec={spec} width={400} height={300} tooltip tooltipContainer={null} />)
      placeAt(host, 0, 0)
      move(host, A.x, A.y)
      expect([tip()!.style.left, tip()!.style.top]).toEqual([`${A.x + 10 - 37}px`, `${A.y + 10 + 12}px`])
    })
  })

  describe('the tooltip comes and goes with the pointer and the chart', () => {
    it('is removed from the body on pointer leave, on an item without a tooltip, and on unmount', () => {
      const m = mount(<Chart spec={spec} width={400} height={300} tooltip />)
      placeAt(m.host, 0, 0)
      move(m.host, A.x, A.y)
      expect(tip()).not.toBeNull()
      act(() => { m.host.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
      expect(tip()).toBeNull()
      move(m.host, A.x, A.y)
      expect(tip()).not.toBeNull()
      move(m.host, 390, 10) // nothing there
      expect(tip()).toBeNull()
      move(m.host, A.x, A.y)
      expect(tip()).not.toBeNull()
      m.unmount()
      expect(tips()).toEqual([])
      expect(document.body.children.length).toBe(0)
    })

    it('is hidden when the spec changes under it, and when tooltips are turned off', () => {
      const m = mount(<Chart spec={spec} width={400} height={300} tooltip />)
      placeAt(m.host, 0, 0)
      move(m.host, A.x, A.y)
      expect(tip()!.textContent).toBe('a')
      // another chart (not only new rows for the same one): a new chart, with nothing hovered yet
      const other = { ...spec, scales: [spec.scales[0], { ...spec.scales[1], domain: [0, 20] }] }
      m.rerender(<Chart spec={other} width={400} height={300} tooltip />)
      expect(tip()).toBeNull()
      placeAt(m.host, 0, 0)
      move(m.host, A.x, A.y)
      expect(tip()).toBeNull() // `a` is at y = 270 on this chart
      m.rerender(<Chart spec={spec} width={400} height={300} tooltip />)
      placeAt(m.host, 0, 0)
      move(m.host, A.x, A.y)
      expect(tip()!.textContent).toBe('a')
      m.rerender(<Chart spec={spec} width={400} height={300} />)
      expect(tip()).toBeNull()
      // and stays hidden when they are turned on again, until the pointer moves
      m.rerender(<Chart spec={spec} width={400} height={300} tooltip />)
      expect(tip()).toBeNull()
      move(m.host, A.x, A.y)
      expect(tip()!.textContent).toBe('a')
    })

    it('several charts on one page each have their own tooltip', () => {
      const one = mount(<Chart spec={spec} width={400} height={300} tooltip />)
      const two = mount(<Chart spec={{ ...spec, data: [{ name: 'table', values: [{ x: 1, y: 2, label: 'two' }] }] }} width={400} height={300} tooltip />)
      placeAt(one.host, 0, 0)
      placeAt(two.host, 0, 400)
      move(one.host, A.x, A.y)
      expect(tips().map((t) => t.textContent)).toEqual(['a'])
      act(() => { one.host.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: two.host })) })
      move(two.host, A.x, 400 + A.y)
      expect(tips().map((t) => t.textContent)).toEqual(['two'])
      expect(tips()[0]!.style.top).toBe(`${400 + A.y + 10}px`)
      two.unmount()
      expect(tips()).toEqual([])
      move(one.host, C.x, C.y)
      expect(tips().map((t) => t.textContent)).toEqual(['c'])
    })
  })

  describe('renderTooltip content sits in the same box, and stays in the React tree', () => {
    it('renders inside the portalled box and reads React context through the portal', () => {
      const Theme = React.createContext('none')
      const Tip = ({ label }: { label: unknown }): React.ReactElement => <span data-testid="custom">{`${React.useContext(Theme)} ${String(label)}`}</span>
      const { host } = mount(
        <Theme.Provider value="dark">
          <Chart spec={spec} width={400} height={300} renderTooltip={(d) => <Tip label={d.label} />} />
        </Theme.Provider>,
      )
      placeAt(host, 0, 0)
      move(host, A.x, A.y)
      const box = tip()!
      expect(box.parentElement).toBe(document.body)
      expect(box.querySelector('[data-testid="custom"]')!.textContent).toBe('dark a')
      expect([box.style.left, box.style.top]).toEqual([`${A.x + 10}px`, `${A.y + 10}px`])
    })

    it('a move over the same item does not call renderTooltip again', () => {
      const calls: unknown[] = []
      const renderTooltip = (d: Record<string, unknown>): React.ReactNode => { calls.push(d.label); return <b>{String(d.label)}</b> }
      const { host } = mount(<Chart spec={spec} width={400} height={300} renderTooltip={renderTooltip} />)
      placeAt(host, 0, 0)
      move(host, A.x, A.y)
      const after = calls.length
      expect(after).toBeGreaterThan(0)
      move(host, A.x + 1, A.y + 1)
      move(host, A.x + 2, A.y)
      expect(calls.length).toBe(after)
      expect(tip()!.style.left).toBe(`${A.x + 2 + 10}px`)
      move(host, C.x, C.y)
      expect(calls.at(-1)).toBe('c')
    })
  })

  describe('tooltipContainer', () => {
    it('an element: the box is portalled into it, still fixed and placed at the pointer', () => {
      const dialog = document.createElement('div')
      document.body.appendChild(dialog)
      const { host } = mount(<Chart spec={spec} width={400} height={300} tooltip tooltipContainer={dialog} />, dialog)
      placeAt(host, 0, 0)
      move(host, A.x, A.y)
      const box = tip()!
      expect(box.parentElement).toBe(dialog)
      expect(host.contains(box)).toBe(false)
      expect(box.style.position).toBe('fixed')
      expect([box.style.left, box.style.top]).toEqual([`${A.x + 10}px`, `${A.y + 10}px`])
    })

    it('an element inside a shadow root', () => {
      const shadowHost = document.createElement('div')
      document.body.appendChild(shadowHost)
      const shadow = shadowHost.attachShadow({ mode: 'open' })
      const inner = document.createElement('div')
      shadow.appendChild(inner)
      const { host } = mount(<Chart spec={spec} width={400} height={300} tooltip tooltipContainer={inner} />, inner)
      placeAt(host, 0, 0)
      move(host, A.x, A.y)
      expect(tips()).toEqual([])
      const box = inner.querySelector<HTMLElement>('[data-testid="chart-tooltip"]')!
      expect(box.textContent).toBe('a')
      expect(box.parentElement).toBe(inner)
    })

    it('null: the box renders inside the chart element (fixed, at the pointer)', () => {
      const { host } = mount(<Chart spec={spec} width={400} height={300} tooltip tooltipContainer={null} />)
      placeAt(host, 0, 0)
      move(host, A.x, A.y)
      const box = tip()!
      expect(box.parentElement).toBe(host)
      expect(box.style.position).toBe('fixed')
      expect([box.style.left, box.style.top]).toEqual([`${A.x + 10}px`, `${A.y + 10}px`])
    })

    it('a fullscreen element hosts the default tooltip, as vega-tooltip puts it there (what is outside it is not shown)', () => {
      const full = document.createElement('div')
      document.body.appendChild(full)
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => full })
      try {
        const { host } = mount(<Chart spec={spec} width={400} height={300} tooltip />, full)
        placeAt(host, 0, 0)
        move(host, A.x, A.y)
        expect(tip()!.parentElement).toBe(full)
      } finally {
        delete (document as { fullscreenElement?: Element | null }).fullscreenElement
      }
    })

    it('changing it moves the shown tooltip', () => {
      const other = document.createElement('section')
      document.body.appendChild(other)
      const m = mount(<Chart spec={spec} width={400} height={300} tooltip />)
      placeAt(m.host, 0, 0)
      move(m.host, A.x, A.y)
      expect(tip()!.parentElement).toBe(document.body)
      m.rerender(<Chart spec={spec} width={400} height={300} tooltip tooltipContainer={other} />)
      expect(tip()!.parentElement).toBe(other)
      expect([tip()!.style.left, tip()!.style.top]).toEqual([`${A.x + 10}px`, `${A.y + 10}px`])
    })
  })
})
