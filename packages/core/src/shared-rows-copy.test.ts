/**
 * A step that only picks rows (a filter, a collect) over another dataset's rows copies the rows it returns, not every row it is given.
 *
 * The chart-bench survival chart's `atX` dataset filters a 6,000-row source by a signal that moves on every pointer move; each
 * evaluation copied all 6,000 rows before the filter to keep the half or less that passed. The rows a dataset hands on are still the
 * evaluation's own copies, equal to a fresh evaluation's, and none of them is a row of the source.
 */
import { describe, it, expect } from 'vitest'
import { compileChart } from './compiler.js'
import { datasetsOfScene } from './runtime.js'
import { evaluateChart } from './evaluate.js'
import { renderSceneToSvg } from './render.js'
import { createChartSession } from './session.js'
import { stepCounts } from './step-reuse.js'
import type { VgSpec } from './types.js'

type Row = { series: string; x: number; y: number }
const rows: Row[] = Array.from({ length: 600 }, (_, i) => ({ series: `s${i % 3}`, x: Math.floor(i / 3), y: ((i * 37) % 101) / 100 }))

const spec = {
  width: 300, height: 200, autosize: 'none',
  signals: [{ name: 'hoverX', value: null }],
  data: [
    { name: 'table', values: rows },
    {
      // the survival chart's dataset: the last row at or before the pointer, per series
      name: 'atX', source: 'table',
      transform: [
        { type: 'filter', expr: 'hoverX != null && datum.x <= hoverX' },
        { type: 'aggregate', groupby: ['series'], fields: ['x'], ops: ['argmax'], as: ['last'] },
        { type: 'formula', expr: 'datum.last.y', as: 'y' },
        { type: 'pivot', field: 'series', value: 'y' },
      ],
    },
    // a filter then a sort: both pick rows
    { name: 'under', source: 'table', transform: [{ type: 'filter', expr: 'datum.x <= hoverX' }, { type: 'collect', sort: { field: 'y', order: 'descending' } }] },
    // a filter alone: the dataset's rows are what it returns
    { name: 'picked', source: 'table', transform: [{ type: 'filter', expr: 'datum.x < hoverX' }] },
    // a filter then a step that writes
    { name: 'scaled', source: 'table', transform: [{ type: 'filter', expr: 'datum.x > hoverX' }, { type: 'formula', expr: 'datum.y * 2', as: 'y2' }] },
    // a sort that reads no signal: kept from the evaluation before
    { name: 'sorted', source: 'table', transform: [{ type: 'collect', sort: { field: 'y' } }] },
  ],
  scales: [{ name: 'x', type: 'linear', domain: [0, 200], range: 'width' }],
  marks: [
    { type: 'symbol', from: { data: 'picked' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { field: 'y', mult: 100 } } } },
    { type: 'symbol', from: { data: 'under' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { value: 5 }, size: { field: 'y' } } } },
    { type: 'text', from: { data: 'atX' }, encode: { update: { text: { signal: "format(datum.s0, '.2f') + ' ' + format(datum.s2, '.2f')" } } } },
  ],
} as unknown as VgSpec

// JS comparison, as the expressions compare (a null hoverX is 0 to `<=`)
const count = (p: (r: Row) => boolean): number => rows.filter(p).length

describe('a step that picks rows of another dataset copies only the rows it returns', () => {
  it('a signal-driven filter over a source copies what passes; every dataset equals a fresh evaluation\'s', () => {
    const session = createChartSession()
    session.evaluate(spec, {})
    const sourceRows = new Set<unknown>()
    for (const h of [10, 150, 199, 0, 60, 60.5, -1, null, 120]) {
      const before = stepCounts.copied
      const scene = session.evaluate(spec, { signals: { hoverX: h } })
      const copied = stepCounts.copied - before
      const hv = h as number
      // (the filters that read hoverX run again: atX's, under's, picked's, scaled's; `sorted` and `table` are kept)
      const expected = (h != null ? count((r) => r.x <= hv) : 0) + count((r) => r.x <= hv) + count((r) => r.x < hv) + count((r) => r.x > hv)

      const fresh = evaluateChart(compileChart(spec), { signals: { hoverX: h } })
      const mine = datasetsOfScene(scene)
      const theirs = datasetsOfScene(fresh)
      expect([...mine.keys()].sort()).toEqual([...theirs.keys()].sort())
      for (const [name, got] of mine) expect(got, `${name} at hoverX ${h}`).toEqual(theirs.get(name))
      expect(renderSceneToSvg(scene)).toBe(renderSceneToSvg(fresh))

      // the rows a derived dataset hands on are its own: none is a row of its source
      sourceRows.clear()
      for (const r of mine.get('table')!) sourceRows.add(r)
      for (const name of ['atX', 'under', 'picked', 'scaled', 'sorted']) {
        for (const r of mine.get(name)!) expect(sourceRows.has(r), `${name} holds a row of table`).toBe(false)
      }
      for (const r of mine.get('atX')!) for (const v of Object.values(r as object)) expect(sourceRows.has(v)).toBe(false)
      expect(copied, `rows copied at hoverX ${h}`).toBe(expected)
    }
  })
})
