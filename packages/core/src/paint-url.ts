/**
 * A paint text (`fill`, `stroke`, the background) as the SVG renderers write it: never a reference to another document.
 *
 * SVG paint is `none | <color> | url(<ref>) [none | <color>]?`. A `url()` naming another document makes some browsers
 * (Chromium) fetch it, a request the URL policy and `urlData: 'refuse'` never see, and paint can come from the data.
 * A reference within the page (`url(#pattern)`, a pattern or gradient the page defines) loads nothing and is kept.
 *
 * What is written instead is what a browser that does not load other documents draws (Firefox and WebKit, for vega's
 * output): a paint that starts with such a `url()` draws its fallback colour, else nothing (`none`); a text with a
 * `url()` anywhere else is not a paint at all, so the attribute is dropped, as the browser drops an invalid value.
 *
 * CSS escapes are decoded before the check (`\75 rl(` is `url(`, `url(\23 a)` is `url(#a)`), so an escaped name cannot
 * hide one; a text with no escape and no `l(` / `L(` cannot name a `url()` and is returned at once (`canNameNoUrl`).
 * An escaped quote or whitespace is a character of the URL, not syntax (`url(\"#a\")` names `"#a"`, a relative URL to
 * another document, and `url(\20#a)` names ` #a`, which resolves against the page's base), so it decodes to a character
 * that is neither: the reference then does not start with `#` and counts as another document.
 */

/** The characters that are syntax around a URL (a quote, whitespace): escaped, each is a character of the URL instead. */
const URL_SYNTAX = /["' \t\n\r\f]/

/**
 * CSS escapes decoded (CSS Syntax 4.3.7): `\` + 1-6 hex digits + one optional whitespace, or `\` + any other character.
 * An escaped quote or whitespace decodes to U+FFFD, so the check below cannot read it as the quote or the whitespace
 * around a URL (see the file comment).
 */
function unescapeCss(s: string): string {
  return s.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S]))/g, (_, hex: string | undefined, ch: string | undefined) => {
    // (CSS reads 0, a surrogate and anything past U+10FFFF as U+FFFD; only the letters of `url(`, a `#`, the quotes and
    // whitespace matter here, and fromCodePoint throws only past U+10FFFF)
    const c = hex === undefined ? ch! : parseInt(hex, 16) > 0x10ffff ? '\ufffd' : String.fromCodePoint(parseInt(hex, 16))
    return URL_SYNTAX.test(c) ? '\ufffd' : c
  })
}

/**
 * A `url(` (ASCII case-insensitive, as CSS matches function names) whose reference is not within the page: its text,
 * after optional whitespace and an optional quote, does not start with `#`.
 */
const OTHER_DOCUMENT = /url\((?![ \t\n\r\f]*["']?#)/i
/** A paint that starts with a `url()` written without escapes, and the text after it (its fallback). */
const LEADING_URL = /^[ \t\n\r\f]*url\([ \t\n\r\f]*(?:"[^"\\]*"|'[^'\\]*'|[^"'()\\ \t\n\r\f]*)[ \t\n\r\f]*\)([\s\S]*)$/i

/**
 * True when a text cannot name a `url()` (the check every paint text takes first): without an escape, `url(` is written
 * as it is, so it ends in `l(` or `L(`. `#336699`, `steelblue` and `rgb(...)` pass; `hsl(...)` takes the full check.
 */
export function canNameNoUrl(text: string): boolean {
  return text.indexOf('\\') < 0 && text.indexOf('l(') < 0 && text.indexOf('L(') < 0
}

/**
 * True when a text names another document in a CSS `url()` (escapes decoded first): what no attribute but a paint may hold,
 * and a paint only as {@link paintText} rewrites it.
 */
export function namesOtherDocument(text: string): boolean {
  if (canNameNoUrl(text)) return false
  return OTHER_DOCUMENT.test(text.indexOf('\\') < 0 ? text : unescapeCss(text))
}

/**
 * The text to write for a paint text: the text itself when it names no other document; otherwise the fallback colour
 * after a leading `url()`, `'none'` when there is none (or it cannot be told safely), or null for no attribute.
 */
export function paintText(text: string): string | null {
  if (canNameNoUrl(text)) return text
  const plain = text.indexOf('\\') < 0 ? text : unescapeCss(text)
  if (!OTHER_DOCUMENT.test(plain)) return text
  if (!/^[ \t\n\r\f]*url\(/i.test(plain)) return null
  // a leading url(): its fallback, when it is written plainly (no escapes) and names no document itself
  const m = LEADING_URL.exec(text)
  const fallback = m === null ? '' : m[1]!.trim()
  // (a fallback is a colour: it is kept only when it, too, is written as it is)
  return fallback !== '' && paintText(fallback) === fallback ? fallback : 'none'
}
