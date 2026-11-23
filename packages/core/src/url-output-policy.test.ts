/**
 * The URL vetting of the output, as properties over generated texts (C3, C391; the attribute sinks and the scenes are
 * output-urls.test.ts's): what `outputUrl` / `sanitizeHref` keep is a URL the WHATWG parser reads as allowed, in a web page and in
 * a `file:` page alike; a refused URL is reported without its credentials. The oracle is the WHATWG parser (Node's), not
 * url-policy.ts. (No DOM: the parser is the platform's, not jsdom's.)
 */
import { describe, expect, it } from 'vitest'
import { outputUrl, redactUrl, sanitizeHref, AsterUrlError, type ImageUrlPolicy } from './url-policy.js'
import { renderSpec } from './index.js'
import type { VgSpec } from './types.js'

const LINK_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:']
const IMAGE_PROTOCOLS = ['http:', 'https:', 'data:']

/** As output-urls.test.ts's: allowed in a web page and in a `file:` page, or a reference within the page's own origin. */
function urlOk(text: string, kind: 'link' | 'image'): boolean {
  if (text === '') return true
  const allowed = kind === 'link' ? LINK_PROTOCOLS : IMAGE_PROTOCOLS
  for (const base of ['https://page.test/dir/', 'file:///dir/page.html']) {
    let u: URL
    try { u = new URL(text, base) } catch { continue }
    const pageOrigin = new URL(base)
    const sameDoc = u.protocol === pageOrigin.protocol && u.host === pageOrigin.host && !/^[\s\u0000-\u001f]*[a-z][a-z0-9+.-]*:/i.test(text)
    if (sameDoc) continue
    if (!allowed.includes(u.protocol) || u.username !== '' || u.password !== '') return false
  }
  return true
}

// --- outputUrl and sanitizeHref as properties --------------------------------------------------------------------------

/** A seeded generator of URL-ish texts: schemes, separators, whitespace, credentials, escapes, `file://` prefixes. */
function* urlTexts(n: number, seed: number): Generator<string> {
  let s = seed >>> 0
  const r = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)]!
  const schemes = ['', 'javascript:', 'JAVASCRIPT:', 'java\tscript:', 'vbscript:', 'data:', 'DATA:', 'file:', 'file://', 'http:', 'https:', 'HTTPS:', 'ftp:', 'blob:', 'mailto:', 'tel:', 'cid:', 'x-evil:']
  const lead = ['', ' ', '\t', '\n', '\u0000', '\u001f', 'file://', 'file://file://', '//', '\\\\', '/\\']
  const auth = ['', '//', '///', '\\\\', '//user:pw@', '//u@', '//evil.test', '//evil.test:8080', '//a%40b:c@']
  const rest = ['', 'evil.test/x', 'alert(1)', '%0aalert(1)', 'text/html,<script>x</script>', 'image/png;base64,AA', '/etc/passwd', 'a@b.test', '?q=1#f', '#frag']
  for (let i = 0; i < n; i++) yield pick(lead) + pick(schemes) + pick(auth) + pick(rest)
}

