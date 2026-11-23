/**
 * LIVE differential for how the regex screen (packages/core/src/regex-screen.ts) READS a pattern: its tree against the tree a
 * reference parser (@eslint-community/regexpp, ecmaVersion 2025) makes of the same pattern and flags, mapped to the screen's node
 * shape with the screen's own set arithmetic, for a hand list of the syntax that once fooled it (Annex B escapes, modifiers,
 * `v`-mode sets) and for patterns generated from the grammar's tokens. A screen that misreads a pattern analyses another one, so
 * the reading must be exact: same structure, same quantifier bounds, same character sets (upper and lower bound).
 *
 * Also checked on every generated pattern: the screen terminates promptly, it never answers null for a pattern it cannot read
 * (fail closed), and V8 itself is the judge of validity (an invalid pattern is left to the RegExp constructor). And the tables
 * the screen carries, against V8: `\s` over every code point, and the case-insensitive closure (no code point V8 matches
 * case-insensitively is left out).
 */
import { describe, expect, it } from 'vitest'
import { RegExpParser, type AST } from '@eslint-community/regexpp'
import {
  csComplement, csIntersect, csSubtract, csUnion, DIGIT, exactSet, fold, FULL, readPattern, regexHazard, SPACE, UNKNOWN_SET, WORD,
  normalize, type CharSet, type RNode,
} from '../../core/src/regex-screen.ts'

const parser = new RegExpParser({ ecmaVersion: 2025 })

