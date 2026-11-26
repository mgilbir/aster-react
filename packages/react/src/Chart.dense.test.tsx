// @vitest-environment jsdom
import { createRoot, hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act } from 'react'
import { describe, it, expect, vi } from 'vitest'
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
      const adopted = container.querySelector('svg')
      expect(adopted).not.toBeNull()
      const recoverable: unknown[] = []
      // (React reports a difference inside dangerouslySetInnerHTML with console.error only)
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      let root: ReturnType<typeof hydrateRoot> | null = null
      try {
        await act(async () => {
          root = hydrateRoot(container, <Chart spec={spec} width={400} height={300} a11y={false} />, { onRecoverableError: (e) => recoverable.push(e) })
        })
        await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
        expect(recoverable).toEqual([])
        expect(logged.mock.calls.map((a) => String(a[0]))).toEqual([])
      } finally { logged.mockRestore() }
      // After hydration the mode flips and the existing tree is batched in place: the server's svg element, not a new one.
      expect(container.querySelector('svg')).toBe(adopted)
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

  // One path composites once where separate elements composite at every overlap, so a translucent (or blended, or filled and
  // stroked) symbol shares a path only with symbols whose ink cannot reach the same pixel (overlap-batch.ts; the batch gate holds
  // batched and per-item drawings to the same pixels), and a rotated one never does. A symbol that overlaps its neighbours is
  // drawn per item in every shell and on every path to the DOM, whatever `denseMarks` says.
  describe('a translucent symbol shares a path only with ones it cannot overlap; a rotated symbol keeps its own element', () => {
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
    const piled = (extra: Record<string, unknown>): Record<string, unknown> => {
      const spec = translucent(extra) as { data: Array<{ values: unknown }> }
      spec.data[0]!.values = Array.from({ length: 1000 }, (_, i) => ({ x: 100 + (i % 7), y: 100 + (i % 5) }))
      return spec
    }
    for (const [name, extra] of cases) {
      forEachVariant(['svg', 'interaction'], (Chart) => {
        it(`${name}: on a client-only mount, with denseMarks auto and true`, async () => {
          for (const dense of ['auto', true] as const) {
            for (const [label, spec] of [['spread', translucent(extra)], ['piled', piled(extra)]] as const) {
              const container = document.createElement('div')
              document.body.appendChild(container)
              const root = createRoot(container)
              await act(async () => { root.render(<Chart spec={spec} width={400} height={300} denseMarks={dense} tooltip a11y={false} />) })
              if (name === 'angle' || label === 'piled') expect(markPaths(container), `${name} ${label}`).toBe(1000)
              else {
                // spread out, the translucent symbols batch: fewer elements, every symbol still drawn once
                expect(markPaths(container), `${name} ${label}`).toBeLessThan(200)
                expect(subpaths(container)).toBe(1000)
              }
              await act(async () => { root.unmount() })
              container.remove()
            }
          }
        })
      })
    }

    forEachVariant(['svg', 'interaction'], (Chart) => {
      it('the tooltip is not what keeps a mark per item: the same opaque mark with a tooltip batches', async () => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        await act(async () => { root.render(<Chart spec={translucent({ tooltip: { signal: 'datum.x' } })} width={400} height={300} tooltip a11y={false} />) })
        expect(markPaths(container)).toBeLessThanOrEqual(8)
        expect(subpaths(container)).toBe(1000)
        await act(async () => { root.unmount() })
        container.remove()
      })
    })

    forEachVariant(['svg'], (Chart) => {
      it('batched the same after hydration, and an opaque run among translucent items still batches', async () => {
        // the items whose x is a multiple of 3 opaque: a run of opaque ones is a path, translucent ones batch where they are apart
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
        // (hydration lands on the structure a client-only mount builds)
        const hydrated = markPaths(container)
        const fresh = document.createElement('div')
        document.body.appendChild(fresh)
        const r1 = createRoot(fresh)
        await act(async () => { r1.render(<Chart spec={spec} width={400} height={300} a11y={false} />) })
        expect(hydrated).toBe(markPaths(fresh))
        expect(hydrated).toBeLessThan(900)
        await act(async () => { r1.unmount() })
        fresh.remove()
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

    it('a stream batches them too, and a stream of a pile stays per item', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(<ChartStream spec={translucent({ fillOpacity: { value: 0.7 } }) as never} width={400} height={300} a11y={false} />)
      })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(markPaths(container)).toBeLessThan(200)
      expect(subpaths(container)).toBe(1000)
      await act(async () => { root.unmount() })
      container.remove()
      const heap = document.createElement('div')
      document.body.appendChild(heap)
      const r2 = createRoot(heap)
      await act(async () => {
        r2.render(<ChartStream spec={piled({ fillOpacity: { value: 0.7 } }) as never} width={400} height={300} a11y={false} />)
      })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(markPaths(heap)).toBe(1000)
      await act(async () => { r2.unmount() })
      heap.remove()
    })
  })
})
