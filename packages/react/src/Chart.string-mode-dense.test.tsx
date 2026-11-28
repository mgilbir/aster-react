// @vitest-environment jsdom
// `incremental={false}` is the string mode: every update serializes the whole svg and sets it as markup. Dense symbol batching
// (`denseMarks`, 'auto' by default from 512 symbols) belongs to the incremental DOM patcher, so in string mode it must not be chosen: the
// string path skipped the markup for a batched scene and the patcher never ran, so a chart of 512 or more symbols drew nothing at all.
// Found by the browser benchmark once its `aster` row really was string mode (C304).
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect } from 'vitest'
import { forEachVariant } from './testing/variants'

const values = (n: number) => Array.from({ length: n }, (_, i) => ({ x: (i * 37) % 400, y: (i * 23) % 300 }))

const spec = (n: number) => ({
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 400, height: 300, padding: 0, autosize: 'none', background: 'white',
  data: [{ name: 't', values: values(n) }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 400], range: [0, 400] },
    { name: 'y', type: 'linear', domain: [0, 300], range: [300, 0] },
  ],
  marks: [{
    type: 'symbol', from: { data: 't' },
    encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 30 } } },
  }],
})

const markPaths = (el: ParentNode): number => el.querySelectorAll('svg g.mark-symbol > path').length

describe('Chart incremental={false} with dense symbol marks', () => {
  forEachVariant(['svg'], (Chart) => {
    for (const [name, dense] of [['default denseMarks', undefined], ["denseMarks='auto'", 'auto'], ['denseMarks', true]] as const) {
      for (const n of [511, 512, 1000, 3000]) {
        it(`draws every symbol: ${name}, ${n} symbols`, async () => {
          const container = document.createElement('div')
          document.body.appendChild(container)
          const root = createRoot(container)
          await act(async () => { root.render(<Chart spec={spec(n)} width={400} height={300} a11y={false} incremental={false} {...(dense === undefined ? {} : { denseMarks: dense })} />) })
          expect(markPaths(container), `${n} symbols, string mode`).toBe(n)
          // and an update (new rows) redraws them
          await act(async () => { root.render(<Chart spec={spec(n + 3)} width={400} height={300} a11y={false} incremental={false} {...(dense === undefined ? {} : { denseMarks: dense })} />) })
          expect(markPaths(container), `${n + 3} symbols after an update`).toBe(n + 3)
          await act(async () => { root.unmount() })
          container.remove()
        })
      }
    }
  })
})
