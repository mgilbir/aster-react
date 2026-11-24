/**
 * Static screen for regular expressions whose backtracking can run away. Applied ONLY under limits (see limits.ts), to every
 * pattern a spec or its data can supply, BEFORE the pattern is compiled or run: a cooperative clock cannot interrupt a regex that
 * has started, so the only defence available in-process is to refuse the dangerous ones up front.
 *
 * How it reads a pattern. `Parser` reads the whole ECMAScript 2025 pattern grammar in each of its three modes: the legacy (Annex
 * B) mode of a pattern without `u`/`v` (where `\u{`, `\x`, `\k`, `\c`, `\8`, a lone `{` and the octal escapes are literals), the
 * `u` mode and the `v` mode (class set operations, `\q{...}` strings, properties of strings), with modifier groups `(?i:...)` and
 * named groups. A pattern the RegExp constructor rejects is not screened (its own SyntaxError surfaces); a pattern the constructor
 * accepts and this parser cannot read is REFUSED (fail closed): the screen never vouches for what it did not read. Every step of
 * the parser consumes input, so it terminates on any string.
 *
 * What it refuses. The pattern becomes its position automaton (Glushkov), with how many distinct ways each transition can be
 * taken (a backtracking matcher enumerates parse trees, so `(a*)*` loops two ways on `a` though the automaton has one position),
 * and with the implicit lazy `[^]*` loop of the search in front unless every branch starts with `^` (without `m`): V8 tries each
 * start position in turn, which adds one to the degree of everything after it. Then:
 *   1. EXPONENTIAL ambiguity: a position from which two distinct paths come back to it on the same input (`(a+)+`, `(a|a)*`,
 *      `(\w+\s?){1,50}`, `((a|a))*`), found as a strongly connected component of the automaton squared that holds a diagonal pair
 *      and a step where the two paths differ.
 *   2. too many live paths: more than 4096 ways to have matched one input so far (`(a|a)(a|a)...`), a loop absorbing any length of
 *      it.
 *   3. a backreference inside a group that repeats.
 * Otherwise the pattern has a COST (`RegexCost`): `degree`, the longest chain of loops each of which can hand the same input on to
 * the next, the search's loop included (`a*b` searched and `\s+$` are 2, `a*a*a*b` 4, `\s*.*x` searched and the trim idiom
 * `^\s*(.*?)\s*$` 3; a loop from which the match can always end at once is no link of a chain, `\s*.*`, `\d+\.?\d*`, but still reads
 * the input: at least 1), and `work`, the transitions tried per character from the live paths of one start, counted on the whole
 * automaton (a bounded run after a loop over the same characters, `a*[ab]{0,20}x`, is entered from every place the loop can stop).
 * A run on `n` characters takes about `work * n ** degree` steps, at REGEX_NS_PER_UNIT each: under limits every run is refused,
 * before it starts, when that on its actual subject exceeds the time left (limits.ts `checkRegexRun`: `maxTimeMs`, else
 * REGEX_RUN_BUDGET_MS; the subject is at most `maxStringLength`, else REGEX_MAX_INPUT). Nothing can interrupt a running RegExp.
 * `regexHazard` gives the same verdict for a subject length and a budget (`regexRunMs` is the time).
 * Bounded repeats of a single character set are expanded exactly up to 64; any other repeat that may run twice is read as
 * unbounded (`(a+){1,60}` is `(a+)+`, the exponential shape it has in practice). Lookaround bodies are screened as patterns of
 * their own (they run at every position the match tries). A Unicode property is read as "any character" (an upper bound), a
 * case-insensitive set is closed under every case mapping, and a set operation keeps an upper and a lower bound, so nothing the
 * pattern can match is left out of what is analysed.
 *
 * It is a STATIC model of a backtracking matcher, conservative by construction (a few safe patterns are refused, such as
 * `(a|a){2}` or `.{1,100}.{1,100}x`); the hard guarantee for untrusted input remains a killable worker (docs/LIMITS.md).
 */

import { TextTable } from './util.js'
import { REGEX_MAX_INPUT, REGEX_NS_PER_UNIT, REGEX_RUN_BUDGET_MS } from './limits.js'

// --- character sets ---------------------------------------------------------------------------------

/** Sorted, disjoint, non-adjacent inclusive code point ranges. */
export type Ranges = ReadonlyArray<readonly [number, number]>

const MAX = 0x10ffff
export const FULL: Ranges = [[0, MAX]]
const EMPTY: Ranges = []
export const DIGIT: Ranges = [[48, 57]]
export const WORD: Ranges = [[48, 57], [65, 90], [95, 95], [97, 122]]
/** `\s`: WhiteSpace and LineTerminator (ECMA-262 22.2.2.9; a test pins it to V8's over every code point). */
export const SPACE: Ranges = [[9, 13], [32, 32], [160, 160], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff]]

export function normalize(r: ReadonlyArray<readonly [number, number]>): Ranges {
  const s = r.filter(([lo, hi]) => lo <= hi).sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  for (const [lo, hi] of s) {
    const last = out[out.length - 1]
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi)
    else out.push([lo, hi])
  }
  return out
}
export function complement(r: Ranges): Ranges {
  const out: Array<[number, number]> = []
  let at = 0
  for (const [lo, hi] of r) {
    if (lo > at) out.push([at, lo - 1])
    at = hi + 1
  }
  if (at <= MAX) out.push([at, MAX])
  return out
}
export const union = (a: Ranges, b: Ranges): Ranges => normalize([...a, ...b])
export function intersect(a: Ranges, b: Ranges): Ranges {
  const out: Array<[number, number]> = []
  let i = 0, j = 0
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i]![0], b[j]![0]), hi = Math.min(a[i]![1], b[j]![1])
    if (lo <= hi) out.push([lo, hi])
    if (a[i]![1] < b[j]![1]) i++
    else j++
  }
  return out
}
export const subtract = (a: Ranges, b: Ranges): Ranges => intersect(a, complement(b))
function overlaps(a: Ranges, b: Ranges): boolean {
  let i = 0, j = 0
  while (i < a.length && j < b.length) {
    if (a[i]![0] <= b[j]![1] && b[j]![0] <= a[i]![1]) return true
    if (a[i]![1] < b[j]![1]) i++
    else j++
  }
  return false
}

/**
 * The case-insensitive closure: every code point some case mapping relates to one in the set. Code points are related when
 * lower(upper(x)) agree (simple folding, as `u`/`v` canonicalize), when upper(x) agree (the legacy canonicalization) or when
 * lower(x) agree, each mapping taken only where it yields one code point; the relation is closed transitively. That
 * over-approximates both modes. Built once, on the first case-insensitive pattern; no code point above U+1FFFF has a case mapping
 * (a test pins that).
 */
