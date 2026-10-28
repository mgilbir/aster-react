/**
 * A worker whose add-on import fails answers THAT message with the error (typed, with its id) and keeps going: the messages behind
 * it are answered in order, and a message that needs nothing is never held up by the failure of an earlier one's import.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChartStream, VgSpec } from '@aster/core'
import { createWorkerDispatcher, type ChartWorkerResponse, type ChartWorkerStreamResponse } from './worker'

vi.mock('@aster/core/addons', async (importOriginal) => {
  const real = await importOriginal<typeof import('@aster/core/addons')>()
  return { ...real, loadAddons: vi.fn(() => Promise.reject(new Error('[aster] could not load the "transforms" add-on (@aster/core/transforms): offline'))) }
})

const PIE: VgSpec = {
  width: 100, height: 60, padding: 0,
  data: [{ name: 't', values: [{ v: 1 }, { v: 2 }], transform: [{ type: 'pie', field: 'v' }] }],
  marks: [{ type: 'arc', from: { data: 't' }, encode: { update: { startAngle: { field: 'startAngle' }, endAngle: { field: 'endAngle' }, outerRadius: { value: 20 } } } }],
}
const PLAIN: VgSpec = { width: 50, height: 50, padding: 0, marks: [] }

describe('worker dispatcher, an import that fails', () => {
  it('answers that message with the error and the ones behind it in order', async () => {
    const out: Array<ChartWorkerResponse | ChartWorkerStreamResponse> = []
    const dispatch = createWorkerDispatcher(new Map<number, ChartStream>(), (r) => out.push(r))
    dispatch({ id: 1, spec: PIE })
    dispatch({ kind: 'stream', id: 2, streamId: 9, op: 'init', spec: PIE })
    dispatch({ id: 3, spec: PLAIN })
    for (let i = 0; i < 200 && out.length < 3; i++) await new Promise((r) => setTimeout(r, 5))
    expect(out.map((r) => r.id)).toEqual([1, 2, 3])
    expect(out[0]!.error?.message).toMatch(/could not load the "transforms" add-on/)
    expect(out[1]!).toMatchObject({ kind: 'stream', streamId: 9 })
    expect(out[1]!.error?.message).toMatch(/could not load the "transforms" add-on/)
    expect(out[2]!.error).toBeUndefined()
    expect((out[2] as ChartWorkerResponse).svg).toContain('<svg')
  })
})
