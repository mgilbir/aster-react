// @vitest-environment jsdom
/**
 * Add-on auto-load, through the shells: a spec that needs an opt-in add-on (`@aster/core/transforms`, `@aster/core/geo`)
 * renders with NOTHING imported by the app. The shell reads which add-ons the spec needs, imports them, and renders when
 * they are there; until then it SUSPENDS (a <Suspense> boundary above shows its fallback; with none the root waits), so
 * there is no flash of an error. What it renders is what the static path renders. A spec that needs no add-on renders
 * synchronously and imports nothing.
 *
 * This file imports no add-on, directly or through a helper (vitest gives each file its own module registry), so the
 * registries start empty; the first test checks that, because every other test depends on it.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSpec, geoRegistry, transformRegistry, type VgSpec } from '@aster/core'
import { isAddonLoaded } from '@aster/core/addons'
import { forEachVariant } from './testing/variants'
import { ignoreSuspendedActWarning } from './testing/quiet'

ignoreSuspendedActWarning()

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'conformance', 'corpus')
const corpus = (name: string): VgSpec => JSON.parse(readFileSync(join(CORPUS, name), 'utf8')) as VgSpec
const PIE = corpus('t-pie.vg.json') // `pie` transform: the transforms add-on
const MAP = corpus('geo-vlout-mercator-translate.vg.json') // a projection and a geoshape: the geo add-on
const PLAIN: VgSpec = {
  width: 100, height: 60, padding: 5,
  data: [{ name: 't', values: [{ k: 'a', v: 3 }, { k: 'b', v: 5 }] }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width' },
    { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height' },
  ],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'k' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 } } } }],
}

const FALLBACK = 'loading-the-chart'
const roots: Array<{ unmount(): void }> = []
afterEach(() => { act(() => { for (const r of roots.splice(0)) r.unmount() }); document.body.innerHTML = '' })

/** The markup of the svg as the static path writes it, parsed into the same DOM the shell produces. */
function staticSvg(spec: VgSpec): string {
  const holder = document.createElement('div')
  holder.innerHTML = renderSpec(spec, { width: 300, height: 200 })
  return holder.firstElementChild!.outerHTML
}

/** Wait (inside act, so React can retry the suspended tree) until `ready()` or time runs out. */
async function until(ready: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now()
  while (!ready() && Date.now() - t0 < ms) await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
}

describe('add-on auto-load', () => {
  it('starts with no add-on registered (the premise of every test below)', () => {
    expect(isAddonLoaded('transforms')).toBe(false)
    expect(isAddonLoaded('geo')).toBe(false)
    expect(isAddonLoaded('load')).toBe(false)
    expect(geoRegistry.buildProjection).toBeNull()
    expect(transformRegistry.size).toBe(0)
  })
})

forEachVariant(['svg'], (Chart) => {
  // `act` is awaited by the caller after it has looked at the first commit: React needs the act scope to be awaited to retry a
  // suspended tree, and the first commit (before any import can settle) is where the fallback is checked.
  const mount = (spec: VgSpec, extra: Record<string, unknown> = {}): { container: HTMLElement; errors: Error[]; settled: Promise<void> } => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const errors: Error[] = []
    const settled = act(() => {
      root.render(
        <React.Suspense fallback={<div data-testid={FALLBACK} />}>
          <Chart spec={spec} width={300} height={200} a11y={false} onError={(e) => errors.push(e)} {...extra} />
        </React.Suspense>,
      )
    }) as unknown as Promise<void>
    return { container, errors, settled }
  }
  const svgOf = (c: HTMLElement): string | undefined => c.querySelector('svg')?.outerHTML

  describe('a spec that needs no add-on', () => {
    it('renders in the first commit, with no fallback and nothing imported', async () => {
      const before = (['transforms', 'geo', 'load'] as const).map(isAddonLoaded)
      const { container, errors, settled } = mount(PLAIN)
      await settled
      expect(container.querySelector(`[data-testid="${FALLBACK}"]`)).toBeNull()
      expect(container.querySelector('svg')).not.toBeNull()
      expect(errors).toEqual([])
      expect((['transforms', 'geo', 'load'] as const).map(isAddonLoaded)).toEqual(before)
      expect(svgOf(container)).toBe(staticSvg(PLAIN))
    })
  })

  for (const [name, spec, addon] of [['pie (a transform)', PIE, 'transforms'], ['a projection', MAP, 'geo']] as const) {
    describe(`a spec with ${name}, nothing imported`, () => {
      it(`loads the ${addon} add-on, shows no error meanwhile, and renders what the static path renders`, async () => {
        const wasLoaded = isAddonLoaded(addon)
        const others = (['transforms', 'geo', 'load'] as const).filter((a) => a !== addon).map((a) => [a, isAddonLoaded(a)] as const)
        const { container, errors, settled } = mount(spec)
        if (!wasLoaded) {
          // the add-on is not there: the tree is suspended (the boundary's fallback), nothing is reported
          expect(container.querySelector(`[data-testid="${FALLBACK}"]`)).not.toBeNull()
          expect(container.querySelector('svg')).toBeNull()
          expect(errors).toEqual([])
        }
        await settled
        await until(() => container.querySelector('svg') !== null)
        expect(errors).toEqual([])
        expect(container.querySelector(`[data-testid="${FALLBACK}"]`)).toBeNull()
        expect(isAddonLoaded(addon)).toBe(true)
        // only what the spec needs was imported
        for (const [a, was] of others) expect(isAddonLoaded(a)).toBe(was)
        // and the chart is the static path's, byte for byte (the add-on is registered now, so renderSpec can run)
        expect(svgOf(container)).toBe(staticSvg(spec))
      })
    })
  }
})
