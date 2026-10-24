import { describe, expect, it } from 'vitest'
import { renderSpec, SpecParseError } from './index.js'

const spec = (domain: unknown): never => ({
  width: 100, height: 60, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [{ k: 'a' }, { k: 'b' }] }],
  scales: [{ name: 'x', type: 'band', domain, range: 'width' }],
  marks: [],
}) as never

describe('a scale domain vega.parse refuses', () => {
  for (const domain of ['Aa', 42, true, {}, { field: 'k' }]) {
    it(`${JSON.stringify(domain)} names no data set: the spec is refused, not logged`, () => {
      const errors: unknown[] = []
      expect(() => renderSpec(spec(domain), { logger: { error: (...a) => errors.push(a[0]), warn: () => {} } })).toThrow(SpecParseError)
      expect(errors).toEqual([])
    })
  }

  it('a domain over a data set that is not there stays a logged error of the running dataflow', () => {
    const errors: unknown[] = []
    expect(() => renderSpec(spec({ data: 'nosuch', field: 'k' }), { logger: { error: (...a) => errors.push(a[0]), warn: () => {} } })).not.toThrow()
    expect(errors.length).toBeGreaterThan(0)
  })

  it('valid domains still build', () => {
    expect(() => renderSpec(spec(['a', 'b']))).not.toThrow()
    expect(() => renderSpec(spec({ data: 't', field: 'k' }))).not.toThrow()
    expect(() => renderSpec(spec(null))).not.toThrow()
  })
})
