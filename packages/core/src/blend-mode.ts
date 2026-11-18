/**
 * An item's `blend` as the SVG renderers write it: the CSS `mix-blend-mode` keyword it names, or nothing.
 *
 * The SVG output carries `blend` inside a `style` attribute, a CSS declaration list, where a value such as
 * `multiply; fill: url(...)` would add declarations of its own. `blend` can come from an expression over the
 * data, so it is untrusted text: only a keyword the property takes is ever written.
 *
 * Which values count is what the browser takes from vega's SVG renderer (`el.style.setProperty('mix-blend-mode',
 * value)`): a keyword of the property, matched the way CSS matches keywords (surrounding CSS whitespace ignored,
 * ASCII letters in either case). Anything else draws as if no blend were set, which is what the browser does with a
 * value it rejects. The keyword written is the canonical lower-case one, never the input.
 *
 * The canvas renderer does not use this: it hands the value to `globalCompositeOperation`, which takes its own
 * set of names and ignores anything else, as vega's canvas renderer does.
 */

/** The `mix-blend-mode` values (CSS Compositing and Blending: `<blend-mode> | plus-darker | plus-lighter`). */
export const BLEND_MODES: ReadonlySet<string> = new Set([
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light',
  'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'plus-darker', 'plus-lighter',
])

/** CSS whitespace (space, tab, line feed, carriage return, form feed) at either end. */
const CSS_SPACE_ENDS = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g
const ASCII_UPPER = /[A-Z]/g
const lower = (c: string): string => String.fromCharCode(c.charCodeAt(0) + 32)

/** The keyword a text names, matched as CSS matches it (vega writes `value + ''`; the browser parses that). */
function keywordOf(text: string): string | null {
  if (BLEND_MODES.has(text)) return text
  // CSS trims CSS whitespace and matches keywords ASCII-case-insensitively (not by Unicode lower-casing: the Kelvin
  // sign U+212A lower-cases to `k` in JS, which CSS does not take for `k`)
  const s = text.replace(CSS_SPACE_ENDS, '').replace(ASCII_UPPER, lower)
  return BLEND_MODES.has(s) ? s : null
}

// The items of a mark mostly share one blend: the last text and its keyword are kept, so a mark of many items
// matches it once (and a value that is not a keyword is not re-normalized per item).
let lastText: string | undefined
let lastKeyword: string | null = null

/** The `mix-blend-mode` keyword `blend` names, or null when it names none (absent, or not a keyword). */
export function blendMode(blend: unknown): string | null {
  if (blend == null) return null
  if (typeof blend !== 'string') return keywordOf(String(blend))
  if (blend !== lastText) {
    lastKeyword = keywordOf(blend)
    lastText = blend
  }
  return lastKeyword
}
