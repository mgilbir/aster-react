// @vitest-environment jsdom
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { forEachVariant } from './testing/variants'

/**
 * A chart is ONE tab stop. jsdom has no sequential focus navigation, so `tab()` below walks the document's tab order the way
 * a browser does (elements with tabIndex >= 0 in tree order, wrapping); scripts/browser-interaction.mts presses the real
 * Tab key in Chromium over the same pages.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
forEachVariant(['svg'], (Chart, variant) => {
  const spec = (extra: Record<string, unknown> = {}): never => ({
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 200, height: 100, padding: 5, autosize: 'none',
    data: [{ name: 't', values: [{ px: 0, py: 0, c: 'a' }, { px: 5, py: 5, c: 'b' }, { px: 10, py: 10, c: 'c' }] }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 10], range: 'width', nice: false },
      { name: 'y', type: 'linear', domain: [0, 10], range: 'height', nice: false },
      { name: 'color', type: 'ordinal', domain: ['a', 'b', 'c'], range: ['red', 'green', 'blue'] },
    ],
    axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left' }],
    legends: [{ fill: 'color' }],
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: {
      x: { scale: 'x', field: 'px' }, y: { scale: 'y', field: 'py' }, size: { value: 100 }, fill: { scale: 'color', field: 'c' }, description: { field: 'c' },
    } } }],
    ...extra,
  } as never)

  let root: Root
  let host: HTMLElement
  const render = (el: React.ReactElement): void => { act(() => { root.render(el) }) }
  const setup = (): void => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  afterEach(() => { act(() => { root.unmount() }); document.body.innerHTML = '' })

  /** Elements of the chart a keyboard user can Tab to. */
  const stops = (chart: Element): HTMLElement[] => [...chart.querySelectorAll<HTMLElement>('[tabindex]')]
    .concat(chart.hasAttribute('tabindex') ? [chart as HTMLElement] : [])
    .filter((el) => el.tabIndex >= 0)
  const tabOrder = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[tabindex]')].filter((el) => el.tabIndex >= 0)
  const tab = (back = false): HTMLElement | null => {
    // the next tabbable element after (before) the focused one in tree order, whether or not the focused one is tabbable itself
    const order = tabOrder()
    const from = document.activeElement
    const follows = (el: HTMLElement): boolean => from == null || from === document.body || (from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && !from.contains(el)
    const precedes = (el: HTMLElement): boolean => from == null || from === document.body || (from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) !== 0 && !el.contains(from)
    const next = back ? order.filter(precedes).at(-1) ?? order.at(-1) : order.find(follows) ?? order[0]
    act(() => { next?.focus() })
    return next ?? null
  }
  const press = (key: string, init: KeyboardEventInit = {}): void => {
    act(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
  }
  const charts = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-aster-view]')]
  const nodeIn = (el: Element | null): boolean => el?.closest('[data-a11y-id]') != null

  const page = (props: Record<string, unknown>[], s = spec()): React.ReactElement => (
    <div>
      {props.map((p, i) => <Chart key={i} spec={s} width={200} height={100} {...p} />)}
    </div>
  )
  const configs: Array<[string, Record<string, unknown>]> = [
    ['no interaction', {}],
    ['panZoom', { panZoom: true }],
    ['pan', { pan: true }],
    ['zoom', { zoom: true }],
    ['brush', { brush: { x: [1, 3] } }],
    ['onSelect', { onSelect: () => undefined }],
    ['panZoom + onSelect + ariaLabel', { panZoom: true, onSelect: () => undefined, ariaLabel: 'c' }],
  ]

  describe('one tab stop per chart', () => {
    for (const [label, props] of configs) {
      it(`${label}: exactly one element of the chart is in the tab order`, () => {
        setup()
        render(page([props]))
        expect(stops(charts()[0]!)).toHaveLength(1)
      })
    }

    it('several charts on one page: each contributes one stop, Tab visits each once and Shift+Tab walks back', () => {
      setup()
      render(page(configs.map(([, p]) => p)))
      const cs = charts()
      expect(cs).toHaveLength(configs.length)
      for (const c of cs) expect(stops(c)).toHaveLength(1)
      const seen: HTMLElement[] = []
      for (let i = 0; i < cs.length; i++) seen.push(tab()!)
      expect(seen.map((el) => cs.findIndex((c) => c.contains(el)))).toEqual(cs.map((_, i) => i))
      expect(tab()).toBe(seen[0])
      expect(tab(true)).toBe(seen.at(-1))
    })

    it('with pan/zoom the stop is the container; without it, a roving mark node', () => {
      setup()
      render(page([{ panZoom: true }, {}]))
      const [zoomable, plain] = charts()
      expect(stops(zoomable!)).toEqual([zoomable])
      expect(stops(plain!)).toHaveLength(1)
      expect(nodeIn(stops(plain!)[0]!)).toBe(true)
      expect(tab()).toBe(zoomable)
      expect(nodeIn(tab())).toBe(true)
    })

    it('pan/zoom: PageDown on the container enters the nodes, arrows rove, Tab leaves the chart, still one stop throughout', () => {
      setup()
      render(page([{ panZoom: true }, {}]))
      const [zoomable, plain] = charts()
      tab()
      expect(document.activeElement).toBe(zoomable)
      press('PageDown')
      const first = document.activeElement as HTMLElement
      expect(nodeIn(first)).toBe(true)
      expect(zoomable!.contains(first)).toBe(true)
      expect(stops(zoomable!)).toEqual([zoomable])
      const marks = [...zoomable!.querySelectorAll<HTMLElement>('[data-a11y-kind="mark"]')]
      act(() => { marks[0]!.focus() })
      press('ArrowRight')
      expect(document.activeElement).toBe(marks[1])
      expect(stops(zoomable!)).toEqual([zoomable])
      // Tab from a node goes to the next chart, not back into this one
      expect(plain!.contains(tab())).toBe(true)
    })

    it('pan/zoom: the container keeps the pan/zoom keys; PageUp enters at the end', () => {
      setup()
      const views: unknown[] = []
      render(page([{ panZoom: true, onViewChange: (v: unknown) => views.push(v) }]))
      tab()
      press('+')
      expect(views.length).toBeGreaterThan(0)
      press('PageUp')
      const all = [...host.querySelectorAll<HTMLElement>('[data-a11y-id]')]
      expect(document.activeElement).toBe(all.at(-1))
    })

    it('legend toggling, re-render, resize and prop changes keep one stop, and focus is not lost', () => {
      setup()
      const el = (w: number, extra: Record<string, unknown> = {}): React.ReactElement => page([{ panZoom: true, width: w, ...extra }, { width: w }])
      render(el(200))
      const [zoomable, plain] = charts()
      tab()
      press('PageDown')
      const legend = [...zoomable!.querySelectorAll<HTMLElement>('[data-a11y-kind="legend-entry"]')][0]!
      act(() => { legend.focus() })
      press('Enter')
      expect(zoomable!.contains(document.activeElement)).toBe(true)
      for (const c of [zoomable!, plain!]) expect(stops(c)).toHaveLength(1)
      // resize: the focused node survives, the page still has two stops
      render(el(260))
      expect(document.activeElement && host.contains(document.activeElement) && document.activeElement !== document.body).toBe(true)
      expect(tabOrder()).toHaveLength(2)
      // a re-render with a new spec (nodes may all change): focus stays inside the chart, not on <body>
      render(page([{ panZoom: true, width: 260 }, { width: 260 }], spec({ width: 180 })))
      expect(host.contains(document.activeElement) && document.activeElement !== document.body).toBe(true)
      expect(tabOrder()).toHaveLength(2)
      // toggling pan/zoom off and on moves the stop between container and nodes, never two
      render(page([{ width: 260 }, { width: 260 }]))
      expect(tabOrder()).toHaveLength(2)
      render(page([{ panZoom: true, width: 260 }, { panZoom: true, width: 260 }]))
      expect(tabOrder()).toHaveLength(2)
      expect(host.contains(document.activeElement) && document.activeElement !== document.body).toBe(true)
    })

    it('screen-reader semantics are unchanged: the container is labelled, the a11y group keeps its role and label', () => {
      setup()
      render(page([{ panZoom: true, ariaLabel: 'Sales' }]))
      const c = charts()[0]!
      expect(c.getAttribute('aria-label')).toBe('Sales')
      expect(c.getAttribute('role')).toBe('group')
      const g = c.querySelector('[data-testid="chart-a11y"]')!
      expect(g.getAttribute('role')).toBe('group')
      expect(g.getAttribute('aria-label')).toBeTruthy()
      for (const n of c.querySelectorAll<HTMLElement>('[data-a11y-id]')) {
        expect(n.getAttribute('tabindex')).toBe('-1')
        expect(n.getAttribute('role')).toBeTruthy()
      }
    })

    variant.it(['interaction'], 'tooltips and selections keep one stop', () => {
      setup()
      let sel: unknown
      render(page([{ panZoom: true, tooltip: true, onSelectionChange: (s: unknown) => { sel = s } }, { tooltip: true }]))
      const [a, b] = charts()
      tab()
      press('Escape')
      act(() => { a!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 })) })
      expect(sel === null || sel === undefined || typeof sel === 'object').toBe(true)
      expect(stops(a!)).toEqual([a])
      expect(stops(b!)).toHaveLength(1)
    })
  })
  void variant
})
