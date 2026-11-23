// @vitest-environment jsdom
/**
 * Every combination of `incremental` and `denseMarks` draws every symbol, at mount and after each change of data or spec
 * (C43: `incremental={false}` with a dense symbol mark drew nothing, because the dense route leaves the markup empty for the
 * layout effect to build, and that effect returned early for `incremental={false}`). Counted as the symbols in the DOM's
 * paths, whether one element per item or batched chunks.
 */
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { forEachVariant } from './testing/variants'

const values = (n: number, k = 37) => Array.from({ length: n }, (_, i) => ({ x: (i * k) % 400, y: (i * 23) % 300 }))
const spec = (rows: Array<{ x: number; y: number }>, size = 30) => ({
  width: 400, height: 300, padding: 0, autosize: 'none',
  data: [{ name: 't', values: rows }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 400], range: [0, 400] },
    { name: 'y', type: 'linear', domain: [0, 300], range: [300, 0] },
  ],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: size } } } }],
})
/** The symbols drawn: one `M` per symbol in the mark's paths (per-item elements or batched chunks alike). */
const drawn = (el: ParentNode): number => {
  let n = 0
  for (const p of el.querySelectorAll('svg g.mark-symbol > path')) for (const ch of p.getAttribute('d') ?? '') if (ch === 'M') n++
  return n
}

forEachVariant(['svg'], (Chart) => {
  describe('incremental x denseMarks draws every symbol through mounts and updates', () => {
    for (const incremental of [true, false]) {
      for (const denseMarks of ['auto', true, false] as const) {
        it(`incremental=${incremental} denseMarks=${String(denseMarks)}`, () => {
          ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
          const el = document.createElement('div')
          document.body.appendChild(el)
          const root = createRoot(el)
          const steps: Array<[string, Record<string, unknown>, number]> = [
            ['mount', { spec: spec(values(1000)) }, 1000],
            ['fewer rows', { spec: spec(values(700)) }, 700],
            ['rows through data', { spec: spec([]), data: { t: values(1200, 41) } }, 1200],
            ['another spec', { spec: spec(values(300), 60) }, 300],
          ]
          for (const [name, props, n] of steps) {
            act(() => { root.render(<Chart {...(props as { spec: never })} incremental={incremental} denseMarks={denseMarks} a11y={false} />) })
            expect(el.querySelector('svg'), name).not.toBeNull()
            expect(drawn(el), name).toBe(n)
          }
          act(() => root.unmount())
          el.remove()
        })
      }
    }
  })
})