let FOLD: Array<[number, number[]]> | null = null
function foldTable(): Array<[number, number[]]> {
  if (FOLD) return FOLD
  const single = (s: string, c: number): number => {
    const v = s.codePointAt(0)!
    return s.length === (v > 0xffff ? 2 : 1) ? v : c
  }
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    let r = x
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!
    parent.set(x, r)
    return r
  }
  const join = (a: number, b: number): void => {
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (let c = 0; c <= 0x1ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue
    const ch = String.fromCodePoint(c)
    const up = single(ch.toUpperCase(), c)
    const low = single(ch.toLowerCase(), c)
    if (up === c && low === c) continue
    join(c, up)
    join(c, low)
    join(c, single(String.fromCodePoint(up).toLowerCase(), up))
  }
  // The mappings above miss the special foldings (`\u{1FD3}` folds with `\u{390}`, `\u{1DF95}` with `ß`, neither of which has a
  // one-code-point upper case): V8's own `iu` matching names them, each case-relevant code point matched against all the others.
  // (The legacy `i` mode canonicalizes by the one-code-point upper case, which the mappings above already relate.) About 0.15 s,
  // once per process, on the first case-insensitive pattern screened.
  const relevant = /\p{Cased}|\p{Changes_When_Casefolded}|\p{Changes_When_Casemapped}/u
  const candidates: number[] = []
  for (let c = 0; c <= 0x1ffff; c++) if ((c < 0xd800 || c > 0xdfff) && relevant.test(String.fromCodePoint(c))) candidates.push(c)
  const text = String.fromCodePoint(...candidates)
  for (const c of candidates) {
    for (const m of text.matchAll(new RegExp(`\\u{${c.toString(16)}}`, 'giu'))) join(c, m[0].codePointAt(0)!)
  }
  const classes = new Map<number, number[]>()
  for (const c of parent.keys()) {
    const r = find(c)
    let l = classes.get(r)
    if (!l) classes.set(r, (l = []))
    l.push(c)
  }
  const out: Array<[number, number[]]> = []
  for (const members of classes.values()) for (const c of members) out.push([c, members.filter((x) => x !== c)])
  FOLD = out.sort((a, b) => a[0] - b[0])
  return FOLD
}
export function fold(r: Ranges): Ranges {
  if (r.length === 1 && r[0]![0] === 0 && r[0]![1] === MAX) return r
  const t = foldTable()
  const extra: Array<[number, number]> = []
  for (const [lo, hi] of r) {
    let a = 0, b = t.length
    while (a < b) { const m = (a + b) >> 1; if (t[m]![0] < lo) a = m + 1; else b = m }
    for (let k = a; k < t.length && t[k]![0] <= hi; k++) for (const p of t[k]![1]) extra.push([p, p])
  }
  return extra.length ? union(r, extra) : r
}

/** A set as far as the screen knows it: `hi` holds every code point it may match, `lo` only code points it surely matches. */
export interface CharSet { hi: Ranges; lo: Ranges }
export const exactSet = (r: Ranges): CharSet => ({ hi: r, lo: r })
/** A Unicode property: the screen does not carry the tables, so it may be anything. */
export const UNKNOWN_SET: CharSet = { hi: FULL, lo: EMPTY }
export const csUnion = (a: CharSet, b: CharSet): CharSet => ({ hi: union(a.hi, b.hi), lo: union(a.lo, b.lo) })
export const csIntersect = (a: CharSet, b: CharSet): CharSet => ({ hi: intersect(a.hi, b.hi), lo: intersect(a.lo, b.lo) })
export const csSubtract = (a: CharSet, b: CharSet): CharSet => ({ hi: subtract(a.hi, b.lo), lo: subtract(a.lo, b.hi) })
export const csComplement = (a: CharSet): CharSet => ({ hi: complement(a.lo), lo: complement(a.hi) })

// --- the pattern tree -------------------------------------------------------------------------------

/** What the screen reads a pattern as. */
export type RNode =
  | { t: 'set'; set: CharSet }
  | { t: 'seq'; items: RNode[] }
  | { t: 'alt'; alts: RNode[] }
  | { t: 'rep'; n: RNode; min: number; max: number }
  | { t: 'group'; n: RNode; capture: boolean }
  | { t: 'look'; n: RNode; behind: boolean; negate: boolean }
  | { t: 'assert'; kind: 'start' | 'end' | 'word' | 'nonword' }
  | { t: 'backref' }
  /** a property of strings (`\p{RGI_Emoji}`, `v` mode): one string of unknown length and content */
  | { t: 'strings' }

/** The pattern is not one the screen can read: refused under limits. */
class Unreadable extends Error {}
/** The pattern is readable, but larger than the analysis' budget: refused under limits. */
class TooComplex extends Error {}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'
const isHex = (c: string | undefined): boolean => c !== undefined && /^[0-9a-fA-F]$/.test(c)
const isOctal = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '7'
const isAsciiLetter = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z]$/.test(c)
/** v-mode ClassSetReservedPunctuator: what `\` may escape in a class besides the syntax characters. */
const CLASS_SET_PUNCTUATOR = new Set('&-!#%,:;<=>@`~'.split(''))
/** The syntax characters an identity escape names in `u`/`v` mode (and `/`). */
const SYNTAX = '^$\\.*+?()[]{}|/'
/** Properties of strings (ECMA-262 "Binary Unicode properties of strings"). */
const STRING_PROPERTIES = new Set(['Basic_Emoji', 'Emoji_Keycap_Sequence', 'RGI_Emoji_Modifier_Sequence', 'RGI_Emoji_Flag_Sequence', 'RGI_Emoji_Tag_Sequence', 'RGI_Emoji_ZWJ_Sequence', 'RGI_Emoji'])

/** A `v`-mode class's content: its characters, and the strings it may hold (`strings` + `anyStrings`) and surely holds. */
interface ClassSet { set: CharSet; strings: number[][]; anyStrings: boolean; stringsLo: number[][] }
const strKey = (s: number[]): string => s.join(',')
const strIn = (s: number[], list: number[][]): boolean => list.some((x) => strKey(x) === strKey(s))
const NO_STRINGS = (): Pick<ClassSet, 'strings' | 'anyStrings' | 'stringsLo'> => ({ strings: [], anyStrings: false, stringsLo: [] })

/** Count the capturing groups and whether any is named (the grammar's `N` parameter), skipping escapes and classes. */
function scanGroups(s: string, v: boolean): { count: number; named: boolean } {
  let count = 0, named = false, depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') { i++; continue }
    if (depth > 0) {
      if (c === ']') depth--
      else if (c === '[' && v) depth++
      continue
    }
    if (c === '[') { depth = 1; continue }
    if (c === '(') {
      if (s[i + 1] !== '?') count++
      else if (s[i + 2] === '<' && s[i + 3] !== '=' && s[i + 3] !== '!') { count++; named = true }
    }
  }
  return { count, named }
}

