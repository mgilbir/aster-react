/**
 * A group item positioned by a string that is no number on ONE axis (`"15px"`, 32.61): vega's canvas draws its content untranslated (a
 * translate that is not two numbers is ignored) and asks the bounds of what it holds at the pointer less the position -- NaN on the axis
 * that is no number, which no edge excludes, and the pointer less the position on the other, where the bounds still do. The index used to
 * drop the bounds test on both axes there (224 and 690 of the 1650 points below are wrong without the fix).
 *
 * The grids are what vega's own canvas pick answered in Chromium (vega 6.3.1, `view._handler.pick`, a point every 6 px from (3, 3);
 * the digit is the id of the image row it picked, `.` nothing): the generated geometry spec of seed 3 of `pnpm conformance:geometry`,
 * reduced to its one group mark, and the same group with the position the other way round (x a number, y the string).
 */
import { describe, expect, it } from 'vitest'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { buildHitIndex } from '@aster-charts/core/hit'

const IMAGE = {"type":"image","name":"m6","from":{"data":"d_m6"},"encode":{"update":{"x":{"signal":"[267.28,217.15,201.24,43.94,'216px',178.23][datum.i]"},"y":{"signal":"[110.84,-1/0,110.19,51.15,14.4,17.66][datum.i]"},"url":{"value":"data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="},"width":{"signal":"[42.97,31.05,36.3,1.11,-3.5,NaN][datum.i]"},"height":{"signal":"[1e-7,1/0,1/0,53.58,1/0,56.4][datum.i]"},"stroke":{"value":"red"}}}}
const data = [
  { name: 'd_g5', values: [{ i: 0, id: 'r0' }, { i: 1, id: 'r1' }, { i: 2, id: 'r2' }] },
  { name: 'd_m6', values: [0, 1, 2, 3, 4, 5].map((i) => ({ i, id: 'r' + i })) },
]
const groupAt = (x: string, y: string): Record<string, unknown> => ({
  type: 'group', name: 'g5', from: { data: 'd_g5' },
  encode: { update: { x: { signal: x }, y: { signal: y }, width: { signal: '[60,60,0][datum.i]' }, height: { signal: '[50,90,94.21][datum.i]' }, stroke: { value: '#888' } } },
  marks: [IMAGE],
})
const spec = (x: string, y: string): never => ({ width: 300, height: 200, padding: 5, autosize: 'none', data, marks: [groupAt(x, y)] }) as never

const VEGA = {
  /** x: "15px", y: 32.61 */
  'x is no number': [
    "......................1111111111111111111111111111",
    "......................1111111111111111111111111111",
    "......................1111111111111111111111111111",
    "......................1111111444444444444444444444",
    "......................1111111444444444444444444444",
    "......................1111111444444444444444444444",
    "......................1111111444444444444444444444",
    "......................1111111444444444444444444444",
    "......................1111111444444444444444444444",
    "......................5555555444444444444444444444",
    "......................5555555444444444444444444444",
    "......................5555555444444444444444444444",
    "......................5555555444444444444444444444",
    "......................5555555444444444444444444444",
    "......................5555555444444444444444444444",
    "......................5555555444444444444444444444",
    "......................5555555444444444444444444444",
    "......................5555555444444444444444444444",
    "......................5555555444444444444444444444",
    "......................4444444444444444444444444444",
    "......................4444444444444444444444444444",
    "......................4444444444444444444444444444",
    "......................4444444444444444444444444444",
    "......................4444444444444444444444444444",
    "......................4444444444444444444444444444",
    "......................4444444444444444444444444444",
    "......................4444444444444444444444444444",
    "......................4444444444444444444444444444",
    "......................4444444444444444444444444444",
    "......................4444444444444444444444444444",
    "......................4444444444444444444444444444",
    "......................4444444444444444444444444444",
    "......................4444444444444444444444444444",
  ],
  /** x: 48, y: "7px" */
  'y is no number': [
    "................4444444444444444444444455555555555",
    "................4444444444444444444444455555555555",
    "................4444444444444444444444455555555555",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
    "................4444444444444444444444444444444444",
  ],
}
const SPECS: Record<string, never> = {
  'x is no number': spec("[146.04,'15px',127.36][datum.i]", '[-0,32.61,-2.26][datum.i]'),
  'y is no number': spec('[146.04,48,127.36][datum.i]', "[-0,'7px',-2.26][datum.i]"),
}

describe('the canvas index of a group positioned by a string that is no number on one axis', () => {
  for (const [name, grid] of Object.entries(VEGA)) {
    it(`${name}: every one of ${grid.length * 50} points picks what vega's canvas picks`, () => {
      const index = buildHitIndex(evaluateChart(compileChart(structuredClone(SPECS[name]!)), {}), undefined, { renderer: 'canvas' })
      const wrong: string[] = []
      grid.forEach((row, r) => {
        for (let c = 0; c < row.length; c++) {
          const hit = index.pick(3 + 6 * c, 3 + 6 * r)
          const got = hit ? String((hit.item as { datum?: { i?: number } }).datum?.i) : '.'
          if (got !== row[c]) wrong.push(`(${3 + 6 * c}, ${3 + 6 * r}): vega ${row[c]}, index ${got}`)
        }
      })
      expect(wrong.slice(0, 5)).toEqual([])
      expect(wrong.length).toBe(0)
      // not vacuous: the picks are several rows, and the points that pick none are many
      expect(new Set(grid.join('')).size).toBeGreaterThanOrEqual(3)
    })
  }
})
