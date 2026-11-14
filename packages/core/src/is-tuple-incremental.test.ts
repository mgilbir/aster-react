import { describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { createChartSession } from './session.js'
import { renderSceneToSvg } from './index.js'
import type { VgSpec } from './types.js'

// isTuple in a pipeline's steps answers as a full build does when the rows arrive as a pulse (appends, edits, removals), and
// when the host gives the rows: each step's rows are tuples to the next step, as in vega's dataflow
const spec = {
  width: 200, height: 100, autosize: 'none',
  data: [{ name: 't', values: [], transform: [
    { type: 'filter', expr: 'isTuple(datum)' },
    { type: 'formula', expr: 'datum.v * 2', as: 'w' },
    { type: 'filter', expr: 'isTuple(datum)' },
    { type: 'window', ops: ['row_number'], as: ['n'] },
    { type: 'formula', expr: "isTuple(datum) ? 'y' : 'n'", as: 'z' },
  ] }],
  marks: [{ type: 'text', from: { data: 't' }, encode: { update: { x: { field: 'v' }, text: { signal: "datum.z + isTuple(datum)" } } } }],
} as unknown as VgSpec

const rowsOf = (n: number, from = 0) => Array.from({ length: n }, (_, i) => Object.freeze({ v: from + i }))

describe('isTuple across incremental updates', () => {
  it('appends, edits and removals give what a fresh evaluation gives', () => {
    const session = createChartSession()
    let rows: readonly object[] = rowsOf(20)
    session.evaluate(spec, { data: { t: rows as object[] } })
    const steps: Array<(r: readonly object[]) => object[]> = [
      (r) => [...r, ...rowsOf(5, 100)],
      (r) => r.map((x, i) => (i === 3 ? Object.freeze({ v: 999 }) : x)),
      (r) => r.slice(2),
      (r) => [...r, ...rowsOf(1, 500)],
    ]
    for (const step of steps) {
      rows = step(rows)
      const inc = session.evaluate(spec, { data: { t: rows as object[] } })
      const fresh = evaluateChart(compileChart(spec), { data: { t: rows as object[] } })
      expect(renderSceneToSvg(inc)).toBe(renderSceneToSvg(fresh))
      expect(renderSceneToSvg(inc)).toContain('>ytrue<')
      expect(renderSceneToSvg(inc)).not.toContain('false<')
    }
  })
})
