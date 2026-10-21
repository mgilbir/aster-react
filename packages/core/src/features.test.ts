import { describe, it, expect } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './runtime.js'
import type { SceneGroup, SceneItem } from './types.js'

const base = { width: 400, height: 300, padding: 5, autosize: 'none' } as const
const itemsOf = (g: SceneGroup): SceneItem[] => (g.items ?? []) as SceneItem[]

describe('enter + update encode merge', () => {
  it('update channels and enter channels both survive, update wins per-channel', () => {
    const chart = compileChart({
      ...base,
      data: [{ name: 't', values: [{ a: 'A', b: 5 }] }],
      scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'a' }, range: 'width' }],
      marks: [{
        type: 'rect', from: { data: 't' },
        encode: {
          enter: { x: { scale: 'x', field: 'a' }, fill: { value: 'red' } },
          update: { y: { value: 10 }, fill: { value: 'blue' } },
        },
      }],
    } as never)
    const mark = chart.marks[0]!
    const update = mark.encode!.update!
    // enter.x merged in; update.fill overrides enter.fill
    expect(update.x).toBeDefined()
    expect(update.fill).toEqual({ value: 'blue' })
    expect(update.y).toEqual({ value: 10 })
  })
})

describe('signal update resolution', () => {
  it('derives a signal from width and exposes it to encodings', () => {
    const chart = compileChart({
      ...base,
      signals: [{ name: 'cx', update: 'width / 2' }, { name: 'rr', update: 'cx + 5' }],
      marks: [{ type: 'symbol', encode: { update: { x: { signal: 'cx' }, y: { signal: 'rr' }, size: { value: 1 } } } }],
    } as never)
    const scene = evaluateChart(chart)
    const item = itemsOf(scene.items.find((g): g is SceneGroup => (g as SceneGroup).marktype === 'symbol')!).find((x) => x.x != null)!
    expect(item.x).toBe(200) // width/2
    expect(item.y).toBe(205) // cx+5, chained in declaration order
  })
})

describe('config resolution', () => {
  it('config.style.<type> supplies encode channels the mark omits (encode wins)', () => {
    const chart = compileChart({
      ...base,
      config: { style: { rect: { fill: 'tomato', cornerRadius: 3 } } },
      marks: [{ type: 'rect', style: ['rect'], encode: { update: { x: { value: 1 }, fill: { value: 'keepme' } } } }],
    } as never)
    const update = chart.marks[0]!.encode!.update!
    expect(update.fill).toEqual({ value: 'keepme' }) // encode wins
    expect(update.cornerRadius).toEqual({ value: 3 }) // supplied from style
  })

  it('config.background is the fallback root background', () => {
    const chart = compileChart({ ...base, config: { background: '#eee' } } as never)
    expect(chart.background).toBe('#eee')
  })
})

describe('sequential color scales do not zero-extend', () => {
  it('a linear scale with a scheme range maps domain min to t=0 (not 0-domain)', () => {
    const chart = compileChart({
      ...base,
      data: [{ name: 't', values: [{ v: 28 }, { v: 55 }] }],
      scales: [{ name: 'c', type: 'linear', domain: { data: 't', field: 'v' }, range: { scheme: 'viridis' } }],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 1 }, height: { value: 1 }, fill: { scale: 'c', field: 'v' } } } }],
    } as never)
    const scene = evaluateChart(chart)
    const rects = itemsOf(scene.items.find((g): g is SceneGroup => (g as SceneGroup).marktype === 'rect')!)
    // domain is [28,55]; the min datum maps to viridis(0) = rgb(68, 1, 84),
    // which only holds if zero-extension was NOT applied.
    expect(String(rects[0]!.fill)).toMatch(/68,\s*1,\s*84/)
  })
})

describe('band-size encode offsets', () => {
  it('applies offset to a band-sized height', () => {
    const chart = compileChart({
      ...base,
      data: [{ name: 't', values: [{ g: 'a', v: 1 }, { g: 'b', v: 2 }] }],
      scales: [{ name: 'y', type: 'band', range: [200, 0], domain: { data: 't', field: 'g' } }],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: {
        x: { value: 0 }, width: { value: 10 },
        y: { scale: 'y', field: 'g' },
        height: { scale: 'y', band: 1, offset: -1 },
        fill: { value: 'steelblue' },
      } } }],
    } as never)
    const scene = evaluateChart(chart)
    const mark = scene.items.find((g): g is SceneGroup => g.marktype === 'rect')!
    const rects = itemsOf(mark)
    const bandwidth = 200 / 2
    expect(rects[0]!.height).toBe(bandwidth - 1)
    expect(rects[1]!.height).toBe(bandwidth - 1)
  })
})

