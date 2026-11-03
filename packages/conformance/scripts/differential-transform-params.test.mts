/**
 * LIVE check of the table of transform parameters (transform-params.ts) against the definitions of the pinned vega. vega reads a
 * transform through its definition: the parameters in the order the definition lists them, each by its kind; the table must be that
 * list for every transform Aster accepts, and the order of refusals must follow it (the sites in expression-sites.mts put two broken
 * expressions in one transform, in the opposite order to the definition).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { TRANSFORM_TYPES } from '../../core/src/transform-names.ts'
import { transformParams } from '../../core/src/transform-params.ts'
import { asterOutcome, type Spec, vegaOutcome } from './expression-sites.mts'

interface Param { name: string; type: string; expr?: boolean; params?: Array<{ params: Param[] }>; array?: boolean }
const definition = (type: string): { params: Param[] } => (vega as unknown as { definition(t: string): { params: Param[] } }).definition(type)

const kindOf = (p: Param): string => (p.type === 'expr' ? 'expression' : p.type === 'compare' ? 'compare' : p.type === 'field' || p.expr ? 'field' : 'value')

/** What the spec's keys are for a definition: an index parameter is read from the keys `from` and `key` of the spec. */
const keysOf = (p: Param): Array<{ name: string; kind: string }> =>
  p.type === 'index' ? [{ name: 'from', kind: 'value' }, { name: 'key', kind: 'value' }] : [{ name: p.name, kind: kindOf(p) }]

describe('the table of transform parameters is the definitions of the pinned vega', () => {
  for (const type of TRANSFORM_TYPES) {
    it(type, () => {
      const want = definition(type).params.flatMap(keysOf)
      expect(transformParams(type).map(({ name, kind }) => ({ name, kind }))).toEqual(want)
    })
  }

  it('a transform is read through its definition: a key it does not list is never read, a parameter is read by its kind', () => {
    const data = (transform: Spec): Spec => ({ width: 10, height: 10, data: [{ name: 'd', values: [{ a: 1 }], transform: [transform] }] })
    const cases: Spec[] = [
      { type: 'extent', field: 'a', nosuch: { expr: '1 +' } },
      { type: 'extent', field: { expr: '1 +' } },
      { type: 'bin', field: 'a', extent: [0, 1], maxbins: { expr: '1 +' } },
      { type: 'sample', size: { expr: '1 +' } },
      { type: 'filter', expr: { signal: 's' } },
      { type: 'collect', sort: { field: [{ expr: '1 +' }], order: [{ expr: 'foo()' }] } },
      { type: 'collect', sort: { field: 'a', order: [{ expr: 'foo()' }, { expr: '1 +' }] } },
      { type: 'stack', field: { expr: '(' }, groupby: [{ expr: ')' }] },
      { type: 'stack', groupby: [{ expr: ')' }], field: { expr: '(' } },
    ]
    for (const t of cases) {
      const spec = data(t)
      expect(asterOutcome(spec), JSON.stringify(t)).toBe(vegaOutcome(spec))
    }
  })
})
