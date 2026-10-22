/**
 * Static screen for regular expressions that are prone to catastrophic
 * backtracking. Applied ONLY under limits (see limits.ts), to every pattern a
 * spec or its data can supply, BEFORE the pattern is compiled or run: a
 * cooperative clock cannot interrupt a regex that has started, so the only
 * defence available in-process is to refuse the dangerous shapes up front.
 *
 * It parses the pattern into a small AST (no regex over the regex) and rejects:
 *   1. a group under an UNBOUNDED quantifier whose body contains another
 *      unbounded quantifier (star height > 1): `(a+)+`, `(\w+\s?)*`, `(.*a){2,}`;
 *   2. an UNBOUNDED-quantified alternation whose branches can start with the
 *      same character: `(a|a)*`, `(a|aa)+`, `(\w|\d)+`;
 *   3. a backreference inside a group quantified more than once.
 *
 * It is a HEURISTIC. It blocks the known exponential shapes; it does not prove
 * a pattern safe (polynomial blow-ups such as `a*a*a*b` pass, and some safe
 * patterns such as `(\d+\.)*\d+` are refused). A hard guarantee still needs a
 * killable worker (docs/LIMITS.md). Syntax this parser does not understand is
 * allowed through: the RegExp constructor validates syntax, and refusing what we
 * cannot read would reject valid patterns wholesale.
 */

type Ranges = Array<[number, number]>
interface Quant { min: number; max: number }
type Node =
  | { t: 'set'; r: Ranges }
  | { t: 'assert' }
  | { t: 'backref' }
  | { t: 'group'; alts: Term[][]; look: boolean }
interface Term { n: Node; q?: Quant }

const MAX = 0x10ffff
const FULL: Ranges = [[0, MAX]]
const DIGIT: Ranges = [[48, 57]]
const WORD: Ranges = [[48, 57], [65, 90], [95, 95], [97, 122]]
const SPACE: Ranges = [[9, 13], [32, 32], [160, 160], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff]]

function normalize(r: Ranges): Ranges {
  const s = r.slice().sort((a, b) => a[0] - b[0])
  const out: Ranges = []
  for (const [lo, hi] of s) {
    const last = out[out.length - 1]
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi)
    else out.push([lo, hi])
  }
  return out
}
function complement(r: Ranges): Ranges {
  const out: Ranges = []
  let at = 0
  for (const [lo, hi] of normalize(r)) {
    if (lo > at) out.push([at, lo - 1])
    at = hi + 1
  }
  if (at <= MAX) out.push([at, MAX])
  return out
}
function intersects(a: Ranges, b: Ranges): boolean {
  for (const [alo, ahi] of a) for (const [blo, bhi] of b) if (alo <= bhi && blo <= ahi) return true
  return false
}
/** Add the other-case counterparts of ASCII letters (flag `i`). */
function fold(r: Ranges): Ranges {
  const extra: Ranges = []
  for (const [lo, hi] of r) {
    const ulo = Math.max(lo, 65), uhi = Math.min(hi, 90)
    if (ulo <= uhi) extra.push([ulo + 32, uhi + 32])
    const llo = Math.max(lo, 97), lhi = Math.min(hi, 122)
    if (llo <= lhi) extra.push([llo - 32, lhi - 32])
  }
  return extra.length ? normalize([...r, ...extra]) : r
}

class Parser {
  i = 0
  constructor(private readonly s: string, private readonly icase: boolean) {}

  private set(r: Ranges): Node { return { t: 'set', r: this.icase ? fold(r) : r } }

  parse(): Term[][] {
    const alts = this.disjunction()
    if (this.i < this.s.length) throw new Error('unbalanced')
    return alts
  }

  private disjunction(): Term[][] {
    const alts: Term[][] = [this.sequence()]
    while (this.s[this.i] === '|') { this.i++; alts.push(this.sequence()) }
    return alts
  }

  private sequence(): Term[] {
    const seq: Term[] = []
    while (this.i < this.s.length && this.s[this.i] !== '|' && this.s[this.i] !== ')') {
      const n = this.atom()
      seq.push({ n, q: this.quantifier() })
    }
    return seq
  }

