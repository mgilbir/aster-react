// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DATA, cn, xq, yq, compileFrozen } from './helpers.js'

const NULLS = { values: [{ c: 'A', x: 1, y: 2, s: 3 }, { c: 'B', x: 2, y: null, s: 5 }, { c: 'C', x: 3, y: 4, s: null }] }
const scale = (vg: any, name: string): any => vg.scales.find((s: any) => s.name === name)
const marksUpdate = (vg: any): any => {
  const walk = (m: any): any => (m.marks ? walk(m.marks[m.marks.length - 1]) : m)
  return walk(vg.marks[vg.marks.length - 1]).encode.update
}
const transforms = (vg: any): any[] => vg.data.find((d: any) => d.name === 'data_0').transform

describe('config.scale (vega-lite scale/range.ts and properties.ts)', () => {
  const pt = (scaleCfg: unknown, encoding: unknown = {}, mark: unknown = 'point') =>
    compileFrozen({ data: DATA, mark, encoding: { x: xq, y: yq, ...(encoding as object) }, config: { scale: scaleCfg } })

  it('minSize and maxSize bound a point size scale; the default max follows the step', () => {
    const size = { size: { field: 'x', type: 'quantitative' } }
    expect(scale(pt({ minSize: 20, maxSize: 200 }, size), 'size').range).toEqual([20, 200])
    expect(scale(pt({}, size), 'size').range).toEqual([4, 361])
  })

  it('the size range follows the mark: font size, stroke width, band size', () => {
    const size = { size: { field: 'x', type: 'quantitative' } }
    expect(scale(pt({ minFontSize: 12, maxFontSize: 30 }, { ...size, text: cn }, 'text'), 'size').range).toEqual([12, 30])
    expect(scale(pt({ minStrokeWidth: 2, maxStrokeWidth: 6 }, size, 'line'), 'size').range).toEqual([2, 6])
    expect(scale(pt({ minBandSize: 3, maxBandSize: 30 }, { ...size, x: cn }, 'bar'), 'size').range).toEqual([3, 30])
  })

  it('strokeWidth and opacity ranges come from config', () => {
    expect(scale(pt({ minStrokeWidth: 2, maxStrokeWidth: 7 }, { strokeWidth: { field: 'x', type: 'quantitative' } }), 'strokeWidth').range).toEqual([2, 7])
    expect(scale(pt({ minOpacity: 0.1, maxOpacity: 0.5 }, { opacity: { field: 'x', type: 'quantitative' } }), 'opacity').range).toEqual([0.1, 0.5])
  })

  it('quantile and quantize size scales spread their count of values over the range', () => {
    const q = (type: string) => scale(pt({ quantileCount: 6, quantizeCount: 3 }, { size: { field: 'x', type: 'quantitative', scale: { type } } }), 'size').range.signal
    expect(q('quantile')).toContain('(6 - 1)')
    expect(q('quantize')).toContain('(3 - 1)')
  })

  it('nested-offset and offset band padding come from config', () => {
    const vg = compileFrozen({ data: DATA, mark: 'bar', encoding: { x: cn, y: yq, xOffset: { field: 'g', type: 'nominal' } }, config: { scale: { bandWithNestedOffsetPaddingInner: 0.4, bandWithNestedOffsetPaddingOuter: 0.1, offsetBandPaddingInner: 0.3 } } })
    expect(scale(vg, 'x')).toMatchObject({ paddingInner: 0.4, paddingOuter: 0.1 })
    expect(scale(vg, 'xOffset')).toMatchObject({ paddingInner: 0.3 })
  })

  it('pointPadding, clamp and round reach the scales', () => {
    const vg = compileFrozen({ data: DATA, mark: 'point', encoding: { x: cn, y: yq }, config: { scale: { pointPadding: 0.2, clamp: true, round: true } } })
    expect(scale(vg, 'x')).toMatchObject({ padding: 0.2, round: true })
    expect(scale(vg, 'y').clamp).toBe(true)
  })

  it('useUnaggregatedDomain adds the raw min and max to the aggregate and reads the domain from them', () => {
    const vg = compileFrozen({ data: DATA, mark: 'bar', encoding: { x: cn, y: { field: 'v', type: 'quantitative', aggregate: 'mean' } }, config: { scale: { useUnaggregatedDomain: true } } })
    const agg = transforms(vg).find((t) => t.type === 'aggregate')
    expect(agg.ops).toEqual(['mean', 'min', 'max'])
    expect(scale(vg, 'y').domain.fields).toEqual(['min_v', 'max_v'])
    const off = compileFrozen({ data: DATA, mark: 'bar', encoding: { x: cn, y: { field: 'v', type: 'quantitative', aggregate: 'sum' } }, config: { scale: { useUnaggregatedDomain: true } } })
    expect(transforms(off).find((t) => t.type === 'aggregate').ops).toEqual(['sum'])
  })
})

describe('channels reach every mark', () => {
  it('opacity and size drive bars', () => {
    const vg = compileFrozen({ data: DATA, mark: 'bar', encoding: { x: cn, y: yq, opacity: { field: 'v', type: 'quantitative' }, size: { field: 'v', type: 'quantitative' } } })
    const u = marksUpdate(vg)
    expect(u.opacity).toEqual({ scale: 'opacity', field: 'v' })
    expect(u.width).toEqual({ scale: 'size', field: 'v' })
    expect(u.xc).toMatchObject({ band: 0.5 })
  })
  it('a legend symbol follows the mark', () => {
    const lg = (mark: string) => compileFrozen({ data: DATA, mark, encoding: { x: cn, y: yq, opacity: { field: 'v', type: 'quantitative' } } }).legends[0]
    expect(lg('bar').symbolType).toBe('square')
    expect(lg('line').symbolType).toBe('stroke')
    expect(lg('bar').encode.symbols.update.stroke).toEqual({ value: 'transparent' })
  })
})

