// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect } from 'vitest'
import { useChart } from './useChart'

const spec = {
  width: 100, height: 100, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [{ c: 'a', v: 1 }] }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'c' } as never, range: [0, 100] as never },
    { name: 'y', type: 'linear', domain: [0, 2] as never, range: [100, 0] as never },
  ],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: {
    x: { scale: 'x', field: 'c' }, width: { scale: 'x', band: 1 },
    y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 }, fill: { value: 'steelblue' },
  } } }],
}

function Probe(props: { onResult: (r: ReturnType<typeof useChart>) => void }) {
  const result = useChart(spec as never)
  props.onResult(result)
  return null
}

describe('useChart', () => {
  it('returns a scene and SVG and a stable session', () => {
    const results: Array<ReturnType<typeof useChart>> = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(<Probe onResult={(r) => results.push(r)} />) })
    const first = results[results.length - 1]!
    expect(first.error).toBeNull()
    expect(first.scene).not.toBeNull()
    expect(first.svg).toContain('<svg')
    act(() => { root.render(<Probe onResult={(r) => results.push(r)} />) })
    expect(results[results.length - 1]!.session).toBe(first.session)
    act(() => { root.unmount() })
  })

  it('surfaces render errors instead of throwing', () => {
    const results: Array<ReturnType<typeof useChart>> = []
    function Bad() {
      const r = useChart({ marks: { bad: true } } as never)
      results.push(r)
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(<Bad />) })
    expect(results[0]!.error).toBeInstanceOf(Error)
    expect(results[0]!.scene).toBeNull()
    act(() => { root.unmount() })
  })
})