/** Reads a pattern the RegExp constructor accepted. Any input terminates; what it cannot read throws `Unreadable`. */
class Parser {
  private i = 0
  private readonly u: boolean
  private readonly v: boolean
  private readonly named: boolean
  private readonly groups: number
  private icase: boolean

  constructor(private readonly s: string, flags: string) {
    this.v = flags.includes('v')
    this.u = this.v || flags.includes('u')
    this.icase = flags.includes('i')
    const g = scanGroups(s, this.v)
    this.groups = g.count
    this.named = this.u || g.named
  }

  parse(): RNode {
    const n = this.disjunction()
    if (this.i !== this.s.length) this.fail('unbalanced')
    return n
  }

  private fail(why: string): never { throw new Unreadable(why) }
  private peek(k = 0): string | undefined { return this.s[this.i + k] }
  private eat(str: string): boolean {
    if (!this.s.startsWith(str, this.i)) return false
    this.i += str.length
    return true
  }
  /** One source character: a code point in `u`/`v` mode, a code unit otherwise. */
  private char(): number {
    if (this.i >= this.s.length) this.fail('end of pattern')
    const c = this.u ? this.s.codePointAt(this.i)! : this.s.charCodeAt(this.i)
    this.i += c > 0xffff ? 2 : 1
    return c
  }
  private folded(set: CharSet): CharSet { return this.icase ? { hi: fold(set.hi), lo: set.lo } : set }
  private setNode(set: CharSet): RNode { return { t: 'set', set: this.folded(set) } }
  private one(c: number): CharSet { return exactSet([[c, c]]) }

  private disjunction(): RNode {
    const alts: RNode[] = [this.alternative()]
    while (this.peek() === '|') { this.i++; alts.push(this.alternative()) }
    return { t: 'alt', alts }
  }

  private alternative(): RNode {
    const items: RNode[] = []
    while (this.i < this.s.length && this.peek() !== '|' && this.peek() !== ')') {
      const at = this.i
      items.push(this.term())
      if (this.i <= at) this.fail('no progress')
    }
    return { t: 'seq', items }
  }

  private term(): RNode {
    const c = this.peek()!
    if (c === '^') { this.i++; return { t: 'assert', kind: 'start' } }
    if (c === '$') { this.i++; return { t: 'assert', kind: 'end' } }
    if (c === '\\' && (this.peek(1) === 'b' || this.peek(1) === 'B')) {
      this.i += 2
      return { t: 'assert', kind: this.s[this.i - 1] === 'b' ? 'word' : 'nonword' }
    }
    if (this.s.startsWith('(?=', this.i) || this.s.startsWith('(?!', this.i)) {
      const negate = this.s[this.i + 2] === '!'
      this.i += 3
      const look: RNode = { t: 'look', n: this.disjunction(), behind: false, negate }
      if (!this.eat(')')) this.fail('unbalanced lookahead')
      // (Annex B: without `u`/`v` a lookahead may be quantified)
      return this.u ? look : this.quantified(look)
    }
    if (this.s.startsWith('(?<=', this.i) || this.s.startsWith('(?<!', this.i)) {
      const negate = this.s[this.i + 3] === '!'
      this.i += 4
      const look: RNode = { t: 'look', n: this.disjunction(), behind: true, negate }
      if (!this.eat(')')) this.fail('unbalanced lookbehind')
      return look
    }
    return this.quantified(this.atom())
  }

  private quantified(n: RNode): RNode {
    let min: number, max: number
    const c = this.peek()
    if (c === '*') { min = 0; max = Infinity; this.i++ }
    else if (c === '+') { min = 1; max = Infinity; this.i++ }
    else if (c === '?') { min = 0; max = 1; this.i++ }
    else if (c === '{') {
      const q = this.braces()
      if (!q) return n
      ;[min, max] = q
    } else return n
    if (this.peek() === '?') this.i++ // lazy: the same paths, tried in another order
    return { t: 'rep', n, min, max }
  }

  /** `{n}`, `{n,}`, `{n,m}` (consumed), or null for a brace that is not a quantifier (a literal, outside `u`/`v`). */
  private braces(): [number, number] | null {
    let j = this.i + 1
    const num = (): number | undefined => {
      const st = j
      while (isDigit(this.s[j])) j++
      return j > st ? Number(this.s.slice(st, j)) : undefined
    }
    const min = num()
    if (min === undefined) return null
    let max = min
    if (this.s[j] === ',') { j++; const m = num(); max = m === undefined ? Infinity : m }
    if (this.s[j] !== '}') return null
    this.i = j + 1
    return [min, max]
  }

  private atom(): RNode {
    const c = this.peek()!
    if (c === '(') return this.group()
    if (c === '[') return this.classAtom()
    if (c === '.') { this.i++; return this.setNode(exactSet(FULL)) }
    if (c === '\\') return this.atomEscape()
    if (c === ')' || c === '*' || c === '+' || c === '?') this.fail('nothing to repeat')
    return this.setNode(this.one(this.char()))
  }

  private group(): RNode {
    this.i++ // (
    if (this.peek() !== '?') return this.groupBody(true)
    if (this.eat('?:')) return this.groupBody(false)
    if (this.peek(1) === '<') {
      const end = this.s.indexOf('>', this.i)
      if (end < 0) this.fail('group name')
      this.i = end + 1
      return this.groupBody(true)
    }
    // modifiers: (?ims-ims:...)
    const m = /^\?([ims]*)(?:-([ims]*))?:/.exec(this.s.slice(this.i, this.i + 10))
    if (!m) this.fail('unknown group')
    this.i += m[0].length
    const saved = this.icase
    if (m[1]!.includes('i')) this.icase = true
    if (m[2]?.includes('i')) this.icase = false
    try { return this.groupBody(false) } finally { this.icase = saved }
  }
  private groupBody(capture: boolean): RNode {
    const n = this.disjunction()
    if (!this.eat(')')) this.fail('unbalanced group')
    return { t: 'group', n, capture }
  }

  private atomEscape(): RNode {
    this.i++ // backslash
    const c = this.peek()
    if (c === undefined) this.fail('trailing backslash')
    // a backreference by number (in u/v mode, or when there are that many groups) or by name (`\k<name>` with named groups)
    if (c >= '1' && c <= '9') {
      const st = this.i
      while (isDigit(this.peek())) this.i++
      if (this.u || Number(this.s.slice(st, this.i)) <= this.groups) return { t: 'backref' }
      this.i = st // a legacy octal or an identity escape
    }
    if (c === 'k' && this.named) {
      if (this.peek(1) !== '<') this.fail('\\k without a name')
      const end = this.s.indexOf('>', this.i)
      if (end < 0) this.fail('\\k without a name')
      this.i = end + 1
      return { t: 'backref' }
    }
    if (this.u && (c === 'p' || c === 'P')) return this.property()
    const cls = this.classEscape(c)
    if (cls) { this.i++; return this.setNode(cls) }
    // Annex B: `\c` not followed by a letter is a backslash, and the `c` is then read as itself
    if (c === 'c' && !isAsciiLetter(this.peek(1))) {
      if (this.u) this.fail('\\c')
      return this.setNode(this.one(92))
    }
    return this.setNode(this.one(this.characterEscape(false)))
  }

