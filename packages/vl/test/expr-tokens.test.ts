import { describe, expect, it } from 'vitest'
import { tokenize } from '../src/expr-tokens.js'
import { relabelUnits, renameExpr } from '../src/embed.js'

const BS = String.fromCharCode(92)
/** `name` spelled with one escape per character. */
const escaped = (name: string): string => [...name].map((c) => `${BS}u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')

describe('the tokens of an expression, as vega reads them', () => {
  it('reads a name with escapes as the name it spells, and past ASCII', () => {
    const names = tokenize(`${escaped('width')} + gr${String.fromCharCode(0xf6)}${String.fromCharCode(0xdf)}e`).filter((t) => t.kind === 'name').map((t) => t.value)
    expect(names).toEqual(['width', `gr${String.fromCharCode(0xf6)}${String.fromCharCode(0xdf)}e`])
  })

  it('reads a string whole, its escapes decoded, and a regular expression whole', () => {
    const t = tokenize(`test(/a"b/, "x${BS}u0079" + 'it${BS}'s')`)
    expect(t.filter((x) => x.kind === 'regexp').map((x) => x.raw)).toEqual(['/a"b/'])
    expect(t.filter((x) => x.kind === 'string').map((x) => x.value)).toEqual(['xy', "it's"])
  })

  it('gives every character back: the tokens spell the text', () => {
    const text = `a.b + ${escaped('c')}("d", 1.5e3) / 2 ? {e: f} : [g]`
    expect(tokenize(text).map((t) => t.raw).join('')).toBe(text)
  })
})

describe('renameExpr', () => {
  const r = { signals: new Map([['width', 'concat_0_width']]), scales: new Map([['x', 'concat_0_x']]), datasets: new Map([['data_1', 'data_7']]) }
  it('renames a name however it is spelled, and the scale or dataset a call names by a literal', () => {
    expect(renameExpr(`${escaped('width')} + sc${BS}u0061le('x', 1) + length(data("dat${BS}u0061_1"))`, r)).toBe(`concat_0_width + sc${BS}u0061le('concat_0_x', 1) + length(data("data_7"))`)
  })
  it('leaves a property, a call, an object key and the text of a string alone', () => {
    expect(renameExpr(`a.width + width(1) + {width: 2}.width + "width"`, r)).toBe(`a.width + width(1) + {width: 2}.width + "width"`)
  })
})

describe('relabelUnits', () => {
  const keep = (): boolean => false
  it('relabels the unit a tuple names and the mark a group call reads, however spelled, and nothing in a string', () => {
    expect(relabelUnits(`${escaped('unit')} === "layer_0" && group("cell") && "unit: \\"x\\""`, keep, keep, 'outer_'))
      .toBe(`${escaped('unit')} === "outer_layer_0" && group("outer_cell") && "unit: \\"x\\""`)
  })
})
