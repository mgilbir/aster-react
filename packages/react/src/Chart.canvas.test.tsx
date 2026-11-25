// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { forEachVariant } from './testing/variants'
import { chartTooltip } from './testing/tooltip'

// The matrix runs every test below on <Chart>, <SvgChart> and <SvgChart interaction={interaction}>;
// `Chart` is the variant's component (see testing/variants.tsx).
forEachVariant(['svg', 'canvas'], (Chart) => {
  function makeSpec() {
    return {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200,
      height: 100,
      padding: 5,
      background: 'white',
      autosize: 'none',
      data: [
        { name: 'table', values: [{ x: 0, y: 10 }, { x: 1, y: 20 }, { x: 2, y: 15 }] },
      ],
      scales: [
        { name: 'x', type: 'linear', domain: { data: 'table', field: 'x' } as never, range: 'width' },
        { name: 'y', type: 'linear', domain: { data: 'table', field: 'y' } as never, range: [100, 0] as never },
      ],
      marks: [
        {
          type: 'line',
          from: { data: 'table' },
          encode: {
            enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, stroke: { value: 'steelblue' }, strokeWidth: { value: 2 } },
          },
        },
      ],
    }
  }

  describe('Chart renderer="canvas"', () => {
    it('renders a canvas element sized to the scene', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(<Chart spec={makeSpec()} width={200} height={100} renderer="canvas" />)
      })
      const canvas = container.querySelector('canvas')
      expect(canvas).not.toBeNull()
      // Scene size = spec size + padding (autosize pad). At a pixel ratio of 1 the backing store is the canvas's size, as in
      // vega's canvas renderer (no CSS size, so a host's CSS sizes it as an image)
      expect(Number(canvas!.getAttribute('width'))).toBe(210)
      expect(Number(canvas!.getAttribute('height'))).toBe(110)
      expect(canvas!.style.width).toBe('')
      expect(canvas!.style.height).toBe('')
      await act(async () => {
        root.unmount()
      })
    })

    it('at a pixel ratio of 2, a backing store twice the size and the scene size in CSS pixels', async () => {
      const before = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
      Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true })
      try {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        await act(async () => {
          root.render(<Chart spec={makeSpec()} width={200} height={100} renderer="canvas" />)
        })
        const canvas = container.querySelector('canvas')!
        expect(Number(canvas.getAttribute('width'))).toBe(420)
        expect(Number(canvas.getAttribute('height'))).toBe(220)
        expect(canvas.style.width).toBe('210px')
        expect(canvas.style.height).toBe('110px')
        await act(async () => {
          root.unmount()
        })
      } finally {
        if (before) Object.defineProperty(window, 'devicePixelRatio', before)
        else delete (window as { devicePixelRatio?: number }).devicePixelRatio
      }
    })

    it('emits no SVG markup in canvas mode', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(<Chart spec={makeSpec()} width={200} height={100} renderer="canvas" />)
      })
      expect(container.querySelector('svg')).toBeNull()
      await act(async () => {
        root.unmount()
      })
    })

    it('redraws without leaking elements when the spec changes: the new picture is painted, and it is the one a fresh mount paints', async () => {
      // jsdom has no 2D context (getContext returns null): a recording one stands in, so what is painted can be read
      const painted: string[] = []
      const ctx = new Proxy({}, {
        get: (_t, p) => (p === 'canvas' ? {} : (...args: unknown[]) => { painted.push(`${String(p)}(${args.join(',')})`) }),
        set: () => true,
      })
      const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
      vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 1 })
      vi.stubGlobal('cancelAnimationFrame', () => {})
      try {
        const lineTo = (): string[] => painted.filter((c) => c.startsWith('lineTo(') || c.startsWith('moveTo('))
        const mountFresh = async (spec: ReturnType<typeof makeSpec>): Promise<string[]> => {
          const el = document.createElement('div')
          document.body.appendChild(el)
          const r = createRoot(el)
          painted.length = 0
          await act(async () => { r.render(<Chart spec={spec} width={200} height={100} renderer="canvas" />) })
          const out = lineTo()
          await act(async () => { r.unmount() })
          el.remove()
          return out
        }
        const spec2 = makeSpec()
        ;(spec2.data![0]! as { values: unknown[] }).values = [{ x: 0, y: 5 }, { x: 1, y: 9 }, { x: 2, y: 1 }]
        const expectedFirst = await mountFresh(makeSpec())
        const expectedSecond = await mountFresh(spec2)
        expect(expectedFirst.length).toBeGreaterThan(0)
        expect(expectedSecond).not.toEqual(expectedFirst)

        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        painted.length = 0
        await act(async () => {
          root.render(<Chart spec={makeSpec()} width={200} height={100} renderer="canvas" />)
        })
        expect(lineTo()).toEqual(expectedFirst)
        painted.length = 0
        await act(async () => {
          root.render(<Chart spec={spec2} renderer="canvas" />)
        })
        // the canvas was repainted with the new scene: cleared, then the new line (a canvas that never repainted paints nothing here)
        expect(painted.some((c) => c.startsWith('clearRect(') || c.startsWith('fillRect('))).toBe(true)
        expect(lineTo()).toEqual(expectedSecond)
        // Still exactly one canvas, no stray SVG nodes.
        expect(container.querySelectorAll('canvas').length).toBe(1)
        expect(container.querySelector('svg')).toBeNull()
        await act(async () => {
          root.unmount()
        })
      } finally {
        getContext.mockRestore()
        vi.unstubAllGlobals()
      }
    })

    it('shows a tooltip via the scene hit index in canvas mode', async () => {
      const spec = {
        $schema: 'https://vega.github.io/schema/vega/v6.json',
        width: 100,
        height: 100,
        padding: 0,
        autosize: 'none',
        data: [{ name: 'table', values: [{ cat: 'a', v: 5 }, { cat: 'b', v: 7 }] }],
        scales: [
          { name: 'x', type: 'band', domain: { data: 'table', field: 'cat' } as never, range: [0, 100] as never },
          { name: 'y', type: 'linear', domain: [0, 10] as never, range: [100, 0] as never },
        ],
        marks: [{
          type: 'rect',
          from: { data: 'table' },
          encode: {
            enter: {
              x: { scale: 'x', field: 'cat' }, width: { scale: 'x', band: 1 },
              y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 },
              fill: { value: '#4c78a8' }, tooltip: { signal: 'datum' },
            },
          },
        }],
      }
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(<Chart spec={spec} width={100} height={100} renderer="canvas" tooltip />)
      })
      // The first bar spans x [0,50); hover at (20, 80) — inside the bar (v=5 →
      // y from 50 to 100) — and the tooltip should carry the datum.
      const canvas = container.querySelector('canvas')!
      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 80, bubbles: true }))
      })
      const tip = chartTooltip()
      expect(tip?.textContent).toContain('cat')
      expect(tip?.textContent).toContain('a')
      await act(async () => {
        root.unmount()
      })
    })

    it('SSR renders empty for canvas mode without throwing', async () => {
      const { renderToString } = await import('react-dom/server')
      const html = renderToString(<Chart spec={makeSpec()} renderer="canvas" />)
      expect(html).toContain('<canvas')
      expect(html).not.toContain('<svg')
    })
  })
})

// A renderer name that is none of ours ("webgl", a typo) drew SVG with no word, where `renderer="canvas"` without the capability is
// reported (C645): every variant now reports it once, through `onError`, and draws SVG.
forEachVariant(['svg'], (_Chart, variant) => {
  describe('renderer that is no renderer', () => {
    it('draws SVG and reports the name once', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      const errors: Error[] = []
      const spec = { width: 40, height: 30, padding: 0, autosize: 'none', data: [{ name: 't', values: [{ x: 1 }] }], marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 10 }, height: { value: 10 } } } }] }
      const props = { spec, renderer: 'webgl' as never, onError: (e: Error) => { errors.push(e) } }
      // (the raw component of the variant: the matrix wrapper drops a `renderer` it has no canvas for)
      await act(async () => { root.render(variant.element(props)) })
      await act(async () => { root.render(variant.element(props)) })
      expect(container.querySelector('canvas')).toBeNull()
      expect(container.querySelector('svg')).not.toBeNull()
      expect(errors.map((e) => e.message)).toEqual(['[aster] renderer="webgl" is no renderer ("svg" or "canvas"), so it renders SVG'])
      await act(async () => { root.unmount() })
      container.remove()
    })
  })
})