describe('outputUrl, sanitizeHref: what is written is always a URL the WHATWG parser reads as allowed', () => {
  it('links and images, with and without a base, over generated texts', () => {
    let kept = 0
    for (const text of urlTexts(6000, 7)) {
      for (const kind of ['link', 'image'] as const) {
        for (const policy of [undefined, {}, { baseURL: 'https://base.test/a/' }, { protocols: ['https:'] }] as Array<ImageUrlPolicy | undefined>) {
          const x = outputUrl(kind, text, policy)
          if (x === null) continue
          kept++
          expect(urlOk(x, kind), `${kind} ${JSON.stringify(text)} ${JSON.stringify(policy)} -> ${JSON.stringify(x)}`).toBe(true)
          if (policy?.protocols && URL.canParse(x, 'https://page.test/')) {
            expect(new URL(x, 'https://page.test/').protocol === 'https:' || !/^[\s\u0000-\u001f]*[a-z][a-z0-9+.-]*:/i.test(x), x).toBe(true)
          }
        }
      }
      const h = sanitizeHref(text)
      if (h !== null) expect(urlOk(h, 'link'), `${JSON.stringify(text)} -> ${JSON.stringify(h)}`).toBe(true)
    }
    // (the generator does make texts that are kept: the property is not vacuous)
    expect(kept).toBeGreaterThan(1000)
  })

  it('C3: `file://` is stripped as vega strips it, and the remainder is what is judged', () => {
    for (const p of ['javascript:alert(document.domain)', 'vbscript:x', 'data:text/html,<script>x</script>', 'JaVaScRiPt:x', ' javascript:x']) {
      expect(sanitizeHref('file://' + p), p).toBeNull()
      expect(sanitizeHref('file://file://' + p), p).toBeNull()
    }
    // vega's own rewrites are kept: a file path becomes a path of the page, `//host` an http url
    expect(sanitizeHref('file:///docs/a.html')).toBe('/docs/a.html')
    expect(sanitizeHref('//cdn.test/x')).toBe('http://cdn.test/x')
    // a host-naming text with no scheme of its own is written as the URL it was judged as
    expect(sanitizeHref('\\\\evil.test\\share')).toBe('https://evil.test/share')
  })

  it('an allow hook is asked once per URL the evaluation did not already ask about, and its answer is the output\'s', () => {
    const asked: string[] = []
    const policy: ImageUrlPolicy = { allow: (u) => { asked.push(u.href); return u.hostname === 'ok.test' } }
    expect(outputUrl('link', 'https://ok.test/a', policy)).toBe('https://ok.test/a')
    expect(outputUrl('link', 'https://ok.test/a', policy)).toBe('https://ok.test/a')
    expect(outputUrl('link', 'https://no.test/a', policy)).toBeNull()
    expect(outputUrl('link', 'rel.html', policy)).toBeNull()
    expect(asked).toEqual(['https://ok.test/a', 'https://no.test/a'])
    // a hook that throws is a refusal
    expect(outputUrl('image', 'https://x.test/', { allow: () => { throw new Error('boom') } })).toBeNull()
  })
})

// --- C391: a refused URL never carries its credentials out ---------------------------------------------------------------

describe('AsterUrlError and redactUrl: no password in a message or on the error', () => {
  it('over generated credential-carrying texts', () => {
    const secrets = ['hunter2', 'p%40ss', 's3cr3t!']
    for (const text of urlTexts(3000, 11)) {
      for (const pw of secrets) {
        const raw = text.replace('user:pw@', `user:${pw}@`).replace('//u@', `//u:${pw}@`)
        if (!raw.includes(pw)) continue
        const e = new AsterUrlError(raw, 'reason')
        expect(e.message, raw).not.toContain(pw)
        expect(e.url, raw).not.toContain(pw)
      }
    }
    expect(redactUrl('https://u:hunter2@ex.test/a')).toBe('https://***@ex.test/a')
    expect(redactUrl('https:\t//u:hunter2@ex.test/a')).toBe('https://***@ex.test/a')
    expect(redactUrl('mailto:me@ex.test')).toBe('mailto:me@ex.test')
    expect(redactUrl('https://ex.test/a')).toBe('https://ex.test/a')
  })

  it('end to end: a spec\'s url with credentials, refused under limits, is reported without them', () => {
    const spec = { width: 20, height: 20, marks: [{ type: 'image', encode: { update: { url: { value: 'https://u:hunter2@ex.test/a.png' }, width: { value: 5 }, height: { value: 5 } } } }] } as unknown as VgSpec
    let err: unknown
    try { renderSpec(spec, { limits: {} }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(AsterUrlError)
    expect(String((err as Error).message)).not.toContain('hunter2')
    expect((err as AsterUrlError).url).not.toContain('hunter2')
  })
})

