/**
 * Generated text marks (text-cases.ts) in Chromium, where text is measured by the real canvas: `<Chart>` against vega, canonical
 * SVG compared exactly (limit, ellipsis, dir, font, size, polar offset, multi-line). The headless-metrics twin is
 * text-truncation-vs-vega.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { runInline } from './gallery/react.js'
import { textCase } from './text-cases.js'

describe('text marks in Chromium against vega', () => {
  it('60 generated text specs: the same SVG as vega', { timeout: 600_000 }, async () => {
    const cases = Array.from({ length: 60 }, (_, i) => ({ id: `text-${i}`, ...textCase(9000 + i) }))
    const out = await runInline(cases.map((c) => ({ id: c.id, spec: c.spec, liveMs: 0 })), () => undefined, 4)
    const bad = out.filter((o) => o.status !== 'pass')
    expect(bad.slice(0, 3).map((o) => `${o.id}: ${o.status} ${o.reason ?? ''} ${o.first ?? ''}\n${JSON.stringify(cases.find((c) => c.id === o.id)!.spec)}`)).toEqual([])
  })
})
