// @vitest-environment jsdom
/**
 * With the Vega-Lite compiler loaded, a spec it refuses (C47) is a chart error like any other: the compile runs inside the
 * guarded evaluation, so the `VLCompileError` reaches the error state and `onError` once (and `useChart`'s `error`), and the
 * host's tree is not unmounted.
 */
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import './vl'
import { useChart } from './useChart'
import { forEachVariant } from './testing/variants'

const base = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 200, height: 100,
  data: { values: [{ c: 'a', v: 3 }, { c: 'b', v: 7 }] },
  mark: 'bar',
  encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } },
}

/** Specs the compiler refuses, each a different part of it. */
const REFUSED: Array<[string, Record<string, unknown>]> = [
  ['an unknown mark type', { ...base, mark: 'no-such-mark' }],
  ['an unknown aggregate', { ...base, encoding: { ...base.encoding, y: { field: 'v', type: 'quantitative', aggregate: 'nope' } } }],
  ['an unknown top-level property', { ...base, foo: 1 }],
  ['an invalid predicate', { ...base, transform: [{ filter: { field: 'v', month: 'Smarch' } }] }],
]

let roots: Array<{ root: Root; el: HTMLElement }> = []
afterEach(() => {
  act(() => { for (const r of roots) r.root.unmount() })
  for (const r of roots) r.el.remove()
  roots = []
})
function mount(): { el: HTMLElement; render: (node: React.ReactNode) => void } {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  roots.push({ root, el })
  return { el, render: (node) => act(() => { root.render(node) }) }
}

forEachVariant(['svg'], (Chart) => {
  describe('a Vega-Lite compile error reaches the error state and onError once', () => {
    for (const [name, spec] of REFUSED) {
      it(name, () => {
        const m = mount()
        const errors: Error[] = []
        const at = (): React.ReactElement => <Chart spec={{ ...spec } as never} onError={(e) => errors.push(e)} a11y={false} />
        expect(() => m.render(at())).not.toThrow()
        m.render(at())
        expect(errors).toHaveLength(1)
        expect(errors[0]!.message).toMatch(/^\[aster\/vl\]/)
        expect(m.el.querySelector('[role="alert"]')).not.toBeNull()
        // and a spec the compiler accepts draws in the same place
        m.render(<Chart spec={base as never} onError={(e) => errors.push(e)} a11y={false} />)
        expect(m.el.querySelector('svg')).not.toBeNull()
        expect(errors).toHaveLength(1)
      })
    }
  })
})

describe('useChart returns a Vega-Lite compile error as `error`', () => {
  for (const [name, spec] of REFUSED) {
    it(name, () => {
      const m = mount()
      const seen: Array<string | null> = []
      function Probe(): null {
        const { error, scene } = useChart(spec as never, { width: 200, height: 100 })
        seen.push(scene === null ? error?.message ?? 'no error' : null)
        return null
      }
      expect(() => m.render(<Probe />)).not.toThrow()
      expect(seen.at(-1)).toMatch(/^\[aster\/vl\]/)
    })
  }
})
