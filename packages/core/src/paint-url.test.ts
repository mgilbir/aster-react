import { describe, it, expect } from 'vitest'
import { paintText } from './paint-url.js'
import { cssUrls, namesAnotherDocument } from './css-url.testlib.js'

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

  it('an escaped quote or whitespace is a character of the URL, not the quote or the space around it (#178)', () => {
    // `url(\"#a\")` names `"#a"`: Chromium resolves it against the page and fetches `<page dir>/%22`
    for (const v of [
      'url(\\"#a\\")', "url(\\'#a\\')", 'url(\\22#a\\22)', 'url(\\27 #a)', 'url(\\"x.svg#a\\")',
      // inside a quoted URL, an escaped quote is a character too: `"#a`
      'url("\\"#a")', "url('\\'#a')",
      // an escaped space or tab starts the URL, so it is resolved against the page's base, not read as `#a`
      'url(\\20#a)', 'url(\\20 #a)', 'url(\\9#a)', 'url(\\ #a)', 'url("\\20#a")', 'url(\\a#a)',
    ]) {
      expect(namesAnotherDocument(v), JSON.stringify(v)).toBe(true)
      expect(paintText(v), JSON.stringify(v)).toBe('none')
    }
    // the fallback is not trusted after a url() written with escapes
    expect(paintText('url(\\"#a\\") red')).toBe('none')
    expect(paintText('red url(\\"#a\\")')).toBeNull()
  })

  it('an escaped `#` or other URL character inside url() is still a reference within the page', () => {
    for (const v of ['url(\\#a)', 'url(\\23 a)', 'url(\\000023a)', 'url("\\23 a")', 'url(#a\\"x)', 'url("#a\\"")', 'url(#\\61)']) {
      expect(namesAnotherDocument(v), JSON.stringify(v)).toBe(false)
      expect(paintText(v), JSON.stringify(v)).toBe(v)
    }
  })

  it('a url() naming another document anywhere else makes no paint: no attribute', () => {
    expect(paintText('red url(http://example.invalid/a)')).toBeNull()
    expect(paintText('rgb(url(http://example.invalid/a))')).toBeNull()
    expect(paintText('red \\75 rl(http://example.invalid/a)')).toBeNull()
  })

  it('never returns text that names another document, as a browser tokenizes it (css-url.testlib.ts)', () => {
    const parts = [
      'url(', 'URL(', '\\75 rl(', 'http://e.invalid/a', '#a', ')', ' ', 'red', '"', "'", '\\', 'rgb(1,2,3)', ',',
      '\\"', "\\'", '\\20 ', '\\23 ', 'x.svg', '#',
    ]
    // every text of up to 4 parts
    const texts: string[] = ['']
    for (let n = 0; n < 4; n++) for (const t of texts.splice(0)) for (const p of parts) texts.push(t + p)
    expect(texts.length).toBe(parts.length ** 4)
    let kept = 0
    for (const t of texts) {
      const out = paintText(t)
      if (out === null) continue
      if (out === t && cssUrls(t).length > 0) kept++
      if (namesAnotherDocument(out)) expect.fail(`${JSON.stringify(t)} -> ${JSON.stringify(out)}`)
    }
    // (and the check is not vacuous: texts that name a url() within the page are kept as they are)
    expect(kept).toBeGreaterThan(1000)
  })
})
