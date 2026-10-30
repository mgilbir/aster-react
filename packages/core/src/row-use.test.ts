/**
 * `rowUseOf`: which transforms may be applied to ANOTHER dataset's row objects without copying them first.
 *
 * A transform it calls `subset` or `fresh` must never write a row it is given (the rows are shared with the dataset they came from),
 * and a `fresh` one must return none of them. The claim is checked by running a corpus of transforms over frozen rows: a write to a
 * frozen object throws, so a transform that writes cannot be called read-only without this failing.
 */
import { describe, it, expect } from 'vitest'
import './addon-transforms.js'
import { applyTransforms, applyTransformsToSharedRows, rowUseOf, type Row } from './transform.js'
import type { CompiledTransform } from './types.js'

const make = (): Row[] => Array.from({ length: 30 }, (_, i) => ({ id: i, g: i % 4, x: (i * 7) % 11, y: ((i * 5) % 13) - 6, s: i % 2 ? 'a' : 'b' }))
const frozen = (): Row[] => make().map((r) => Object.freeze(r))
const BITS = { mask: 3, data: () => [], curr: () => new Uint32Array(30) }
const runtime = { scale: () => undefined, data: () => undefined, expr: () => () => undefined } as never
const ctx = (): { runtime: never; signals: Record<string, unknown> } => ({ runtime, signals: {} })

// every transform type that is cheap to build, with parameters that make it do its work
const CORPUS: Array<Record<string, unknown>> = [
  { type: 'filter', expr: 'datum.x > 3' },
  { type: 'collect', sort: { field: 'x', order: 'descending' } },
  { type: 'collect' },
  { type: 'aggregate', groupby: ['g'] },
  { type: 'aggregate', groupby: ['g'], fields: ['x', 'y', 'x'], ops: ['mean', 'max', 'ci0'], as: ['m', 'mx', 'lo'] },
  { type: 'aggregate', groupby: ['g', 's'], fields: ['x', 'y'], ops: ['median', 'distinct'], as: ['md', 'd'], cross: true },
  { type: 'aggregate', groupby: ['g'], fields: ['x'], ops: ['values'], as: ['v'] },
  { type: 'aggregate', groupby: ['g'], fields: ['x', 'x'], ops: ['argmin', 'argmax'], as: ['lo', 'hi'] },
  { type: 'formula', as: 'z', expr: 'datum.x * 2' },
  { type: 'bin', field: 'x', extent: [0, 11], maxbins: 4 },
  { type: 'extent', field: 'x', signal: 'ext' },
  { type: 'project', fields: ['x'], as: ['xx'] },
  { type: 'joinaggregate', groupby: ['g'], fields: ['x'], ops: ['sum'], as: ['t'] },
  { type: 'window', sort: { field: 'id' }, ops: ['rank'], as: ['r'] },
  { type: 'stack', groupby: ['g'], field: 'x' },
  { type: 'fold', fields: ['x', 'y'] },
  { type: 'flatten', fields: ['x'] },
  { type: 'identifier', as: 'uid' },
  { type: 'impute', field: 'x', key: 'id', method: 'value', value: 0 },
  { type: 'pivot', field: 's', value: 'x', groupby: ['g'] },
  { type: 'sample', size: 7 },
  { type: 'crossfilter', signal: 'xf', fields: ['x', 'y'], query: [[1, 5], [-3, 3]] },
  { type: 'resolvefilter', ignore: 1, filter: BITS },
]

describe('rowUseOf', () => {
  for (const t of CORPUS) {
    const use = rowUseOf(t as unknown as CompiledTransform)
    const label = `${t.type}${t.ops ? ` ${JSON.stringify(t.ops)}` : ''}: ${use}`
    it(label, () => {
      let threw = false
      let out: Row[] = []
      const input = frozen()
      try { out = applyTransforms(input, [t as unknown as CompiledTransform], ctx() as never) } catch (e) {
        if (!(e instanceof TypeError)) throw e // (a transform that is wrong for this table is not what is checked)
        threw = true
      }
      if (use !== 'writes') expect(threw, 'a write to a row it was given').toBe(false)
      if (use === 'fresh') {
        const given = new Set<unknown>(input)
        expect(out.some((r) => given.has(r)), 'a row it was given, returned').toBe(false)
      }
      if (use === 'subset') {
        const given = new Set<unknown>(input)
        expect(out.every((r) => given.has(r)), 'only rows it was given').toBe(true)
      }
    })
  }

  it('reads the claim off the transform: unknown ops, signal ops and other types are not read-only', () => {
    expect(rowUseOf({ type: 'aggregate', ops: { signal: 'o' } } as never)).toBe('writes')
    expect(rowUseOf({ type: 'aggregate', ops: ['count', 'values'] } as never)).toBe('writes')
    expect(rowUseOf({ type: 'aggregate' } as never)).toBe('fresh')
    expect(rowUseOf({ type: 'formula', as: 'a', expr: '1' } as never)).toBe('writes')
  })
})

