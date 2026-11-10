// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { it, expect, vi } from 'vitest'
import { SvgChart } from './SvgChart'

// The interpolation is an on-demand module: a chart never imports it until its `transition` prop is set. (The module's
// first import runs the factory below; this file's module registry is its own, so nothing imported it before.)
const loads = vi.hoisted(() => ({ n: 0 }))
vi.mock('@aster-charts/core/transition', async (importOriginal) => {
  loads.n++
  return importOriginal()
})

const spec = {
  width: 100, height: 100, padding: 0, autosize: 'none', data: [{ name: 't' }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, width: { value: 10 }, y: { field: 'v' }, y2: { value: 100 } } } }],
} as never

it('a chart without `transition` never imports @aster-charts/core/transition; setting the prop imports it once', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const el = (v: number, transition?: boolean): React.ReactElement => <SvgChart spec={spec} data={{ t: [{ v }] }} width={100} height={100} transition={transition} />
  await act(async () => { root.render(el(10)) })
  await act(async () => { root.render(el(50)) })
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  expect(loads.n).toBe(0)
  await act(async () => { root.render(el(50, true)) })
  await vi.waitFor(() => expect(loads.n).toBe(1))
  await act(async () => { root.render(el(80, true)) })
  expect(loads.n).toBe(1)
  act(() => root.unmount())
})