  private quantifier(): Quant | undefined {
    const c = this.s[this.i]
    let q: Quant | undefined
    if (c === '*') { q = { min: 0, max: Infinity }; this.i++ }
    else if (c === '+') { q = { min: 1, max: Infinity }; this.i++ }
    else if (c === '?') { q = { min: 0, max: 1 }; this.i++ }
    else if (c === '{') {
      const m = this.braces()
      if (m) q = m
    }
    if (q && this.s[this.i] === '?') this.i++ // lazy
    return q
  }

  /** `{n}`, `{n,}`, `{n,m}` only; anything else is a literal brace. */
  private braces(): Quant | undefined {
    let j = this.i + 1
    const num = (): number | undefined => {
      const st = j
      while (j < this.s.length && this.s.charCodeAt(j) >= 48 && this.s.charCodeAt(j) <= 57) j++
      return j > st ? Number(this.s.slice(st, j)) : undefined
    }
    const min = num()
    if (min === undefined) return undefined
    let max = min
    if (this.s[j] === ',') { j++; const m = num(); max = m === undefined ? Infinity : m }
    if (this.s[j] !== '}') return undefined
    this.i = j + 1
    return { min, max }
  }

  private atom(): Node {
    const c = this.s[this.i]!
    switch (c) {
      case '(': return this.group()
      case '[': return this.klass()
      case '\\': return this.escape(false)
      case '.': this.i++; return this.set(FULL)
      case '^': case '$': this.i++; return { t: 'assert' }
      default: this.i++; return this.set([[c.charCodeAt(0), c.charCodeAt(0)]])
    }
  }

  private group(): Node {
    this.i++ // (
    let look = false
    if (this.s[this.i] === '?') {
      const rest = this.s.slice(this.i, this.i + 4)
      if (rest.startsWith('?:')) this.i += 2
      else if (rest.startsWith('?=') || rest.startsWith('?!')) { this.i += 2; look = true }
      else if (rest.startsWith('?<=') || rest.startsWith('?<!')) { this.i += 3; look = true }
      else if (rest.startsWith('?<')) {
        const end = this.s.indexOf('>', this.i)
        if (end < 0) throw new Error('bad group name')
        this.i = end + 1
      } else throw new Error('unknown group')
    }
    const alts = this.disjunction()
    if (this.s[this.i] !== ')') throw new Error('unbalanced')
    this.i++
    return { t: 'group', alts, look }
  }

  private escapeClass(c: string): Ranges | undefined {
    switch (c) {
      case 'd': return DIGIT
      case 'D': return complement(DIGIT)
      case 'w': return WORD
      case 'W': return complement(WORD)
      case 's': return SPACE
      case 'S': return complement(SPACE)
      default: return undefined
    }
  }

  /** After a backslash. Returns the node (or, inside a class, a set). */
  private escape(inClass: boolean): Node {
    this.i++ // backslash
    const c = this.s[this.i]
    if (c === undefined) throw new Error('trailing backslash')
    this.i++
    const cls = this.escapeClass(c)
    if (cls) return this.set(cls)
    if (!inClass) {
      if (c === 'b' || c === 'B') return { t: 'assert' }
      if (c >= '1' && c <= '9') { while (/[0-9]/.test(this.s[this.i] ?? '')) this.i++; return { t: 'backref' } }
      if (c === 'k' && this.s[this.i] === '<') {
        const end = this.s.indexOf('>', this.i)
        if (end < 0) throw new Error('bad \\k')
        this.i = end + 1
        return { t: 'backref' }
      }
    }
    if (c === 'p' || c === 'P') { // property escape: unknown set, assume it can overlap anything
      if (this.s[this.i] === '{') { const end = this.s.indexOf('}', this.i); if (end > 0) this.i = end + 1 }
      return this.set(FULL)
    }
    if (c === 'x') { const v = parseInt(this.s.slice(this.i, this.i + 2), 16); this.i += 2; return this.one(v) }
    if (c === 'u') {
      if (this.s[this.i] === '{') { const end = this.s.indexOf('}', this.i); const v = parseInt(this.s.slice(this.i + 1, end), 16); this.i = end + 1; return this.one(v) }
      const v = parseInt(this.s.slice(this.i, this.i + 4), 16); this.i += 4; return this.one(v)
    }
    if (c === 'c') { const v = (this.s.charCodeAt(this.i) || 0) % 32; this.i++; return this.one(v) }
    const map: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13, '0': 0 }
    if (c in map) return this.one(map[c]!)
    if (inClass && c === 'b') return this.one(8)
    return this.one(c.charCodeAt(0))
  }

  private one(v: number): Node { return this.set([[Number.isNaN(v) ? 0 : v, Number.isNaN(v) ? 0 : v]]) }

  private klass(): Node {
    this.i++ // [
    let negate = false
    if (this.s[this.i] === '^') { negate = true; this.i++ }
    const out: Ranges = []
    const item = (): Ranges => {
      if (this.s[this.i] === '\\') {
        const n = this.escape(true)
        return n.t === 'set' ? n.r : []
      }
      const v = this.s.charCodeAt(this.i++)
      return [[v, v]]
    }
    let closed = false
    while (this.i < this.s.length) {
      if (this.s[this.i] === ']') { this.i++; closed = true; break }
      const a = item()
      if (this.s[this.i] === '-' && this.s[this.i + 1] !== ']' && this.i + 1 < this.s.length && a.length === 1 && a[0]![0] === a[0]![1]) {
        const save = this.i
        this.i++
        const b = item()
        if (b.length === 1 && b[0]![0] === b[0]![1]) { out.push([a[0]![0], Math.max(a[0]![0], b[0]![0])]); continue }
        this.i = save // `a-\d`: treat '-' literally
      }
      for (const x of a) out.push(x)
    }
    if (!closed) throw new Error('unterminated class')
    const r = normalize(out)
    const base = this.icase ? fold(r) : r
    return { t: 'set', r: negate ? complement(base) : base }
  }
}