  private classEscape(c: string): CharSet | null {
    switch (c) {
      case 'd': return exactSet(DIGIT)
      case 'D': return exactSet(complement(DIGIT))
      case 'w': return exactSet(WORD)
      case 'W': return exactSet(complement(WORD))
      case 's': return exactSet(SPACE)
      case 'S': return exactSet(complement(SPACE))
      default: return null
    }
  }

  /** `\p{...}` / `\P{...}` in u/v mode (the backslash read). A property of strings is a node of its own. */
  private property(): RNode {
    const negate = this.peek() === 'P'
    this.i++
    if (this.peek() !== '{') this.fail('property')
    const end = this.s.indexOf('}', this.i)
    if (end < 0) this.fail('property')
    const name = this.s.slice(this.i + 1, end)
    this.i = end + 1
    if (!negate && this.v && STRING_PROPERTIES.has(name)) return { t: 'strings' }
    return this.setNode(UNKNOWN_SET)
  }

  /**
   * A CharacterEscape (the backslash read): control escapes, `\cX`, `\0`, `\xHH`, `\uHHHH`, `\u{...}`, Annex B's legacy octal
   * escapes, identity escapes. Returns the character. `inClass` reads `\b` as backspace and Annex B's `\c0`/`\c_`.
   */
  private characterEscape(inClass: boolean): number {
    const c = this.peek()!
    const CONTROL: Record<string, number> = { f: 12, n: 10, r: 13, t: 9, v: 11 }
    if (Object.hasOwn(CONTROL, c)) { this.i++; return CONTROL[c]! }
    if (inClass && c === 'b') { this.i++; return 8 }
    if (c === 'c') {
      const l = this.peek(1)
      if (isAsciiLetter(l) || (inClass && !this.u && (isDigit(l) || l === '_'))) { this.i += 2; return l!.charCodeAt(0) % 32 }
      this.fail('\\c')
    }
    if (c === '0' && !isDigit(this.peek(1))) { this.i++; return 0 }
    if (isDigit(c)) {
      if (this.u) this.fail('decimal escape')
      // Annex B LegacyOctalEscapeSequence; `\8` and `\9` are identity escapes
      if (!isOctal(c)) { this.i++; return c.charCodeAt(0) }
      let digits = c
      this.i++
      if (isOctal(this.peek())) {
        digits += this.peek()
        this.i++
        if (c <= '3' && isOctal(this.peek())) { digits += this.peek(); this.i++ }
      }
      return parseInt(digits, 8)
    }
    if (c === 'x') {
      if (isHex(this.peek(1)) && isHex(this.peek(2))) { this.i += 3; return parseInt(this.s.slice(this.i - 2, this.i), 16) }
      if (this.u) this.fail('\\x')
      this.i++
      return 120 // Annex B: `\x` is `x`
    }
    if (c === 'u') {
      const v = this.unicodeEscape()
      if (v !== null) return v
      if (this.u) this.fail('\\u')
      this.i++
      return 117 // Annex B: `\u` is `u`
    }
    // identity escapes: in u/v mode only the syntax characters (and `-` in a class); else anything but `c` (and `k` with names)
    if (this.u) {
      if (!SYNTAX.includes(c) && !(inClass && c === '-')) this.fail('identity escape')
    } else if (c === 'k' && this.named && !inClass) this.fail('\\k')
    return this.char()
  }

  /** `\uHHHH` (a surrogate pair of them in u/v mode) or `\u{H...}` (u/v mode), the `u` not yet read; null if it is neither. */
  private unicodeEscape(): number | null {
    const at = this.i
    if (this.u && this.s[at + 1] === '{') {
      const end = this.s.indexOf('}', at + 2)
      if (end < 0) return null
      const hex = this.s.slice(at + 2, end)
      if (!/^[0-9a-fA-F]+$/.test(hex)) return null
      const v = parseInt(hex, 16)
      if (v > MAX) return null
      this.i = end + 1
      return v
    }
    const hex4 = this.s.slice(at + 1, at + 5)
    if (!/^[0-9a-fA-F]{4}$/.test(hex4)) return null
    let v = parseInt(hex4, 16)
    this.i = at + 5
    if (this.u && v >= 0xd800 && v <= 0xdbff && this.s.startsWith('\\u', this.i)) {
      const lo = this.s.slice(this.i + 2, this.i + 6)
      if (/^[0-9a-fA-F]{4}$/.test(lo)) {
        const w = parseInt(lo, 16)
        if (w >= 0xdc00 && w <= 0xdfff) { v = 0x10000 + ((v - 0xd800) << 10) + (w - 0xdc00); this.i += 6 }
      }
    }
    return v
  }

  // --- classes ----------------------------------------------------------------------------------------

  private classAtom(): RNode {
    if (!this.v) return { t: 'set', set: this.folded(this.legacyClass()) }
    const cs = this.setClass()
    const set = this.folded(cs.set)
    if (!cs.strings.length && !cs.anyStrings) return { t: 'set', set }
    const alts: RNode[] = [{ t: 'set', set }]
    for (const s of cs.strings) alts.push({ t: 'seq', items: s.map((c) => this.setNode(this.one(c))) })
    if (cs.anyStrings) alts.push({ t: 'strings' })
    return { t: 'alt', alts }
  }

  /** A class without `v`: single characters, ranges, class escapes; Annex B reads `\d-z` as three members. */
  private legacyClass(): CharSet {
    this.i++ // [
    const negate = this.eat('^')
    let acc: CharSet = exactSet(EMPTY)
    for (;;) {
      if (this.i >= this.s.length) this.fail('unterminated class')
      if (this.peek() === ']') { this.i++; break }
      const a = this.classMember()
      if (this.peek() === '-' && this.peek(1) !== ']' && this.i + 1 < this.s.length) {
        const save = this.i
        this.i++
        const b = this.classMember()
        if (a.single !== null && b.single !== null) {
          if (a.single > b.single) this.fail('range out of order')
          acc = csUnion(acc, exactSet([[a.single, b.single]]))
          continue
        }
        if (this.u) this.fail('class escape in a range')
        this.i = save // Annex B: `\d-z` is `\d`, `-`, `z`
      }
      acc = csUnion(acc, a.set)
    }
    return negate ? csComplement(acc) : acc
  }
  private classMember(): { set: CharSet; single: number | null } {
    if (this.peek() !== '\\') { const c = this.char(); return { set: this.one(c), single: c } }
    this.i++
    const c = this.peek()
    if (c === undefined) this.fail('trailing backslash')
    if (this.u && (c === 'p' || c === 'P')) {
      const n = this.property()
      return { set: n.t === 'set' ? n.set : UNKNOWN_SET, single: null }
    }
    const cls = this.classEscape(c)
    if (cls) { this.i++; return { set: cls, single: null } }
    if (!this.u && c === 'c' && !(isAsciiLetter(this.peek(1)) || isDigit(this.peek(1)) || this.peek(1) === '_')) {
      return { set: this.one(92), single: 92 } // Annex B: a backslash; the `c` is the next member
    }
    if (!this.u && c === 'k') { this.i++; return { set: this.one(107), single: 107 } }
    const v = this.characterEscape(true)
    return { set: this.one(v), single: v }
  }