describe('invalid values (mark.invalid)', () => {
  const spec = (mark: string, invalid?: unknown, config?: unknown) => ({
    data: NULLS,
    mark: invalid === undefined ? mark : { type: mark, invalid },
    encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } },
    ...(config ? { config } : {}),
  })
  const filter = (vg: any) => transforms(vg).find((t) => t.type === 'filter')?.expr as string | undefined

  it('filters invalid values from non-path marks by default, and from paths on request', () => {
    expect(filter(compileFrozen(spec('point')))).toContain('isFinite(+datum["y"])')
    expect(filter(compileFrozen(spec('line')))).toBeUndefined()
    expect(filter(compileFrozen(spec('line', 'filter')))).toContain('isFinite(+datum["y"])')
  })

  it('breaks a path at an invalid value instead of filtering it', () => {
    const u = marksUpdate(compileFrozen(spec('line')))
    expect(u.defined.signal).toContain('isFinite(+datum["y"])')
    expect(marksUpdate(compileFrozen(spec('line', 'filter'))).defined).toBeUndefined()
  })

  it('"show" keeps the datum and draws an invalid value at zero-or-min', () => {
    const vg = compileFrozen(spec('point', 'show'))
    expect(filter(vg)).toBeUndefined()
    const y = marksUpdate(vg).y
    expect(y[0].test).toBe('!isValid(datum["y"]) || !isFinite(+datum["y"])')
    expect(y[1]).toEqual({ scale: 'y', field: 'y' })
    expect(compileFrozen(spec('point', null)).data[1].transform.some((t: any) => t.type === 'filter')).toBe(false)
  })

  it('config.scale.invalid gives a channel its own value for invalid data', () => {
    const vg = compileFrozen(spec('point', undefined, { scale: { invalid: { y: { value: 10 } } } }))
    expect(marksUpdate(vg).y[0]).toMatchObject({ value: 10 })
    expect(filter(vg)).not.toContain('"y"')
  })
})

describe('mark keys and the image mark', () => {
  it('x2Offset moves only the second endpoint of a ranged bar', () => {
    const vg = compileFrozen({ data: DATA, mark: { type: 'bar', x2Offset: 6 }, encoding: { x: xq, x2: { field: 'y', type: 'quantitative' }, y: cn } })
    const u = marksUpdate(vg)
    expect(u.x2.offset).toBe(6)
    expect(u.x.offset).toBeUndefined()
  })
  it('markDef.style names extend the mark style list', () => {
    const vg = compileFrozen({ data: DATA, mark: { type: 'bar', style: ['hi'] }, encoding: { x: cn, y: yq }, config: { style: { hi: { fill: 'red' } } } })
    expect(vg.marks[0].style).toEqual(['bar', 'hi'])
    expect(vg.config.style.hi).toEqual({ fill: 'red' })
  })
  it('an image mark lays out like a rect, with a url and no paint', () => {
    const vg = compileFrozen({ data: { values: [{ x: 1, y: 2, u: 'a.png' }] }, mark: { type: 'image', width: 20, height: 30, aspect: false }, encoding: { x: xq, y: yq, url: { field: 'u', type: 'nominal' } } })
    const m = vg.marks[0]
    expect(m.type).toBe('image')
    expect(m.encode.update).toMatchObject({ aspect: { value: false }, xc: { scale: 'x' }, width: { value: 20 }, yc: { scale: 'y' }, height: { value: 30 } })
    expect(m.encode.update.url.signal).toContain('datum["u"]')
    expect(m.encode.update.fill).toBeUndefined()
  })
  it('the url channel belongs to image marks only', () => {
    expect(() => compileFrozen({ data: DATA, mark: 'point', encoding: { x: xq, y: yq, url: cn } })).toThrow(/image mark/)
  })
})

describe('width / height: "container"', () => {
  it('sizes the view from the host element with containerSize signals and an autosize fit', () => {
    const vg = compileFrozen({ data: DATA, width: 'container', height: 120, mark: 'point', encoding: { x: xq, y: yq } })
    expect(vg.autosize).toEqual({ type: 'fit-x', contains: 'padding' })
    expect(vg.width).toBeUndefined()
    expect(vg.height).toBe(120)
    expect(vg.signals[0]).toMatchObject({ name: 'width', on: [{ events: 'window:resize' }] })
    expect(vg.signals[0].init).toContain('containerSize()[0]')
  })
  it('both dimensions fit, and a user autosize keeps its own type', () => {
    const both = compileFrozen({ data: DATA, width: 'container', height: 'container', mark: 'bar', encoding: { x: cn, y: yq } })
    expect(both.autosize.type).toBe('fit')
    expect(both.signals.map((s: any) => s.name)).toEqual(['width', 'height'])
    const user = compileFrozen({ data: DATA, width: 'container', height: 'container', autosize: { type: 'fit', contains: 'content' }, mark: 'bar', encoding: { x: cn, y: yq } })
    expect(user.autosize.contains).toBe('content')
  })
  it('works on a layer and is refused inside a composition', () => {
    const layer = compileFrozen({ data: DATA, width: 'container', layer: [{ mark: 'line', encoding: { x: xq, y: yq } }] })
    expect(layer.autosize.type).toBe('fit-x')
    expect(() => compileFrozen({ data: DATA, hconcat: [{ width: 'container', mark: 'point', encoding: { x: xq, y: yq } }] })).toThrow(/container/)
  })
})
