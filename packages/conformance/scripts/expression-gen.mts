/**
 * Seeded generator of expression sources (valid, invalid, mutated) shared by the generated expression
 * differentials. `hardened` adds the names Aster's sandbox treats specially (Object.prototype members,
 * `Function`, `eval`, timers): vega-interpreter answers those differently on purpose-built grounds, so the
 * vega comparison leaves them out and the pinned sandbox probes cover them instead.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export function rng(seed: number) {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number): number => Math.floor(next() * n)
  const chance = (p: number): boolean => next() < p
  const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length)] as T
  return { next, int, chance, pick }
}
export type Rng = ReturnType<typeof rng>

const WS = [' ', ' ', ' ', '', '\t', '\n', '\r\n', '\u00a0', '\u2028', '\ufeff', '\u3000', '\u000b', '\u000c', '\u1680', '\u202f']
const IDS: string[] = [
  'a', 'b', 'c', 'x', 'y', 'datum', 'item', 'event', 'PI', 'E', 'NaN', 'MIN_VALUE', 'MAX_VALUE', 'LN2', 'undefined', 'Infinity',
  '$a', '_b', 'if', 'in', 'instanceof', 'true', 'false', 'null', 'this', 'function', 'new', 'typeof', 'void', 'delete', 'var',
  'let', 'class', 'else', 'do', 'enum', 'implements', 'interface', 'yield', 'super', 'debugger',
  '\u00e9', '\u03c0', '\u00f1and\u00fa', '\u65e5\u672c', 'a\u0301', '\u{1D49C}', 'x\u200c', '\u01c5', '\u2177', '\\u0061bc', '\\u{61}', 'a\\u0062', '\\u0069f', '\\u00e9',
  '_', '$', '$$', 'a1', 'A_B', 'ab\u0300',
]
// callable names (the default function table of the interpreter), plus ones that are not
const FNS: string[] = [
  'abs', 'max', 'min', 'floor', 'ceil', 'round', 'pow', 'sqrt', 'sin', 'cos', 'atan2', 'exp', 'log', 'clamp', 'isNaN', 'isFinite',
  'upper', 'lower', 'trim', 'length', 'join', 'indexof', 'lastindexof', 'slice', 'reverse', 'sort', 'substring', 'split', 'replace',
  'parseFloat', 'parseInt', 'btoa', 'atob', 'encodeURIComponent', 'datetime', 'utc', 'year', 'month', 'date',
  'day', 'hours', 'minutes', 'seconds', 'milliseconds', 'time', 'utcyear', 'utcmonth', 'utcdate', 'utchours', 'timezoneoffset',
  'if', '_abs', '_if', 'hostSum', 'hostThis', 'hostFn', 'isFoo', 'nothing', 'view', 'item', 'group', 'xy', 'x', 'y',
]
export const OPS = ['*', '/', '%', '+', '-', '<<', '>>', '>>>', '<', '>', '<=', '>=', 'in', 'instanceof', '==', '!=', '===', '!==', '&', '^', '|', '&&', '||']
const BAD_OPS = ['=', '+=', '++', '--', '=>', '**', '??', '?.', '...', '<<=', '>>>=', ',', ';', '#', '@', '`', '\\']
const UNARY = ['!', '-', '+', '~', '!', '-', 'typeof ', 'void ', 'delete ', '++', '--']
const KEYS: string[] = ['a', 'b', 'c', 'list', 'nested', 'deep', 'x', 'n', 's', 'length', 'map', 'slice', 'name', '0', '1', 'if', 'true', 'null', 'in', 'f g']
const NUMS = [
  '0', '1', '2', '10', '123', '0.5', '.5', '5.', '1e3', '1E+3', '1e-3', '1e', '1e+', '0x1F', '0Xff', '0x', '0xg', '017', '08', '09', '00', '0.',
  '1_0', '1n', '0b1', '0o7', '1e999', '0.0000001', '123456789012345678901234567890', '0e0', '1.5e2', '.e1', '1..2', '3x', '0.5.5', '9007199254740993',
]
const STR_PIECES = [
  'a', 'abc', ' ', '\u00e9', '\u65e5', '\u{1F600}', '\\n', '\\r', '\\t', '\\b', '\\f', '\\v', '\\0', '\\00', '\\01', '\\12', '\\377', '\\400', '\\8', '\\9',
  '\\x41', '\\x4', '\\xg1', '\\u0041', '\\u00', '\\u00e9', '\\ud83d\\ude00', '\\u{41}', '\\u{1F600}', '\\u{110000}', '\\u{}', '\\u{41', '\\x{41}',
  '\\\n', '\\\r\n', '\\\r', '\\\u2028', '\\q', "\\'", '\\"', '\\\\', '\n', '\r', '\u2028', "'", '"', '/', 'if',
]
const RE_BODIES = ['a+b', '[a-z]', '[/]', '\\/', '\\d{2,3}', '(?:x)', '(', '[', 'a**', '(?<n>x)', '\\u{41}', '\u{1F600}', '\\p{L}', '', '*', '\\', 'a\\n', '[\\]]', '^$', '(a)\\1', '/', '=', '\\k<x>', 'a|b']
const RE_FLAGS = ['', '', 'g', 'i', 'gi', 'gimuy', 'u', 'y', 'gg', 'x', 'v', 's', 'd', 'g\\u0069']

const mkRegex = (r: Rng): string => {
  const body = r.pick(RE_BODIES)
  const flags = r.pick(RE_FLAGS)
  return r.chance(0.04) ? `/${body}` : r.chance(0.03) ? `/${body}/${flags}\n` : `/${body}/${flags}`
}
const mkString = (r: Rng): string => {
  const q = r.pick(["'", '"'])
  let s = q
  for (let n = r.int(5); n > 0; n--) s += r.pick(STR_PIECES)
  return r.chance(0.93) ? s + q : s
}
const mkNum = (r: Rng): string => (r.chance(0.7) ? r.pick(NUMS) : String(r.int(1000)))
const mkId = (r: Rng): string => r.pick(IDS)
const sp = (r: Rng): string => (r.chance(0.6) ? ' ' : r.pick(WS))

export function gen(r: Rng, depth: number): string {
  const d = depth - 1
  const w = d <= 0 ? r.int(5) : r.int(24)
  switch (w) {
    case 0: return mkNum(r)
    case 1: return mkString(r)
    case 2: return mkId(r)
    case 3: return r.pick(['true', 'false', 'null', 'datum', 'a', 'b', 'PI'])
    case 4: return r.chance(0.5) ? mkRegex(r) : mkId(r)
    case 5: case 6: case 7: case 8: case 9: // binary, the most common
      return `${gen(r, d)}${sp(r)}${r.chance(0.04) ? r.pick(BAD_OPS) : r.pick(OPS)}${sp(r)}${gen(r, d)}`
    case 10: case 11: return `${r.pick(UNARY)}${gen(r, d)}`
    case 12: return `${gen(r, d)}${sp(r)}?${sp(r)}${gen(r, d)}${sp(r)}:${sp(r)}${gen(r, d)}`
    case 13: case 14: return `(${gen(r, d)})`
    case 15: case 16: return `${gen(r, d)}.${r.chance(0.1) ? mkNum(r) : r.pick(KEYS)}`
    case 17: return `${gen(r, d)}[${gen(r, d)}]`
    case 18: case 19: {
      const args: string[] = []
      for (let n = r.int(4); n > 0; n--) args.push(gen(r, d))
      return `${r.chance(0.92) ? r.pick(FNS) : gen(r, d)}(${args.join(r.chance(0.97) ? ',' + sp(r) : ';')})`
    }
    case 20: {
      const els: string[] = []
      for (let n = r.int(4); n > 0; n--) els.push(r.chance(0.08) ? '' : gen(r, d))
      return `[${els.join(',')}${r.chance(0.1) ? ',' : ''}]`
    }
    case 21: case 22: {
      const props: string[] = []
      for (let n = r.int(4); n > 0; n--) {
        const key = r.chance(0.5) ? r.pick(KEYS) : r.chance(0.5) ? mkString(r) : r.chance(0.5) ? mkNum(r) : mkId(r)
        props.push(`${key}${r.chance(0.97) ? ':' : ''}${sp(r)}${gen(r, d)}`)
      }
      return `{${props.join(',')}${r.chance(0.05) ? ',' : ''}}`
    }
    default: return `${gen(r, d)}${sp(r)}${gen(r, d)}`
  }
}

const POOL = [...'()[]{},.:;?!~+-*/%&|^<>=\'"\\ \t\n$_#@`0123456789abcxyz', '\u00e9', '\u2028', '\u00a0', '\u{1F600}', '\ud800', '\\u0041', '/*', '//', '\\u{']
function mutate(r: Rng, s: string): string {
  for (let n = 1 + r.int(3); n > 0; n--) {
    const i = r.int(s.length + 1)
    switch (r.int(6)) {
      case 0: s = s.slice(0, i) + s.slice(i + 1); break
      case 1: s = s.slice(0, i) + r.pick(POOL) + s.slice(i); break
      case 2: s = s.slice(0, i) + r.pick(POOL) + s.slice(i + 1); break
      case 3: s = s.slice(0, i); break
      case 4: s = s.slice(0, i) + s.slice(i, i + 1 + r.int(4)) + s.slice(i); break
      default: s = s.slice(i)
    }
  }
  return s
}
export const mkSource = (r: Rng): string => {
  const s = gen(r, 1 + r.int(5))
  return r.chance(0.35) ? mutate(r, s) : r.chance(0.1) ? ` ${s} ` : s
}

