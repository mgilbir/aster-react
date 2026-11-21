/**
 * Test oracle: the URLs a CSS text names, as a browser's tokenizer reads them (CSS Syntax 3, section 4: consume an
 * ident-like token, a url token, a string token, an escaped code point), written independently of paint-url.ts so the
 * tests do not share its shortcuts. A URL that does not start with `#` is a reference to another document: Chromium
 * resolves it against the page and fetches it (`url(" #a")` and `url(\20#a)` resolve against the base too).
 *
 * The oracle may count more texts as naming a URL than a browser does (a number before `url(` is a dimension to a
 * browser; here `url(` is still read), never fewer.
 */

const isWs = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n'
const isHex = (c: string | undefined): boolean => c !== undefined && /^[0-9a-fA-F]$/.test(c)
const isNameStart = (c: string | undefined): boolean => c !== undefined && (/^[A-Za-z_]$/.test(c) || c.charCodeAt(0) >= 0x80)
const isName = (c: string | undefined): boolean => isNameStart(c) || (c !== undefined && /^[0-9-]$/.test(c))
const isNonPrintable = (c: string): boolean => {
  const n = c.charCodeAt(0)
  return n <= 8 || n === 0xb || (n >= 0xe && n <= 0x1f) || n === 0x7f
}

/** Every URL the text names (the value of each url token, and the string after each `url(` function), decoded. */
export function cssUrls(text: string): string[] {
  // (input preprocessing: CR LF, CR and FF are LF; NUL is U+FFFD)
  const s = Array.from(text.replace(/\r\n?|\f/g, '\n').replace(/\0/g, '�'))
  let i = 0
  const out: string[] = []
  const validEscape = (at: number): boolean => s[at] === '\\' && s[at + 1] !== undefined && s[at + 1] !== '\n'
  const startsIdent = (at: number): boolean =>
    s[at] === '-'
      ? isNameStart(s[at + 1]) || s[at + 1] === '-' || validEscape(at + 1)
      : isNameStart(s[at]) || validEscape(at)
  /** after the backslash */
  const escape = (): string => {
    const c = s[i]
    if (c === undefined) return '�'
    if (isHex(c)) {
      let h = ''
      while (h.length < 6 && isHex(s[i])) h += s[i++]
      if (isWs(s[i])) i++
      const cp = parseInt(h, 16)
      return cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff ? '�' : String.fromCodePoint(cp)
    }
    i++
    return c
  }
  const name = (): string => {
    let v = ''
    for (;;) {
      if (isName(s[i])) v += s[i++]
      else if (validEscape(i)) { i++; v += escape() }
      else return v
    }
  }
  /** the opening quote consumed; null for a bad string */
  const string = (q: string): string | null => {
    let v = ''
    for (;;) {
      const c = s[i]
      if (c === undefined) return v
      if (c === q) { i++; return v }
      if (c === '\n') return null
      i++
      if (c === '\\') {
        if (s[i] === undefined) continue
        if (s[i] === '\n') { i++; continue }
        v += escape()
      } else v += c
    }
  }
  const badUrlRest = (): void => {
    for (;;) {
      if (s[i] === undefined) return
      if (s[i] === ')') { i++; return }
      if (validEscape(i)) { i++; escape() } else i++
    }
  }
  /** after `url(` and the whitespace; null for a bad url */
  const url = (): string | null => {
    let v = ''
    for (;;) {
      const c = s[i]
      if (c === undefined) return v
      if (c === ')') { i++; return v }
      if (isWs(c)) {
        while (isWs(s[i])) i++
        if (s[i] === undefined) return v
        if (s[i] === ')') { i++; return v }
        badUrlRest()
        return null
      }
      if (c === '"' || c === "'" || c === '(' || isNonPrintable(c)) { badUrlRest(); return null }
      if (c === '\\') {
        if (!validEscape(i)) { badUrlRest(); return null }
        i++
        v += escape()
        continue
      }
      v += c
      i++
    }
  }
  while (i < s.length) {
    const c = s[i]!
    if (c === '/' && s[i + 1] === '*') {
      let j = i + 2
      while (j < s.length && !(s[j] === '*' && s[j + 1] === '/')) j++
      i = j >= s.length ? s.length : j + 2
    } else if (c === '"' || c === "'") {
      i++
      string(c)
    } else if (startsIdent(i)) {
      const n = name()
      if (n.toLowerCase() === 'url' && s[i] === '(') {
        i++
        while (isWs(s[i])) i++
        const q = s[i]
        if (q === '"' || q === "'") {
          i++
          const v = string(q)
          if (v !== null) out.push(v)
        } else {
          const v = url()
          if (v !== null) out.push(v)
        }
      }
    } else i++
  }
  return out
}

/** True when the text names a URL that is not within the page (does not start with `#`). */
export function namesAnotherDocument(text: string): boolean {
  return cssUrls(text).some((u) => !u.startsWith('#'))
}