/** The reference tree, in the screen's node shape. */
function reference(source: string, flags: string): RNode {
  const v = flags.includes('v'), u = v || flags.includes('u')
  const pattern = parser.parsePattern(source, 0, source.length, { unicode: u && !v, unicodeSets: v })
  let icase = flags.includes('i')
  const folded = (s: CharSet): CharSet => (icase ? { hi: fold(s.hi), lo: s.lo } : s)
  const one = (c: number): CharSet => exactSet([[c, c]])
  const escapeSet = (n: AST.EscapeCharacterSet | AST.UnicodePropertyCharacterSet): CharSet => {
    const base = n.kind === 'digit' ? exactSet(DIGIT) : n.kind === 'word' ? exactSet(WORD) : n.kind === 'space' ? exactSet(SPACE) : UNKNOWN_SET
    if (n.kind === 'property') return UNKNOWN_SET
    return n.negate ? csComplement(base) : base
  }
  /** A v-mode class operand: its set and its multi-character strings (and whether a property of strings is among them). */
  interface CS { set: CharSet; strings: number[][]; any: boolean }
  const classOf = (n: AST.CharacterClass | AST.ExpressionCharacterClass | AST.ClassIntersection | AST.ClassSubtraction | AST.ClassSetOperand): CS => {
    switch (n.type) {
      case 'Character': return { set: one(n.value), strings: [], any: false }
      case 'CharacterClassRange': return { set: exactSet([[n.min.value, n.max.value]]), strings: [], any: false }
      case 'CharacterSet':
        if (n.kind === 'property' && n.strings) return { set: exactSet([]), strings: [], any: true }
        return { set: escapeSet(n as AST.EscapeCharacterSet), strings: [], any: false }
      case 'ClassStringDisjunction': {
        const all = n.alternatives.map((a) => a.elements.map((c) => c.value))
        const singles = all.filter((s) => s.length === 1).map((s) => [s[0]!, s[0]!] as [number, number])
        return { set: exactSet(normalize(singles)), strings: all.filter((s) => s.length !== 1), any: false }
      }
      case 'CharacterClass': {
        let acc: CS = { set: exactSet([]), strings: [], any: false }
        for (const e of n.elements) {
          const c = classOf(e as never)
          acc = { set: csUnion(acc.set, c.set), strings: [...acc.strings, ...c.strings], any: acc.any || c.any }
        }
        return n.negate ? { set: csComplement(acc.set), strings: [], any: false } : acc
      }
      case 'ExpressionCharacterClass': {
        const c = classOf(n.expression)
        return n.negate ? { set: csComplement(c.set), strings: [], any: false } : c
      }
      case 'ClassIntersection': {
        const a = classOf(n.left), b = classOf(n.right)
        const key = (s: number[]): string => s.join(',')
        const strings = a.any && b.any ? [...a.strings, ...b.strings] : a.any ? b.strings : b.any ? a.strings : a.strings.filter((s) => b.strings.some((t) => key(t) === key(s)))
        return { set: csIntersect(a.set, b.set), strings, any: a.any && b.any }
      }
      case 'ClassSubtraction': {
        const a = classOf(n.left), b = classOf(n.right)
        const key = (s: number[]): string => s.join(',')
        return { set: csSubtract(a.set, b.set), strings: a.strings.filter((s) => !b.strings.some((t) => key(t) === key(s))), any: a.any }
      }
      default: throw new Error('unexpected class node ' + (n as { type: string }).type)
    }
  }
  const alts = (list: AST.Alternative[]): RNode => ({ t: 'alt', alts: list.map((a) => ({ t: 'seq', items: a.elements.map(el) })) })
  const el = (n: AST.Element): RNode => {
    switch (n.type) {
      case 'Character': return { t: 'set', set: folded(one(n.value)) }
      case 'CharacterSet':
        if (n.kind === 'any') return { t: 'set', set: folded(exactSet(FULL)) }
        if (n.kind === 'property' && n.strings) return { t: 'strings' }
        return { t: 'set', set: folded(escapeSet(n)) }
      case 'CharacterClass': case 'ExpressionCharacterClass': {
        const c = classOf(n)
        const set = folded(c.set)
        if (!c.strings.length && !c.any) return { t: 'set', set }
        const out: RNode[] = [{ t: 'set', set }]
        for (const s of c.strings) out.push({ t: 'seq', items: s.map((x) => ({ t: 'set', set: folded(one(x)) })) })
        if (c.any) out.push({ t: 'strings' })
        return { t: 'alt', alts: out }
      }
      case 'Quantifier': return { t: 'rep', n: el(n.element), min: n.min, max: n.max }
      case 'Group': {
        const saved = icase
        if (n.modifiers?.add.ignoreCase) icase = true
        if (n.modifiers?.remove?.ignoreCase) icase = false
        try { return { t: 'group', n: alts(n.alternatives), capture: false } } finally { icase = saved }
      }
      case 'CapturingGroup': return { t: 'group', n: alts(n.alternatives), capture: true }
      case 'Assertion':
        if (n.kind === 'start') return { t: 'assert', kind: 'start' }
        if (n.kind === 'end') return { t: 'assert', kind: 'end' }
        if (n.kind === 'word') return { t: 'assert', kind: n.negate ? 'nonword' : 'word' }
        return { t: 'look', n: alts(n.alternatives), behind: n.kind === 'lookbehind', negate: n.negate }
      case 'Backreference': return { t: 'backref' }
      default: throw new Error('unexpected node ' + (n as { type: string }).type)
    }
  }
  return alts(pattern.alternatives)
}

/** One shape for both trees: a sequence or alternation of one is its member, nested sequences are flattened. */
function canon(n: RNode): unknown {
  switch (n.t) {
    case 'seq': {
      const items = n.items.flatMap((x) => { const c = canon(x) as { t?: string; items?: unknown[] }; return c && c.t === 'seq' ? c.items! : [c] })
      return items.length === 1 ? items[0] : { t: 'seq', items }
    }
    case 'alt': return n.alts.length === 1 ? canon(n.alts[0]!) : { t: 'alt', alts: n.alts.map(canon) }
    case 'rep': return { t: 'rep', n: canon(n.n), min: n.min, max: n.max === Infinity ? 'inf' : n.max }
    case 'group': return { t: 'group', n: canon(n.n), capture: n.capture }
    case 'look': return { t: 'look', n: canon(n.n), behind: n.behind, negate: n.negate }
    case 'set': return { t: 'set', hi: n.set.hi, lo: n.set.lo }
    default: return n
  }
}

