// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import type { VgSpec } from '@aster-charts/core'
import { handleChartWorkerRequest } from './worker'
import { useChart } from './useChart'
import { forEachVariant } from './testing/variants'

// `maxRows` on the React paths: the rows a chart is given are counted once each -- the host's `data` under a dataset's name replaces
// its inline rows, a host array under another name counts as well -- at exactly `maxRows` the chart renders, one more is refused.

const MAX = 10
const rows = (n: number): Array<Record<string, unknown>> => Array.from({ length: n }, (_, i) => ({ v: i }))
const rect = (from: string): Record<string, unknown> => ({ type: 'rect', from: { data: from }, encode: { update: { x: { field: 'v' }, width: { value: 1 }, y: { value: 0 }, height: { value: 1 } } } })
const spec: VgSpec = {
  width: 50, height: 20,
  data: [{ name: 'a', values: rows(MAX) }, { name: 'b', values: rows(4) }],
  marks: [rect('a'), rect('b')],
} as unknown as VgSpec
/** `total` rows: b's 4 inline, the rest the host's rows for a (which replace a's own 10). */
const dataFor = (total: number): Record<string, unknown[]> => ({ a: rows(total - 4) })
const isRowLimit = (e: unknown): boolean => e instanceof Error && /maxRows/.test(e.message)

afterEach(() => { document.body.innerHTML = '' })

describe('maxRows on the worker request handler', () => {
  it('counts the host rows a request carries, once', () => {
    const at = (total: number): unknown => handleChartWorkerRequest({ id: 1, spec, input: { data: dataFor(total), limits: { maxRows: MAX } } }).error
    expect(at(MAX)).toBeUndefined()
    expect(String((at(MAX + 1) as { message?: string })?.message)).toMatch(/maxRows/)
    // (a host array under a name the spec does not have is rows given to the chart too)
    const extra = handleChartWorkerRequest({ id: 2, spec, input: { data: { a: rows(2), extra: rows(5) }, limits: { maxRows: MAX } } }).error
    expect(String((extra as { message?: string })?.message)).toMatch(/maxRows/)
  })
})

describe('maxRows on useChart', () => {
  it('counts host rows once', () => {
    const results: Array<Error | null> = []
    function Probe({ total }: { total: number }): React.ReactElement {
      const { error } = useChart(spec, { data: dataFor(total), limits: { maxRows: MAX } })
      results.push(error)
      return <div />
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => { root.render(<Probe total={MAX} />) })
    expect(results.at(-1)).toBeNull()
    act(() => { root.render(<Probe total={MAX + 1} />) })
    expect(isRowLimit(results.at(-1))).toBe(true)
    act(() => { root.unmount() })
  })
})

forEachVariant(['svg'], (Chart) => describe('maxRows on <Chart data limits>', () => {
  it('counts host rows once, and `dataChanges` over them', () => {
    const errors: Error[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const draw = (data: Record<string, unknown[]>, dataChanges?: Record<string, number[]>): void => {
      act(() => { root.render(<Chart spec={spec} data={data} dataChanges={dataChanges} limits={{ maxRows: MAX }} width={50} height={20} onError={(e) => { errors.push(e) }} />) })
    }
    const at = dataFor(MAX)
    draw(at)
    const edited = { a: at.a!.map((r, i) => (i === 1 ? { v: 99 } : r)) }
    draw(edited, { a: [1] })
    expect(errors).toEqual([])
    // the changeset was applied: the edited row (v 99) is drawn, and the host rows were not counted twice by it
    expect(container.innerHTML).toContain('M99,0')
    draw(dataFor(MAX + 1))
    expect(errors.some(isRowLimit)).toBe(true)
    act(() => { root.unmount() })
  })
}))
