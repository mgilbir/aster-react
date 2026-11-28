/**
 * A value an expression made from `data(...)` holds copies of the dataset's rows, whatever way the call is spelled: the runtime
 * decides from the parsed expression which ones call `data`, not from their text. The parser reads a call of a name whatever
 * surrounds the name (parentheses, blanks, a `\uXXXX` escape), so a spelling the text pattern `\bdata\s*\(`
 * misses is still a call, and a scene returned earlier held the live rows a later append advances in place (a signal's value, an
 * item's property).
 */
import { describe, it, expect } from 'vitest'
import { compileChart } from './compiler.js'
import { createChartSession } from './session.js'
import { callsData } from './expr-reads.js'
import { callPattern, lexedText } from './expr-text.js'
import type { SceneRoot, SceneItem, SceneGroup } from './types.js'

const SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  ['plain', "data('t')"],
  ['parenthesised callee', "(data)('t')"],
  ['doubly parenthesised', "((data))('t')"],
  ['blank before the arguments', "data ('t')"],
  ['newline before the arguments', "data\n('t')"],
  ['escape in the name', "d\\u0061ta('t')"],
  ['escape in a parenthesised name', "(\\u0064ata)('t')"],
]

const specOf = (call: string) => ({
  $schema: 'https://vega.github.io/schema/vega/v6.json', width: 100, height: 100, autosize: 'none', padding: 0,
  data: [{ name: 'raw' }, { name: 't', source: 'raw', transform: [{ type: 'filter', expr: 'datum.v > 0' }] }],
  signals: [
    { name: 'k', value: 0 },
    { name: 'held', update: `{k: k, rows: ${call}, deep: [{b: [${call}]}]}` },
    { name: 'whole', update: `k >= 0 ? ${call} : null` },
  ],
  marks: [
    { type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'v' }, y: { value: 5 } } } },
    { type: 'text', encode: { update: { x: { value: 1 }, y: { value: 1 }, text: { value: 'x' }, tooltip: { signal: `{all: ${call}, pair: [${call}]}` } } } },
  ],
})

const tooltipOf = (s: SceneRoot): { all: unknown[]; pair: unknown[][] } =>
  ((s.items.find((g) => g.marktype === 'text') as SceneGroup).items as SceneItem[])[0]!.tooltip as never

describe('a value made of data(...) holds copies of the rows, in every spelling of the call', () => {
  for (const [what, call] of SPELLINGS) {
    it(what, () => {
      const session = createChartSession()
      const rows: Array<{ v: number }> = [{ v: 1 }, { v: 2 }]
      const first = session.evaluate(specOf(call) as never, { data: { raw: rows }, signals: { k: 1 } }) as SceneRoot
      const params = first.signalParams as unknown as { held: { rows: unknown[]; deep: Array<{ b: unknown[][] }> }; whole: unknown[] }
      // (the signals read the rows: a spelling the dependency scan misses read none)
      expect(params.held.rows).toHaveLength(2)
      expect(params.whole).toHaveLength(2)
      expect(tooltipOf(first).all).toHaveLength(2)

      // an append that advances the engine's rows in place
      const grown = [...rows, { v: 3 }]
      const next = session.evaluate(specOf(call) as never, {
        data: { raw: grown }, signals: { k: 2 },
        dataPulse: { raw: { appendOnly: true, baseLength: 2, added: [[2, 3]], from: [0, 1, -1], to: [0, 1] } },
      } as never) as SceneRoot
      const later = next.signalParams as unknown as typeof params
      expect(later.held.rows).toHaveLength(3)
      expect(later.whole).toHaveLength(3)
      expect(tooltipOf(next).all).toHaveLength(3)

      // the scene returned earlier did not move
      expect(params.held.rows, 'signal, in a record').toHaveLength(2)
      expect(params.held.deep[0]!.b[0], 'signal, nested').toHaveLength(2)
      expect(params.whole, 'signal, the rows themselves').toHaveLength(2)
      expect(tooltipOf(first).all, 'item property').toHaveLength(2)
      expect(tooltipOf(first).pair[0], 'item property, nested').toHaveLength(2)
    })
  }
})

describe('callsData reads the parsed call', () => {
  it('finds every spelling of a call of data, and no other call', () => {
    for (const [, call] of SPELLINGS) expect(callsData(`length(${call}) + 1`), call).toBe(true)
    for (const text of ["indata('t', 'v', 1)", "treePath('t', 1, 2)", "length('data(1)')", 'datum.data + data', "vlSelectionTest('s', datum)", '__data("t")']) expect(callsData(text), text).toBe(false)
  })
  it("reads the encoders' `_name` spelling as the evaluator does", () => {
    expect(callsData("_data('t')")).toBe(true)
    expect(callsData("(_data)('t')")).toBe(true)
  })
  it('takes text the parser refuses to call it (nothing is trusted that is not read)', () => {
    expect(callsData('data(')).toBe(true)
  })
  it('compiles the chart (the spellings are valid specs)', () => {
    for (const [, call] of SPELLINGS) expect(() => compileChart(specOf(call) as never), call).not.toThrow()
  })
})

describe('callPattern finds a call by the name the evaluator resolves', () => {
  const found = (names: string, text: string): boolean => callPattern(names).test(lexedText(text))
  it('through parentheses, blanks, escapes and the underscore spelling', () => {
    for (const text of ["(data)('t')", "((data))('t')", "data ('t')", "d\\u0061ta('t')", "_data('t')", "1 + (_data)('t')", 'a.data(1)']) expect(found('data', text), text).toBe(true)
    expect(found('now', '(now)()')).toBe(true)
    expect(found('geo[A-Za-z]*', '(geoCentroid)("p", datum)')).toBe(true)
  })
  it('and not through another name', () => {
    for (const text of ["mydata('t')", "__data('t')", "data_x('t')", 'data + 1', 'datum.data', '(data)']) expect(found('data', text), text).toBe(false)
  })
})
