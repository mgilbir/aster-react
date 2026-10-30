/**
 * LIVE generated differential for data formats (vega-loader 5.1.2): type inference over random columns, the type
 * parsers over random values, and `readData` against vega-loader's `read` over random csv / tsv / dsv / json inputs
 * with every form of `parse` (none, `auto`, per-field types, `date:` / `utc:` patterns). The rows, the types and the
 * errors thrown for an illegal pattern must be equal, NaN, -0 and Dates told apart.
 */
import { describe, expect, it } from 'vitest'
import '../../core/src/addon-load.ts'
import { inferType, inferTypes, readData, typeParsers } from '../../core/src/data-format.ts'
import { enc } from './differential-util.mts'
import { importChain, seeded } from './upstream.mts'

const loader: any = await importChain('vega', 'vega-loader')

const VALUES: unknown[] = [
  'true', 'false', true, false, 1, 0, -0, '1', '1.5', '-2', '', ' ', 'abc', null, undefined, NaN, '2020-01-01', '2020-01-01T10:00:00Z', '12/31/2020',
  new Date(0), new Date(NaN), 'NaN', '1e3', '0x10', '0b11', 'TRUE', 'True', [], {}, [1], [1, 2], '-', Infinity, '-Infinity', 'Infinity', '  7  ', '1,5', '٣', 2 ** 53, '9007199254740993', 'null',
]

function image(f: () => unknown): unknown {
  try {
    return enc(f())
  } catch (e) {
    // Aster's messages carry an `[aster]` prefix and a lower-case start; what follows must be the same
    return { threw: String((e as Error).message).replace(/^\[aster\] /, '').replace(/^./, (c) => c.toLowerCase()) }
  }
}

describe('type inference and parsers vs vega-loader (generated)', () => {
  it('inferType agrees over random columns', () => {
    const r = seeded(5)
    const seen = new Set<string>()
    for (let i = 0; i < 20000; i++) {
      const column = Array.from({ length: r.int(6) }, () => r.pick(VALUES))
      const rows = column.map((f) => ({ f }))
      const want = loader.inferType(rows, 'f')
      expect(inferType(rows, 'f'), JSON.stringify(column.map(String))).toBe(want)
      expect(inferType(column), JSON.stringify(column.map(String))).toBe(loader.inferType(column))
      seen.add(want)
    }
    // every outcome occurs, or the comparison is blind to one of them
    expect([...seen].sort()).toEqual(['boolean', 'date', 'integer', 'number', 'string', 'unknown'])
  })

  it('inferTypes agrees over random tables', () => {
    const r = seeded(6)
    for (let i = 0; i < 2000; i++) {
      const rows = Array.from({ length: 1 + r.int(5) }, () => ({ a: r.pick(VALUES), b: r.pick(VALUES), c: r.pick(['1', '2', '3']) }))
      expect(inferTypes(rows, ['a', 'b', 'c', 'zz'])).toEqual(loader.inferTypes(rows, ['a', 'b', 'c', 'zz']))
    }
  })

  it('every type parser agrees on every value', () => {
    for (const type of ['boolean', 'integer', 'number', 'date', 'string', 'unknown']) {
      for (const v of VALUES) {
        expect(image(() => typeParsers[type]!(v)), `${type} ${String(v)}`).toEqual(image(() => loader.typeParsers[type](v)))
      }
    }
    expect(Object.keys(typeParsers).sort()).toEqual(Object.keys(loader.typeParsers).sort())
  })
})

describe('readData vs vega-loader read (generated)', () => {
  const CELLS = ['1', '2.5', '-3', '', 'true', 'false', 'x', 'hello world', '2020-02-29', '12/31/1999', '0', '1e3', '"quoted, cell"', '2021-13-45', ' 4 ']
  const PARSES: unknown[] = [
    undefined, 'auto',
    { a: 'number', b: 'boolean' }, { a: 'integer', c: 'string' }, { b: 'date', c: 'number' },
    { a: 'date:"%Y-%m-%d"', b: "utc:'%d/%m/%Y'" }, { a: 'date:%m/%d/%Y', c: 'utc:%Y-%m-%d' }, { a: 'unknown' }, { a: 'nonsense' }, { zz: 'number' },
  ]

  it('csv, tsv and dsv inputs read to the same rows', () => {
    const r = seeded(7)
    let compared = 0
    for (let i = 0; i < 1500; i++) {
      const type = r.pick(['csv', 'tsv', 'dsv'])
      const delimiter = type === 'csv' ? ',' : type === 'tsv' ? '\t' : ';'
      const cell = () => { const c = r.pick(CELLS); return c.includes('"') ? c : delimiter === ',' ? c.replace(/,/g, ' ') : c }
      const lines = [['a', 'b', 'c'].join(delimiter)]
      for (let n = r.int(6); n > 0; n--) lines.push([cell(), cell(), cell()].join(delimiter))
      const text = lines.join(r.pick(['\n', '\r\n'])) + r.pick(['', '\n'])
      const format = { type, ...(type === 'dsv' ? { delimiter } : {}), ...(r.int(3) ? { parse: r.pick(PARSES) } : {}) } as Record<string, unknown>
      const tag = JSON.stringify([text, format])
      expect(image(() => readData(text, format as never)), tag).toEqual(image(() => loader.read(text, structuredClone(format))))
      compared++
    }
    expect(compared).toBe(1500)
  })

  it('json inputs read to the same rows, with and without a property path', () => {
    const r = seeded(8)
    for (let i = 0; i < 1500; i++) {
      const rows = Array.from({ length: r.int(5) }, () => ({ a: r.pick(VALUES.filter((v) => !(v instanceof Date))), b: r.pick(CELLS), c: r.pick(CELLS) }))
      const wrapped = r.pick([rows, { values: rows }, { deep: { values: rows } }])
      const property = wrapped === rows ? undefined : wrapped.values ? 'values' : 'deep.values'
      const format = { type: 'json', ...(property ? { property } : {}), ...(r.int(3) ? { parse: r.pick(PARSES) } : {}) }
      const input = r.int(2) ? JSON.stringify(wrapped) : wrapped
      const tag = JSON.stringify([input, format])
      expect(image(() => readData(input, format as never)), tag).toEqual(image(() => loader.read(typeof input === 'string' ? input : structuredClone(input), structuredClone(format))))
    }
  })
})
