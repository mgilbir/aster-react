/**
 * LIVE differential for which functions an expression may call. vega's parser refuses a call of a name its code generator has no
 * function for (`Unrecognized function: foo`), when the spec is parsed. Every name either engine knows, and the near misses of each
 * (an underscore in front, a name every object has, a name vega never had; vega's parser fails on a few of the names every object has with a message of the JavaScript engine, which Aster does not copy), is called with no argument, one (the name of a data set the spec has) and three; Aster must
 * compile exactly what vega parses and refuse the rest with the same message.
 *
 * Where Aster has no implementation of a function vega has (the logging functions, the lasso tools...), or the function lives in an
 * add-on that a plain compile has not loaded, the compile still accepts it, as vega does: running it is where it can fail.
 */
import { describe, expect, it } from 'vitest'
import { ADDON_FUNCTIONS } from '../../core/src/addon-functions.ts'
import { expressionFunctionNames, isExpressionFunction, UNWRITTEN_FUNCTIONS } from '../../core/src/expression.ts'
import { importChain } from './upstream.mts'
import { asterOutcome, type Spec, vegaOutcome } from './expression-sites.mts'

const vegaFunctions = Object.keys(((await importChain('vega', 'vega-functions')) as { codeGenerator: { functions: Record<string, unknown> } }).codeGenerator.functions)

const call = (name: string, args: string): Spec => ({ data: [{ name: 'd', values: [] }], signals: [{ name: 't', update: `${name}(${args})` }] })

const NAMES = [...new Set([
  ...vegaFunctions, ...expressionFunctionNames(), ...Object.keys(ADDON_FUNCTIONS), ...UNWRITTEN_FUNCTIONS,
  ...vegaFunctions.flatMap((n) => ['_' + n, n + 'x', n.toUpperCase()]),
  'foo', 'Math', 'isInvalid', 'constructor', 'toString', 'isPrototypeOf', 'datum', 'event', 'item', 'signal', 'PI',
])]

describe('the functions an expression may call are the ones vega recognises (Aster vs real Vega)', { timeout: 120_000 }, () => {
  it('every name, called with no argument, one and three arguments, is compiled or refused as vega parses or refuses it', () => {
    const mismatches: string[] = []
    for (const name of NAMES) {
      for (const args of ['', "'d'", "'d', 'a', 1"]) {
        const spec = call(name, args)
        const want = vegaOutcome(spec)
        const got = asterOutcome(spec)
        if (got !== want) mismatches.push(`${name}(${args}): vega ${want}; aster ${got}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('knows every function vega\'s code generator has', () => {
    for (const name of vegaFunctions) expect(isExpressionFunction(name), name).toBe(true)
  })

  it('knows nothing vega does not', () => {
    const known = NAMES.filter(isExpressionFunction)
    expect(known.filter((n) => !vegaFunctions.includes(n))).toEqual([])
  })

  it('the functions it does not implement are exactly those vega has and the engine and its add-ons have not', () => {
    const written = new Set([...expressionFunctionNames(), ...Object.keys(ADDON_FUNCTIONS)])
    const eventFunctions = ['view', 'item', 'group', 'xy', 'x', 'y']
    const missing = vegaFunctions.filter((n) => !n.startsWith('_') && !written.has(n) && !eventFunctions.includes(n))
    expect([...UNWRITTEN_FUNCTIONS].sort()).toEqual(missing.sort())
  })
})
