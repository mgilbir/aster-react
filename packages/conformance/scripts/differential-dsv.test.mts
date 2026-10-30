/**
 * LIVE generated differential for the delimited-text reader and writer (d3-dsv 3.0.1): random texts over an alphabet
 * of delimiters, quotes, line breaks and literals, and random rows to format, go through the real d3-dsv and through
 * `@aster/core`'s `dsvFormat`, for the comma, semicolon, tab and pipe dialects. Rows, their `columns`, the row
 * converter calls (value, index, columns) and the formatted text must be equal, bit for bit.
 */
import { describe, expect, it } from 'vitest'
import * as d3 from 'd3-dsv'
import { dsvFormat } from '../../core/src/dsv.ts'
import { enc } from './differential-util.mts'
import { seeded } from './upstream.mts'

const DELIMITERS = [',', ';', '\t', '|']
const PIECES = ['a', 'b', 'c', '0', '1', ' ', 'é', '"', '""', '\n', '\r', '\r\n', 'x y', '__proto__', 'false', '-']

function text(r: ReturnType<typeof seeded>, delimiter: string): string {
  let s = ''
  for (let n = r.int(40); n > 0; n--) s += r.int(4) === 0 ? delimiter : r.pick(PIECES)
  return s
}

/** The rows with their `columns` annotation, in one comparable image (columns is a property of the array). */
function image(rows: unknown[] & { columns?: string[] }): unknown {
  return { rows: enc(Array.from(rows)), columns: rows.columns ?? null }
}

function duplicateProto(t: string, delimiter: string): boolean {
  try {
    d3.dsvFormat(delimiter).parse(t)
    return false
  } catch (e) {
    return e instanceof SyntaxError && /__proto__/.test(e.message)
  }
}

function run(f: () => unknown): unknown {
  try {
    return f()
  } catch (e) {
    return { threw: (e as Error).message }
  }
}

const VALUES = ['x', 'y,z', 'q"r', 'a\nb', 'a\rb', '', ' ', 1, 2.5, -0, 0, null, undefined, true, false, NaN, 'semi;colon', 'tab\tbed', 'pipe|', '"']
const DATES = [0, 1e12, 86399999, 1.7e12 + 123, 951782400000, -62198755200000, 253402300800000 + 60000, NaN, 1e15].map((t) => new Date(t))

describe('dsvFormat vs d3-dsv (generated)', () => {
  for (const delimiter of DELIMITERS) {
    const want = d3.dsvFormat(delimiter)
    const got = dsvFormat(delimiter)
    const r = seeded(delimiter.charCodeAt(0) * 31 + 7)

    it(`parse, parseRows and the row converter agree for "${JSON.stringify(delimiter).slice(1, -1)}"`, () => {
      let rowCount = 0
      let skipped = 0
      for (let i = 0; i < 3000; i++) {
        const t = text(r, delimiter)
        // d3 builds its row objects with generated code, which refuses two `__proto__` columns (a SyntaxError of the
        // generator, not a property of the format); Aster reads such a file, so those texts are not compared
        if (duplicateProto(t, delimiter)) {
          skipped++
          continue
        }
        expect(image(got.parse(t)), JSON.stringify(t)).toEqual(image(want.parse(t)))
        expect(got.parseRows(t), JSON.stringify(t)).toEqual(want.parseRows(t))
        const seen: unknown[][] = []
        const seenWant: unknown[][] = []
        const keep = (log: unknown[][]) => (row: unknown, i: number, columns?: unknown): unknown => {
          log.push([enc(row), i, columns ?? null])
          // drop every third row, rewrite the next: the converter's return value decides what is kept
          return i % 3 === 2 ? null : i % 3 === 1 ? { n: i } : row
        }
        const a = got.parse(t, keep(seen) as never)
        const b = want.parse(t, keep(seenWant) as never)
        expect(seen, JSON.stringify(t)).toEqual(seenWant)
        expect(image(a), JSON.stringify(t)).toEqual(image(b))
        const rowsA = got.parseRows(t, keep(seen) as never)
        const rowsB = want.parseRows(t, keep(seenWant) as never)
        expect(enc(rowsA)).toEqual(enc(rowsB))
        rowCount += rowsB.length
      }
      expect(rowCount).toBeGreaterThan(3000)
      expect(skipped).toBeLessThan(150)
    })

    it(`format, formatBody, formatRows and formatRow agree for "${JSON.stringify(delimiter).slice(1, -1)}"`, () => {
      for (let i = 0; i < 1500; i++) {
        const rows = Array.from({ length: r.int(5) }, () => {
          const row: Record<string, unknown> = {}
          for (const k of ['a', 'b', 'c', 'd e', 'f"g'].slice(0, 1 + r.int(5))) row[k] = r.int(6) === 0 ? r.pick(DATES) : r.pick(VALUES)
          return row
        })
        const columns = r.int(3) === 0 ? ['a', 'c', 'zz', 'f"g'] : undefined
        const tag = JSON.stringify(rows)
        expect(run(() => got.format(rows, columns)), tag).toEqual(run(() => want.format(rows, columns)))
        expect(run(() => got.formatBody(rows, columns)), tag).toEqual(run(() => want.formatBody(rows, columns)))
        const matrix = rows.map((row) => Object.values(row))
        expect(run(() => got.formatRows(matrix)), tag).toEqual(run(() => want.formatRows(matrix)))
        for (const row of matrix) expect(got.formatRow(row)).toEqual(want.formatRow(row))
        for (const v of [...VALUES, ...DATES]) expect(enc(got.formatValue(v))).toEqual(enc(want.formatValue(v)))
      }
    })
  }

  it('treats a 0 or false cell as empty in objects, as d3 does', () => {
    expect(Array.from(dsvFormat(',').parse('a,b\n0,false\n1,x'))).toEqual(Array.from(d3.csvParse('a,b\n0,false\n1,x')))
  })
})
