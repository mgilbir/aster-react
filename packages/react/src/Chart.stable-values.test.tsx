// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect } from 'vitest'
import { Chart } from './Chart'
import { contentEqual } from './spec.js'

const rows = (n: number, bump = -1) => Array.from({ length: n }, (_, i) => ({ k: 'r' + i, v: (i * 37) % 100 + (i === bump ? 1 : 0) }))
const spec = (values: unknown[]) => ({
  width: 300, height: 120, padding: 5, autosize: 'none',
  data: [{ name: 't', values }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 101], range: 'height' },
  ],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'k' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 } } } }],
})

describe('contentEqual: the rows of a data set are compared by identity', () => {
  it('a skeleton compares by content, a data set\'s values by identity', () => {
    const v = rows(5)
    const by = (a: unknown, b: unknown): boolean => contentEqual(a, b, 0, false, true)
    expect(by(spec(v), spec(v))).toBe(true)
    expect(by(spec(v), spec(rows(5)))).toBe(false)
    expect(contentEqual(spec(v), spec(rows(5)))).toBe(true) // (content mode: streams)
    expect(by(spec(v), { ...spec(v), width: 301 })).toBe(false)
    // elsewhere in a spec an equal array is still equal (an axis' tick values, a scale domain)
    expect(by({ axes: [{ values: [1, 2] }] }, { axes: [{ values: [1, 2] }] })).toBe(true)
    expect(by({ data: [{ values: [1] }] }, { data: [{ values: [1] }] })).toBe(false)
  })
})

describe('<Chart> with an equal spec rebuilt every render', () => {
  async function mount(initial: unknown[]) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    let renders = 0
    function Host({ values }: { values: unknown[] }) {
      renders++
      return <Chart spec={spec(values) as never} width={300} height={120} a11y={false} />
    }
    await act(async () => { root.render(<Host values={initial} />) })
    return { container, root, Host, renders: () => renders }
  }

  it('an equal re-created rows array changes nothing in the DOM; a changed row re-renders; an inline literal does not loop', async () => {
    const m = await mount(rows(2000))
    const heights = () => [...m.container.querySelectorAll('svg g.mark-rect path')].map((p) => p.getAttribute('d')).join('|')
    const before = heights()
    expect(before.length).toBeGreaterThan(0)

    let mutations = 0
    const obs = new MutationObserver((l) => { mutations += l.length })
    obs.observe(m.container, { subtree: true, childList: true, attributes: true, characterData: true })
    const rendersBefore = m.renders()
    for (let i = 0; i < 3; i++) await act(async () => { m.root.render(<m.Host values={rows(2000)} />) })
    obs.takeRecords()
    expect(m.renders() - rendersBefore).toBe(3) // one render per update: no loop
    expect(mutations).toBe(0)
    expect(heights()).toBe(before)

    // one row changed in an otherwise equal, re-created array: the chart follows
    await act(async () => { m.root.render(<m.Host values={rows(2000, 1000)} />) })
    expect(heights()).not.toBe(before)
    obs.disconnect()
    await act(async () => { m.root.unmount() })
    m.container.remove()
  })
})
