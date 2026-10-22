import { describe, it, expect } from 'vitest'
import { chartInfoFromScene, evaluateChart, compileChart, getChartInfo } from '@aster/core'
import {
  baseDomainsOf, continuousAxes, dragToDataInterval, keyboardView, pixelSpanOf, positionalScales,
  selectionToPixels, viewToDomainRaw,
} from './interaction.js'

const marks = (xs: string, ys: string): unknown[] => [{
  type: 'symbol', from: { data: 't' },
  encode: { update: { x: { scale: xs, field: 'a' }, y: { scale: ys, field: 'b' } } },
}]
const mk = (over: Record<string, unknown>): never => ({
  width: 300, height: 200, padding: 5, autosize: 'none',
  data: [{ name: 't', values: [{ a: 0, b: 0 }, { a: 10, b: 20 }] }],
  ...over,
}) as never

const tutorial = mk({
  scales: [
    { name: 'xscale', type: 'linear', domain: { data: 't', field: 'a' }, range: 'width' },
    { name: 'yscale', type: 'linear', domain: { data: 't', field: 'b' }, range: 'height' },
  ],
  axes: [{ scale: 'xscale', orient: 'bottom' }, { scale: 'yscale', orient: 'left' }],
  marks: marks('xscale', 'yscale'),
})

describe('positionalScales (C68)', () => {
  it('finds scales that are not literally named x/y (axes first)', () => {
    expect(positionalScales(tutorial)).toEqual({ x: 'xscale', y: 'yscale' })
  })

  it('falls back to the mark channels when there are no axes, via x2/y2/xc/yc and rule arrays', () => {
    const spec = mk({
      scales: [
        { name: 'sx', type: 'linear', domain: [0, 1], range: 'width' },
        { name: 'sy', type: 'log', domain: [1, 10], range: 'height' },
      ],
      marks: [{ type: 'rect', encode: { update: {
        xc: [{ test: 'true', scale: 'sx', field: 'a' }, { value: 0 }],
        y2: { scale: 'sy', field: 'b' },
      } } }],
    })
    expect(positionalScales(spec)).toEqual({ x: 'sx', y: 'sy' })
  })

  it('skips discrete scales and picks the continuous one for the orientation', () => {
    const spec = mk({
      scales: [
        { name: 'cat', type: 'band', domain: { data: 't', field: 'a' }, range: 'width' },
        { name: 'val', type: 'linear', domain: [0, 1], range: 'height' },
      ],
      axes: [{ scale: 'cat', orient: 'bottom' }, { scale: 'val', orient: 'left' }],
      marks: marks('cat', 'val'),
    })
    expect(positionalScales(spec)).toEqual({ y: 'val' })
  })

  it('finds scales declared under axes/marks of nested groups', () => {
    const spec = mk({
      scales: [
        { name: 'gx', type: 'time', domain: [0, 1], range: 'width' },
        { name: 'gy', type: 'linear', domain: [0, 1], range: 'height' },
      ],
      marks: [{ type: 'group', axes: [{ scale: 'gx', orient: 'top' }], marks: marks('gx', 'gy') }],
    })
    expect(positionalScales(spec)).toEqual({ x: 'gx', y: 'gy' })
  })

  it('keeps working for plain x/y specs, and yields nothing when there is no continuous scale', () => {
    const plain = mk({
      scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 1], range: 'height' }],
      marks: [],
    })
    expect(positionalScales(plain)).toEqual({ x: 'x', y: 'y' })
    expect(positionalScales(mk({ marks: [] }))).toEqual({})
  })
})

describe('positional scale names flow through the helpers (C68)', () => {
  const info = getChartInfo(tutorial, { width: 300, height: 200 })
  const names = positionalScales(tutorial)

  it('viewToDomainRaw keys the override by scale name', () => {
    expect(viewToDomainRaw({ x: [1, 2], y: [3, 4] }, names)).toEqual({ xscale: [1, 2], yscale: [3, 4] })
    // Without names the legacy x/y keys apply.
    expect(viewToDomainRaw({ x: [1, 2] })).toEqual({ x: [1, 2] })
  })

  it('dragToDataInterval / selectionToPixels / continuousAxes / baseDomainsOf read the named scales', () => {
    const interval = dragToDataInterval({ x: 55, y: 55 }, { x: 155, y: 105 }, info, names)
    expect(interval.x).toBeDefined()
    expect(interval.y).toBeDefined()
    expect(dragToDataInterval({ x: 55, y: 55 }, { x: 155, y: 105 }, info)).toEqual({}) // legacy names: nothing
    const rect = selectionToPixels(interval, info, names)
    expect(rect.x).toBeCloseTo(55, 0)
    expect(rect.width).toBeCloseTo(100, 0)
    expect(continuousAxes(info, names)).toEqual(['x', 'y'])
    expect(baseDomainsOf(info, names)).toEqual({ x: [0, 10], y: [0, 20] })
  })

  it('domainRaw by scale name actually changes the evaluated scale', () => {
    const scene = evaluateChart(compileChart(tutorial), { width: 300, height: 200, domainRaw: viewToDomainRaw({ x: [2, 4] }, names) })
    expect(baseDomainsOf(chartInfoFromScene(scene), names).x).toEqual([2, 4])
  })
})

describe('keyboardView gating (C66)', () => {
  const base = { x: [0, 10] as [number, number], y: [0, 20] as [number, number] }
  it('pan:false blocks arrows but not zoom or reset', () => {
    expect(keyboardView('ArrowRight', null, base, { pan: false }).handled).toBe(false)
    expect(keyboardView('+', null, base, { pan: false }).handled).toBe(true)
    expect(keyboardView('0', { x: [1, 2] }, base, { pan: false })).toEqual({ handled: true, view: null })
  })
  it('zoom:false blocks +/- but not arrows', () => {
    expect(keyboardView('+', null, base, { zoom: false }).handled).toBe(false)
    expect(keyboardView('-', null, base, { zoom: false }).handled).toBe(false)
    expect(keyboardView('ArrowRight', null, base, { zoom: false }).handled).toBe(true)
  })
})

describe('pixelSpanOf (C64)', () => {
  it('is signed by the scale orientation', () => {
    const up = getChartInfo(tutorial, { width: 300, height: 200 }).scales.get('yscale')
    const right = getChartInfo(tutorial, { width: 300, height: 200 }).scales.get('xscale')
    expect(pixelSpanOf(right, [0, 10])!).toBeGreaterThan(0)
    expect(pixelSpanOf(up, [0, 20])!).toBeLessThan(0)
    expect(pixelSpanOf(undefined, [0, 1])).toBeNull()
  })
})