  /** A `v`-mode class: a union, an intersection (`&&`) or a subtraction (`--`) of operands (nested classes, `\q{...}`). */
  private setClass(): ClassSet {
    this.i++ // [
    const negate = this.eat('^')
    let acc: ClassSet | null = null
    let op: 'union' | 'and' | 'minus' | null = null
    let pending: 'and' | 'minus' | null = null
    for (;;) {
      if (this.i >= this.s.length) this.fail('unterminated class')
      if (this.peek() === ']') { this.i++; break }
      if (this.s.startsWith('&&', this.i) || this.s.startsWith('--', this.i)) {
        const next = this.s[this.i] === '&' ? 'and' : 'minus'
        if (acc === null || op === 'union' || (op !== null && op !== next) || pending) this.fail('set operator')
        this.i += 2
        op = pending = next
        continue
      }
      let operand = this.setOperand()
      // a range of two single characters
      if (operand.single !== null && this.peek() === '-' && this.peek(1) !== '-') {
        this.i++
        const b = this.setOperand()
        if (b.single === null || operand.single > b.single) this.fail('bad range')
        operand = { cs: { set: exactSet([[operand.single, b.single]]), ...NO_STRINGS() }, single: null }
      }
      const cs = operand.cs
      if (acc === null) { acc = cs; continue }
      if (pending === 'and') acc = { set: csIntersect(acc.set, cs.set), ...stringsAnd(acc, cs) }
      else if (pending === 'minus') acc = { set: csSubtract(acc.set, cs.set), ...stringsMinus(acc, cs) }
      else {
        if (op !== null && op !== 'union') this.fail('set operator')
        op = 'union'
        acc = { set: csUnion(acc.set, cs.set), strings: [...acc.strings, ...cs.strings], anyStrings: acc.anyStrings || cs.anyStrings, stringsLo: [...acc.stringsLo, ...cs.stringsLo] }
      }
      pending = null
    }
    if (pending) this.fail('set operator')
    const out = acc ?? { set: exactSet(EMPTY), ...NO_STRINGS() }
    if (!negate) return out
    if (out.anyStrings || out.strings.length) this.fail('negated class of strings')
    return { set: csComplement(out.set), ...NO_STRINGS() }
  }
  private setOperand(): { cs: ClassSet; single: number | null } {
    const c = this.peek()!
    if (c === '[') return { cs: this.setClass(), single: null }
    if (c === '\\') {
      this.i++
      const e = this.peek()
      if (e === undefined) this.fail('trailing backslash')
      if (e === 'q' && this.peek(1) === '{') return { cs: this.classStrings(), single: null }
      if (e === 'p' || e === 'P') {
        const n = this.property()
        if (n.t === 'strings') return { cs: { set: exactSet(EMPTY), strings: [], anyStrings: true, stringsLo: [] }, single: null }
        return { cs: { set: n.t === 'set' ? n.set : UNKNOWN_SET, ...NO_STRINGS() }, single: null }
      }
      const cls = this.classEscape(e)
      if (cls) { this.i++; return { cs: { set: cls, ...NO_STRINGS() }, single: null } }
      const v = this.setEscape()
      return { cs: { set: this.one(v), ...NO_STRINGS() }, single: v }
    }
    if ('()[]{}/-|'.includes(c)) this.fail('class set syntax character')
    if (CLASS_SET_PUNCTUATOR.has(c) && this.peek(1) === c) this.fail('reserved double punctuator')
    const v = this.char()
    return { cs: { set: this.one(v), ...NO_STRINGS() }, single: v }
  }
  /** An escape in a `v`-mode class (the backslash read): a reserved punctuator, or a CharacterEscape. */
  private setEscape(): number {
    const e = this.peek()!
    if (CLASS_SET_PUNCTUATOR.has(e) && e !== '-') { this.i++; return e.charCodeAt(0) }
    return this.characterEscape(true)
  }
  /** `\q{abc|d|}`: its single characters join the set; the others (the empty string too) are strings. */
  private classStrings(): ClassSet {
    this.i += 2 // q{
    const strings: number[][] = []
    let cur: number[] = []
    for (;;) {
      const c = this.peek()
      if (c === undefined) this.fail('unterminated \\q')
      if (c === '}') { this.i++; strings.push(cur); break }
      if (c === '|') { this.i++; strings.push(cur); cur = []; continue }
      if (c === '\\') { this.i++; cur.push(this.setEscape()); continue }
      cur.push(this.char())
    }
    const singles = strings.filter((s) => s.length === 1).map((s) => [s[0]!, s[0]!] as [number, number])
    const multi = strings.filter((s) => s.length !== 1)
    return { set: exactSet(normalize(singles)), strings: multi, anyStrings: false, stringsLo: multi }
  }
}

function stringsAnd(a: ClassSet, b: ClassSet): Pick<ClassSet, 'strings' | 'anyStrings' | 'stringsLo'> {
  // what may be in both (an unknown side keeps the other's), and what surely is in both
  const strings = a.anyStrings && b.anyStrings ? [...a.strings, ...b.strings]
    : a.anyStrings ? b.strings : b.anyStrings ? a.strings : a.strings.filter((s) => strIn(s, b.strings))
  return { strings, anyStrings: a.anyStrings && b.anyStrings, stringsLo: a.stringsLo.filter((s) => strIn(s, b.stringsLo)) }
}
function stringsMinus(a: ClassSet, b: ClassSet): Pick<ClassSet, 'strings' | 'anyStrings' | 'stringsLo'> {
  return {
    strings: a.strings.filter((s) => !strIn(s, b.stringsLo)),
    anyStrings: a.anyStrings,
    stringsLo: b.anyStrings ? [] : a.stringsLo.filter((s) => !strIn(s, b.strings)),
  }
}

