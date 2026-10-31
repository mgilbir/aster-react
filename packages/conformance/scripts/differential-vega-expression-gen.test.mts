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

interface Outcome { ok?: unknown; err?: { name: unknown; message: unknown; index: unknown; description: unknown } }

const parseOutcome = (parse: (c: string) => unknown, code: string): Outcome => {
  try {
    return { ok: canon(parse(code)) }
  } catch (e: any) {
    return { err: { name: e?.name, message: e?.message, index: e?.index, description: e?.description } }
  }
}
const vegaParse = (code: string): Outcome => parseOutcome(ve.parseExpression, code)
const asterParse = (code: string): Outcome => parseOutcome(parseExpression as (c: string) => unknown, code)

/**
 * Exact structural equality of two canonical trees (or error records), without building the tagged image
 * of both and serialising it: NaN equals NaN, -0 is not 0, undefined is not an absent key, a RegExp is its
 * source and flags, and key order does not matter. It is the same relation as comparing `enc` images
 * (profiled: encoding and stringifying both sides was a quarter of the time of this file's main test).
 */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (a instanceof RegExp || b instanceof RegExp) return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const y = b as unknown[]
    if (a.length !== y.length) return false
    for (let i = 0; i < a.length; i++) if (!same(a[i], y[i])) return false
    return true
  }
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}
const show = (o: Outcome): string => JSON.stringify('ok' in o ? { ok: enc(o.ok) } : o)

const SEED = process.env.ASTER_EXPR_FUZZ_SEED ? Number(process.env.ASTER_EXPR_FUZZ_SEED) : 0xA57E12
const N = process.env.ASTER_EXPR_FUZZ_N ? Number(process.env.ASTER_EXPR_FUZZ_N) : 30000
/** Sources per test: ~0.3 s of work alone, so a loaded machine has to be 15x slower before vitest's 5 s default bites. */
const CHUNK = 2500

/** The N sources, generated once, in order, from the one seeded stream (the same 30000 whatever the chunking). */
let SOURCES: string[] | null = null
const sources = (): string[] => {
  if (SOURCES) return SOURCES
  const r = rng(SEED)
  SOURCES = Array.from({ length: N }, (_, i) => (i % 2 === 0 ? mkSource(r) : mkCleanSource(r)))
  return SOURCES
}

describe('generated: vega-expression vs Aster expr-parser', () => {
  it('the comparison tells apart what the tagged image tells apart', () => {
    const re = (flags: string): RegExp => new RegExp('a', flags)
    expect(same({ a: [1, { b: NaN }], c: re('g') }, { c: re('g'), a: [1, { b: NaN }] })).toBe(true)
    for (const [x, y] of [
      [0, -0], [NaN, 0], [1, '1'], [null, undefined], [{ a: undefined }, {}], [{ a: 1 }, { a: 1, b: 2 }], [{ a: 1, b: 2 }, { a: 1, c: 2 }],
      [[1, 2], [1, 2, 3]], [[1], { 0: 1 }], [re('g'), re('i')], [re('g'), 'a'], [{ v: re('g') }, { v: new RegExp('b', 'g') }], [1n, 1],
    ] as Array<[unknown, unknown]>) {
      expect(same(x, y), `${String(x)} vs ${String(y)}`).toBe(false)
      expect(same(y, x)).toBe(false)
    }
  })

  for (let from = 0; from < N; from += CHUNK) {
    const to = Math.min(N, from + CHUNK)
    it(`agrees on accept/reject, error message, index and tree over random sources ${from}..${to - 1} of ${N}`, () => {
      const codes = sources().slice(from, to)
      let accepted = 0
      const messages = new Set<string>()
      const bad: string[] = []
      for (const code of codes) {
        const want = vegaParse(code)
        const got = asterParse(code)
        if ('ok' in want) accepted++
        else messages.add(want.err!.message as string)
        if (!same(got, want)) {
          bad.push(`${JSON.stringify(code)}\n   vega:  ${show(want)}\n   aster: ${show(got)}`)
          if (bad.length >= 8) break
        }
      }
      expect(bad).toEqual([])
      // the generator is not degenerate: it reaches both outcomes and many distinct diagnostics in every chunk
      // (measured per chunk of 2500: 60-62% accepted, 26-35 distinct messages)
      expect(accepted).toBeGreaterThan(codes.length * 0.15)
      expect(accepted).toBeLessThan(codes.length * 0.85)
      expect(messages.size).toBeGreaterThanOrEqual(14)
    })
  }

  it('agrees on every UTF-16 code unit as identifier start/part, in a string, as whitespace, raw and \\u-escaped', () => {
    const bad: string[] = []
    for (let cu = 0; cu <= 0xFFFF; cu++) {
      const ch = String.fromCharCode(cu)
      const hex = cu.toString(16).padStart(4, '0')
      const forms = [ch, `a${ch}`, `a${ch}b`, `"${ch}"`, `\\u${hex}`, `a\\u${hex}`, `1${ch}`, `/a${ch}/${ch}`, `a.${ch}`, `{${ch}:1}`]
      for (const code of forms) {
        const want = vegaParse(code)
        const got = asterParse(code)
        if (!same(got, want) && bad.length < 8) bad.push(`${JSON.stringify(code)}\n   vega:  ${show(want)}\n   aster: ${show(got)}`)
      }
    }
    expect(bad).toEqual([])
  }, 120_000)

  it('agrees on astral characters (surrogate pairs) as identifier parts and in escapes', () => {
    const bad: string[] = []
    for (let cp = 0x10000; cp <= 0x10FFFF; cp += 0x101) {
      const ch = String.fromCodePoint(cp)
      for (const code of [ch, `a${ch}`, `"${ch}"`, `"\\u{${cp.toString(16)}}"`, `\\u{${cp.toString(16)}}`, `/${ch}/u`]) {
        const want = vegaParse(code)
        const got = asterParse(code)
        if (!same(got, want) && bad.length < 8) bad.push(`${JSON.stringify(code)}\n   vega:  ${show(want)}\n   aster: ${show(got)}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('agrees on operator precedence and associativity (every operator pair, both orders, chained)', () => {
    const ops = OPS.filter((o) => o !== 'in' && o !== 'instanceof').concat(['in', 'instanceof'])
    const bad: string[] = []
    for (const p of ops) for (const q of ops) {
      for (const code of [`a ${p} b ${q} c`, `a ${p} b ${q} c ${p} d`, `!a ${p} -b ${q} ~c`, `a ? b ${p} c : d ${q} e`, `a ${p} b ? c : d ${q} e`]) {
        if (!same(asterParse(code), vegaParse(code)) && bad.length < 8) bad.push(code)
      }
    }
    expect(bad).toEqual([])
  })
})

