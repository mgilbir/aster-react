// @vitest-environment jsdom
/**
 * `useChartWorkerStream` without a Worker keeps its stream on the main thread, so it waits for the add-ons the spec needs before it
 * creates the stream (with a treemap and nothing imported: the transforms add-on), then streams as usual. No add-on is imported
 * by this file.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import type { VgSpec } from '@aster/core'
import { isAddonLoaded } from '@aster/core/addons'
import { useChartWorkerStream } from './useChartWorkerStream'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TREEMAP: VgSpec = {
  width: 120, height: 80, padding: 0,
  data: [{
    name: 'tree',
    values: [{ id: 1, parent: null }, { id: 2, parent: 1 }, { id: 3, parent: 1 }],
    transform: [{ type: 'stratify', key: 'id', parentKey: 'parent' }, { type: 'treemap', field: 'id', size: [120, 80] }],
  }],
  marks: [{ type: 'rect', from: { data: 'tree' }, encode: { update: { x: { field: 'x0' }, y: { field: 'y0' }, x2: { field: 'x1' }, y2: { field: 'y1' }, fill: { value: 'tomato' } } } }],
}
const roots: Array<{ unmount(): void }> = []
afterEach(() => { act(() => { for (const r of roots.splice(0)) r.unmount() }); document.body.innerHTML = '' })

describe('useChartWorkerStream without a Worker, with nothing imported', () => {
  it('creates its stream once the transforms add-on has loaded', async () => {
    expect(isAddonLoaded('transforms')).toBe(false)
    let seen: ReturnType<typeof useChartWorkerStream> | null = null
    function Probe() { seen = useChartWorkerStream(TREEMAP); return null }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => { root.render(<Probe />) })
    // the first commit: still waiting (pending, no error flashed)
    expect(seen!.pending).toBe(true)
    expect(seen!.error).toBeNull()
    for (let i = 0; i < 400 && seen!.pending; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    expect(seen!.error).toBeNull()
    expect(isAddonLoaded('transforms')).toBe(true)
    expect(seen!.scene).toBeTruthy()
    expect((seen!.svg ?? '').match(/fill="tomato"/g)?.length).toBeGreaterThanOrEqual(3)
  })
})
