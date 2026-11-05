import { describe, expect, it } from 'vitest'
import { compileChart, evaluateChart } from './index.js'
import type { SceneGroup } from './types.js'

/**
 * A dataset's rows are ingested as vega-dataflow ingests them (a datum that is not an object becomes `{data: datum}`). An
 * append-only pulse leaves the rows before its `baseLength` as they were but for the ones it lists as changed, so an append to a
 * long dataset looks at what was appended (and changed), not at every row again: appending one row to 100,000 had come to cost a
 * scan of all of them per append.
 */
const N = 5000

const spec = (values: unknown[] = []): Record<string, unknown> => ({
  width: 100, height: 100, padding: 0, autosize: 'none',
  data: [{ name: 't', values }],
  scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 100] }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { value: 1 } } } }],
})

const datums = (scene: { items: unknown[] }): unknown[] => ((scene.items[0] as SceneGroup).items ?? []).map((it) => (it as { datum?: unknown }).datum)

/** The host's array, counting the reads of the rows it held when `count` starts. */
function counted(rows: unknown[]): { host: unknown[]; reads: () => number; count: () => void } {
  let reads = 0
  let below = -1
  const host = new Proxy(rows, {
    get(t, k, r) {
      if (below >= 0 && typeof k === 'string' && /^\d+$/.test(k) && Number(k) < below) reads++
      return Reflect.get(t, k, r)
    },
  })
  return { host, reads: () => reads, count: () => { below = rows.length; reads = 0 } }
}

describe('an append-only pulse ingests the rows it appended (and changed), not the whole dataset', () => {
  it('the rows before the append are not read again (a stream appends to the array it gave)', () => {
    const rows = Array.from({ length: N }, (_, k) => ({ x: (k % 100) / 100 }))
    const { host, reads, count } = counted(rows)
    const chart = compileChart(spec() as never)
    evaluateChart(chart, { data: { t: host } })
    rows.push({ x: 0.5 })
    count()
    const scene = evaluateChart(chart, { data: { t: host }, dataPulse: { t: { appendOnly: true, baseLength: N, changed: [] } } })
    // (the incremental engine looks at a row or two at the seam; a scan reads every one)
    expect(reads()).toBeLessThan(10)
    expect(datums(scene)).toHaveLength(N + 1)
  })

  it('a primitive appended after object rows is wrapped as {data: v}', () => {
    const rows: unknown[] = Array.from({ length: 50 }, (_, k) => ({ x: k / 50 }))
    const chart = compileChart(spec() as never)
    evaluateChart(chart, { data: { t: rows } })
    rows.push(0.25)
    const scene = evaluateChart(chart, { data: { t: rows }, dataPulse: { t: { appendOnly: true, baseLength: 50, changed: [] } } })
    expect(datums(scene)[50]).toEqual({ data: 0.25 })
  })

  it('a row the pulse lists as changed is looked at again: one replaced by a primitive is wrapped', () => {
    const rows: unknown[] = Array.from({ length: 50 }, (_, k) => ({ x: k / 50 }))
    const chart = compileChart(spec() as never)
    evaluateChart(chart, { data: { t: rows } })
    rows[7] = 0.5
    const scene = evaluateChart(chart, { data: { t: rows }, dataPulse: { t: { appendOnly: true, baseLength: 50, changed: [7] } } })
    expect(datums(scene)[7]).toEqual({ data: 0.5 })
  })

  it('what is known of one array is not taken for another: a new array is looked at whole', () => {
    const chart = compileChart(spec() as never)
    evaluateChart(chart, { data: { t: Array.from({ length: 50 }, (_, k) => ({ x: k / 50 })) } })
    const fresh: unknown[] = Array.from({ length: 50 }, (_, k) => (k === 3 ? 0.1 : { x: k / 50 }))
    const scene = evaluateChart(chart, { data: { t: fresh } })
    expect(datums(scene)[3]).toEqual({ data: 0.1 })
  })
})
