// @vitest-environment jsdom
/**
 * Add-on auto-load, the unhappy paths and the cost of the happy one. `loadAddons` (the only thing that imports an add-on)
 * is a spy over the real function here, so these tests can say what was NOT imported and can make an import fail.
 *
 *   - a spec that needs no add-on never calls it;
 *   - an app that imported the add-on itself never calls it either (no second load);
 *   - a failed import reaches `onError` once, after the wait and never before, and is not a thrown render error.
 *
 * Like Chart.autoload.test.tsx this file imports no add-on of its own except where a test says so.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { VgSpec } from '@aster-charts/core'
import { isAddonLoaded, loadAddons } from '@aster-charts/core/addons'
import { forEachVariant } from './testing/variants'
import { ignoreSuspendedActWarning } from './testing/quiet'

ignoreSuspendedActWarning()

vi.mock('@aster-charts/core/addons', async (importOriginal) => {
  const real = await importOriginal<typeof import('@aster-charts/core/addons')>()
  return { ...real, loadAddons: vi.fn(real.loadAddons) }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'conformance', 'corpus')
const corpus = (name: string): VgSpec => JSON.parse(readFileSync(join(CORPUS, name), 'utf8')) as VgSpec
const MAP = corpus('geo-vlout-mercator-translate.vg.json')
const PLAIN: VgSpec = {
  width: 100, height: 60, padding: 5,
  data: [{ name: 't', values: [{ k: 'a', v: 3 }, { k: 'b', v: 5 }] }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width' },
    { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height' },
  ],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'k' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 } } } }],
}

const roots: Array<{ unmount(): void }> = []
afterEach(() => { act(() => { for (const r of roots.splice(0)) r.unmount() }); document.body.innerHTML = ''; vi.mocked(loadAddons).mockReset() })

// A failed import is remembered for the page (React retries a suspended tree by asking for the same promise again, and browsers keep a
// failed module fetch), so only the FIRST mount that needs an add-on sees the wait. Each variant therefore fails a different add-on,
// one nothing else in this file loads, and every variant sees the wait, the single report and no flash of an error before it.
const FAILS: Record<string, { addon: 'geo' | 'transforms' | 'load'; spec: VgSpec }> = {
  Chart: { addon: 'geo', spec: MAP },
  SvgChart: { addon: 'transforms', spec: corpus('t-pie.vg.json') },
  'SvgChart+interaction': { addon: 'load', spec: {
    width: 100, height: 40, padding: 0,
    data: [{ name: 't', values: 'k,v\na,1\nb,2', format: { type: 'csv', parse: { v: 'number' } } }],
    scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: 'width' }],
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { value: 10 } } } }],
  } },
}

forEachVariant(['svg'], (Chart, variant) => {
  const mount = (spec: VgSpec): { container: HTMLElement; errors: Error[]; settled: Promise<void>; rerender(): Promise<void> } => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const errors: Error[] = []
    const settled = act(() => {
      root.render(
        <React.Suspense fallback={<div data-testid="fallback" />}>
          <Chart spec={spec} width={300} height={200} a11y={false} onError={(e) => errors.push(e)} />
        </React.Suspense>,
      )
    }) as unknown as Promise<void>
    // the same failed spec again, in a new element tree: an actual re-render of the mounted chart
    const rerender = (): Promise<void> => act(async () => {
      root.render(
        <React.Suspense fallback={<div data-testid="fallback" />}>
          <Chart spec={{ ...spec }} width={300} height={200} a11y={false} onError={(e) => errors.push(e)} />
        </React.Suspense>,
      )
      await new Promise((r) => setTimeout(r, 20))
    })
    return { container, errors, settled, rerender }
  }

  describe('the cost of the happy path', () => {
    it('a spec that needs no add-on imports nothing', async () => {
      const { container, settled } = mount(PLAIN)
      await settled
      expect(container.querySelector('svg')).not.toBeNull()
      expect(loadAddons).not.toHaveBeenCalled()
      expect((['transforms', 'geo', 'load'] as const).some(isAddonLoaded)).toBe(false)
    })
  })

  describe('a failed import', () => {
    it('is reported once through onError, after the wait, and the chart does not throw', async () => {
      const { addon, spec } = FAILS[variant.name]!
      // the add-on cannot be loaded for real in this realm yet (it is the premise: nothing registered), so its import is made to fail
      expect(isAddonLoaded(addon)).toBe(false)
      const message = `[aster] could not load the "${addon}" add-on (@aster-charts/core/${addon}): offline`
      vi.mocked(loadAddons).mockImplementation(() => Promise.reject(new Error(message)))
      const { container, errors, settled, rerender } = mount(spec)
      // before the import settles: the fallback, and no error (nothing flashes)
      expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull()
      expect(errors).toEqual([])
      await settled
      for (let i = 0; i < 20 && errors.length === 0; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)) })
      expect(errors.map((e) => e.message)).toEqual([message])
      expect(container.querySelector('[data-testid="fallback"]')).toBeNull()
      expect(container.querySelector('svg')).toBeNull()
      // a re-render with the same failed spec does not report it again
      await rerender()
      await rerender()
      expect(errors).toHaveLength(1)
    })
  })
})