/**
 * Read a pattern as the screen does: the tree the analysis runs on (exported for the differential against a reference parser).
 * Throws on a pattern the screen cannot read.
 */
export function readPattern(source: string, flags = ''): RNode {
  return new Parser(source, flags).parse()
}

// --- the position automaton -------------------------------------------------------------------------

/** Ways are only told apart up to 2 (one way, or several). */
const cap = (n: number): number => (n > 2 ? 2 : n)
type Mult = Map<number, number>
function addMult(to: Mult, from: Mult, times = 1): void {
  if (!times) return
  for (const [k, n] of from) to.set(k, cap((to.get(k) ?? 0) + n * times))
}

/** What a subtree contributes (Glushkov): where it starts and ends, in how many ways, and whether it can match nothing. */
interface Part {
  first: Mult
  last: Mult
  /** the ends after which the match finishes whatever the input (no assertion, lookaround or backreference after them) */
  lastU: Set<number>
  /** the ways to match nothing (up to 2) */
  empty: number
  /** whether it can match nothing unconditionally */
  emptyU: boolean
}

/** Positions over this many (bounded repeats expanded) are more than the screen analyses: the pattern is refused. */
const MAX_POSITIONS = 2048
/** Repeats of one character set are expanded exactly up to this bound; larger ones are read as unbounded. */
const EXPAND_SET = 64
/** Steps of the analysis before it gives up (and the pattern is refused). */
const MAX_STEPS = 4_000_000
/** Live paths on one input above which a pattern is refused. */
const MAX_AMBIGUITY = 4096

class Automaton {
  readonly sets: Ranges[] = []
  readonly follow: Mult[] = []
  /** lookaround bodies, screened as patterns of their own */
  readonly looks: RNode[] = []

  private pos(r: Ranges): Part {
    const p = this.sets.length
    if (p >= MAX_POSITIONS) throw new TooComplex('too many positions')
    this.sets.push(r)
    this.follow.push(new Map())
    return { first: new Map([[p, 1]]), last: new Map([[p, 1]]), lastU: new Set([p]), empty: 0, emptyU: false }
  }
  private link(from: Mult, to: Mult): void {
    for (const [l, a] of from) addMult(this.follow[l]!, to, a)
  }
  private epsilon(conditional: boolean): Part {
    return { first: new Map(), last: new Map(), lastU: new Set(), empty: 1, emptyU: !conditional }
  }
  seq(a: Part, b: Part): Part {
    this.link(a.last, b.first)
    const first = new Map(a.first); addMult(first, b.first, a.empty)
    const last = new Map(b.last); addMult(last, a.last, b.empty)
    const lastU = new Set(b.lastU)
    if (b.emptyU) for (const p of a.lastU) lastU.add(p)
    return { first, last, lastU, empty: cap(a.empty * b.empty), emptyU: a.emptyU && b.emptyU }
  }
  private alt(parts: Part[]): Part {
    const first: Mult = new Map(), last: Mult = new Map(), lastU = new Set<number>()
    let empty = 0, emptyU = false
    for (const p of parts) {
      addMult(first, p.first)
      addMult(last, p.last)
      for (const x of p.lastU) lastU.add(x)
      empty = cap(empty + p.empty)
      emptyU ||= p.emptyU
    }
    return { first, last, lastU, empty, emptyU }
  }
  /** `x*` (min 0) or `x+` (min 1): the way back from its ends to its starts (an iteration that matches nothing is rejected). */
  private loop(x: Part, min: 0 | 1): Part {
    this.link(x.last, x.first)
    return min === 0 ? { ...x, empty: 1, emptyU: true } : x
  }
  private optional(x: Part): Part {
    return { ...x, empty: cap(1 + x.empty), emptyU: true }
  }

  build(n: RNode): Part {
    switch (n.t) {
      case 'set': return this.pos(n.set.hi)
      case 'seq': return n.items.reduce<Part>((acc, it) => this.seq(acc, this.build(it)), this.epsilon(false))
      case 'alt': return this.alt(n.alts.map((a) => this.build(a)))
      case 'group': return this.build(n.n)
      case 'assert': return this.epsilon(true)
      case 'look': this.looks.push(n.n); return this.epsilon(true)
      case 'backref': {
        // the captured text: any string, possibly empty, matched one way, and it may fail
        const p = this.pos(FULL)
        this.link(p.last, p.first)
        return { ...p, lastU: new Set(), empty: 1, emptyU: false }
      }
      case 'strings': return this.loop(this.pos(FULL), 1)
      case 'rep': return this.repeat(n)
    }
  }
  private repeat(n: Extract<RNode, { t: 'rep' }>): Part {
    const { min, max } = n
    if (max === 0) return this.epsilon(false)
    if (n.n.t === 'set' && min <= EXPAND_SET && (max <= EXPAND_SET || max === Infinity)) {
      // exactly: `x{2,4}` is x x (x (x)?)?, and `x{2,}` is x x+
      let acc = this.epsilon(false)
      if (max === Infinity) {
        for (let k = 1; k < min; k++) acc = this.seq(acc, this.build(n.n))
        return this.seq(acc, this.loop(this.build(n.n), min === 0 ? 0 : 1))
      }
      for (let k = 0; k < min; k++) acc = this.seq(acc, this.build(n.n))
      const tail = (left: number): Part => (left === 0 ? this.epsilon(false) : this.optional(this.seq(this.build(n.n), tail(left - 1))))
      return this.seq(acc, tail(max - min))
    }
    if (max === 1) return min === 1 ? this.build(n.n) : this.optional(this.build(n.n))
    // a repeat that may run twice or more is read as unbounded
    return this.loop(this.build(n.n), min === 0 ? 0 : 1)
  }
}

/** Iterative Tarjan over the nodes 0..n-1: each node's component; components are numbered in reverse topological order. */
function components(n: number, succ: (v: number) => readonly number[]): Int32Array {
  const index = new Int32Array(n).fill(-1), low = new Int32Array(n), comp = new Int32Array(n).fill(-1)
  const onStack = new Uint8Array(n)
  const stack: number[] = []
  let next = 0, ncomp = 0
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue
    const work: Array<[number, number]> = [[root, 0]]
    index[root] = low[root] = next++
    stack.push(root)
    onStack[root] = 1
    while (work.length) {
      const top = work[work.length - 1]!
      const v = top[0]
      const out = succ(v)
      if (top[1] < out.length) {
        const w = out[top[1]++]!
        if (index[w] === -1) {
          index[w] = low[w] = next++
          stack.push(w)
          onStack[w] = 1
          work.push([w, 0])
        } else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!)
        continue
      }
      work.pop()
      if (work.length) { const u = work[work.length - 1]![0]; low[u] = Math.min(low[u]!, low[v]!) }
      if (low[v] === index[v]) {
        for (;;) { const w = stack.pop()!; onStack[w] = 0; comp[w] = ncomp; if (w === v) break }
        ncomp++
      }
    }
  }
  return comp
}