describe('applyTransformsToSharedRows', () => {
  const same = (a: Row[], b: Row[]): void => { expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(b))) }
  const PIPELINES: Array<Record<string, unknown>[]> = [
    [],
    [{ type: 'filter', expr: 'datum.x > 3' }],
    [{ type: 'collect', sort: { field: 'y' } }],
    [{ type: 'filter', expr: 'datum.x > 3' }, { type: 'aggregate', groupby: ['g'] }],
    [{ type: 'filter', expr: 'datum.x > 3' }, { type: 'aggregate', groupby: ['g'] }, { type: 'formula', as: 'z', expr: 'datum.count * 2' }],
    [{ type: 'filter', expr: 'datum.x > 3' }, { type: 'formula', as: 'z', expr: 'datum.x * 2' }, { type: 'aggregate', groupby: ['g'], fields: ['z'], ops: ['sum'], as: ['sz'] }],
    [{ type: 'aggregate', groupby: ['g'], fields: ['x'], ops: ['values'], as: ['v'] }],
    [{ type: 'filter', expr: 'datum.y < 2' }, { type: 'bin', field: 'x', extent: [0, 11], maxbins: 4 }],
  ]
  for (const p of PIPELINES) {
    it(JSON.stringify(p.map((t) => t.type)), () => {
      const source = make()
      const before = JSON.stringify(source)
      const t = p as unknown as CompiledTransform[]
      const got = applyTransformsToSharedRows([...source], t, ctx() as never)
      same(got, p.length ? applyTransforms(make().map((r) => ({ ...r })), t, ctx() as never) : make())
      // the source dataset's rows were not changed, and the result holds none of them
      expect(JSON.stringify(source)).toBe(before)
      const given = new Set<unknown>(source)
      expect(got.some((r) => given.has(r))).toBe(false)
    })
  }
})

describe('rows a pipeline made are its own to write onto', () => {
  const run = (t: Array<Record<string, unknown>>, rows: Row[] = make()): Row[] => applyTransforms(rows, t as unknown as CompiledTransform[], ctx() as never)

  // each chain starts with a row-making transform and goes on through writers: the later ones write onto the rows the first made
  const CHAINS: Array<Array<Record<string, unknown>>> = [
    [{ type: 'bin', field: 'x', extent: [0, 11], maxbins: 4 }, { type: 'bin', field: 'y', extent: [-6, 7], maxbins: 4, as: ['y0', 'y1'] }, { type: 'bin', field: 'id', extent: [0, 30], step: 10, as: ['i0', 'i1'] }],
    [{ type: 'formula', as: 'z', expr: 'datum.x * 2' }, { type: 'identifier', as: 'uid' }, { type: 'stack', groupby: ['g'], field: 'x' }, { type: 'formula', as: 'z', expr: 'datum.z + 1' }],
    [{ type: 'joinaggregate', groupby: ['g'], fields: ['x'], ops: ['sum'], as: ['t'] }, { type: 'window', sort: { field: 'id' }, ops: ['rank'], as: ['r'] }, { type: 'bin', field: 'x', extent: [0, 11], maxbins: 4 }],
    [{ type: 'filter', expr: 'datum.x > 3' }, { type: 'bin', field: 'x', extent: [0, 11], maxbins: 4 }, { type: 'filter', expr: 'datum.bin0 > 2' }, { type: 'identifier', as: 'uid' }],
    [{ type: 'bin', field: 'x', extent: [0, 11], maxbins: 4 }, { type: 'impute', field: 'x', key: 'id', groupby: ['g'], keyvals: [0, 1, 2, 100], method: 'mean' }, { type: 'formula', as: 'z', expr: 'datum.id' }],
    [{ type: 'bin', field: 'x', extent: [0, 11], maxbins: 4 }, { type: 'lookup', from: 'other', key: 'id', fields: ['id'], values: ['x'], as: ['ox'] }, { type: 'timeunit', field: 'id', units: ['year'], timezone: 'utc' }],
  ]
  for (const chain of CHAINS) {
    it(chain.map((t) => t.type).join(' > '), () => {
      const source = frozen()
      const before = JSON.stringify(source)
      const other = frozen()
      const c = { runtime, signals: {}, datasets: () => other } as never
      const out = applyTransforms(source, chain as unknown as CompiledTransform[], c)
      expect(JSON.stringify(source)).toBe(before) // nothing was written onto the input...
      const given = new Set<unknown>(source)
      expect(out.some((r) => given.has(r))).toBe(false) // ...and the result holds none of it
      const again = applyTransforms(source, chain as unknown as CompiledTransform[], c)
      expect(JSON.stringify(again)).toBe(JSON.stringify(out)) // so a second run over the same rows gives the same
    })
  }

  it('a window result that holds rows shows what a later transform writes onto them, as it does in Vega', () => {
    const out = run([
      { type: 'joinaggregate', groupby: ['g'], fields: ['x'], ops: ['values'], as: ['members'] },
      { type: 'formula', as: 'z', expr: 'datum.id' },
    ])
    for (const row of out) expect((row.members as Row[]).every((m) => 'z' in m)).toBe(true)
    expect(out.every((row) => (row.members as Row[]).includes(row))).toBe(true) // (a row is among the members of its own group)
  })

  it('a transform that makes new rows leaves the ones a result holds as they were', () => {
    const out = run([
      { type: 'joinaggregate', groupby: ['g'], fields: ['x'], ops: ['values'], as: ['members'] },
      { type: 'project' },
      { type: 'formula', as: 'z', expr: 'datum.id' },
    ])
    for (const row of out) expect((row.members as Row[]).some((m) => 'z' in m)).toBe(false)
  })

  it('rows a transform returns unchanged stay the input\'s: the next writer copies them', () => {
    const source = frozen()
    expect(() => applyTransforms(source, [{ type: 'collect' }, { type: 'bin', field: 'x', extent: [0, 11], maxbins: 4 }] as unknown as CompiledTransform[], ctx() as never)).not.toThrow()
    expect(() => applyTransforms(source, [{ type: 'sample', size: 5 }, { type: 'formula', as: 'z', expr: '1' }] as unknown as CompiledTransform[], ctx() as never)).not.toThrow()
  })
})
