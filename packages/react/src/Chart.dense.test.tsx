// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect } from 'vitest'
import { Chart } from './Chart'
import { ChartStream } from './ChartStream'

const values = (n: number) => Array.from({ length: n }, (_, i) => ({ x: (i * 37) % 400, y: (i * 23) % 300 }))

function makeSpec(rows: Array<{ x: number; y: number }>) {
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
  }
}

const markPaths = (el: ParentNode): number => el.querySelectorAll('svg g.mark-symbol > path').length

describe('Chart denseMarks', () => {
  it('switches the mark group to batched paths on the first update', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const spec = makeSpec(values(1000))
    await act(async () => { root.render(<Chart spec={spec} width={400} height={300} denseMarks a11y={false} />) })
    // Mount is the SSR/hydration markup (per-item), so hydration stays valid.
    expect(markPaths(container)).toBe(1000)

    const next = makeSpec(values(1001).map((r, i) => (i === 0 ? { x: 1, y: 1 } : r)))
    await act(async () => { root.render(<Chart spec={next} width={400} height={300} denseMarks a11y={false} />) })
    expect(markPaths(container)).toBeGreaterThan(0)
    expect(markPaths(container)).toBeLessThanOrEqual(8)
    // Geometry is preserved: one subpath per datum.
    let subpaths = 0
    for (const p of container.querySelectorAll('svg g.mark-symbol > path')) {
      for (const ch of p.getAttribute('d') ?? '') if (ch === 'M') subpaths++
    }
    expect(subpaths).toBe(1001)

    await act(async () => { root.unmount() })
    container.remove()
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
          denseMarks
          a11y={false}
          streamOptions={{ initial: { data: { t: values(1000) } }, autoFlush: true }}
        />,
      )
    })
    // give the stream flush a tick
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(markPaths(container)).toBeGreaterThan(0)
    expect(markPaths(container)).toBeLessThanOrEqual(8)
    await act(async () => { root.unmount() })
    container.remove()
  })
})
