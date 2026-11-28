/**
 * The schema check is generated from vega-lite's JSON schema (C245): scripts/schema-table.mjs writes src/schema-table.ts from the
 * pinned vega-lite, and src/schema.ts reads it. These tests hold that chain to the schema itself:
 *  - the committed table is what the generator makes of the pinned schema (a table edited by hand, or left behind by a vega-lite
 *    upgrade, fails here);
 *  - every extension (a form vega-lite reads beyond its schema) is still needed: its example is refused without it;
 *  - the checker agrees with an independent reading of the schema (test/schema-oracle.ts) over every corpus spec and over
 *    generated wrong values at every position of a sample of them: what the schema allows is never refused, and what the checker
 *    lets through the schema allows (an unknown property outside the config aside, which validate.ts and the consumption check own);
 *  - an `{"expr"}` is an expression only where the schema takes an ExprRef, a literal where it takes any value (C442).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkSchema, isLiteralValue } from '../src/schema.js'
import { schemaOracle } from './schema-oracle.js'
import { EXTENSIONS, extendedSchema, generate, pinnedSchema } from '../scripts/schema-table.mjs'

type Spec = Record<string, unknown>

const { schema, version } = pinnedSchema()
const full = extendedSchema(schema)
const strict = schemaOracle(full, 'strict')
const lenient = schemaOracle(full, 'lenient')
const accepts = (s: unknown): boolean => {
  try {
    checkSchema(s)
    return true
  } catch {
    return false
  }
}

const CORPUS = join(__dirname, '..', '..', 'conformance', 'corpus')
const corpus: Array<[string, Spec]> = readdirSync(CORPUS).filter((f) => f.endsWith('.vl.json')).sort().map((f) => [f, JSON.parse(readFileSync(join(CORPUS, f), 'utf8')) as Spec])

describe('the generated schema table', () => {
  it(`is what scripts/schema-table.mjs makes of vega-lite ${version}'s schema`, () => {
    expect(version).toBe('6.4.3')
    expect(readFileSync(join(__dirname, '..', 'src', 'schema-table.ts'), 'utf8')).toBe(generate(full, version))
  })

  for (const e of EXTENSIONS) {
    it(`needs its extension: ${e.why}`, () => {
      expect(e.pinnedBy).toMatch(/\.(test\.ts|vl\.json)/)
      const without = schemaOracle(extendedSchema(schema, EXTENSIONS.filter((x) => x !== e)), 'strict')
      expect(without(e.example), 'the example is refused without the extension').toBe(false)
      expect(strict(e.example), 'and allowed with it').toBe(true)
      expect(accepts(e.example), 'and the checker allows it').toBe(true)
    })
  }
})

describe('the schema check agrees with an independent reading of the schema', () => {
  it('on every corpus spec', () => {
    for (const [f, s] of corpus) {
      expect(lenient(s), f).toBe(true)
      expect(accepts(s), f).toBe(true)
    }
  })

  // wrong values at every position of every 8th corpus spec (the rows are data, not spec: not mutated)
  const WRONG: unknown[] = [null, 5, -1, 2.5, 'str', '', true, [], [null], [5], ['a'], {}, { a: 1 }, { expr: 'x' }, { field: 'a' }, [1, 2]]
  const paths = (o: unknown, p: string[] = []): string[][] => {
    const out: string[][] = []
    if (o !== null && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        if (k === 'values' || k === 'datasets') continue
        out.push([...p, k], ...paths((o as Spec)[k], [...p, k]))
      }
    }
    return out
  }
  const setAt = (o: Spec, p: string[], v: unknown): Spec => {
    const c = structuredClone(o)
    let cur = c as Record<string, unknown>
    for (const k of p.slice(0, -1)) cur = cur[k] as Record<string, unknown>
    cur[p[p.length - 1]!] = v
    return c
  }
  // One test per sampled spec (tens of ms each): the whole sweep is seconds of work, and as one test it fell over the 5 s default
  // whenever the machine was busy. The sweep itself is unchanged, and so is its size, which is asserted below.
  const sample = corpus.filter((_, i) => i % 8 === 0)
  for (const [f, s] of sample) {
    it(`on wrong values at every position of ${f}: nothing the schema allows is refused, nothing it forbids passes`, () => {
      const falseRefusals: string[] = []
      const falsePasses: string[] = []
      for (const p of paths(s)) {
        for (const w of WRONG) {
          const m = setAt(s, p, w)
          const mine = accepts(m)
          if (strict(m) && !mine) falseRefusals.push(`${f} ${p.join('.')} = ${JSON.stringify(w)}`)
          if (mine && !lenient(m)) falsePasses.push(`${f} ${p.join('.')} = ${JSON.stringify(w)}`)
        }
      }
      expect(falseRefusals).toEqual([])
      expect(falsePasses).toEqual([])
    })
  }
  it('the sweep covers more than 20 000 wrong values', () => {
    expect(sample.reduce((n, [, s]) => n + paths(s).length * WRONG.length, 0)).toBeGreaterThan(20_000)
  })
})

describe('{"expr"} is an expression only where the schema takes an ExprRef (C442)', () => {
  const unit = (extra: Spec): Spec => ({ data: { values: [{ a: 1 }] }, mark: 'point', ...extra })
  it('a value at a position that takes any value is a literal, whatever it holds', () => {
    const def = { expr: 'x' }
    const keyvals = [{ expr: 'y' }]
    const value = { expr: 'z' }
    const param = { a: { expr: 'w' } }
    checkSchema(unit({ params: [{ name: 'p', value: param }], transform: [{ lookup: 'a', from: { data: { values: [] }, key: 'a' }, default: def }, { impute: 'a', key: 'a', keyvals, value }] }))
    for (const v of [def, keyvals[0]!, value, param]) expect(isLiteralValue(v)).toBe(true)
  })
  it('an ExprRef position reads it as an expression', () => {
    const opacity = { expr: 'x' }
    const datum = { expr: 'y' }
    checkSchema(unit({ mark: { type: 'point', opacity }, encoding: { x: { datum } } }))
    expect(isLiteralValue(opacity)).toBe(false)
    expect(isLiteralValue(datum)).toBe(false)
  })
  it('a typed position that takes neither refuses it, by its path', () => {
    expect(() => checkSchema(unit({ transform: [{ window: [{ op: 'rank', as: 'r' }], frame: [{ expr: 'x' }, 0] }] }))).toThrow(/^\[aster\/vl\] transform\[0\]\.frame\[0\]: .*got an \{"expr"\} reference/)
    expect(() => checkSchema(unit({ transform: [{ density: 'a', bandwidth: { expr: 'x' } }] }))).toThrow(/^\[aster\/vl\] transform\[0\]\.bandwidth: /)
    expect(() => checkSchema(unit({ transform: [{ quantile: 'a', probs: [{ expr: 'x' }] }] }))).toThrow(/^\[aster\/vl\] transform\[0\]\.probs\[0\]: /)
    expect(() => checkSchema(unit({ transform: [{ window: [{ op: 'rank', as: { expr: 'x' } }] }] }))).toThrow(/^\[aster\/vl\] transform\[0\]\.window\[0\]\.as: /)
  })
})
