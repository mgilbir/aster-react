import { afterEach, describe, expect, it } from 'vitest'
import { checkExpression } from './expr-check.js'
import { isExpressionFunction, registerExpressionFunction, UNWRITTEN_FUNCTIONS } from './expression.js'
import { ADDON_FUNCTIONS } from './addon-functions.js'
import { SpecParseError } from './parse-error.js'

const signals = new Set(['s', 'width'])
const refusal = (text: string): string | null => {
  try {
    checkExpression(text, (name) => signals.has(name))
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

describe('what vega refuses in an expression it has read', () => {
  it('a syntax error is the text, not the parser words; the refusal is a SpecParseError', () => {
    expect(refusal('1 +')).toBe('Expression parse error: 1 +')
    expect(() => checkExpression('a b', () => true)).toThrow(SpecParseError)
  })

  it('an unknown function, whatever the arguments say', () => {
    expect(refusal('foo(1)')).toBe('Unrecognized function: foo')
    expect(refusal('1 + bar(nosuch)')).toBe('Unrecognized function: bar')
    expect(refusal('_format(1)')).toBe('Unrecognized function: _format')
    expect(refusal('isInvalid(1)')).toBe('Unrecognized function: isInvalid')
    expect(refusal('abs(s) + sqrt(width)')).toBeNull()
  })

  it('a name that is no signal, last: after everything the tree can be refused for, in the order the names were read', () => {
    expect(refusal('nosuch')).toBe('Unrecognized signal name: "nosuch"')
    expect(refusal('s + b + a')).toBe('Unrecognized signal name: "b"')
    expect(refusal('b + foo()')).toBe('Unrecognized function: foo')
    expect(refusal('datum.nosuch + event.x + item().y + PI + s')).toBeNull()
    expect(refusal('x.y.z')).toBe('Unrecognized signal name: "x"')
    expect(refusal('datum[nosuch]')).toBe('Unrecognized signal name: "nosuch"')
    expect(refusal('{nosuch: s}')).toBeNull()
  })

  it('the refusals of the code generator', () => {
    expect(refusal('_ + 1')).toBe('Illegal identifier: _')
    expect(refusal('a.b()')).toBe('Illegal callee type: MemberExpression')
    expect(refusal('(1)()')).toBe('Illegal callee type: Literal')
    expect(refusal('clamp(1)')).toBe('Missing arguments to clamp function.')
    expect(refusal('if(1, 2, 3, 4)')).toBe('Too many arguments to if function.')
    expect(refusal('{__proto__: 1}')).toBe('Illegal property: __proto__')
    expect(refusal("{'__proto__': 1}")).toBeNull()
  })

  it('a call reads only the arguments the code generator reads', () => {
    expect(refusal('date(1, foo())')).toBeNull()
    expect(refusal('length(1, foo())')).toBeNull()
    expect(refusal('upper(foo())')).toBe('Unrecognized function: foo')
    expect(refusal("substring('a', foo())")).toBe('Unrecognized function: foo')
    expect(refusal('upper()')).toBe("Cannot read properties of undefined (reading 'type')")
  })

  it('a call that names data or a scale gives the name', () => {
    expect(refusal('data(s)')).toBe('First argument to data functions must be a string literal.')
    expect(refusal('indata("d", s, 1)')).toBe('Second argument to indata must be a string literal.')
    expect(refusal('scale()')).toBe("Cannot read properties of undefined (reading 'type')")
  })

  it('what the parser reads first is refused first: the calls of the whole tree, then the code', () => {
    expect(refusal('foo() + data(s)')).toBe('First argument to data functions must be a string literal.')
    // (the names every object has are names like any other: vega's parser fails on some of them with a message of the engine)
    for (const name of ['hasOwnProperty', 'valueOf', 'constructor', '__proto__', 'toLocaleString']) expect(refusal(`${name}(1)`), name).toBe(`Unrecognized function: ${name}`)
    expect(refusal('toString')).toBe('Unrecognized signal name: "toString"')
  })
})

describe('the functions vega recognises in an expression', () => {
  const disposers: Array<() => void> = []
  afterEach(() => { for (const d of disposers.splice(0)) d() })

  it('knows the built-ins, the event functions, `if`, the internal scale calls, the add-ons and the unwritten ones', () => {
    for (const name of ['abs', 'format', 'toNumber', 'xy', 'item', 'if', '_scale', '_bandwidth', '_range', 'indata', 'vlSelectionTest']) expect(isExpressionFunction(name), name).toBe(true)
    for (const name of Object.keys(ADDON_FUNCTIONS)) expect(isExpressionFunction(name), name).toBe(true)
    for (const name of UNWRITTEN_FUNCTIONS) expect(isExpressionFunction(name), name).toBe(true)
  })

  it('does not know what vega does not, names with an underscore included', () => {
    for (const name of ['foo', 'isInvalid', '_format', '_if', '_abs', 'constructor', 'hasOwnProperty', '__proto__', 'Math']) expect(isExpressionFunction(name), name).toBe(false)
  })

  it('knows a function from the moment the host registers it, and not after it is disposed', () => {
    expect(isExpressionFunction('priceForTheTest')).toBe(false)
    const dispose = registerExpressionFunction('priceForTheTest', () => '$1')
    disposers.push(dispose)
    expect(isExpressionFunction('priceForTheTest')).toBe(true)
    expect(refusal('priceForTheTest(1)')).toBeNull()
    dispose()
    expect(isExpressionFunction('priceForTheTest')).toBe(false)
    expect(refusal('priceForTheTest(1)')).toBe('Unrecognized function: priceForTheTest')
  })
})
