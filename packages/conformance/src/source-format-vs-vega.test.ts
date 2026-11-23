/**
 * A dataset derived by `source` is its source's tuples: vega reads no `format` there (the source parsed its rows), so the derived
 * rows hold what the source's transforms made, unparsed again (C115, DECISIONS Q12: match vega). Generated: source pipelines x
 * derived formats x inline or host rows, against `view.data(name)`.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, datasetsOfScene, evaluateChart } from '@aster-charts/core'

const ROWS = [{ v: 1, s: '10' }, { v: 2, s: '20' }, { v: 3, s: '30' }]
const SOURCE_PIPES: unknown[][] = [[], [{ type: 'filter', expr: 'datum.v > 1' }], [{ type: 'formula', as: 'w', expr: 'datum.v * 100' }], [{ type: 'collect', sort: { field: 'v', order: 'descending' } }]]
const FORMATS: unknown[] = [{ type: 'json' }, { parse: { s: 'number' } }, { type: 'json', parse: { v: 'string' } }, { parse: 'auto' }]
const DERIVED_PIPES: unknown[][] = [[], [{ type: 'formula', as: 'w2', expr: 'datum.w' }]]

describe('a source-derived dataset reads no format (vs real vega)', () => {
  it('rows of the derived dataset', async () => {
    const diffs: string[] = []
    for (const sp of SOURCE_PIPES) for (const format of FORMATS) for (const dp of DERIVED_PIPES) for (const host of [false, true]) {
      const spec = { width: 10, height: 10, data: [{ name: 'a', values: ROWS, transform: sp }, { name: 'b', source: 'a', format, transform: dp }], marks: [] }
      const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' }) as unknown as { data(n: string, v?: unknown): unknown[]; runAsync(): Promise<unknown>; finalize(): void }
      if (host) view.data('a', structuredClone(ROWS))
      await view.runAsync()
      const want = JSON.stringify(view.data('b').map((r) => ({ ...(r as object) })))
      view.finalize()
      const scene = evaluateChart(compileChart(structuredClone(spec) as never), host ? { data: { a: structuredClone(ROWS) } } : {})
      const got = JSON.stringify((datasetsOfScene(scene).get('b') ?? []).map((r) => ({ ...(r as object) })))
      if (got !== want) diffs.push(`${JSON.stringify(sp)} ${JSON.stringify(format)} ${JSON.stringify(dp)} host=${host}: vega ${want} | aster ${got}`)
    }
    expect(diffs).toEqual([])
  })
})
