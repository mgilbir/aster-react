// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { compile, compileUnit } from '../src/index.js'
import { DATA, xq, yq, cn, deepFreeze, objects } from './helpers.js'

const CONFORMANCE = join(__dirname, '..', '..', 'conformance')
const corpus: Array<[string, unknown]> = []
for (const dir of ['corpus', 'corpus-vega-only']) {
  const d = join(CONFORMANCE, dir)
  if (!existsSync(d)) continue
  for (const f of readdirSync(d).filter((x) => x.endsWith('.vl.json')).sort()) {
    const doc = JSON.parse(readFileSync(join(d, f), 'utf8'))
    corpus.push([f.replace('.vl.json', ''), doc.$schema ? doc : (doc.spec ?? doc)])
  }
}

describe('compile never mutates its input (C73)', () => {
  it('found the conformance corpus', () => {
    expect(corpus.length).toBeGreaterThan(150)
  })

  for (const [name, spec] of corpus) {
    it(`${name}: a deep-frozen spec compiles, twice, to the same Vega, sharing no object with the input`, () => {
      const before = JSON.stringify(spec)
      const frozen = deepFreeze(JSON.parse(before))
      const a = compile(frozen)
      const b = compile(frozen)
      expect(JSON.stringify(frozen)).toBe(before)
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
      // no output object is an input object: the output is free to be edited by the caller
      const inputObjects = new Set<unknown>()
      for (const o of objects(frozen)) inputObjects.add(o)
      for (const o of objects(a)) expect(inputObjects.has(o)).toBe(false)
    })
  }

  it('repeated compiles of a faceted spec do not accumulate group-by keys in the caller\'s transform (audit repro)', () => {
    const spec = {
      data: DATA,
      facet: { row: { field: 'c', type: 'nominal' }, column: { field: 'g', type: 'nominal' } },
      spec: { mark: 'bar', width: 80, height: 60, encoding: { x: cn, y: { field: 'v', type: 'quantitative' }, color: { field: 'g', type: 'nominal' } } },
      transform: [{ aggregate: [{ op: 'sum', field: 'v', as: 's' }], groupby: ['a', 'b'] }],
    }
    const input = JSON.parse(JSON.stringify(spec))
    const first = JSON.stringify(compile(input))
    for (let i = 0; i < 3; i++) expect(JSON.stringify(compile(input))).toBe(first)
    expect(input).toEqual(spec)
  })

  it('mutating the OUTPUT cannot reach back into the input', () => {
    const spec = deepFreeze({ data: DATA, transform: [{ filter: 'datum.x > 1' }], mark: 'point', encoding: { x: xq, y: yq } })
    const out = compile(spec) as { data: Array<{ transform?: Array<Record<string, unknown>>; values?: unknown[] }> }
    for (const d of out.data) {
      d.values?.push({ injected: true })
      for (const t of d.transform ?? []) t.expr = 'false'
    }
    expect(JSON.stringify(spec)).not.toContain('injected')
    expect((spec.transform[0] as { filter: string }).filter).toBe('datum.x > 1')
  })

  it('compileUnit is just as pure', () => {
    const spec = deepFreeze({ data: DATA, mark: 'bar', encoding: { x: cn, y: { ...yq, aggregate: 'sum' } } })
    expect(() => compileUnit(spec)).not.toThrow()
  })
})
