// @vitest-environment jsdom
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act } from 'react'
import { describe, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest'
import './vl' // the Vega-Lite `time` animation below
import type { ChartHandle, ChartProps } from './Chart'
import { loadTransitions } from './transition'
import { forEachVariant, type ChartComponent } from './testing/variants'

type Row = { k: string; x: number; v: number }

// Bars at a pixel x of their own over a fixed y scale (baseline y = 100), keyed by `k`; the tooltip is the key.
const barSpec = {
  width: 100, height: 100, padding: 0, autosize: 'none',
  signals: [{ name: 'w', value: 10 }],
  data: [{ name: 't' }],
  scales: [{ name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
  marks: [{
    type: 'rect', from: { data: 't' }, key: 'k',
    encode: { update: {
      x: { field: 'x' }, width: { signal: 'w' }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 },
      fill: { value: 'steelblue' }, tooltip: { signal: 'datum.k' },
    } },
  }],
} as never

const A: Row[] = [{ k: 'a', x: 0, v: 2 }, { k: 'b', x: 20, v: 4 }]
const B: Row[] = [{ k: 'a', x: 0, v: 8 }, { k: 'b', x: 60, v: 4 }]
const C: Row[] = [{ k: 'a', x: 0, v: 0.5 }, { k: 'b', x: 80, v: 10 }]
const LINEAR = { duration: 300, easing: 'linear' } as const

beforeAll(async () => {
  // the module a chart with `transition` loads on demand: loaded up front, so every test can animate its first change
  await loadTransitions()
})

/** The bars as drawn: `M x,y h w v h h -w Z` -> [x, y, w, h]. */
function bars(container: HTMLElement): number[][] {
  return [...container.querySelectorAll('.mark-rect path')].map((p) => {
    const m = /^M([-\d.e]+),([-\d.e]+)h([-\d.e]+)v([-\d.e]+)/.exec(p.getAttribute('d') ?? '')
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : []
  })
}
const svgOf = (container: HTMLElement): string => container.querySelector('svg')!.outerHTML

forEachVariant(['svg'], (Chart, variant) => {
  describe('transition', () => {
    const roots: Root[] = []
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] })
    })
    afterEach(() => {
      for (const r of roots.splice(0)) act(() => r.unmount())
      vi.advanceTimersByTime(2000)
      vi.useRealTimers()
      document.body.innerHTML = ''
      delete (window as { matchMedia?: unknown }).matchMedia
    })

    const mount = (node: React.ReactElement): { container: HTMLElement; root: Root } => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      roots.push(root)
      act(() => { root.render(node) })
      return { container, root }
    }
    const el = (C: ChartComponent, props: Partial<ChartProps>): React.ReactElement => <C spec={barSpec} width={100} height={100} {...props} />
    /** The svg a fresh chart draws for these props: what a transition must settle on. */
    const fresh = (props: Partial<ChartProps>): string => svgOf(mount(el(Chart, props)).container)
    const advance = (ms: number): void => { act(() => { vi.advanceTimersByTime(ms) }) }

    variant.it(['svg'], 'without `transition`, new data is drawn at once and no frame is requested', () => {
      const { container, root } = mount(el(Chart, { data: { t: A } }))
      act(() => { root.render(el(Chart, { data: { t: B } })) })
      expect(vi.getTimerCount()).toBe(0)
      expect(svgOf(container)).toBe(fresh({ data: { t: B } }))
    })

    variant.it(['svg'], 'with `transition`, new data is drawn as frames that end on exactly the scene a fresh chart draws', () => {
      const { container, root } = mount(el(Chart, { data: { t: A }, transition: LINEAR }))
      const before = bars(container)
      act(() => { root.render(el(Chart, { data: { t: B }, transition: LINEAR })) })
      // the first frame is the picture that was on screen
      expect(bars(container)).toEqual(before)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      advance(150)
      const [a, b] = bars(container)
      // a grows from height 20 to 80, b slides from x 20 to 60: half way at half time
      expect(a![3]).toBeGreaterThan(45)
      expect(a![3]).toBeLessThan(55)
      expect(b![0]).toBeGreaterThan(35)
      expect(b![0]).toBeLessThan(45)
      advance(200)
      expect(vi.getTimerCount()).toBe(0)
      expect(svgOf(container)).toBe(fresh({ data: { t: B }, transition: LINEAR }))
    })

    variant.it(['svg'], '`true` animates with the defaults (300 ms, cubic-in-out)', () => {
      const { container, root } = mount(el(Chart, { data: { t: A }, transition: true }))
      act(() => { root.render(el(Chart, { data: { t: B }, transition: true })) })
      advance(75) // a quarter of the time: cubic-in-out has moved 1/16 of the way (height 20 -> 80: ~23.75)
      expect(bars(container)[0]![3]).toBeGreaterThan(21)
      expect(bars(container)[0]![3]).toBeLessThan(27)
      advance(250)
      expect(svgOf(container)).toBe(fresh({ data: { t: B } }))
    })

    variant.it(['svg'], 'reduced motion: the preference is honoured by default, `never` overrides it and `always` never animates', () => {
      const prefers = vi.fn((q: string) => ({ matches: q.includes('reduce'), media: q }))
      ;(window as { matchMedia?: unknown }).matchMedia = prefers
      const user = mount(el(Chart, { data: { t: A }, transition: LINEAR }))
      act(() => { user.root.render(el(Chart, { data: { t: B }, transition: LINEAR })) })
      expect(prefers).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
      expect(vi.getTimerCount()).toBe(0)
      expect(svgOf(user.container)).toBe(fresh({ data: { t: B } }))

      const never = { ...LINEAR, reducedMotion: 'never' } as const
      const anyway = mount(el(Chart, { data: { t: A }, transition: never }))
      act(() => { anyway.root.render(el(Chart, { data: { t: B }, transition: never })) })
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      advance(400)

      delete (window as { matchMedia?: unknown }).matchMedia
      const always = { ...LINEAR, reducedMotion: 'always' } as const
      const off = mount(el(Chart, { data: { t: A }, transition: always }))
      act(() => { off.root.render(el(Chart, { data: { t: B }, transition: always })) })
      expect(vi.getTimerCount()).toBe(0)
      expect(svgOf(off.container)).toBe(fresh({ data: { t: B } }))
    })

    variant.it(['svg'], 'new data during a transition starts the next one from the frame on screen', () => {
      const { container, root } = mount(el(Chart, { data: { t: A }, transition: LINEAR }))
      act(() => { root.render(el(Chart, { data: { t: B }, transition: LINEAR })) })
      advance(150)
      const shown = bars(container)
      act(() => { root.render(el(Chart, { data: { t: C }, transition: LINEAR })) })
      // not A's bars (where the first started) nor B's (where it was going): the frame that was on screen
      expect(bars(container)).toEqual(shown)
      advance(400)
      expect(svgOf(container)).toBe(fresh({ data: { t: C } }))
    })

    variant.it(['svg'], 'unmounting during a transition stops it: no frame is left requested', () => {
      const { root } = mount(el(Chart, { data: { t: A }, transition: LINEAR }))
      act(() => { root.render(el(Chart, { data: { t: B }, transition: LINEAR })) })
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      act(() => { root.unmount() })
      roots.splice(roots.indexOf(root), 1)
      expect(vi.getTimerCount()).toBe(0)
    })

    variant.it(['svg'], 'strict mode: animates once and settles, and unmount leaves nothing scheduled', () => {
      const strict = (rows: Row[]): React.ReactElement => <React.StrictMode>{el(Chart, { data: { t: rows }, transition: LINEAR })}</React.StrictMode>
      const { container, root } = mount(strict(A))
      act(() => { root.render(strict(B)) })
      advance(150)
      expect(bars(container)[0]![3]).toBeGreaterThan(45)
      expect(bars(container)[0]![3]).toBeLessThan(55)
      advance(200)
      expect(svgOf(container)).toBe(fresh({ data: { t: B } }))
      act(() => { root.render(strict(C)) })
      act(() => { root.unmount() })
      roots.splice(roots.indexOf(root), 1)
      expect(vi.getTimerCount()).toBe(0)
    })

    variant.it(['svg'], 'a change that is not data (a signal, the size) is drawn at once; during a transition it becomes its end', () => {
      const { container, root } = mount(el(Chart, { data: { t: A }, transition: LINEAR }))
      act(() => { root.render(el(Chart, { data: { t: A }, transition: LINEAR, signals: { w: 15 } })) })
      expect(vi.getTimerCount()).toBe(0)
      expect(svgOf(container)).toBe(fresh({ data: { t: A }, signals: { w: 15 } }))
      act(() => { root.render(el(Chart, { data: { t: A }, transition: LINEAR, signals: { w: 15 }, width: 120 })) })
      expect(vi.getTimerCount()).toBe(0)
      expect(svgOf(container)).toBe(fresh({ data: { t: A }, signals: { w: 15 }, width: 120 }))
      // new data, then a signal while it moves: it keeps moving, and ends on the scene with both
      act(() => { root.render(el(Chart, { data: { t: B }, transition: LINEAR, signals: { w: 15 }, width: 120 })) })
      advance(100)
      act(() => { root.render(el(Chart, { data: { t: B }, transition: LINEAR, signals: { w: 5 }, width: 120 })) })
      const [a] = bars(container)
      expect(a![3]).toBeGreaterThan(30) // still part way (20 -> 80) ...
      expect(a![3]).toBeLessThan(70)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      advance(300)
      expect(svgOf(container)).toBe(fresh({ data: { t: B }, signals: { w: 5 }, width: 120 }))
    })

    variant.it(['svg'], 'an options object made anew on every render does not restart a transition', () => {
      const { container, root } = mount(el(Chart, { data: { t: A }, transition: { ...LINEAR } }))
      act(() => { root.render(el(Chart, { data: { t: B }, transition: { ...LINEAR } })) })
      advance(150)
      act(() => { root.render(el(Chart, { data: { t: B }, transition: { ...LINEAR }, className: 'x' })) })
      const h = bars(container)[0]![3]!
      expect(h).toBeGreaterThan(45) // not back at the start (20)
      advance(100)
      expect(bars(container)[0]![3]).toBeGreaterThan(h)
    })

    variant.it(['svg'], 'batched dense marks are drawn at once', () => {
      const dense = {
        width: 100, height: 100, padding: 0, autosize: 'none', data: [{ name: 't' }],
        marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { value: 10 }, fill: { value: 'red' } } } }],
      } as never
      const pts = (dx: number): Array<{ x: number }> => Array.from({ length: 600 }, (_, i) => ({ x: (i % 100) + dx }))
      const { container, root } = mount(<Chart spec={dense} width={100} height={100} data={{ t: pts(0) }} transition={LINEAR} />)
      act(() => { root.render(<Chart spec={dense} width={100} height={100} data={{ t: pts(1) }} transition={LINEAR} />) })
      expect(vi.getTimerCount()).toBe(0)
      expect(svgOf(container)).toBe(svgOf(mount(<Chart spec={dense} width={100} height={100} data={{ t: pts(1) }} />).container))
    })

    variant.it(['canvas'], 'canvas: switching from SVG during a transition stops it, and the canvas draws the new scene', () => {
      const { container, root } = mount(el(Chart, { data: { t: A }, transition: LINEAR }))
      act(() => { root.render(el(Chart, { data: { t: B }, transition: LINEAR })) })
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      act(() => { root.render(el(Chart, { data: { t: B }, transition: LINEAR, renderer: 'canvas' })) })
      // (jsdom has no 2D context: the canvas paints nothing and requests no frame, so only a transition could be left)
      expect(vi.getTimerCount()).toBe(0)
      expect(container.querySelector('[data-testid="chart-canvas"]')).not.toBeNull()
      act(() => { root.render(el(Chart, { data: { t: C }, transition: LINEAR, renderer: 'canvas' })) })
      expect(vi.getTimerCount()).toBe(0)
    })

    variant.it(['interaction'], 'hover during a transition resolves against the new scene, not the frame drawn', () => {
      const { container, root } = mount(el(Chart, { data: { t: A }, transition: LINEAR, tooltip: true }))
      act(() => { root.render(el(Chart, { data: { t: B }, transition: LINEAR, tooltip: true })) })
      advance(20) // b is drawn near x 20, but it is at x 60 in the scene
      const host = container.firstElementChild as HTMLElement
      const tip = (x: number, y: number): string | null => {
        act(() => { host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y })) })
        return container.querySelector('[data-testid="chart-tooltip"]')?.textContent ?? null
      }
      expect(tip(25, 80)).toBeNull()
      expect(tip(65, 80)).toBe('b')
    })

    variant.it(['signals'], 'a Vega-Lite `time` animation tweens between its frames', () => {
      const rows = [1990, 1991, 1992].flatMap((year) => ['a', 'b'].map((c, i) => ({ year, c, x: year - 1990 + i * 10, y: i })))
      const vl = {
        $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
        width: 200, height: 100, padding: 0, autosize: 'none',
        data: { values: rows },
        params: [{ name: 'anim', select: { type: 'point', on: 'timer', fields: ['year'] } }],
        transform: [{ filter: { param: 'anim' } }],
        mark: 'point',
        encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' }, time: { field: 'year', type: 'ordinal' }, key: { field: 'c' } },
      } as never
      const xs = (container: HTMLElement): number[] => [...container.querySelectorAll('.mark-symbol path')]
        .map((p) => Number(/translate\(([-\d.e]+)/.exec(p.getAttribute('transform') ?? '')?.[1]))
      const ref = React.createRef<ChartHandle>()
      const { container } = mount(<Chart ref={ref} spec={vl} width={200} height={100} transition={{ duration: 300, easing: 'linear' }} />)
      // the same animation without `transition`, on the same clock: the frames as they are drawn when they step
      const plain = mount(<Chart spec={vl} width={200} height={100} />).container
      advance(100) // the first frame (1990): the other years leave
      const year = (): unknown => (ref.current!.getSignals().anim_tuple as { values: unknown[] }).values[0]
      expect(year()).toBe(1990)
      advance(300) // done
      const at1990 = xs(container)
      expect(at1990).toHaveLength(2)
      expect(svgOf(container)).toBe(svgOf(plain)) // settled on the frame (the clock ticking on is no change of data)
      // through the switch to 1991 (at ~517 ms after the first tick), then part of its transition
      let steps = 0
      while (year() === 1990 && steps++ < 100) advance(17)
      expect(year()).toBe(1991)
      advance(100)
      const moving = xs(container)
      advance(250) // done, and before the next frame (500 ms after this one)
      const at1991 = xs(container)
      expect(svgOf(container)).toBe(svgOf(plain))
      expect(at1991[0]).toBeGreaterThan(at1990[0]!)
      // part way between the two frames, where neither frame draws it
      expect(moving[0]).toBeGreaterThan(at1990[0]!)
      expect(moving[0]).toBeLessThan(at1991[0]!)
    })

    variant.it(['svg'], 'server rendering ignores it: the markup is the chart without `transition`', () => {
      const html = (t?: ChartProps['transition']): string => renderToString(el(Chart, { data: { t: A }, ...(t ? { transition: t } : {}) }))
      expect(html(LINEAR)).toBe(html())
    })
  })
})
