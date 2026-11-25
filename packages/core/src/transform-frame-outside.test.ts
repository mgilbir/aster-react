/**
 * Where vega's transforms read a row that is not there they fail with the engine's own TypeError (a window frame that ends outside
 * its partition, a `flatten` of a field a row does not hold). Here the window answers (an empty frame has no first or last value:
 * `null`, as `nth_value` of a frame too short) and the flatten says which field of which row; neither is a raw engine error.
 * The live comparison with vega, counted over generated cases, is differential-transforms-generated.test.mts.
 */
import { describe, expect, it } from 'vitest'
import { windowRows } from './transform-window.js'
import { flattenRows } from './transform-basic.js'
import { flattenSize } from './incremental-state.js'

const rows = [{ g: 'a', v: 3, w: 1 }, { g: 'a', v: 1, w: 2 }, { g: 'a', v: 2, w: 3 }, { g: 'a', v: 2, w: 4 }]
const out = (t: Record<string, unknown>): unknown[][] => windowRows(rows, { sort: { field: 'v' }, ...t } as never).map((r) => Object.values(r).slice(3))

describe('a window frame that ends outside its partition', () => {
  for (const ignorePeers of [true, false]) {
    it(`gives null for the first and last value of a frame with no row at that end (ignorePeers: ${ignorePeers})`, () => {
      // after the last row, before the first, and inverted (it starts after it ends)
      // (input order: the first row sorts last, so its frame starts after the partition's end; the others have a first row)
      expect(out({ ops: ['first_value'], fields: ['w'], frame: [1, null], ignorePeers }).map((r) => r[0])).toEqual([null, expect.any(Number), expect.any(Number), expect.any(Number)])
      // (the row that sorts first ends its frame before the partition)
      expect(out({ ops: ['last_value'], fields: ['w'], frame: [null, -1], ignorePeers })[1]).toEqual([null])
      // (wholly after the partition: no first row, the last is the partition's own; wholly before: the other way round)
      expect(out({ ops: ['first_value', 'last_value'], fields: ['w', 'w'], frame: [5, 7], ignorePeers }).map((r) => r[0])).toEqual(rows.map(() => null))
      expect(out({ ops: ['first_value', 'last_value'], fields: ['w', 'w'], frame: [5, 7], ignorePeers }).map((r) => r[1])).toEqual(rows.map(() => expect.any(Number)))
      expect(out({ ops: ['first_value', 'last_value'], fields: ['w', 'w'], frame: [-7, -5], ignorePeers }).map((r) => r[1])).toEqual(rows.map(() => null))
      expect(out({ ops: ['first_value', 'last_value'], fields: ['w', 'w'], frame: [-7, -5], ignorePeers }).map((r) => r[0])).toEqual(rows.map(() => expect.any(Number)))
    })
    it(`does not fail on the bag of an aggregate that reads rows the frame dropped without holding them (ignorePeers: ${ignorePeers})`, () => {
      for (const frame of [[2, -1], [3, 0], [1, null], [-5, -3], [4, 1]]) {
        for (const op of ['q1', 'median', 'ci0', 'distinct', 'max', 'min', 'argmax']) {
          expect(() => out({ ops: [op], fields: ['v'], frame, ignorePeers }), `${op} over ${JSON.stringify(frame)}`).not.toThrow()
        }
      }
    })
  }
})

describe('flatten of a field a row does not hold', () => {
  it('names the field, and is the TypeError vega gives', () => {
    for (const hole of [undefined, null]) {
      const data = [{ a: [1, 2] }, { a: hole }]
      expect(() => flattenRows(data, { fields: ['a'] })).toThrow(TypeError)
      expect(() => flattenRows(data, { fields: ['a'] })).toThrow(/^\[aster\] flatten: a row holds (null|undefined) in the field "a"/)
      expect(() => flattenSize(data[1]!, ['a'])).toThrow(/^\[aster\] flatten: .*"a"/)
    }
    // a field that is there but no array is read as vega reads it (its length, if it has one)
    expect(flattenRows([{ a: 'xy' }, { a: 5 }], { fields: ['a'] })).toHaveLength(2)
  })
})
