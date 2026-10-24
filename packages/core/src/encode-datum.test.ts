/**
 * C21: encoding never writes channel values back into the datum.
 *
 * `resolveEncodeSet` used to mirror every resolved channel (x, y, size, fill,
 * opacity, ...) onto `item.datum`, so a data field named like a channel was
 * overwritten with a pixel/visual value; tooltips, signals and interactions then
 * read the corrupted value (Vega keeps the data value). The encoded values live
 * on the scene item only.
 */
import { describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './runtime.js'
import type { SceneRoot } from './types.js'

type Row = Record<string, unknown>

/** Every channel a mark type can encode (plus the shared styling ones). */
const COMMON = ['fill', 'stroke', 'opacity', 'fillOpacity', 'strokeOpacity', 'strokeWidth', 'strokeCap', 'strokeJoin', 'cursor', 'zindex', 'description', 'blend']
const CHANNELS: Record<string, string[]> = {
  symbol: ['x', 'y', 'size', 'shape', 'angle'],
  rect: ['x', 'x2', 'y', 'y2', 'width', 'height', 'cornerRadius'],
  text: ['x', 'y', 'text', 'fontSize', 'angle', 'dx', 'dy', 'align', 'baseline', 'limit', 'font', 'fontWeight'],
  line: ['x', 'y', 'interpolate', 'tension'],
  area: ['x', 'y', 'y2', 'interpolate', 'orient'],
  rule: ['x', 'x2', 'y', 'y2'],
  arc: ['x', 'y', 'startAngle', 'endAngle', 'innerRadius', 'outerRadius', 'padAngle', 'cornerRadius'],
  trail: ['x', 'y', 'size'],
}

/** A value for a channel: numeric channels get a number, the rest a string. */
const NUMERIC = new Set(['x', 'x2', 'y', 'y2', 'width', 'height', 'size', 'angle', 'fontSize', 'dx', 'dy', 'limit', 'cornerRadius', 'startAngle', 'endAngle', 'innerRadius', 'outerRadius', 'padAngle', 'opacity', 'fillOpacity', 'strokeOpacity', 'strokeWidth', 'zindex', 'tension'])
const encodeValue = (ch: string, i: number): unknown => {
  if (ch === 'fill' || ch === 'stroke') return { scale: 'color', field: 'k' }
  if (ch === 'x' || ch === 'x2') return { scale: 'px', field: 'px' }
  if (ch === 'y' || ch === 'y2') return { scale: 'py', field: 'py' }
  if (ch === 'text') return { signal: 'datum.k' }
  return NUMERIC.has(ch) ? { value: 3 + (i % 5) } : { value: ch === 'shape' ? 'square' : ch === 'align' ? 'left' : ch === 'baseline' ? 'top' : ch === 'interpolate' ? 'linear' : ch === 'orient' ? 'vertical' : 'x' }
}

function items(scene: unknown): Array<{ datum?: Row; [k: string]: unknown }> {
  const out: Array<{ datum?: Row }> = []
  const seen = new Set<unknown>()
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v)) { v.forEach(walk); return }
    const o = v as Record<string, unknown>
    if ('datum' in o && o.datum && typeof o.datum === 'object') out.push(o as { datum: Row })
    if (Array.isArray(o.items)) o.items.forEach(walk)
  }
  walk(scene)
  return out
}

function specFor(mark: string): Record<string, unknown> {
  const channels = [...new Set([...CHANNELS[mark]!, ...COMMON])]
  const update: Record<string, unknown> = {}
  channels.forEach((ch, i) => { update[ch] = encodeValue(ch, i) })
  update.tooltip = { signal: 'datum' }
  return {
    width: 200, height: 100, autosize: 'none', padding: 5,
    data: [{ name: 't' }],
    scales: [
      { name: 'px', type: 'linear', domain: { data: 't', field: 'px' }, range: 'width' },
      { name: 'py', type: 'linear', domain: { data: 't', field: 'py' }, range: 'height' },
      { name: 'color', type: 'ordinal', domain: { data: 't', field: 'k' }, range: 'category' },
    ],
    marks: [{ type: mark, from: { data: 't' }, encode: { update } }],
  }
}

