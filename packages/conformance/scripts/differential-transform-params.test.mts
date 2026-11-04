/**
 * LIVE check of the table of transform parameters (transform-params.ts) against the definitions of the pinned vega. vega reads a
 * transform through its definition: the parameters in the order the definition lists them, each by its kind; the table must be that
 * list for every transform Aster accepts, and the order of refusals must follow it (the sites in expression-sites.mts put two broken
 * expressions in one transform, in the opposite order to the definition).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { TRANSFORM_TYPES, TUPLE_MAKING_TRANSFORMS } from '../../core/src/transform-names.ts'
import { transformParams } from '../../core/src/transform-params.ts'
import { asterOutcome, type Spec, vegaOutcome } from './expression-sites.mts'
import { seeded } from './upstream.mts'
import { scaled } from './differential-gen.mts'
import { transformSpec } from './parse-refusal-gen.mts'

interface Param { name: string; type: string; expr?: boolean; params?: Array<{ params: Param[] }>; array?: boolean; required?: boolean; values?: unknown[] }
interface Definition { params: Param[]; metadata?: { generates?: boolean; changes?: boolean } }
const definition = (type: string): Definition => (vega as unknown as { definition(t: string): Definition }).definition(type)

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

  it('a mark refuses the transforms whose definition makes tuples or drops some (they cannot run on its items)', () => {
    const makes = [...TRANSFORM_TYPES].filter((type) => { const md = definition(type).metadata ?? {}; return !!(md.generates || md.changes) })
    expect([...TUPLE_MAKING_TRANSFORMS].sort()).toEqual(makes.sort())
    // every transform on a group mark and on a rect mark, with the parameters its definition requires: refused (or not) as vega does
    const value = (p: Param): unknown => p.type === 'expr' ? 'true' : p.type === 'number' ? 1 : p.type === 'boolean' ? true : p.type === 'projection' ? 'p'
      : p.type === 'compare' ? { field: 'a' } : p.type === 'enum' ? p.values?.[0] : 'a'
    let refused = 0
    for (const type of TRANSFORM_TYPES) {
      const t: Spec = { type }
      for (const p of definition(type).params) {
        if (p.type === 'index') Object.assign(t, { from: 't', key: 'a' })
        else if (p.required) t[p.name] = p.array ? [value(p)] : value(p)
      }
      for (const mark of ['group', 'rect']) {
        const spec: Spec = { projections: [{ name: 'p', type: 'mercator' }], data: [{ name: 't', values: [{ a: 1 }] }], marks: [{ type: mark, from: { data: 't' }, transform: [t] }] }
        const want = vegaOutcome(spec)
        if (want !== 'ok') refused++
        expect(asterOutcome(spec), `${mark} ${JSON.stringify(t)}`).toBe(want)
      }
    }
    // (not vacuous: each transform that makes tuples is refused, on both marks)
    expect(refused).toBe(makes.length * 2)
  })
})

/**
 * What vega refuses when it parses a transform, generated from the definitions: transforms of every type, in data sets, in a group's data
 * sets and on marks, each with its required parameters and others at random, with one or two parameters spoiled (left out though
 * required, a list given as something else, a projection or a data set the scope does not have, a lookup without a literal `from`,
 * sub-parameters of no known kind, not in a list, or missing what they require). Aster must refuse exactly when vega does, with its
 * message (the first refusal in vega's order), and accept what vega accepts.
 */
describe('a transform is refused when it is parsed, as vega refuses it (generated from the definitions)', () => {
  it(`${scaled(3000)} generated specs`, { timeout: 300_000 }, () => {
    const r = seeded(0x7a2f)
    const bad: string[] = []
    const reasons = new Map<string, number>()
    let accepted = 0
    for (let i = 0; i < scaled(3000); i++) {
      const { spec, label } = transformSpec(r)
      const want = vegaOutcome(spec)
      const got = asterOutcome(spec)
      if (want === 'ok') accepted++
      else reasons.set(want.replace(/[:"].*$/, ''), (reasons.get(want.replace(/[:"].*$/, '')) ?? 0) + 1)
      if (got !== want) bad.push(`#${i} ${label}: vega ${JSON.stringify(want)}, aster ${JSON.stringify(got)}`)
    }
    expect(bad, `${bad.length} differ:\n${bad.slice(0, 10).join('\n')}`).toEqual([])
    // (not vacuous: every kind of refusal is drawn, and many specs are accepted)
    for (const reason of ['Missing required ', 'Lookup ', 'Undefined data set name', 'Unrecognized scale name', 'Unsupported parameter', 'Expected an array of sub-parameters. Instead', 'value.map is not a function', 'Cannot read properties of null (reading ']) {
      expect([...reasons.keys()].some((k) => k.startsWith(reason) || reason.startsWith(k)), `${reason} in ${JSON.stringify([...reasons])}`).toBe(true)
    }
    expect(accepted).toBeGreaterThan(scaled(3000) * 0.15)
  })
})
