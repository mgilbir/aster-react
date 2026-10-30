/**
 * GENERATED live differential of the expression PARSER: random source strings from a grammar (valid,
 * invalid, mutated), parsed by the pinned vega-expression and by Aster's `expr-parser.ts` in the same
 * process. The hand-written corpus (`differential-vega-expression.test.mts`) pins chosen cases; this
 * one sweeps the space between them.
 *
 *   - random: accept or reject, the error class, message, `index` and `description`; an accepted pair
 *     must also agree on the tree (vega's own annotations stripped: the tree shape is Aster's own).
 *   - exhaustive: every UTF-16 code unit as an identifier start/part, a string character, whitespace,
 *     raw and \u-escaped; the Unicode tables are the accepted-set contract.
 *   - precedence: every pair of binary operators, chained and mixed with `?:` and unary operators.
 *
 * The interpreter's counterpart is `differential-vega-interpreter-gen.test.mts`.
 * Seeds are fixed; set `ASTER_EXPR_FUZZ_SEED` / `ASTER_EXPR_FUZZ_N` to hunt with fresh ones.
 */
import { describe, expect, it } from 'vitest'
import * as ve from 'vega-expression'
import { parseExpression } from '../../core/src/expr-parser.ts'
import { enc } from './differential-util.mts'
import { canon, mkCleanSource, mkSource, OPS, rng } from './expression-gen.mts'

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- parse comparison ----------------------------------------------------------------------------

const parseOutcome = (parse: (c: string) => unknown, code: string): unknown => {
  try {
    return { ok: enc(canon(parse(code))) }
  } catch (e: any) {
    return { err: { name: e?.name, message: e?.message, index: e?.index, description: e?.description } }
  }
}
const vegaParse = (code: string): unknown => parseOutcome(ve.parseExpression, code)
const asterParse = (code: string): unknown => parseOutcome(parseExpression as (c: string) => unknown, code)

const SEED = process.env.ASTER_EXPR_FUZZ_SEED ? Number(process.env.ASTER_EXPR_FUZZ_SEED) : 0xA57E12
const N = process.env.ASTER_EXPR_FUZZ_N ? Number(process.env.ASTER_EXPR_FUZZ_N) : 30000

describe('generated: vega-expression vs Aster expr-parser', () => {
  it(`agrees on accept/reject, error message, index and tree over ${N} random sources`, () => {
    const r = rng(SEED)
    let accepted = 0
    const messages = new Set<string>()
    const bad: string[] = []
    for (let i = 0; i < N; i++) {
      const code = i % 2 === 0 ? mkSource(r) : mkCleanSource(r)
      const want = vegaParse(code) as any
      const got = asterParse(code)
      if ('ok' in want) accepted++
      else messages.add(want.err.message)
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`${JSON.stringify(code)}\n   vega:  ${JSON.stringify(want)}\n   aster: ${JSON.stringify(got)}`)
        if (bad.length >= 8) break
      }
    }
    expect(bad).toEqual([])
    // the generator is not degenerate: it reaches both outcomes and many distinct diagnostics
    expect(accepted).toBeGreaterThan(N * 0.15)
    expect(accepted).toBeLessThan(N * 0.85)
    expect(messages.size).toBeGreaterThanOrEqual(14)
  })

  it('agrees on every UTF-16 code unit as identifier start/part, in a string, as whitespace, raw and \\u-escaped', () => {
    const bad: string[] = []
    for (let cu = 0; cu <= 0xFFFF; cu++) {
      const ch = String.fromCharCode(cu)
      const hex = cu.toString(16).padStart(4, '0')
      const forms = [ch, `a${ch}`, `a${ch}b`, `"${ch}"`, `\\u${hex}`, `a\\u${hex}`, `1${ch}`, `/a${ch}/${ch}`, `a.${ch}`, `{${ch}:1}`]
      for (const code of forms) {
        const want = JSON.stringify(vegaParse(code))
        const got = JSON.stringify(asterParse(code))
        if (got !== want && bad.length < 8) bad.push(`${JSON.stringify(code)}\n   vega:  ${want}\n   aster: ${got}`)
      }
    }
    expect(bad).toEqual([])
  }, 120_000)

  it('agrees on astral characters (surrogate pairs) as identifier parts and in escapes', () => {
    const bad: string[] = []
    for (let cp = 0x10000; cp <= 0x10FFFF; cp += 0x101) {
      const ch = String.fromCodePoint(cp)
      for (const code of [ch, `a${ch}`, `"${ch}"`, `"\\u{${cp.toString(16)}}"`, `\\u{${cp.toString(16)}}`, `/${ch}/u`]) {
        const want = JSON.stringify(vegaParse(code))
        const got = JSON.stringify(asterParse(code))
        if (got !== want && bad.length < 8) bad.push(`${JSON.stringify(code)}\n   vega:  ${want}\n   aster: ${got}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('agrees on operator precedence and associativity (every operator pair, both orders, chained)', () => {
    const ops = OPS.filter((o) => o !== 'in' && o !== 'instanceof').concat(['in', 'instanceof'])
    const bad: string[] = []
    for (const p of ops) for (const q of ops) {
      for (const code of [`a ${p} b ${q} c`, `a ${p} b ${q} c ${p} d`, `!a ${p} -b ${q} ~c`, `a ? b ${p} c : d ${q} e`, `a ${p} b ? c : d ${q} e`]) {
        if (JSON.stringify(asterParse(code)) !== JSON.stringify(vegaParse(code)) && bad.length < 8) bad.push(code)
      }
    }
    expect(bad).toEqual([])
  })
})

