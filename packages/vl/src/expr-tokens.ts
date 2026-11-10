/**
 * The tokens of a Vega expression, as vega's lexer reads them: what the compiler reads in an expression's text to rename the names it
 * holds (embed.ts), relabel the units of a named view and tell which datasets the spec reads (optimize.ts). A name is read with its
 * escapes (`\uXXXX`: an escaped `width` is `width`) and past ASCII; a string literal is read whole, so a name inside one is never taken
 * for an identifier, and a regular expression literal too.
 *
 * Each token keeps its text (`raw`, so text that is not rewritten is given back as it was written) and, for a name or a string,
 * what it stands for (`value`).
 */

export type TokenKind = 'name' | 'string' | 'number' | 'regexp' | 'blank' | 'punct'
export interface Token { kind: TokenKind; raw: string; value?: string }

/** The blanks vega's lexer skips: the ASCII ones and the Unicode spaces (it follows esprima's `isWhiteSpace`). */
const BLANK = new RegExp(`[\\s${String.fromCharCode(0x180e, 0xfeff)}]`)
const NAME_START = /[\p{ID_Start}$_]/u
const NAME_PART = new RegExp(`[\\p{ID_Continue}$${String.fromCharCode(0x200c, 0x200d)}]`, 'u')
const NUMBER = /(?:0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y
const HEX4 = /^[0-9a-fA-F]{4}$/

/** The character a `\uXXXX` escape of a name stands for at `i` (the backslash), and where it ends; none when there is no such escape. */
function nameEscape(text: string, i: number): { ch: string; end: number } | undefined {
  if (text[i] !== '\\' || text[i + 1] !== 'u') return undefined
  const hex = text.slice(i + 2, i + 6)
  if (!HEX4.test(hex)) return undefined
  return { ch: String.fromCharCode(parseInt(hex, 16)), end: i + 6 }
}

/**
 * The value of a string literal's body (its escapes read as JavaScript reads them; an escape that is not well formed stands for the
 * character after the backslash). One pass: every step moves past at least the character it reads.
 */
function stringValue(body: string): string {
  let out = ''
  let i = 0
  while (i < body.length) {
    const c = body[i]!
    if (c !== '\\') { out += c; i++; continue }
    const e = body[i + 1]
    if (e === undefined) break
    if (e === 'u' && body[i + 2] === '{') {
      const close = body.indexOf('}', i + 3)
      const hex = close > 0 ? body.slice(i + 3, close) : ''
      const code = /^[0-9a-fA-F]{1,6}$/.test(hex) ? parseInt(hex, 16) : NaN
      if (code <= 0x10ffff) { out += String.fromCodePoint(code); i = close + 1; continue }
    } else if (e === 'u' && HEX4.test(body.slice(i + 2, i + 6))) {
      out += String.fromCharCode(parseInt(body.slice(i + 2, i + 6), 16))
      i += 6
      continue
    } else if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(body.slice(i + 2, i + 4))) {
      out += String.fromCharCode(parseInt(body.slice(i + 2, i + 4), 16))
      i += 4
      continue
    } else if (e === '\r' && body[i + 2] === '\n') {
      i += 3
      continue
    } else if (e === '\n' || e === '\r' || e === String.fromCharCode(0x2028) || e === String.fromCharCode(0x2029)) {
      // (a line continuation stands for nothing)
      i += 2
      continue
    }
    out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' } as Record<string, string>)[e] ?? e
    i += 2
  }
  return out
}

/** Whether a `/` after `prev` (the last token that is no blank) starts a regular expression literal rather than dividing. */
function regexpAllowed(prev: Token | undefined): boolean {
  if (prev === undefined) return true
  if (prev.kind === 'name') return prev.value === 'typeof' || prev.value === 'in' || prev.value === 'return'
  if (prev.kind === 'number' || prev.kind === 'string' || prev.kind === 'regexp') return false
  return prev.raw !== ')' && prev.raw !== ']' && prev.raw !== '}'
}

export function tokenize(text: string): Token[] {
  const out: Token[] = []
  let prev: Token | undefined
  let i = 0
  const n = text.length
  const push = (t: Token): void => { out.push(t); if (t.kind !== 'blank') prev = t }
  while (i < n) {
    const c = text[i]!
    if (BLANK.test(c)) {
      let j = i + 1
      while (j < n && BLANK.test(text[j]!)) j++
      push({ kind: 'blank', raw: text.slice(i, j) })
      i = j
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && text[j] !== c) j += text[j] === '\\' ? 2 : 1
      const raw = text.slice(i, Math.min(j + 1, n))
      push({ kind: 'string', raw, value: stringValue(text.slice(i + 1, Math.min(j, n))) })
      i = j + 1
      continue
    }
    const startEscape = nameEscape(text, i)
    if (NAME_START.test(c) || startEscape) {
      let value = ''
      let j = i
      for (;;) {
        const e = nameEscape(text, j)
        if (e) { value += e.ch; j = e.end; continue }
        const cp = text.codePointAt(j)
        if (cp === undefined) break
        const ch = String.fromCodePoint(cp)
        if (!(j === i ? NAME_START.test(ch) : NAME_PART.test(ch))) break
        value += ch
        j += ch.length
      }
      // (a start that makes no name -- it cannot happen, the test above being the loop's first -- is one character of its own)
      if (j === i) { push({ kind: 'punct', raw: c }); i++; continue }
      push({ kind: 'name', raw: text.slice(i, j), value })
      i = j
      continue
    }
    NUMBER.lastIndex = i
    const num = /[0-9.]/.test(c) ? NUMBER.exec(text) : null
    if (num && num[0] !== '.') {
      push({ kind: 'number', raw: num[0] })
      i += num[0].length
      continue
    }
    if (c === '/' && text[i + 1] !== '/' && text[i + 1] !== '*' && regexpAllowed(prev)) {
      let j = i + 1
      let inClass = false
      while (j < n && (inClass || text[j] !== '/')) {
        if (text[j] === '\\') j++
        else if (text[j] === '[') inClass = true
        else if (text[j] === ']') inClass = false
        j++
      }
      j++
      while (j < n && /[a-z]/i.test(text[j]!)) j++
      push({ kind: 'regexp', raw: text.slice(i, j) })
      i = j
      continue
    }
    // (a non-BMP character outside a name or a string: one token)
    const cp = text.codePointAt(i)!
    const ch = String.fromCodePoint(cp)
    push({ kind: 'punct', raw: ch })
    i += ch.length
  }
  return out
}

/** The index of the next token after `i` that is no blank. */
export function nextSolid(tokens: readonly Token[], i: number): number {
  let j = i + 1
  while (j < tokens.length && tokens[j]!.kind === 'blank') j++
  return j
}

/** The index of the last token before `i` that is no blank (-1: none). */
export function prevSolid(tokens: readonly Token[], i: number): number {
  let j = i - 1
  while (j >= 0 && tokens[j]!.kind === 'blank') j--
  return j
}
