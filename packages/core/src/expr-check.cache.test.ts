import { describe, expect, it, vi } from 'vitest'

const parsed: string[] = []
vi.mock('./expr-parser.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./expr-parser.js')>()
  return { ...real, parseExpressionCached: (code: string) => { parsed.push(code); return real.parseExpressionCached(code) } }
})

const { checkExpression } = await import('./expr-check.js')
const { checkExpressions } = await import('./spec-expressions.js')
const { registerExpressionFunction } = await import('./expression.js')

describe('what is found about an expression is kept across specs', () => {
  it('an expression is parsed once, however many times and in however many specs it is checked', () => {
    parsed.length = 0
    const all = (): boolean => true
    for (let i = 0; i < 5; i++) checkExpression('datum.cachedOnce + 1', all)
    expect(parsed).toEqual(['datum.cachedOnce + 1'])
    const spec = { signals: [{ name: 's', update: 'cachedTwice * 2' }, { name: 'cachedTwice', value: 1 }] }
    checkExpressions(spec, {})
    const after = parsed.length
    checkExpressions(structuredClone(spec), {})
    checkExpressions({ signals: [{ name: 'cachedTwice', value: 1 }, { name: 'other', update: 'cachedTwice * 2' }] }, {})
    expect(parsed.length).toBe(after)
  })

  it('what is kept is about the text alone: the names it reads are asked of each scope', () => {
    expect(() => checkExpressions({ signals: [{ name: 't', update: 'cachedName + 1' }] }, {})).toThrow('Unrecognized signal name: "cachedName"')
    expect(() => checkExpressions({ signals: [{ name: 'cachedName', value: 1 }, { name: 't', update: 'cachedName + 1' }] }, {})).not.toThrow()
    expect(() => checkExpressions({ signals: [{ name: 't', update: 'cachedName + 1' }] }, {})).toThrow('Unrecognized signal name: "cachedName"')
  })

  it('and about the functions there are: a change of the registry is seen by what was kept', () => {
    const spec = { signals: [{ name: 't', update: 'cachedFn(1)' }] }
    expect(() => checkExpressions(spec, {})).toThrow('Unrecognized function: cachedFn')
    const dispose = registerExpressionFunction('cachedFn', () => 1)
    expect(() => checkExpressions(spec, {})).not.toThrow()
    dispose()
    expect(() => checkExpressions(spec, {})).toThrow('Unrecognized function: cachedFn')
  })

  it('is bounded: more texts than it holds do not grow it without end, and every one is still checked right', () => {
    for (let i = 0; i < 20000; i++) checkExpression(`${i} + 1`, () => true)
    expect(() => checkExpression('nosuchbound + 1', () => false)).toThrow('Unrecognized signal name: "nosuchbound"')
    expect(() => checkExpression('1 +', () => true)).toThrow('Expression parse error: 1 +')
  })
})
