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

  // vega.parse itself throws `Undefined data set name` (Scope.getData), so nothing is drawn and nothing is logged
  // (verified against the pinned oracle in spec-data-refs.test.ts, which runs vega.parse on the same specs).
  it('a domain over a data set that is not declared is refused like vega.parse refuses it', () => {
    const errors: unknown[] = []
    expect(() => renderSpec(spec({ data: 'nosuch', field: 'k' }), { logger: { error: (...a) => errors.push(a[0]), warn: () => {} } }))
      .toThrow(/^Undefined data set name: "nosuch"$/)
    expect(errors).toEqual([])
  })

  it('valid domains still build', () => {
    expect(() => renderSpec(spec(['a', 'b']))).not.toThrow()
    expect(() => renderSpec(spec({ data: 't', field: 'k' }))).not.toThrow()
    expect(() => renderSpec(spec(null))).not.toThrow()
  })
})