const SAFE_IDS = ['a', 'b', 'c', 'x', 'y', 'datum', 'item', 'event', 'PI', 'E', 'NaN', 'MIN_VALUE', 'undefined', '$a', '_b', 'if', '\u00e9', '\u03c0', '\u65e5\u672c']
const SAFE_NUMS = ['0', '1', '2', '3', '7', '10', '0.5', '.5', '5.', '1e3', '1E-3', '0x1F', '0xff', '2147483648', '4294967297', '0.1', '255', '1e21', '123456789012']
const SAFE_STRS = ['"a"', "'b'", '""', '"1"', '" 5 "', '"abc"', '"x y"', '"\\n"', '"\\u0041"', '"\\x41"', '"\\u{1F600}"', "'it\\'s'", '"0x10"', '"if"']
const SAFE_RES = ['/a+/', '/[a-z]/i', '/x/g', '/(?:)/', '/\\d/']
const SAFE_KEYS = ['a', 'b', 'c', 'x', 'list', 'nested', 'deep', 'n', 's', 'length', 'map', 'name', 'if', 'true', '0', '1']
const SAFE_CALLS: Array<[string, number]> = [
  ['abs', 1], ['max', 2], ['min', 3], ['floor', 1], ['ceil', 1], ['round', 1], ['pow', 2], ['sqrt', 1], ['clamp', 3], ['isNaN', 1], ['isFinite', 1],
  ['upper', 1], ['lower', 1], ['trim', 1], ['length', 1], ['join', 2], ['indexof', 2], ['lastindexof', 2], ['slice', 3], ['reverse', 1], ['sort', 1],
  ['substring', 3], ['split', 2], ['replace', 3], ['parseFloat', 1], ['parseInt', 1], ['encodeURIComponent', 1], ['datetime', 6], ['utc', 6], ['year', 1],
  ['month', 1], ['date', 1], ['day', 1], ['hours', 1], ['utcyear', 1], ['utcday', 1], ['time', 1], ['if', 3], ['_abs', 1], ['hostSum', 2], ['hostThis', 0],
  ['hostFn', 0], ['isFoo', 1], ['nothing', 2], ['view', 0], ['x', 0], ['xy', 0],
]
const SAFE_BIN = OPS.filter((o) => o !== 'in' && o !== 'instanceof')

