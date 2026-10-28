// @vitest-environment jsdom
/**
 * An app that imports the add-ons itself pays nothing for the auto-load and never loads them twice: the shell finds the
 * registrations, renders in the first commit (no Suspense fallback) and never calls the importer.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec, type VgSpec } from '@aster/core'
import { isAddonLoaded, loadAddons } from '@aster/core/addons'
import { forEachVariant } from './testing/variants'

vi.mock('@aster/core/addons', async (importOriginal) => {
  const real = await importOriginal<typeof import('@aster/core/addons')>()
  return { ...real, loadAddons: vi.fn(real.loadAddons) }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'conformance', 'corpus')
const corpus = (name: string): VgSpec => JSON.parse(readFileSync(join(CORPUS, name), 'utf8')) as VgSpec
const roots: Array<{ unmount(): void }> = []
afterEach(() => { act(() => { for (const r of roots.splice(0)) r.unmount() }); document.body.innerHTML = '' })

forEachVariant(['svg'], (Chart) => {
  for (const [name, spec] of [['pie', corpus('t-pie.vg.json')], ['a projection', corpus('geo-vlout-mercator-translate.vg.json')]] as const) {
    it(`${name}: rendered in the first commit, the importer never called`, () => {
      expect(isAddonLoaded('geo')).toBe(true)
      expect(isAddonLoaded('transforms')).toBe(true)
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      roots.push(root)
      act(() => {
        root.render(<React.Suspense fallback={<div data-testid="fallback" />}><Chart spec={spec} width={300} height={200} a11y={false} /></React.Suspense>)
      })
      expect(container.querySelector('[data-testid="fallback"]')).toBeNull()
      const holder = document.createElement('div')
      holder.innerHTML = renderSpec(spec, { width: 300, height: 200 })
      expect(container.querySelector('svg')!.outerHTML).toBe(holder.firstElementChild!.outerHTML)
      expect(loadAddons).not.toHaveBeenCalled()
    })
  }
})
describe('guard', () => { it('this file imported the add-ons statically (its premise)', () => { expect(isAddonLoaded('geo') && isAddonLoaded('transforms')).toBe(true) }) })
