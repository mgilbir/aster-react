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
 * CSS escapes are decoded before the check (`\75 rl(` is `url(`), so an escaped name cannot hide one; a text with
 * no escape and no `l(` / `L(` cannot name a `url()` and is returned at once (`canNameNoUrl`).
 */

/** CSS escapes decoded (CSS Syntax 4.3.7): `\` + 1-6 hex digits + one optional whitespace, or `\` + any other character. */
function unescapeCss(s: string): string {
  return s.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S]))/g, (_, hex: string | undefined, ch: string | undefined) => {
    if (hex === undefined) return ch!
    // (CSS reads 0, a surrogate and anything past U+10FFFF as U+FFFD; only the letters of `url(` matter here, and
    // fromCodePoint throws only past U+10FFFF)
    const cp = parseInt(hex, 16)
    return cp > 0x10ffff ? '�' : String.fromCodePoint(cp)
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
