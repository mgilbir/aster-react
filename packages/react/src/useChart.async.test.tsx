// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useSpecData } from './useChart'
import { forEachVariant } from './testing/variants'

// The matrix runs every test below on <Chart>, <SvgChart> and <SvgChart interaction={interaction}>;
// `Chart` is the variant's component (see testing/variants.tsx).
forEachVariant(['svg'], (Chart, variant) => {
  const urlSpec = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 200, height: 100, padding: 0, autosize: 'none',
    data: [{ name: 't', url: 'https://example.test/data.csv', format: { type: 'csv' } }],
    scales: [
      { name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' },
      { name: 'y', type: 'linear', domain: { data: 't', field: 'y' }, range: 'height' },
    ],
    marks: [{ type: 'line', from: { data: 't' }, encode: { update: {
      x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, stroke: { value: 'steelblue' },
    } } }],
  } as never

  function fetchText(text: string) {
    return vi.fn(async () => ({ ok: true, status: 200, text: async () => text })) as unknown as typeof fetch
  }

  async function tick(times = 10): Promise<void> {
    for (let i = 0; i < times; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    }
  }

  describe('Suspense / use() async data (R11.2)', () => {
    afterEach(() => { document.body.innerHTML = '' })

    it('suspends, loads URL data through the load addon, then renders', async () => {
      const fetchImpl = fetchText('x,y\n0,1\n1,2\n2,3\n')
      function App() {
        const loaded = useSpecData(urlSpec, { fetch: fetchImpl })
        const rows = (loaded.data as Array<{ values?: unknown[] }>)[0]!.values!
        return <div data-testid="app" data-rows={rows.length}><Chart spec={loaded} width={200} height={100} a11y={false} /></div>
      }
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(
          <React.Suspense fallback={<div data-testid="loading">loading</div>}>
            <App />
          </React.Suspense>,
        )
      })
      await act(async () => {
        // The lazy loader addon import can be slow under the full suite; wait for
        // the suspended boundary to resolve rather than assuming a fixed tick count.
        for (let i = 0; i < 200 && !container.querySelector('[data-testid="app"]'); i++) {
          await new Promise((r) => setTimeout(r, 10))
        }
      })
      expect(container.querySelector('[data-testid="app"]')?.getAttribute('data-rows')).toBe('3')
      expect(container.querySelector('svg .mark-line path')).not.toBeNull()
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      act(() => { root.unmount() })
    })

    it('supports a promise spec through <Chart> and Suspense', async () => {
      let resolve!: (spec: unknown) => void
      const loaded = new Promise((r) => { resolve = r })
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(
          <React.Suspense fallback={<div data-testid="loading">loading</div>}>
            <Chart spec={loaded as never} width={200} height={100} a11y={false} />
          </React.Suspense>,
        )
      })
      expect(container.querySelector('[data-testid="loading"]')).not.toBeNull()
      await act(async () => {
        resolve({
          ...(urlSpec as Record<string, unknown>),
          data: [{ name: 't', values: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }],
        })
        await Promise.resolve()
      })
      await tick(3)
      expect(container.querySelector('svg .mark-line path')).not.toBeNull()
      act(() => { root.unmount() })
    })
  })
})
