/**
 * Small, direct regression tests for the scale/geo port nits (audit C62, C95) the
 * oracle vectors only reach indirectly.
 */
import { describe, expect, it } from 'vitest'
import { ascending, descending } from './arr.js'
import { buildProjection } from './geo.js'
import { interpolate, isContinuous, isDiscrete, isInterpolating, scale } from './scale.js'

describe('d3-array 3.2.4 ascending/descending (C62)', () => {
  it('a null or undefined operand compares as NaN, never as 0 or an ordering', () => {
    for (const bad of [null, undefined]) {
      for (const other of [1, 'a', 0, new Date(0), null, undefined]) {
        expect(ascending(bad, other)).toBeNaN()
        expect(ascending(other, bad)).toBeNaN()
        expect(descending(bad, other)).toBeNaN()
        expect(descending(other, bad)).toBeNaN()
      }
    }
  })
  it('orders everything else like d3', () => {
    expect(ascending(1, 2)).toBe(-1)
    expect(ascending(2, 1)).toBe(1)
    expect(ascending(2, 2)).toBe(0)
    expect(ascending(NaN, 1)).toBeNaN()
    expect(descending(1, 2)).toBe(1)
    expect(descending('b', 'a')).toBe(-1)
    // 0 < null would be true under JS coercion; the guard is what keeps null out of an ordering
    expect(ascending(-1, null)).toBeNaN()
  })
})

describe('the scale registry (C95)', () => {
  it('identity carries no metadata (upstream registers none)', () => {
    const ctor = scale('identity') as unknown as { metadata: Record<string, boolean> }
    expect(Object.keys(ctor.metadata)).toEqual([])
    expect(isContinuous('identity')).toBeFalsy()
    expect(isDiscrete('identity')).toBeFalsy()
    expect(isInterpolating('identity')).toBeFalsy()
  })
  it('every interpolator vega-scale can name resolves (hcl used to be undefined)', () => {
    for (const name of ['rgb', 'hsl', 'hsl-long', 'lab', 'hcl', 'hcl-long', 'cubehelix', 'cubehelix-long', 'rgb-basis', 'rgb-basis-closed',
      'basis', 'basis-closed', 'hue', 'number', 'round', 'string', 'date', 'array', 'number-array', 'object', 'discrete', 'zoom']) {
      expect(typeof interpolate(name), name).toBe('function')
    }
    expect(interpolate('bogus')).toBeUndefined()
  })
  it('gamma applies to the interpolators that take one, and only those', () => {
    const rgbGamma = (interpolate('rgb', 2) as (a: string, b: string) => (t: number) => string)('#000000', '#ffffff')
    const rgbLinear = (interpolate('rgb') as (a: string, b: string) => (t: number) => string)('#000000', '#ffffff')
    expect(rgbGamma(0.5)).not.toBe(rgbLinear(0.5))
    expect(interpolate('hcl', 2)).toBe(interpolate('hcl'))
  })
})

describe('geo: the projection path owns pointRadius (C95)', () => {
  it('the radius lands on the bound path; the projection has no pointRadius of its own', () => {
    const p = buildProjection({ name: 'p', type: 'mercator', pointRadius: 7 })
    expect(p.path.pointRadius()).toBe(7)
    expect(typeof p.pointRadius).toBe('undefined')
    expect(buildProjection({ name: 'p', type: 'mercator' }).path.pointRadius()).toBe(4.5)
  })
  it('a point is drawn as a circle of that radius', () => {
    const d = buildProjection({ name: 'p', type: 'identity', pointRadius: 3 }).path({ type: 'Point', coordinates: [10, 20] }) as string
    expect(d).toContain('a3,3')
  })
})