/** Whether every way through `n` starts with `^` (outside multiline mode), so the search tries no later position. */
function startAnchored(n: RNode): boolean {
  switch (n.t) {
    case 'assert': return n.kind === 'start'
    case 'group': return startAnchored(n.n)
    case 'alt': return n.alts.length > 0 && n.alts.every(startAnchored)
    case 'seq':
      for (const it of n.items) {
        if (startAnchored(it)) return true
        // (only what consumes nothing may come before the anchor)
        if (it.t !== 'assert' && it.t !== 'look') return false
      }
      return false
    default: return false
  }
}

/** A backreference inside a group that repeats. */
function backrefInRepeat(n: RNode, repeated: boolean): boolean {
  switch (n.t) {
    case 'backref': return repeated
    case 'rep': return backrefInRepeat(n.n, repeated || n.max > 1)
    case 'seq': return n.items.some((x) => backrefInRepeat(x, repeated))
    case 'alt': return n.alts.some((x) => backrefInRepeat(x, repeated))
    case 'group': case 'look': return backrefInRepeat(n.n, repeated)
    default: return false
  }
}

/**
 * What one run of a pattern the screen does not refuse outright costs: about `work * n ** degree` steps of V8's matcher on an
 * input of `n` characters (`degree`: the longest chain of loops that can hand the same input on to the next, the search's own loop
 * counted; `work`: the transitions tried per character from the live paths of one start, at least 1).
 */
export interface RegexCost { readonly degree: number; readonly work: number }

/** Screen one pattern tree (the pattern, or a lookaround body): the reason it is refused whatever its input, or its cost. */
function analyse(tree: RNode, unanchored: boolean, budget: { steps: number }, searched = true): string | RegexCost {
  if (backrefInRepeat(tree, false)) return 'a backreference inside a repeated group'
  const A = new Automaton()
  let body = A.build(tree)
  if (searched && (unanchored || !startAnchored(tree))) {
    // the search tries every start position in turn: a lazy loop over anything, in front of the pattern
    body = A.seq(A.build({ t: 'rep', n: { t: 'set', set: exactSet(FULL) }, min: 0, max: Infinity }), body)
  }
  // (a lookaround runs at every step of the match that reaches it: its cost multiplies the pattern's)
  let lookDegree = 0, lookWork = 0
  for (const look of A.looks) {
    // (its hazards as a pattern searched from every position, where it runs; its cost as one run from the position it is at)
    const r = analyse(look, true, budget)
    if (typeof r === 'string') return r
    const run = analyse(look, false, budget, false)
    if (typeof run === 'string') return run
    lookDegree = Math.max(lookDegree, run.degree)
    lookWork += run.work
  }
  const withLooks = (c: RegexCost): RegexCost =>
    A.looks.length ? { degree: c.degree + lookDegree, work: c.work * Math.max(1, lookWork) } : c
  const m = A.sets.length
  if (m === 0) return withLooks({ degree: 0, work: 1 })
  const step = (k = 1): void => {
    budget.steps -= k
    if (budget.steps < 0) throw new TooComplex('analysis budget')
  }
  const follow = A.follow.map((f) => [...f])
  const next = follow.map((f) => f.map(([q]) => q))
  const pred: number[][] = Array.from({ length: m }, () => [])
  for (let p = 0; p < m; p++) for (const [q] of follow[p]!) pred[q]!.push(p)
  const compat = new Uint8Array(m * m)
  const ok = (p: number, q: number): boolean => {
    const k = p * m + q
    let v = compat[k]!
    if (v === 0) {
      v = p === q || overlaps(A.sets[p]!, A.sets[q]!) ? 2 : 1
      compat[k] = v
      compat[q * m + p] = v
    }
    return v === 2
  }

  // the loops of the automaton
  const comp = components(m, (p) => next[p]!)
  const compSize = new Map<number, number>()
  for (let p = 0; p < m; p++) compSize.set(comp[p]!, (compSize.get(comp[p]!) ?? 0) + 1)
  const looping = (p: number): boolean => compSize.get(comp[p]!)! > 1 || next[p]!.includes(p)

  // 1. exponential: a component of the squared automaton that holds a diagonal pair and a step where the two paths differ
  {
    const ids = new Map<number, number>(), nodes: number[] = [], adj: number[][] = []
    const id = (k: number): number => {
      let v = ids.get(k)
      if (v === undefined) { ids.set(k, (v = nodes.length)); nodes.push(k) }
      return v
    }
    for (let p = 0; p < m; p++) if (looping(p)) id(p * m + p)
    // (a path back to the diagonal stays within the loop it started in, on both sides)
    for (let v = 0; v < nodes.length; v++) {
      const k = nodes[v]!, p = Math.floor(k / m), q = k % m
      const out: number[] = []
      for (const p2 of next[p]!) {
        if (comp[p2] !== comp[p]) continue
        for (const q2 of next[q]!) {
          step()
          if (comp[q2] === comp[q] && ok(p2, q2)) out.push(id(p2 * m + q2))
        }
      }
      adj[v] = out
    }
    const sc = components(nodes.length, (v) => adj[v]!)
    const withDiagonal = new Set<number>()
    nodes.forEach((k, v) => { if (Math.floor(k / m) === k % m) withDiagonal.add(sc[v]!) })
    for (let v = 0; v < nodes.length; v++) {
      if (!withDiagonal.has(sc[v]!)) continue
      const k = nodes[v]!, p = Math.floor(k / m), q = k % m
      for (const [p2, ways] of follow[p]!) {
        for (const [q2] of follow[q]!) {
          const w = ids.get(p2 * m + q2)
          if (w === undefined || sc[w] !== sc[v] || !ok(p2, q2)) continue
          if (p === q && p2 === q2 && ways > 1) return 'a repeated group contains another unbounded quantifier (nested quantifiers: exponential backtracking)'
          if (p !== q || p2 !== q2) return 'a repeated group can match the same input in more than one way (exponential backtracking)'
        }
      }
    }
  }

  // 2. polynomial: a chain of loops each handing the same input on to the next (a loop the match can always end from is none)
  const success = body.emptyU ? null : body.lastU
  const live = (p: number): boolean => success !== null && !success.has(p)
  const loops = [...Array(m).keys()].filter((p) => looping(p) && live(p))
  let degree = loops.length ? 1 : 0
  if (loops.length > 1) {
    const reach = (from: number, back: boolean): Set<number> => {
      const seen = new Set<number>([from])
      const queue = [from]
      while (queue.length) {
        const k = queue.pop()!, p = Math.floor(k / m), q = k % m
        for (const p2 of back ? pred[p]! : next[p]!) {
          if (!live(p2)) continue
          for (const q2 of back ? pred[q]! : next[q]!) {
            step()
            if (!live(q2) || !ok(p2, q2)) continue
            const k2 = p2 * m + q2
            if (!seen.has(k2)) { seen.add(k2); queue.push(k2) }
          }
        }
      }
      return seen
    }
    const fwd = new Map(loops.map((p) => [p, reach(p * m + p, false)]))
    const bwd = new Map(loops.map((q) => [q, reach(q * m + q, true)]))
    const edges = new Map<number, Set<number>>()
    for (const p of loops) {
      for (const q of loops) {
        if (comp[p] === comp[q]) continue
        const k = p * m + q
        if (!fwd.get(p)!.has(k) || !bwd.get(q)!.has(k)) continue
        let s = edges.get(comp[p]!)
        if (!s) edges.set(comp[p]!, (s = new Set()))
        s.add(comp[q]!)
      }
    }
    // (Tarjan numbers a component after every component it reaches)
    const longest = new Map<number, number>()
    for (const c of [...new Set(loops.map((p) => comp[p]!))].sort((a, b) => a - b)) {
      let best = 1
      for (const d of edges.get(c) ?? []) best = Math.max(best, 1 + (longest.get(d) ?? 1))
      longest.set(c, best)
      degree = Math.max(degree, best)
    }
  }

  // 3. finite ambiguity and the work of one character. The live paths of a match attempt are counted per input, on the whole
  // automaton: a loop absorbs any length of input, so a bounded run after it (`a*a{0,20}x`, `a+a{30}x`) is entered from as many
  // places as it is long. A loop's growth against another loop is the degree's (2. above): where both the loop itself and the
  // paths entering it reach a position of a loop, it holds the larger of the two counts, not their sum, so the counts stay finite.
  // The work of a character is the transitions the matcher tries from the live paths (each path tries every way on).
  {
    const cuts = new Set<number>([0])
    for (const r of A.sets) for (const [lo, hi] of r) { cuts.add(lo); if (hi < MAX) cuts.add(hi + 1) }
    const atoms = [...cuts].sort((a, b) => a - b)
    const has = (p: number, c: number): boolean => {
      const r = A.sets[p]!
      let a = 0, b = r.length
      while (a < b) { const k = (a + b) >> 1; if (r[k]![1] < c) a = k + 1; else b = k }
      return a < r.length && r[a]![0] <= c
    }
    const keyOf = (v: Map<number, number>): string => [...v].sort((a, b) => a[0] - b[0]).map((e) => e.join(':')).join(',')
    const START = -1
    const out = (p: number): ReadonlyArray<readonly [number, number]> => (p === START ? [...body.first] : follow[p]!)
    const tries = (p: number): number => {
      let n = 0
      for (const [, ways] of out(p)) n += ways
      return n
    }
    const startVec = new Map([[START, 1]])
    const seen = new Set<string>([keyOf(startVec)])
    const queue = [startVec]
    let most = 1
    let work = 0
    while (queue.length) {
      const vec = queue.pop()!
      for (const c of atoms) {
        const within = new Map<number, number>(), entering = new Map<number, number>()
        for (const [p, k] of vec) {
          const o = out(p)
          step(o.length + 1)
          for (const [q, ways] of o) {
            if (!has(q, c)) continue
            const into = p !== START && comp[p] === comp[q] ? within : entering
            into.set(q, Math.min(1e9, (into.get(q) ?? 0) + k * ways))
          }
        }
        const nv = new Map<number, number>()
        for (const [q, k] of entering) nv.set(q, k)
        for (const [q, k] of within) nv.set(q, Math.max(k, nv.get(q) ?? 0))
        if (!nv.size) continue
        let total = 0, w = 0
        for (const [q, k] of nv) { total += k; w += k * tries(q) }
        if (total > most) most = total
        if (w > work) work = w
        if (most > MAX_AMBIGUITY) return `more than ${MAX_AMBIGUITY} ways to match one input (exponential backtracking)`
        const key = keyOf(nv)
        if (!seen.has(key)) { seen.add(key); queue.push(nv) }
      }
    }
    // (a loop the match can always end from backtracks over nothing, but still reads up to the whole input: a run is linear)
    let reads = degree
    if (reads === 0) for (let p = 0; p < m; p++) if (looping(p)) { reads = 1; break }
    return withLooks({ degree: reads, work: Math.max(1, work) })
  }
}