/**
 * A well-formed expression (valid by construction, so nearly every one is accepted) that mixes operators
 * of every precedence level, unparenthesised, to pin the grammar, and exercises member/call/array/object forms.
 */
export function genClean(r: Rng, depth: number): string {
  if (depth <= 0) {
    switch (r.int(6)) {
      case 0: case 1: return r.pick(SAFE_IDS)
      case 2: case 3: return r.pick(SAFE_NUMS)
      case 4: return r.pick(SAFE_STRS)
      default: return r.chance(0.5) ? r.pick(SAFE_RES) : r.pick(['true', 'false', 'null'])
    }
  }
  const d = depth - 1
  switch (r.int(18)) {
    case 0: case 1: case 2: case 3: case 4: case 5: case 6: {
      const op = r.chance(0.03) ? r.pick(['in', 'instanceof']) : r.pick(SAFE_BIN)
      const right = genClean(r, d)
      return `${genClean(r, d)} ${op}${/^[-+]/.test(right) && /^[-+]$/.test(op.slice(-1)) ? ' ' : r.chance(0.7) ? ' ' : ''}${right}`
    }
    case 7: case 8: {
      const u = r.pick(['!', '-', '+', '~'])
      const o = genClean(r, d)
      return `${u}${/^[-+]/.test(o) ? ' ' : ''}${o}`
    }
    case 9: return `${genClean(r, d)} ? ${genClean(r, d)} : ${genClean(r, d)}`
    case 10: return `(${genClean(r, d)})`
    case 11: return `${genClean(r, d)}.${r.pick(SAFE_KEYS)}`
    case 12: return `${genClean(r, d)}[${genClean(r, d)}]`
    case 13: case 14: {
      const [name, arity] = r.pick(SAFE_CALLS)
      const n = r.chance(0.8) ? arity : r.int(4)
      const args: string[] = []
      for (let i = 0; i < n; i++) args.push(genClean(r, d))
      return `${name}(${args.join(', ')})`
    }
    case 15: {
      const els: string[] = []
      for (let n = r.int(4); n > 0; n--) els.push(genClean(r, d))
      return `[${els.join(', ')}]`
    }
    case 16: {
      const keys = new Set<string>()
      const props: string[] = []
      for (let n = r.int(4); n > 0; n--) {
        const key = r.pick([...SAFE_KEYS, '"k q"', "'z'", '5', '1.5'])
        if (keys.has(key)) continue
        keys.add(key)
        props.push(`${key}: ${genClean(r, d)}`)
      }
      return `{${props.join(', ')}}`
    }
    default: return `${genClean(r, d)} ${r.pick(['&&', '||'])} ${genClean(r, d)}`
  }
}
export const mkCleanSource = (r: Rng): string => genClean(r, 1 + r.int(6))