describe('nested group scope', () => {
  it('nested marks resolve outer scales and datasets', () => {
    const chart = compileChart({
      ...base,
      data: [{ name: 't', values: [
        { age: 0, sex: 1, people: 10 }, { age: 0, sex: 2, people: 12 },
        { age: 5, sex: 1, people: 8 }, { age: 5, sex: 2, people: 9 },
      ] }],
      scales: [
        { name: 'y', type: 'band', range: [200, 0], domain: { data: 't', field: 'age' } },
        { name: 'c', type: 'ordinal', domain: [1, 2], range: ['#d5855a', '#6c4e97'] },
      ],
      marks: [{
        type: 'group',
        encode: { update: { x: { value: 0 }, height: { value: 200 } } },
        scales: [{ name: 'x', type: 'linear', range: [100, 0], domain: { data: 't', field: 'people' } }],
        marks: [{ type: 'rect', from: { data: 't' }, encode: { update: {
          x: { scale: 'x', field: 'people' }, x2: { scale: 'x', value: 0 },
          y: { scale: 'y', field: 'age' }, height: { scale: 'y', band: 1 },
          fill: { scale: 'c', field: 'sex' },
        } } }],
      }],
    } as never)
    const scene = evaluateChart(chart)
    const group = scene.items.find((g): g is SceneGroup => g.marktype === 'group' && g.role === 'scope')!
    const rectMark = (group.items as SceneGroup[]).find((g) => g.marktype === 'rect')!
    const rects = itemsOf(rectMark)
    expect(rects).toHaveLength(4)
    for (const r of rects) {
      expect(typeof r.y).toBe('number')
      expect(typeof r.height).toBe('number')
      expect(String(r.fill)).toMatch(/^#(d5855a|6c4e97)$/i)
    }
  })

  it('a group with its own scales+axes renders marks in the child scope', () => {
    const chart = compileChart({
      ...base,
      signals: [{ name: 'gw', update: 'width - 10' }],
      data: [{ name: 't', values: [{ a: 'A', b: 10 }, { a: 'B', b: 20 }] }],
      marks: [{
        type: 'group',
        encode: { update: { x: { value: 5 }, y: { value: 5 }, width: { signal: 'gw' }, height: { value: 130 } } },
        scales: [
          { name: 'xs', type: 'band', domain: { data: 't', field: 'a' }, range: 'width' },
          { name: 'ys', type: 'linear', domain: { data: 't', field: 'b' }, range: 'height' },
        ],
        axes: [{ orient: 'left', scale: 'ys', labels: false }],
        marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'xs', field: 'a' }, y: { scale: 'ys', field: 'b' }, width: { scale: 'xs', band: 1 }, y2: { scale: 'ys', value: 0 }, fill: { value: 'steelblue' } } } }],
      }],
    } as never)
    const scene = evaluateChart(chart)
    const group = scene.items.find((g): g is SceneGroup => g.marktype === 'group' && g.role === 'scope')
    expect(group).toBeDefined()
    // group positioned at encode x/y; contains an axis + a rect mark group
    expect(group!.x).toBe(5)
    const rectMark = (group!.items as SceneGroup[]).find((g) => g.marktype === 'rect')
    expect(rectMark).toBeDefined()
    expect(itemsOf(rectMark!)).toHaveLength(2)
  })
})

describe('top-level title', () => {
  it('renders a title text anchored above the plot', () => {
    const chart = compileChart({ ...base, title: 'Hello' } as never)
    expect(chart.title?.text).toBe('Hello')
    expect(chart.title?.fontSize).toBe(13)
    const scene = evaluateChart(chart)
    const titleGroup = scene.items.find((g): g is SceneGroup => g.role === 'title')
    expect(titleGroup).toBeDefined()
    // title sits above the plot (negative y with autosize none)
    expect(titleGroup!.y).toBeLessThan(0)
  })
})
