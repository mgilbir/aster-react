// @vitest-environment jsdom
/**
 * C93: image `url`s pass the same policy as loaded data, in the string renderer
 * AND the DOM path. The policy runs while the scene is built, so both renderers
 * (and canvas) see already-vetted items.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec, compileChart, evaluateChart, AsterUrlError } from './index.js'
import { renderSceneToDomElement } from './addon-dom.js'
import { renderSceneToCanvas, type CanvasLike } from './canvas.js'
import type { RuntimeInput, VgSpec } from './types.js'

const imageSpec = (url: string): VgSpec => ({
  width: 100, height: 100, data: [{ name: 't', values: [{ u: url }] }],
  marks: [{ type: 'image', from: { data: 't' }, encode: { update: { url: { field: 'u' }, x: { value: 1 }, y: { value: 1 }, width: { value: 10 }, height: { value: 10 } } } }],
} as unknown as VgSpec)

const hrefs = (el: Element): string[] => [...el.querySelectorAll('image')].map((i) => i.getAttribute('xlink:href') ?? i.getAttribute('href') ?? '')
const domOf = (spec: VgSpec, input: RuntimeInput): Element => renderSceneToDomElement(evaluateChart(compileChart(spec), input), document) as unknown as Element

describe('image url policy (C93)', () => {
  const HOSTILE = ['javascript:alert(1)', '  javascript:alert(1)', 'java\tscript:alert(1)', 'JaVaScRiPt:alert(1)', 'file:///etc/passwd', 'vbscript:x', 'ftp://example.test/a.png',
    'https://user:pw@example.test/a.png', 'blob:https://example.test/uuid']

  it.each(HOSTILE)('denied by default under limits, string renderer: %j', (url) => {
    expect(() => renderSpec(imageSpec(url), { limits: { maxRows: 100 } })).toThrowError(AsterUrlError)
  })

  it.each(HOSTILE)('denied by default under limits, DOM path: %j', (url) => {
    expect(() => domOf(imageSpec(url), { limits: { maxRows: 100 } })).toThrowError(AsterUrlError)
  })

  it('ordinary urls pass: https, http, data:image, relative', () => {
    for (const url of ['https://example.test/a.png', 'http://example.test/a.png', 'data:image/png;base64,AAAA', 'img/a.png', '/img/a.png']) {
      const svg = renderSpec(imageSpec(url), { limits: { maxRows: 100 } })
      expect(svg).toContain('<image')
      expect(hrefs(domOf(imageSpec(url), { limits: { maxRows: 100 } }))).toEqual([url])
    }
  })

  it('with neither limits nor a policy images are drawn as given (Vega parity; documented residual risk)', () => {
    expect(renderSpec(imageSpec('javascript:alert(1)'))).toContain('javascript:alert(1)')
  })

  it('an explicit policy applies without limits; allow() restricts hosts; the hook sees a parsed URL', () => {
    const seen: string[] = []
    const policy = { allow: (u: URL) => { seen.push(u.hostname); return u.hostname === 'cdn.example.test' } }
    expect(() => renderSpec(imageSpec('https://evil.test/p.gif'), { urlPolicy: policy })).toThrow(/refused by the allow hook/)
    expect(renderSpec(imageSpec('https://cdn.example.test/p.gif'), { urlPolicy: policy })).toContain('cdn.example.test')
    expect(seen).toEqual(['evil.test', 'cdn.example.test'])
  })

  it('a relative url needs a baseURL once an allow hook is set (fail closed)', () => {
    expect(() => renderSpec(imageSpec('a.png'), { urlPolicy: { allow: () => true } })).toThrow(/needs a baseURL/)
    expect(renderSpec(imageSpec('a.png'), { urlPolicy: { allow: () => true, baseURL: 'https://example.test/' } })).toContain('a.png')
  })

  it('onDeny drops the image in BOTH renderers instead of throwing: nothing is requested, nothing is drawn', () => {
    const denied: string[] = []
    const input: RuntimeInput = { urlPolicy: { onDeny: (u) => denied.push(u) } }
    const svg = renderSpec(imageSpec('javascript:alert(1)'), input)
    expect(svg).not.toContain('<image')
    expect(svg).not.toContain('javascript')
    expect(hrefs(domOf(imageSpec('javascript:alert(1)'), input))).toEqual([])
    expect(denied).toEqual(['javascript:alert(1)', 'javascript:alert(1)'])
  })

  it('a protocol-relative url is a network url: it is classified and vetted, never treated as relative', () => {
    const seen: string[] = []
    expect(() => renderSpec(imageSpec('//evil.test/p.gif'), { urlPolicy: { allow: (u) => { seen.push(u.hostname); return false } } })).toThrow(/refused by the allow hook/)
    expect(seen).toEqual(['evil.test'])
  })

  it('protocols can be widened by the host', () => {
    expect(renderSpec(imageSpec('blob:https://example.test/uuid'), { urlPolicy: { protocols: ['blob:', 'https:'] } })).toContain('blob:')
  })

  describe('canvas path', () => {
    // The canvas renderer never fetches: the host's image loader reads `item.url`
    // from the evaluated scene and attaches `item.image`. So the policy must stop a
    // hostile url BEFORE the scene exists / strip it from the item.
    const spy = (): { ctx: CanvasLike; draws: number } => {
      const state = { draws: 0 }
      const store: Record<string, unknown> = { globalAlpha: 1, lineWidth: 1 }
      const ctx = new Proxy(store, {
        get: (t, k: string) => (k === 'drawImage' ? () => { state.draws++ } : k in t ? t[k] : () => undefined),
        set: (t, k: string, v) => ((t[k] = v), true),
      }) as unknown as CanvasLike
      return { ctx, get draws() { return state.draws } }
    }
    const urlsIn = (scene: ReturnType<typeof evaluateChart>): unknown[] => {
      const out: unknown[] = []
      const walk = (n: { items?: unknown[]; url?: unknown }): void => { if (n.url != null) out.push(n.url); for (const c of (n.items ?? []) as Array<{ items?: unknown[]; url?: unknown }>) walk(c) }
      walk(scene as never)
      return out
    }

    it('under limits a hostile url throws before any scene (and so any host image loader) exists', () => {
      const loaded: unknown[] = []
      expect(() => {
        const scene = evaluateChart(compileChart(imageSpec('javascript:alert(1)')), { limits: { maxRows: 10 } })
        loaded.push(...urlsIn(scene)) // the host loader would start here
      }).toThrowError(AsterUrlError)
      expect(loaded).toEqual([])
    })

    /** What a host's image loader does: fetch each item's url and attach the bitmap. Records what it was asked to load. */
    const loaderAttach = (scene: ReturnType<typeof evaluateChart>): string[] => {
      const asked: string[] = []
      const walk = (n: { items?: unknown[]; url?: unknown }): void => {
        if (typeof n.url === 'string') { asked.push(n.url); (n as Record<string, unknown>).image = { width: 10, height: 10, complete: true } }
        for (const c of (n.items ?? []) as Array<{ items?: unknown[]; url?: unknown }>) walk(c)
      }
      walk(scene as never)
      return asked
    }

    it('with onDeny the loader is never asked for the hostile url and drawImage is never reached; a permitted url is (control)', () => {
      const scene = evaluateChart(compileChart(imageSpec('javascript:alert(1)')), { urlPolicy: { onDeny: () => undefined } })
      expect(loaderAttach(scene)).toEqual([])
      const denied = spy()
      renderSceneToCanvas(scene, denied.ctx)
      expect(denied.draws).toBe(0)
      // control: the same loader + canvas harness does draw a permitted url, so the zero above means something
      const ok = evaluateChart(compileChart(imageSpec('https://example.test/a.png')), { limits: { maxRows: 10 } })
      expect(loaderAttach(ok)).toEqual(['https://example.test/a.png'])
      const allowed = spy()
      renderSceneToCanvas(ok, allowed.ctx)
      expect(allowed.draws).toBeGreaterThan(0)
    })
  })
})