const valid = (source: string, flags: string): boolean => { try { new RegExp(source, flags); return true } catch { return false } }

/** The verdict on one pattern: the readings agree (or both refuse to read it), and the screen answers promptly. */
function check(source: string, flags: string): { read: boolean } {
  const t0 = performance.now()
  const hazard = regexHazard(source, flags)
  const ms = performance.now() - t0
  expect(ms, `screen time for /${source}/${flags}`).toBeLessThan(2000)
  if (!valid(source, flags)) {
    expect(hazard, `invalid /${source}/${flags} is left to the constructor`).toBeNull()
    return { read: false }
  }
  const want = canon(reference(source, flags))
  let got: unknown
  try { got = canon(readPattern(source, flags)) } catch (e) { got = `UNREADABLE: ${(e as Error).message}` }
  expect(got, `/${source}/${flags}`).toEqual(want)
  return { read: true }
}

/** Syntax that fooled the screen (C10, C11a) and the corners of each mode. */
const HAND: Array<[string, string]> = [
  ['a\\u{', ''], ['[\\u{]a', ''], ['\\u{3}', ''], ['\\u{41}', 'u'], ['\\x(a+)+$', ''], ['\\u(a+)+$', ''], ['\\k<(a+)+$', ''], ['\\k<a>(?<a>x)', ''],
  ['(?i:(a+)+)$', ''], ['(?-i:a)', 'i'], ['(?i:[a-z])K', ''], ['\\c', ''], ['\\c1', ''], ['[\\c1]', ''], ['[\\c_]', ''], ['[\\c]', ''], ['\\cA', ''],
  ['\\8', ''], ['\\08', ''], ['\\07', ''], ['\\377', ''], ['\\400', ''], ['(a)\\1', ''], ['(a)\\2', ''], ['(a)\\10', ''], ['\\1(a)', ''],
  ['[\\d-z]', ''], ['[a-\\d]', ''], ['[-a]', ''], ['[a-]', ''], ['[\\b]', ''], ['[\\B]', ''], ['a{', ''], ['a{1', ''], ['a{,2}', ''], ['}', ''], [']', ''],
  ['(?=a)*', ''], ['(?=a){2}', ''], ['\\p{L}', ''], ['\\p{L}', 'u'], ['\\P{Lu}+', 'u'], ['[^\\p{L}]', 'u'], ['[\\p{L}--[a-z]]', 'v'], ['[[a-z]&&[aeiou]]', 'v'],
  ['[\\q{abc|d|}]', 'v'], ['[\\p{RGI_Emoji}--\\q{x}]', 'v'], ['\\p{RGI_Emoji}+', 'v'], ['[[a-z]--b]', 'v'], ['[\\&\\-]', 'v'], ['😀+', ''], ['😀+', 'u'],
  ['\\uD83D\\uDE00', 'u'], ['\\uD83D\\uDE00', ''], ['[😀-😂]', 'u'], ['(?<y>\\d{4})-(?<m>\\d{2})', ''], ['ſ|K', 'iu'], ['[^a]', 'i'], ['\\W', 'iu'],
  ['(a+){1,60}$', ''], ['(a|aa){1,60}$', ''], ['^(\\w+\\s?){1,50}$', ''], ['(.*a){12}$', ''], ['((a|a))*$', ''], ['(?:(a|aa)b?)+$', ''],
]

/** Tokens the generator strings together. */
const TOKENS = [
  'a', 'b', 'K', 'k', 'ſ', 'é', '😀', '.', '^', '$', '|', '(', ')', '(?:', '(?<n>', '(?<m>', '(?=', '(?!', '(?<=', '(?<!', '(?i:', '(?-i:', '(?im-s:',
  '[', '[^', ']', '-', '*', '+', '?', '*?', '{', '}', '{2}', '{1,3}', '{2,}', '{,2}', '\\', '\\d', '\\w', '\\s', '\\D', '\\W', '\\S', '\\b', '\\B',
  '\\1', '\\2', '\\12', '\\0', '\\07', '\\377', '\\8', '\\c', '\\cA', '\\c1', '\\c_', '\\x', '\\x4', '\\x41', '\\u', '\\u004', '\\u0041', '\\u{', '\\u{41}',
  '\\u{110000}', '\\uD83D\\uDE00', '\\k', '\\k<n>', '\\k<', '\\p{L}', '\\P{Lu}', '\\p{RGI_Emoji}', '\\p', '\\q{ab|c|}', '&&', '--', '\\-', '\\/', '\\t',
  '\\n', '\\f', '\\&', '[a-z]', '[^\\d]',
]
const FLAGS = ['', 'u', 'v', 'i', 'iu', 'iv', 'm', 'su']

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