// --- analysis -----------------------------------------------------------------

function nullableSeq(seq: Term[]): boolean { return seq.every(nullableTerm) }
function nullableTerm(t: Term): boolean {
  if (t.q && t.q.min === 0) return true
  const n = t.n
  if (n.t === 'assert') return true
  if (n.t === 'group') return n.alts.some(nullableSeq)
  return false
}
function firstOfSeq(seq: Term[]): Ranges {
  let out: Ranges = []
  for (const t of seq) {
    out = out.concat(firstOfTerm(t))
    if (!nullableTerm(t)) break
  }
  return out
}
function firstOfTerm(t: Term): Ranges {
  const n = t.n
  if (n.t === 'set') return n.r
  if (n.t === 'backref') return FULL
  if (n.t === 'group') return n.alts.reduce<Ranges>((acc, s) => acc.concat(firstOfSeq(s)), [])
  return []
}
function hasUnbounded(alts: Term[][]): boolean {
  for (const seq of alts) for (const t of seq) {
    if (t.q && t.q.max === Infinity) return true
    if (t.n.t === 'group' && hasUnbounded(t.n.alts)) return true
  }
  return false
}
function hasBackref(alts: Term[][]): boolean {
  for (const seq of alts) for (const t of seq) {
    if (t.n.t === 'backref') return true
    if (t.n.t === 'group' && hasBackref(t.n.alts)) return true
  }
  return false
}

function check(alts: Term[][]): string | null {
  for (const seq of alts) for (const t of seq) {
    const n = t.n
    if (n.t !== 'group') continue
    const unbounded = !!t.q && t.q.max === Infinity
    const repeated = !!t.q && t.q.max > 1
    if (unbounded && hasUnbounded(n.alts)) return 'a repeated group contains another unbounded quantifier (nested quantifiers)'
    if (unbounded && n.alts.length > 1) {
      const firsts = n.alts.map(firstOfSeq)
      for (let a = 0; a < firsts.length; a++) for (let b = a + 1; b < firsts.length; b++) {
        if (intersects(firsts[a]!, firsts[b]!)) return 'a repeated alternation has branches that can match the same prefix'
      }
    }
    if (repeated && hasBackref(n.alts)) return 'a backreference inside a repeated group'
    const inner = check(n.alts)
    if (inner) return inner
  }
  return null
}

const CACHE = new Map<string, string | null>()
const CACHE_MAX = 256

/**
 * Returns the reason a pattern is prone to catastrophic backtracking, or null.
 * Results are cached (bounded), since a pattern is usually re-screened per row.
 */
export function regexHazard(source: string, flags = ''): string | null {
  const key = `${flags}/${source}`
  const hit = CACHE.get(key)
  if (hit !== undefined) return hit
  let reason: string | null
  try {
    reason = check(new Parser(source, flags.includes('i')).parse())
  } catch {
    reason = null // unreadable here: leave syntax errors to the RegExp constructor
  }
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value as string)
  CACHE.set(key, reason)
  return reason
}
