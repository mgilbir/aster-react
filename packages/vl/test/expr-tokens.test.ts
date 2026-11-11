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

describe('the tokenizer on any text (a spec may be untrusted)', () => {
  // Termination: every pass of the loop in `tokenize` either moves past at least one character (a blank, a string to its closing quote
  // or the end, a name of at least one character or the single start character, a number, a regular expression literal of at least
  // its slash, or one character as punctuation) or the loop ends; `stringValue` moves past at least one character per pass too.
  const B = String.fromCharCode(92)
  const ADVERSARIAL: Array<[string, string]> = [
    ['unterminated strings', `"abc ${B}" 'def`],
    ['regex-like text', '/a[/b/ / /[/ 1 / 2 /'],
    ['lone backslashes', `${B}${B} ${B} a${B}`],
    ['a short unicode escape', `${B}u12 ${B}u "${B}u1" '${B}x1'`],
    ['an unclosed code point escape', `"${B}u{1234 ${B}u{" ${B}u{110000}`],
    ['surrogate halves', `${String.fromCharCode(0xd800)}a${String.fromCharCode(0xdc00)} "${String.fromCharCode(0xdbff)}"`],
    ['NUL', `a${String.fromCharCode(0)}b "${String.fromCharCode(0)}"`],
    ['names that start with an escape', `${B}u0061 ${B}u00zz ${B}`],
  ]
  for (const [what, text] of ADVERSARIAL) {
    it(`ends, and gives every character back: ${what}`, () => {
      expect(tokenize(text).map((t) => t.raw).join('')).toBe(text)
      // (and repeated to a megabyte, in time)
      const big = text.repeat(Math.ceil(1_000_000 / text.length))
      const t0 = performance.now()
      const tokens = tokenize(big)
      expect(performance.now() - t0).toBeLessThan(5_000)
      expect(tokens.map((t) => t.raw).join('')).toBe(big)
    })
  }

  it('ends on random text, and gives every character back', () => {
    let seed = 7
    const next = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed }
    const alphabet = [B, '"', "'", '/', '[', ']', 'u', '{', '}', 'x', '0', 'a', ' ', '.', '(', String.fromCharCode(0xd800), String.fromCharCode(0)]
    for (let n = 0; n < 2000; n++) {
      const text = Array.from({ length: next() % 40 }, () => alphabet[next() % alphabet.length]).join('')
      expect(tokenize(text).map((t) => t.raw).join(''), JSON.stringify(text)).toBe(text)
    }
  })

  it('costs time linear in the length of the text', () => {
    const unit = `a + "b${B}u0063" / 2 ${B}u0064(1.5e3) `
    const time = (n: number): number => {
      const text = unit.repeat(Math.ceil(n / unit.length))
      const t0 = performance.now()
      tokenize(text)
      return performance.now() - t0
    }
    time(100_000)
    const small = Math.max(time(100_000), 1)
    const big = time(1_000_000)
    // (ten times the text: linear is ten times the time; a quadratic cost would be a hundred)
    expect(big / small).toBeLessThan(40)
  })
})