/** Data rows whose fields carry EVERY channel name with a distinctive data value. */
function rowsFor(mark: string): Row[] {
  const names = [...new Set([...CHANNELS[mark]!, ...COMMON, 'tooltip', 'width', 'height', 'xc', 'yc', 'defined', 'href', 'url'])]
  return [0, 1, 2].map((i) => {
    const r: Row = { px: i * 10 + 1, py: i * 7 + 2, k: ['a', 'b', 'c'][i] }
    for (const n of names) r[n] = `data:${n}:${i}`
    return r
  })
}

describe('C21: the datum keeps its data values', () => {
  it.each(Object.keys(CHANNELS))('%s: a field named like every channel is not overwritten by encoding', (mark) => {
    const rows = rowsFor(mark)
    const before = JSON.parse(JSON.stringify(rows)) as Row[]
    const scene = evaluateChart(compileChart(specFor(mark) as never), { data: { t: rows } }) as SceneRoot
    const its = items(scene).filter((it) => it.datum && 'px' in it.datum)
    expect(its.length, `${mark} produced items`).toBeGreaterThan(0)
    for (const it of its) {
      const d = it.datum!
      const original = before.find((r) => r.px === d.px)!
      expect(d, `${mark} datum`).toEqual(original)
    }
    // the caller's own rows are untouched too
    expect(JSON.parse(JSON.stringify(rows))).toEqual(before)
  })

  it('tooltips and signal-valued channels read data values, not pixels', () => {
    const rows = [{ x: 5, y: 7, size: 'big', fill: 'data-fill', px: 5, py: 7 }]
    const spec = {
      width: 100, height: 100, autosize: 'none', padding: 0,
      data: [{ name: 't' }],
      scales: [
        { name: 'sx', type: 'linear', domain: [0, 10], range: 'width' },
        { name: 'sy', type: 'linear', domain: [0, 10], range: 'height' },
      ],
      marks: [{
        type: 'symbol', from: { data: 't' },
        encode: { update: {
          x: { scale: 'sx', field: 'px' }, y: { scale: 'sy', field: 'py' },
          fill: { value: 'steelblue' },
          size: { signal: 'datum.x * 10 + datum.y' }, // reads the DATA x and y
          tooltip: { signal: 'datum' },
        } },
      }],
    }
    const scene = evaluateChart(compileChart(spec as never), { data: { t: rows } }) as SceneRoot
    const [it] = items(scene).filter((i) => i.datum && 'px' in i.datum)
    expect(it!.datum).toEqual(rows[0])
    expect(it!.x).toBe(50)
    expect(it!.size).toBe(57) // 5 * 10 + 7: data values, not the pixel x/y
    expect((it!.tooltip as Row).x).toBe(5)
    expect((it!.tooltip as Row).fill).toBe('data-fill')
  })

  it('`defined` and conditional tests see the same data values', () => {
    const rows = [{ px: 1, py: 2, y: null }, { px: 3, py: 4, y: 8 }]
    const spec = {
      width: 100, height: 100, autosize: 'none', padding: 0,
      data: [{ name: 't' }],
      scales: [{ name: 'sx', type: 'linear', domain: [0, 4], range: 'width' }, { name: 'sy', type: 'linear', domain: [0, 4], range: 'height' }],
      marks: [{
        type: 'symbol', from: { data: 't' },
        encode: { update: {
          x: { scale: 'sx', field: 'px' }, y: { scale: 'sy', field: 'py' },
          defined: { signal: 'isValid(datum.y)' },
          fill: [{ test: 'datum.y > 5', value: 'red' }, { value: 'blue' }],
        } },
      }],
    }
    const scene = evaluateChart(compileChart(spec as never), { data: { t: rows } }) as SceneRoot
    const its = items(scene).filter((i) => i.datum && 'px' in i.datum)
    expect(its.map((i) => i.datum!.y)).toEqual([null, 8])
    expect(its.map((i) => i.fill)).toEqual(['blue', 'red'])
  })
})
