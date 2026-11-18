import { describe, it, expect } from 'vitest'
import { paintText } from './paint-url.js'

describe('paintText', () => {
  it('a colour, none, or a reference within the page is written as it is', () => {
    for (const v of [
      '#336699', 'steelblue', 'none', 'transparent', 'currentColor', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'hsl(120 50% 50%)',
      'url(#hatch)', 'url("#hatch")', "url('#hatch')", 'url(  #hatch )', 'URL(#a) red', 'url(#a) rgb(1,2,3)',
      // an escaped colour name is still a colour
      'r\\65 d', '\\72 ed',
      // an escaped `#` is still a reference within the page
      'url(\\#a)',
      '', 'url', 'curl', 'urls(x)',
    ]) {
      expect(paintText(v), JSON.stringify(v)).toBe(v)
    }
  })

  it('a leading url() naming another document draws its fallback, or nothing', () => {
    expect(paintText('url(http://example.invalid/a.svg#g)')).toBe('none')
    expect(paintText('url(//example.invalid/a.svg#g)')).toBe('none')
    expect(paintText('url(a.svg#g)')).toBe('none')
    expect(paintText('url(data:image/svg+xml,%3Csvg/%3E)')).toBe('none')
    expect(paintText('URL( "http://example.invalid/a" )')).toBe('none')
    expect(paintText('url(http://example.invalid/a) red')).toBe('red')
    expect(paintText(" url('http://example.invalid/a')   rgb(1, 2, 3) ")).toBe('rgb(1, 2, 3)')
    expect(paintText('url(http://example.invalid/a) none')).toBe('none')
  })

  it('a fallback that names another document itself, or that cannot be read plainly, draws nothing', () => {
    expect(paintText('url(http://example.invalid/a) url(http://example.invalid/b)')).toBe('none')
    expect(paintText('url(#a) url(http://example.invalid/b)')).toBe('none')
    expect(paintText('url(http://example.invalid/a) \\75 rl(http://example.invalid/b)')).toBe('none')
    // a leading url() written with escapes: its fallback is not trusted
    expect(paintText('\\75 rl(http://example.invalid/a) red')).toBe('none')
  })

  it('CSS escapes cannot hide a url()', () => {
    for (const v of [
      '\\75 rl(http://example.invalid/a)', '\\75rl(http://example.invalid/a)', '\\000075rl(http://example.invalid/a)',
      'u\\72l(http://example.invalid/a)', 'ur\\6c (http://example.invalid/a)', '\\55 RL(http://example.invalid/a)',
      '\\u\\r\\l(http://example.invalid/a)', 'url\\28 http://example.invalid/a)',
    ]) {
      expect(paintText(v), JSON.stringify(v)).toBe('none')
    }
  })

  it('a url() naming another document anywhere else makes no paint: no attribute', () => {
    expect(paintText('red url(http://example.invalid/a)')).toBeNull()
    expect(paintText('rgb(url(http://example.invalid/a))')).toBeNull()
    expect(paintText('red \\75 rl(http://example.invalid/a)')).toBeNull()
  })

  it('never returns text that names another document', () => {
    const OTHER = /url\((?![ \t\n\r\f]*["']?#)/i
    const unescape = (s: string): string => s.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S]))/g, (_, h, c) => (h ? String.fromCodePoint(parseInt(h, 16) || 0xfffd) : c))
    const parts = ['url(', 'URL(', '\\75 rl(', 'http://e.invalid/a', '#a', ')', ' ', 'red', '"', "'", '\\', 'rgb(1,2,3)', ',']
    // every text of up to 4 parts
    const texts: string[] = ['']
    for (let n = 0; n < 4; n++) for (const t of texts.splice(0)) for (const p of parts) texts.push(t + p)
    expect(texts.length).toBe(parts.length ** 4)
    for (const t of texts) {
      const out = paintText(t)
      if (out !== null) expect(OTHER.test(unescape(out)), `${JSON.stringify(t)} -> ${JSON.stringify(out)}`).toBe(false)
    }
  })
})
