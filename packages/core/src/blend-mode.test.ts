import { describe, it, expect } from 'vitest'
import { blendMode } from './blend-mode.js'

const KEYWORDS = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light',
  'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'plus-darker', 'plus-lighter',
]

describe('blendMode', () => {
  it('takes every mix-blend-mode keyword as it is spelled', () => {
    for (const k of KEYWORDS) expect(blendMode(k), k).toBe(k)
  })

  it('absent is none', () => {
    expect(blendMode(null)).toBeNull()
    expect(blendMode(undefined)).toBeNull()
  })

  it('matches as CSS does: surrounding CSS whitespace ignored, ASCII case ignored, canonical keyword out', () => {
    expect(blendMode('MULTIPLY')).toBe('multiply')
    expect(blendMode('Color-Dodge')).toBe('color-dodge')
    expect(blendMode(' \t\n\r\fscreen \t\n\r\f')).toBe('screen')
    // a value vega coerces with `value + ''`
    expect(blendMode(['overlay'])).toBe('overlay')
  })

  it('does not take what CSS does not: Unicode case folding, other whitespace, inner space, comments, escapes', () => {
    expect(blendMode('darKen')).toBeNull() // KELVIN SIGN lower-cases to `k` in JS, not in CSS
    expect(blendMode('LİGHTEN')).toBeNull() // dotted capital I
    expect(blendMode(' multiply')).toBeNull() // no-break space is not CSS whitespace
    expect(blendMode('\u000bmultiply')).toBeNull() // nor is a vertical tab
    expect(blendMode('color dodge')).toBeNull()
    expect(blendMode('/**/multiply')).toBeNull()
    expect(blendMode('mul\\74iply')).toBeNull()
  })

  it('refuses anything that is not a keyword, including values that would add CSS declarations', () => {
    for (const v of [
      '', ' ', 'none', 'inherit', 'initial', 'unset', 'revert', 'source-over', 'xor', 'lighter', 'copy',
      'multiply;', 'multiply; fill: red', 'multiply;background:url(https://example.invalid/x)',
      'multiply;background:\\75 rl(https://example.invalid/x)', 'normal } * { color: red', 'multiply !important',
      'multiply\u0000', 0, 1, true, {}, ['multiply', 'screen'],
    ]) {
      expect(blendMode(v), JSON.stringify(v)).toBeNull()
    }
  })

  it('returns only one of the keywords, never input text', () => {
    const inputs = ['MULTIPLY', ' screen ', 'Hue', 'x', 'multiply; x: y', ...KEYWORDS]
    for (const v of inputs) {
      const out = blendMode(v)
      if (out !== null) expect(KEYWORDS).toContain(out)
    }
  })
})