const HARDENED_NAMES = ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty', '__defineGetter__', 'isPrototypeOf', 'toLocaleString', 'Function', 'eval', 'setTimeout', 'setInterval', 'globalThis']
/** Add the sandbox-sensitive names to the pools (for comparisons against an earlier Aster, not against vega). */
export function addHardenedNames(): void {
  IDS.push(...HARDENED_NAMES)
  FNS.push(...HARDENED_NAMES, '_constructor', '_eval')
  KEYS.push(...HARDENED_NAMES, 'prototype', 'call', 'apply', 'bind')
}

/**
 * vega's tree reduced to the fields every ESTree-shaped consumer reads (`raw`, `prefix`, `kind`, `member`,
 * `regex` are vega's own): Aster's tree is exactly that subset.
 */
export function canon(n: any): unknown {
  if (n === null || n === undefined) return n
  if (Array.isArray(n)) return n.map(canon)
  switch (n.type) {
    case 'Literal': return { type: n.type, value: n.value }
    case 'Identifier': return { type: n.type, name: n.name }
    case 'MemberExpression': return { type: n.type, computed: n.computed, object: canon(n.object), property: canon(n.property) }
    case 'CallExpression': return { type: n.type, callee: canon(n.callee), arguments: canon(n.arguments) }
    case 'UnaryExpression': return { type: n.type, operator: n.operator, argument: canon(n.argument) }
    case 'BinaryExpression': case 'LogicalExpression': return { type: n.type, operator: n.operator, left: canon(n.left), right: canon(n.right) }
    case 'ConditionalExpression': return { type: n.type, test: canon(n.test), consequent: canon(n.consequent), alternate: canon(n.alternate) }
    case 'ArrayExpression': return { type: n.type, elements: canon(n.elements) }
    case 'ObjectExpression': return { type: n.type, properties: canon(n.properties) }
    case 'Property': return { type: n.type, key: canon(n.key), value: canon(n.value) }
    default: return { unknownNodeType: String(n.type) }
  }
}
