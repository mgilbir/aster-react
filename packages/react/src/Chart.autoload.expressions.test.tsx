// @vitest-environment jsdom
/**
 * Expressions through the shells: the add-on auto-load reads a spec's expressions to know what to import, and the compile that
 * follows refuses what vega's parser refuses -- an unknown function, a broken handler -- whether or not an add-on's function is in
 * the same spec. The function of an add-on is known to the compile without the add-on being loaded (the shell loads it, so the
 * compile never meets it unloaded); an unknown one is refused after the add-on is there, the error reaching `onError`, not thrown.
 *
 * Like Chart.autoload.test.tsx this file imports no add-on of its own.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import type { VgSpec } from '@aster/core'
import { isAddonLoaded } from '@aster/core/addons'
import { forEachVariant } from './testing/variants'
import { ignoreSuspendedActWarning } from './testing/quiet'

ignoreSuspendedActWarning()

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const withSignal = (update: string, more: Partial<VgSpec> = {}): VgSpec => ({
  width: 100, height: 60, padding: 5,
  signals: [{ name: 's', update }],
  marks: [{ type: 'rect', encode: { update: { x: { value: 1 }, y: { value: 1 }, width: { signal: 'abs(s) + 10' }, height: { value: 10 } } } }],
  ...more,
})

const roots: Array<{ unmount(): void }> = []
afterEach(() => { act(() => { for (const r of roots.splice(0)) r.unmount() }); document.body.innerHTML = '' })

async function until(ready: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now()
  while (!ready() && Date.now() - t0 < ms) await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
}

describe('add-on auto-load, the premise', () => {
  it('starts with no add-on registered', () => {
    expect((['transforms', 'geo', 'load'] as const).some(isAddonLoaded)).toBe(false)
  })
})

forEachVariant(['svg'], (Chart) => {
  const mount = (spec: VgSpec): { container: HTMLElement; errors: Error[]; settled: Promise<void> } => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const errors: Error[] = []
    const settled = act(() => {
      root.render(
        <React.Suspense fallback={<div data-testid="loading" />}>
          <Chart spec={spec} width={300} height={200} a11y={false} onError={(e) => errors.push(e)} />
        </React.Suspense>,
      )
    }) as unknown as Promise<void>
    return { container, errors, settled }
  }
  const refused = async (spec: VgSpec): Promise<{ container: HTMLElement; errors: Error[] }> => {
    const { container, errors, settled } = mount(spec)
    await settled
    await until(() => errors.length > 0 || container.querySelector('svg') !== null)
    return { container, errors }
  }

  describe('a function of an add-on, and nothing else of it', () => {
    it('loads the add-on and renders: the compile knows the function', async () => {
      const spec = withSignal('sampleNormal(0, 1) * 0 + 5')
      const wasLoaded = isAddonLoaded('transforms')
      const { container, errors, settled } = mount(spec)
      if (!wasLoaded) expect(container.querySelector('[data-testid="loading"]')).not.toBeNull()
      await settled
      await until(() => container.querySelector('svg') !== null)
      expect(errors).toEqual([])
      expect(isAddonLoaded('transforms')).toBe(true)
      expect(container.querySelector('svg path[d="M1,1h15v10h-15Z"]')).not.toBeNull()
    })
  })

  describe('an unknown function', () => {
    it('is refused at mount with vega\'s message, in a signal update where it used to be skipped silently', async () => {
      const { container, errors } = await refused(withSignal('foo(1)'))
      expect(errors).toHaveLength(1)
      expect(errors[0]!.name).toBe('SpecParseError')
      expect(errors[0]!.message).toBe('Unrecognized function: foo')
      expect(container.querySelector('svg')).toBeNull()
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
    })

    it('next to a function of an add-on is refused, too (the add-on is loaded first, and the compile then refuses the unknown one)', async () => {
      const { container, errors } = await refused(withSignal('sampleNormal(0, 1) + foo(1)'))
      expect(errors.map((e) => e.message)).toEqual(['Unrecognized function: foo'])
      expect(isAddonLoaded('transforms')).toBe(true)
      expect(container.querySelector('svg')).toBeNull()
    })
  })

  describe('a handler of a signal that cannot be built', () => {
    it('is refused at mount, not reported when the handlers are bound', async () => {
      const spec = withSignal('1', { signals: [{ name: 's', update: '1', on: [{ events: 'click[nosuch > 1]', update: '2' }] }] })
      const { container, errors } = await refused(spec)
      expect(errors.map((e) => e.message)).toEqual(['Unrecognized signal name: "nosuch"'])
      expect(container.querySelector('svg')).toBeNull()
    })
  })
})
