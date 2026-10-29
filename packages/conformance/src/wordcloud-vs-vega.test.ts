/**
 * The `wordcloud` transform against vega-wordcloud / d3-cloud, in Chromium, where vega's canvas exists.
 *
 * d3-cloud lays words out on sprites it cuts from a canvas the words were drawn on: where a word lands depends on the ink of every
 * glyph before it, on the order the words are sprited in (by size), on the numbers drawn for each word's start and for the direction
 * of its spiral, and on the pixels each word is trimmed to. The page runs vega (its own canvas) and `<Chart>` (the engine's port
 * of the layout, which draws on the host's canvas as vega does) on the same seeded random stream, and the pictures must be equal:
 * every word at the same place, size, angle and font.
 *
 * The specs are generated (seeded): the size of the cloud, the words (repeated, unicode, a word too long to place, one too large for
 * the sheet), the font (family, style, weight), the font size as a constant or a field scaled into a range (and a range of `null`,
 * and a field with one value), the rotation as a constant, a field or `random()`, the padding, the spiral.
 */
import { describe, expect, it } from 'vitest'
import { runInline, type InlineSpec } from './gallery/react.js'

import { wordcloudCase } from './wordcloud-cases.js'

const SEEDS = Number(process.env.WORDCLOUD_SEEDS ?? 36)

describe('wordcloud: vega-wordcloud / d3-cloud', () => {
  it(`${SEEDS} generated clouds are the same as vega's, word for word`, { timeout: 900_000 }, async () => {
    const cases = Array.from({ length: SEEDS }, (_, i) => wordcloudCase(i + 1))
    const inputs: InlineSpec[] = cases.map((c) => ({ id: c.id, spec: c.spec, liveMs: 0 }))
    const out = await runInline(inputs, () => undefined, 4)
    const bad = out.filter((o) => o.status !== 'pass')
    const report = bad.slice(0, 5).map((o) => `${o.id}: ${o.status} ${o.reason ?? ''} ${o.first ?? ''}\n${JSON.stringify(cases.find((c) => c.id === o.id)!.spec)}`)
    expect(bad.length, `${bad.length} of ${out.length} clouds differ from vega:\n${report.join('\n\n')}`).toBe(0)
  })
})
