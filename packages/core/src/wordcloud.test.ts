import { describe, expect, it } from 'vitest'
import { evaluateChart } from './runtime.js'
import { compileChart } from './index.js'
import './addon-transforms.js'
import { wordcloudRows } from './wordcloud.js'
import type { Row, TransformContext } from './transform.js'

/**
 * The layout itself is checked against vega-wordcloud in Chromium (conformance/src/wordcloud-vs-vega.test.ts), where d3-cloud has a
 * canvas to draw its sprites on. Here there is none (Node): the words are drawn into the coverage-only context, and what is
 * checked is what does not depend on the glyphs: the order the random numbers are drawn in, that a layout is the same for the same
 * numbers, the font size scale, and what an unplaced word looks like.
 */
const ctxOf = (random: () => number): TransformContext => ({
  runtime: { expr: () => () => undefined, random } as never,
  signals: {},
  inPlace: true,
})

const counting = (): { next: () => number; drawn: () => number } => {
  let a = 0x5eed
  let n = 0
  return {
    next: () => {
      n++
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
    drawn: () => n,
  }
}

const items = (...words: Array<[string, number]>): Row[] => words.map(([text, count]) => ({ text, datum: { text, count } }))

describe('wordcloud (vega-wordcloud / d3-cloud)', () => {
  it('draws two numbers per word for its start and one for the direction of its spiral, in word order', () => {
    const r = counting()
    const rows = items(['alpha', 9], ['beta', 4], ['gamma', 1])
    wordcloudRows(rows, { size: [300, 200], text: { field: 'text' }, fontSize: { field: 'datum.count' }, fontSizeRange: [10, 40] }, ctxOf(r.next))
    expect(r.drawn()).toBe(9)
  })

  it('the same numbers give the same cloud', () => {
    const run = (): Row[] => {
      const r = counting()
      return wordcloudRows(items(['alpha', 9], ['beta', 4], ['gamma', 1], ['delta', 6]), { size: [300, 200], text: { field: 'text' }, fontSize: { field: 'datum.count' }, fontSizeRange: [10, 40], padding: 2 }, ctxOf(r.next))
    }
    expect(run()).toEqual(run())
  })

  it('writes x, y, font, fontSize, fontStyle, fontWeight and angle (as), the size scaled through the signed square root', () => {
    const rows = wordcloudRows(
      items(['small', 1], ['mid', 4], ['big', 9]),
      { size: [400, 300], text: { field: 'text' }, fontSize: { field: 'datum.count' }, fontSizeRange: [10, 40], font: 'serif', fontStyle: 'italic', fontWeight: 'bold', rotate: 30, as: ['px', 'py', 'f', 'fs', 'fst', 'fw', 'a'] },
      ctxOf(counting().next),
    )
    // domain [1, 9] -> sqrt [1, 3]; 4 -> sqrt 2 -> halfway: 10 + 0.5 * 30 = 25
    expect(rows.map((r) => r.fs)).toEqual([10, 25, 40])
    for (const r of rows) {
      expect([r.f, r.fst, r.fw, r.a]).toEqual(['serif', 'italic', 'bold', 30])
      expect(Number.isFinite(r.px)).toBe(true)
      expect(Number.isFinite(r.py)).toBe(true)
    }
  })

  it('a field-valued font size is the size as it is when the spec gives no fontSizeRange', () => {
    const rows = wordcloudRows(items(['a', 7], ['b', 13]), { size: [300, 200], text: { field: 'text' }, fontSize: { field: 'datum.count' } }, ctxOf(counting().next))
    expect(rows.map((r) => r.fontSize)).toEqual([7, 13])
  })

  it('a word with no room has no position and a font size of 0 (NaN, 0: the other outputs stay as they were)', () => {
    const rows = wordcloudRows(items(['enormous', 1]), { size: [60, 40], text: { field: 'text' }, fontSize: 300 }, ctxOf(counting().next))
    expect(rows[0]!.x).toBeNaN()
    expect(rows[0]!.y).toBeNaN()
    expect(rows[0]!.fontSize).toBe(0)
    expect('angle' in rows[0]!).toBe(false)
  })

  it('a size with a zero dimension is an error', () => {
    expect(() => wordcloudRows(items(['a', 1]), { size: [0, 100], text: { field: 'text' } }, ctxOf(counting().next))).toThrow('Wordcloud size dimensions must be non-zero.')
  })

  it('with no usable value the font size scale reads one past the end, as vega-util extent does: the accessor throws', () => {
    expect(() => wordcloudRows(items(['a', 1]).map((r) => ({ ...r, datum: {} })), { size: [200, 100], text: { field: 'text' }, fontSize: { field: 'nope.count' }, fontSizeRange: [10, 40] }, ctxOf(counting().next))).toThrow()
  })
})

describe('wordcloud in a chart', () => {
  const spec = {
    width: 300, height: 200, padding: 0, autosize: 'none',
    data: [{ name: 't', values: [{ text: 'alpha', count: 9 }, { text: 'beta', count: 4 }, { text: 'gamma', count: 1 }, { text: 'delta', count: 6 }] }],
    marks: [{
      type: 'text', from: { data: 't' },
      encode: { enter: { text: { field: 'text' }, align: { value: 'center' } } },
      transform: [{ type: 'wordcloud', size: [300, 200], text: { field: 'text' }, fontSize: { field: 'datum.count' }, fontSizeRange: [10, 40], padding: 1 }],
    }],
  } as never

  /** the text items of a scene, wherever the marks are nested */
  const positions = (scene: unknown): Array<[number, number]> => {
    const out: Array<[number, number]> = []
    const walk = (n: unknown): void => {
      if (n === null || typeof n !== 'object') return
      const o = n as { items?: unknown[]; marktype?: string; x?: number; y?: number }
      if (o.marktype === 'text') for (const i of (o.items ?? []) as Array<{ x: number; y: number }>) out.push([i.x, i.y])
      else for (const c of o.items ?? []) walk(c)
    }
    walk(scene)
    return out
  }

  it('lays the words out where an evaluation of the scene finds them, and does not redraw the numbers for the next evaluation', () => {
    const r = counting()
    const chart = compileChart(spec)
    const first = evaluateChart(chart, { random: r.next })
    const drawn = r.drawn()
    expect(drawn).toBe(12)
    const second = evaluateChart(chart, { random: r.next, width: 300, height: 200 })
    expect(r.drawn()).toBe(drawn)
    expect(positions(first)).toHaveLength(4)
    expect(positions(second)).toEqual(positions(first))
  })
})