describe('the regex screen reads a pattern as a reference parser does', () => {
  it.each(HAND)('/%s/%s', (source, flags) => {
    expect(valid(source, flags), `/${source}/${flags} is valid on this engine`).toBe(true)
    check(source, flags)
  })

  it('generated patterns: same reading, prompt answer, invalid ones left to the constructor', () => {
    const rand = rng(0xa5e7)
    let validCount = 0, total = 0
    for (let n = 0; n < 30000; n++) {
      const len = 1 + Math.floor(rand() * 10)
      let source = ''
      for (let k = 0; k < len; k++) source += TOKENS[Math.floor(rand() * TOKENS.length)]
      const flags = FLAGS[Math.floor(rand() * FLAGS.length)]!
      total++
      if (check(source, flags).read) validCount++
    }
    // (the generator must exercise the parser: a sixth or more of its patterns are valid)
    expect(validCount).toBeGreaterThan(total / 6)
  }, 120_000)

})

describe('the tables of the screen, against V8', () => {
  it('\\s is the set V8 matches, over every code point', () => {
    const re = /^\s$/u
    const inSpace = (c: number): boolean => SPACE.some(([lo, hi]) => c >= lo && c <= hi)
    for (let c = 0; c <= 0x10ffff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue
      if (re.test(String.fromCodePoint(c)) !== inSpace(c)) throw new Error(`\\s differs at U+${c.toString(16)}`)
    }
  })

  it('the case-insensitive closure holds every code point V8 matches case-insensitively, in each mode', () => {
    // no code point above U+1FFFF has a case mapping or folding (the closure is built below it)
    const changes = /\p{Changes_When_Casefolded}|\p{Changes_When_Casemapped}/u
    for (let c = 0x20000; c <= 0x10ffff; c++) if (changes.test(String.fromCodePoint(c))) throw new Error(`U+${c.toString(16)} has a case mapping`)
    // every code point that has one, matched against every code point below U+20000: nothing outside its closure may match
    const all = Array.from({ length: 0x20000 }, (_, k) => (k >= 0xd800 && k <= 0xdfff ? ' ' : String.fromCodePoint(k))).join('')
    const bmp = Array.from({ length: 0x10000 }, (_, k) => (k >= 0xd800 && k <= 0xdfff ? ' ' : String.fromCharCode(k))).join('')
    let checked = 0
    for (let c = 0; c <= 0x1ffff; c++) {
      if ((c >= 0xd800 && c <= 0xdfff) || !changes.test(String.fromCodePoint(c))) continue
      const closure = fold([[c, c]])
      const inside = (y: number): boolean => closure.some(([lo, hi]) => y >= lo && y <= hi)
      for (const m of all.matchAll(new RegExp(`\\u{${c.toString(16)}}`, 'giu'))) {
        const y = m[0].codePointAt(0)!
        if (!inside(y)) throw new Error(`/\\u{${c.toString(16)}}/iu matches U+${y.toString(16)}, outside the closure`)
      }
      if (c <= 0xffff) {
        for (const m of bmp.matchAll(new RegExp(`\\u${c.toString(16).padStart(4, '0')}`, 'gi'))) {
          const y = m[0].charCodeAt(0)
          if (!inside(y)) throw new Error(`/\\u${c.toString(16)}/i matches U+${y.toString(16)}, outside the closure`)
        }
      }
      checked++
    }
    expect(checked).toBeGreaterThan(2000)
  }, 120_000)
})
