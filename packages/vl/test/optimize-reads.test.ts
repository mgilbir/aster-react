import { describe, expect, it } from 'vitest'
import { optimizeData } from '../src/optimize.js'

const BS = String.fromCharCode(92)

/** A spec with a facet header's domain dataset that only an expression may read. */
const spec = (expr: string): Record<string, unknown> => ({
  data: [{ name: 'source_0', values: [{ a: 1 }] }, { name: 'row_domain', source: 'source_0', transform: [{ type: 'aggregate', groupby: ['a'] }] }],
  marks: [{ type: 'symbol', from: { data: 'source_0' }, encode: { update: { size: { signal: expr } } } }],
})
const names = (out: Record<string, unknown>): string[] => (out.data as Array<{ name: string }>).map((d) => d.name)

describe('the datasets the optimizer keeps', () => {
  it('drops a header domain dataset nothing reads', () => {
    const out = spec('30')
    optimizeData(out, () => true)
    expect(names(out)).toEqual(['source_0'])
  })
  it('keeps one an expression reads by name, however the name is spelled', () => {
    for (const lit of ['row_domain', `row${BS}u005fdomain`, `${BS}x72ow_domain`]) {
      const out = spec(`30 + length(data("${lit}"))`)
      optimizeData(out, () => true)
      expect(names(out), lit).toEqual(['source_0', 'row_domain'])
    }
  })
})
