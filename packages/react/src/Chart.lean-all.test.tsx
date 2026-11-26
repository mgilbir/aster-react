// @vitest-environment jsdom
/**
 * `import '@aster-charts/react/all'` on the lean engine (a browser build): every part of the engine is in its slot before the first
 * render, so no chart suspends for one, whatever its spec needs: the first commit is the chart, never the fallback, and it is the
 * chart drawn. The page starts with every slot empty, as Chart.lean.test.tsx starts it; the opt-in module is
 * imported once, the first time, as an app imports it.
 */
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { VgSpec } from '@aster-charts/core'

vi.mock('@aster-charts/core/internal', async () => await import('../../core/dist/lean.js'))
vi.mock('@aster-charts/core/internal/hit', async () => await import('../../core/dist/hit.js'))
// (the canvas renderer and the signal loop are not mocked into their deferred forms: the opt-in module imports their modules itself,
// and a mock of either module would stand in for it there too)

const { forEachVariant } = await import('./testing/variants')
const { ENGINE_PARTS, partLoaded, specNeeds, withdrawParts } = await import('@aster-charts/core/internal')
// a page that starts with every slot empty, then imports the opt-in module (it fills every slot when it runs: once, as an app's import)
withdrawParts(ENGINE_PARTS)
await import('./all')

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'conformance', 'corpus')
const corpus = (name: string): VgSpec => JSON.parse(readFileSync(join(CORPUS, name), 'utf8')) as VgSpec
/** Charts that need, between them, every part a spec can name, the signal loop and (on a canvas) the canvas renderer. */
const SPECS: Array<[string, VgSpec]> = [
  ['legend, colour ramp', corpus('bar-color-blues-reversed-legend.vg.json')],
  ['time, curves, aggregate, window', {
    width: 300, height: 160, padding: 4,
    data: [{ name: 't', values: Array.from({ length: 24 }, (_, i) => ({ d: Date.UTC(2021, i % 12, 1 + i), g: ['a', 'b'][i % 2], v: (i * 7) % 13 })), transform: [
      { type: 'aggregate', groupby: ['d', 'g'], fields: ['v'], ops: ['sum'], as: ['v'] },
      { type: 'window', sort: { field: 'd' }, groupby: ['g'], ops: ['sum'], fields: ['v'], as: ['run'] },
      { type: 'stack', groupby: ['d'], field: 'v' },
    ] }],
    scales: [{ name: 'x', type: 'utc', domain: { data: 't', field: 'd' }, range: 'width' }, { name: 'y', type: 'log', domain: [1, 100], range: 'height' }],
    axes: [{ scale: 'x', orient: 'bottom' }],
    marks: [{ type: 'line', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'd' }, y: { scale: 'y', field: 'run' }, stroke: { value: '#999' }, interpolate: { value: 'step-after' } } } }],
  } as VgSpec],
  ['signals, selections, regex', {
    width: 120, height: 60, padding: 0, autosize: 'none',
    signals: [{ name: 'clicks', value: 0, on: [{ events: 'click', update: 'clicks + 1' }] }],
    data: [{ name: 'store' }],
    marks: [{ type: 'text', encode: { update: { x: { value: 10 }, y: { value: 20 }, text: { signal: "replace('clicks ' + clicks, /s/, 'z') + (length(data('store')) && vlSelectionTest('store', {}) ? '!' : '')" } } } }],
  } as VgSpec],
]

forEachVariant(['svg'], (Chart, variant) => describe(`${variant.name} with every part imported up front`, () => {
  it('no chart suspends for a part: the first commit is the chart', () => {
    expect(ENGINE_PARTS.filter((p) => !partLoaded(p))).toEqual([])
    const named = new Set(SPECS.flatMap(([, s]) => specNeeds(s).parts))
    expect([...named].sort()).toEqual(expect.arrayContaining(['aggregate', 'color', 'curves', 'legend', 'scales', 'selections', 'time', 'window', 'reshape']))
    for (const [what, spec] of SPECS.slice(0, 2)) {
      const c = document.createElement('div')
      document.body.appendChild(c)
      const root = createRoot(c)
      // no `act` to wait in: what the container holds right after a synchronous render is the first commit
      act(() => { root.render(<React.Suspense fallback={<i id="fb" />}><Chart spec={spec} width={300} height={160} a11y={false} /></React.Suspense>) })
      expect(c.querySelector('#fb'), what).toBeNull()
      expect(c.querySelector('svg [class^="mark-"]'), what).not.toBeNull()
      act(() => root.unmount())
    }
  })

  variant.it(['interaction'], 'a chart with signals does not wait for the signal loop either', () => {
    const [what, spec] = SPECS[2]!
    const c = document.createElement('div')
    document.body.appendChild(c)
    const root = createRoot(c)
    act(() => { root.render(<React.Suspense fallback={<i id="fb" />}><Chart spec={spec} width={120} height={60} a11y={false} /></React.Suspense>) })
    expect(c.querySelector('#fb'), what).toBeNull()
    expect(c.querySelector('svg [class^="mark-"]'), what).not.toBeNull()
    act(() => root.unmount())
  })

  variant.it(['canvas'], 'renderer="canvas" does not wait for the canvas renderer', () => {
    const c = document.createElement('div')
    document.body.appendChild(c)
    const root = createRoot(c)
    act(() => { root.render(<React.Suspense fallback={<i id="fb" />}><Chart spec={SPECS[0]![1]} renderer="canvas" width={300} height={160} /></React.Suspense>) })
    expect(c.querySelector('#fb')).toBeNull()
    expect(c.querySelector('canvas')).not.toBeNull()
    act(() => root.unmount())
  })

  it('and the check can see a wait: a part taken out again makes a chart that needs it suspend', async () => {
    const restore = withdrawParts(['time'])
    const c = document.createElement('div')
    document.body.appendChild(c)
    const root = createRoot(c)
    try {
      act(() => { root.render(<React.Suspense fallback={<i id="fb" />}><Chart spec={SPECS[1]![1]} width={300} height={160} /></React.Suspense>) })
      expect(c.querySelector('#fb')).not.toBeNull()
      act(() => root.unmount())
    } finally {
      restore()
    }
    // (the load the chart started finishes after the unmount: inside an awaited `act`, where React expects such an event)
    await act(async () => { await new Promise((r) => setTimeout(r, 100)) })
  })
}))
