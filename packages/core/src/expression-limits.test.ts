// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parseExpression } from './expr-parser.js'
import { expressionInterpreter } from './expr-interpreter.js'
import { AsterLimitError } from './limits.js'

/**
 * Where the expression nesting limit falls, per shape of nesting. The numbers are the boundary of the
 * released implementation (1000 nested unary/conditional productions or a tree 1000 levels tall, counting
 * the extra level a regular-expression literal's value takes): a rewrite of the parser must not move them,
 * because a spec that parsed must keep parsing and a refusal must stay a refusal.
 */
const SHAPES: Array<[name: string, build: (n: number) => string, maxAccepted: number]> = [
  ['parenthesised', (n) => '('.repeat(n) + 'a' + ')'.repeat(n), 499],
  ['unary chain', (n) => '!'.repeat(n) + 'a', 998],
  ['conditional chain', (n) => 'a?b:'.repeat(n) + 'c', 998],
  ['left-leaning sum', (n) => Array(n + 1).fill('1').join('+'), 999],
  ['member chain', (n) => 'a' + '.b'.repeat(n), 999],
  ['nested calls', (n) => 'f('.repeat(n) + 'a' + ')'.repeat(n), 499],
  ['nested arrays', (n) => '['.repeat(n) + 'a' + ']'.repeat(n), 499],
  ['nested objects', (n) => '{k:'.repeat(n) + 'a' + '}'.repeat(n), 499],
  ['member chain on a regexp literal', (n) => '/a/' + '.b'.repeat(n), 998],
  ['member chain on a regexp literal this engine cannot build', (n) => '/\\-/u' + '.b'.repeat(n), 998],
]

describe('expression nesting limit (boundaries of the released parser)', () => {
  for (const [name, build, maxAccepted] of SHAPES) {
    it(`${name}: ${maxAccepted} deep parses, one more is an AsterLimitError`, () => {
      expect(() => parseExpression(build(maxAccepted))).not.toThrow()
      let thrown: unknown
      try { parseExpression(build(maxAccepted + 1)) } catch (e) { thrown = e }
      expect(thrown).toBeInstanceOf(AsterLimitError)
      expect((thrown as Error).message).toMatch(/maxDepth 1001 > 1000 \(expression nesting\)/)
    })
  }

  it('absurd nesting is a limit error for every shape, never a RangeError', () => {
    for (const [, build] of SHAPES) {
      expect(() => parseExpression(build(200_000))).toThrow(AsterLimitError)
    }
  })

  it('evaluates the deepest accepted expression without exhausting the stack', () => {
    const ev = (code: string, datum?: unknown) => expressionInterpreter.parameter({ functions: {} }, { ast: parseExpression(code) })(datum, {})
    expect(ev(Array(1000).fill('1').join('+'))).toBe(1000)
    expect(ev('!'.repeat(998) + 'true')).toBe(true)
    expect(ev('('.repeat(499) + '7' + ')'.repeat(499))).toBe(7)
  })
})
