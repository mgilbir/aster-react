/**
 * LIVE differential for the expression language (ADR-0001 suite formerly recorded as
 * `vega-expression.json`), all five kinds: `parse` / `parseError` (the pinned vega-expression
 * parser vs Aster's `expr-parser.ts`, ASTs compared whole, errors by class and message) and
 * `evalLang` / `evalDatum` / `evalSecurity` (the pinned vega-interpreter vs Aster's
 * `expr-interpreter.ts`, both with an empty host function table so each side's own default
 * table supplies the core). Same process, same engine, same inputs (`vega-expression-cases.mjs`).
 *
 * The parser kinds are engine-independent (strings in, strings and number literals out), but
 * they are live as well: it costs nothing, and the eval kinds are NOT engine-independent (pow,
 * sqrt, the Math functions of the default table, and the V8 wording of the TypeErrors that the
 * `evalSecurity` cases pin: "Cannot read properties of null"), so nothing here is recorded.
 */
import { describe, expect, it } from 'vitest'
import * as ve from 'vega-expression'
import * as vi from 'vega-interpreter'
import { parseExpression } from '../../core/src/expr-parser.ts'
import { interpret } from '../../core/src/expr-interpreter.ts'
import { exact, withTz } from './differential-util.mts'
import { evalCodes, evalDatum, evalErrorCodes, evalLangCodes, evalParams, parseCodes, parseErrorCodes } from './vega-expression-cases.mjs'

/* eslint-disable @typescript-eslint/no-explicit-any */
const viaVega = (code: string, datum: unknown, params: unknown) => exact(() => {
  const ast = ve.parseExpression(code)
  const evalParam = (vi as any).expressionInterpreter.parameter({ functions: {} }, { ast })
  return evalParam(datum, params)
})
const viaAster = (code: string, datum: unknown, params: unknown) => exact(() =>
  interpret(parseExpression(code), {}, (params ?? {}) as Record<string, unknown>, datum))

const sizes = { parse: 92, parseError: 23, evalLang: 74, evalDatum: 18, evalSecurity: 10 }

describe('vega-expression / vega-interpreter vs Aster expr-parser + expr-interpreter (live)', () => {
  const parseSuites: Array<[string, string[]]> = [['parse', parseCodes], ['parseError', parseErrorCodes]]
  for (const [suite, codes] of parseSuites) {
    for (const code of codes) {
      it(`${suite}: ${JSON.stringify(code)}`, () => {
        const want = exact(() => ve.parseExpression(code))
        expect(exact(() => parseExpression(code))).toEqual(want)
      })
    }
  }

  const evalSuites: Array<[string, string[], unknown, unknown]> = [
    ['evalLang', evalLangCodes, undefined, {}],
    ['evalDatum', evalCodes, evalDatum, evalParams],
    ['evalSecurity', evalErrorCodes, evalDatum, {}],
  ]
  for (const [suite, codes, datum, params] of evalSuites) {
    for (const code of codes) {
      it(`${suite}: ${JSON.stringify(code)}`, () =>
        withTz('UTC', () => {
          const want = viaVega(code, structuredClone(datum), structuredClone(params))
          expect(viaAster(code, structuredClone(datum), structuredClone(params))).toEqual(want)
        }))
    }
  }

  it('keeps the recorded suite sizes (coverage floor)', () => {
    expect(parseCodes.length).toBeGreaterThanOrEqual(sizes.parse)
    expect(parseErrorCodes.length).toBeGreaterThanOrEqual(sizes.parseError)
    expect(evalLangCodes.length).toBeGreaterThanOrEqual(sizes.evalLang)
    expect(evalCodes.length).toBeGreaterThanOrEqual(sizes.evalDatum)
    expect(evalErrorCodes.length).toBeGreaterThanOrEqual(sizes.evalSecurity)
  })
})
