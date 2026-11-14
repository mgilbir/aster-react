// @vitest-environment jsdom
import { createRoot, hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act } from 'react'
import { describe, it, expect } from 'vitest'
import { ChartStream } from './ChartStream'
import { forEachVariant } from './testing/variants'

const values = (n: number) => Array.from({ length: n }, (_, i) => ({ x: (i * 37) % 400, y: (i * 23) % 300 }))

function makeSpec(rows: Array<{ x: number; y: number }>, extra: Record<string, unknown> = {}) {
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 400, height: 300, padding: 0, autosize: 'none', background: 'white',
    data: [{ name: 't', values: rows }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 400], range: [0, 400] },
      { name: 'y', type: 'linear', domain: [0, 300], range: [300, 0] },
    ],
    marks: [{
      type: 'symbol', from: { data: 't' },
      encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 30 } } },
    }],
    ...extra,
  }
}

const markPaths = (el: ParentNode): number => el.querySelectorAll('svg g.mark-symbol > path').length
const subpaths = (el: ParentNode): number => {
  let n = 0
  for (const p of el.querySelectorAll('svg g.mark-symbol > path')) {
    for (const ch of p.getAttribute('d') ?? '') if (ch === 'M') n++
  }
  return n
}

describe('Chart denseMarks', () => {
  forEachVariant(['svg'], (Chart) => {
    it('batches large symbol marks on a client-only mount by default', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => { root.render(<Chart spec={makeSpec(values(1000))} width={400} height={300} a11y={false} />) })
      expect(markPaths(container)).toBeGreaterThan(0)
      expect(markPaths(container)).toBeLessThanOrEqual(8)
      expect(subpaths(container)).toBe(1000)
      await act(async () => { root.unmount() })
      container.remove()
    })
  })

  forEachVariant(['svg'], (Chart) => {
    it('keeps per-item elements when denseMarks is false', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(<Chart spec={makeSpec(values(1000))} width={400} height={300} denseMarks={false} a11y={false} />)
      })
      expect(markPaths(container)).toBe(1000)
      await act(async () => { root.unmount() })
      container.remove()
    })
  })

  forEachVariant(['svg', 'signals'], (Chart) => {
    it('auto stays per-item when the spec binds mark events', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      const spec = makeSpec(values(1000), {
        signals: [{
          name: 'picked',
          value: null,
          on: [{ events: 'symbol:click', update: 'datum' }],
        }],
      })
      await act(async () => { root.render(<Chart spec={spec} width={400} height={300} a11y={false} />) })
      // signal.on resolves its datum from per-item DOM nodes, so auto opts out
      expect(markPaths(container)).toBe(1000)
      await act(async () => { root.unmount() })
      container.remove()
    })
  })

  forEachVariant(['svg'], (Chart) => {
    it('hydrates per-item markup and then batches without a mismatch', async () => {
      const spec = makeSpec(values(1000))
      const markup = renderToString(<Chart spec={spec} width={400} height={300} a11y={false} />)
      // SSR always emits the per-item markup so the server and client trees match.
      expect((markup.match(/mark-symbol/g) ?? []).length).toBe(1)
      const container = document.createElement('div')
      container.innerHTML = markup
      document.body.appendChild(container)
      let root: ReturnType<typeof hydrateRoot> | null = null
      await act(async () => {
        root = hydrateRoot(container, <Chart spec={spec} width={400} height={300} a11y={false} />)
      })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // After hydration the mode flips and the existing tree is batched in place.
      expect(markPaths(container)).toBeGreaterThan(0)
      expect(markPaths(container)).toBeLessThanOrEqual(8)
      expect(subpaths(container)).toBe(1000)
      await act(async () => { root!.unmount() })
      container.remove()
    })
  })

  it('mounts a stream already batched (client-owned DOM)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <ChartStream
          spec={makeSpec([]) as never}
          width={400}
          height={300}
          // denseMarks defaults to 'auto'
          a11y={false}
          streamOptions={{ initial: { data: { t: values(1000) } }, autoFlush: true }}
        />,
      )
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(markPaths(container)).toBeGreaterThan(0)
    expect(markPaths(container)).toBeLessThanOrEqual(8)
    await act(async () => { root.unmount() })
    container.remove()
  })

  // Only opaque, unrotated symbols batch: one path composites once where separate elements composite at every overlap, so a
  // translucent symbol keeps its own element (the batch gate holds batched and per-item drawings to the same pixels). A
  // mark whose items are all translucent -- the chart-bench scatter, `fillOpacity: 0.7` and a tooltip -- is drawn per item
  // in every shell and on every path to the DOM, whatever `denseMarks` says.
  describe('a translucent or rotated symbol keeps its own element', () => {
    const translucent = (extra: Record<string, unknown>): Record<string, unknown> => {
      const spec = makeSpec(values(1000)) as Record<string, unknown> & { marks: Array<{ encode: { update: Record<string, unknown> } }> }
      Object.assign(spec.marks[0]!.encode.update, extra)
      return spec
    }
    const cases: Array<[string, Record<string, unknown>]> = [
      ['fillOpacity', { fillOpacity: { value: 0.7 }, tooltip: { signal: 'datum.x' } }],
      ['opacity', { opacity: { value: 0.5 } }],
      ['strokeOpacity', { stroke: { value: '#000' }, strokeOpacity: { value: 0.5 } }],
      ['angle', { shape: { value: 'square' }, angle: { value: 30 } }],
    ]
    for (const [name, extra] of cases) {
      forEachVariant(['svg', 'interaction'], (Chart) => {
        it(`${name}: per item on a client-only mount, with denseMarks auto and true`, async () => {
          for (const dense of ['auto', true] as const) {
            const container = document.createElement('div')
            document.body.appendChild(container)
            const root = createRoot(container)
            await act(async () => { root.render(<Chart spec={translucent(extra)} width={400} height={300} denseMarks={dense} tooltip a11y={false} />) })
            expect(markPaths(container)).toBe(1000)
            await act(async () => { root.unmount() })
            container.remove()
          }
        })
      })
    }

    forEachVariant(['svg'], (Chart) => {
      it('per item after hydration too, and an opaque run among translucent items still batches', async () => {
        // the items whose x is a multiple of 3 opaque: each translucent item keeps its element, each run of opaque ones is a path
        const rows = values(1000)
        let expected = 0
        rows.forEach((r, i) => { if (r.x % 3 !== 0 || i === 0 || rows[i - 1]!.x % 3 !== 0) expected++ })
        const spec = makeSpec(values(1000)) as Record<string, unknown> & { marks: Array<{ encode: { update: Record<string, unknown> } }> }
        spec.marks[0]!.encode.update.fillOpacity = { signal: 'datum.x % 3 === 0 ? 1 : 0.7' }
        const markup = renderToString(<Chart spec={spec} width={400} height={300} a11y={false} />)
        const container = document.createElement('div')
        container.innerHTML = markup
        document.body.appendChild(container)
        let root: ReturnType<typeof hydrateRoot> | null = null
        await act(async () => { root = hydrateRoot(container, <Chart spec={spec} width={400} height={300} a11y={false} />) })
        await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
        expect(subpaths(container)).toBe(1000)
        expect(markPaths(container)).toBe(expected)
        expect(expected).toBeLessThan(1000)
        await act(async () => { root!.unmount() })
        container.remove()
        // an opaque mark of the same size batches, so the difference is the opacity alone
        const opaque = document.createElement('div')
        document.body.appendChild(opaque)
        const r2 = createRoot(opaque)
        await act(async () => { r2.render(<Chart spec={makeSpec(values(1000))} width={400} height={300} a11y={false} />) })
        expect(markPaths(opaque)).toBeLessThanOrEqual(8)
        await act(async () => { r2.unmount() })
        opaque.remove()
      })
    })

    it('per item in a stream', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(<ChartStream spec={translucent({ fillOpacity: { value: 0.7 } }) as never} width={400} height={300} a11y={false} />)
      })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(markPaths(container)).toBe(1000)
      await act(async () => { root.unmount() })
      container.remove()
    })
  })
})