const CACHE = new TextTable<string | RegexCost | null>('regex verdicts', 256, 1_000_000)


/**
 * The screen's reading of a pattern whatever its input: the reason it is refused (exponential backtracking, an ambiguity too
 * large, a backreference in a repeat, a pattern the screen cannot read or analyse: fail closed), or its {@link RegexCost}. A
 * pattern the RegExp constructor rejects is null (its SyntaxError is what surfaces). Cached by flags and pattern (bounded), since a
 * pattern is usually screened again for every row.
 */
export function regexModel(source: string, flags = ''): string | RegexCost | null {
  const key = `${flags}/${source}`
  const hit = CACHE.get(key)
  if (hit !== undefined) return hit
  try {
    // eslint-disable-next-line no-new
    new RegExp(source, flags)
  } catch {
    return null
  }
  let verdict: string | RegexCost
  try {
    verdict = analyse(readPattern(source, flags), flags.includes('m'), { steps: MAX_STEPS })
  } catch (e) {
    if (e instanceof Unreadable) verdict = 'the screen cannot read this pattern'
    else if (e instanceof TooComplex) verdict = 'the pattern is too complex to screen'
    else throw e
  }
  CACHE.set(key, verdict)
  return verdict
}

/** The time a run of a pattern of cost `c` may take on `n` characters (ms), by {@link REGEX_NS_PER_UNIT}. */
export function regexRunMs(c: RegexCost, n: number): number {
  return (c.work * Math.max(1, n) ** c.degree * REGEX_NS_PER_UNIT) / 1e6
}

/**
 * The reason a pattern is refused for a run on `subject` characters within `budgetMs`, or null: its {@link regexModel} refusal, or a
 * cost over the budget ("polynomial backtracking of degree d: about T ms on n characters"). No running RegExp can be interrupted,
 * so this is the bound a host gets: an accepted pattern's run finishes within the budget (fail closed: what the model cannot bound
 * is refused).
 */
export function regexHazard(source: string, flags = '', subject = REGEX_MAX_INPUT, budgetMs = REGEX_RUN_BUDGET_MS): string | null {
  const m = regexModel(source, flags)
  if (m === null || typeof m === 'string') return m
  const ms = regexRunMs(m, subject)
  if (ms <= budgetMs) return null
  const shape = m.degree >= 2 ? `polynomial backtracking of degree ${m.degree}` : 'a run'
  return `${shape}: about ${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms on ${subject} characters, over the ${budgetMs} ms a run may take`
}
