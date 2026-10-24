// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DATA, cn, yq, compileFrozen } from './helpers.js'

const v = { field: 'v', type: 'quantitative' }
const eb = (mark: unknown, encoding: unknown = { x: cn, y: v }) => compileFrozen({ data: DATA, mark, encoding })
const transform = (vg: any): any[] => vg.data.find((d: any) => d.name === 'data_0').transform
const aggregate = (vg: any): any => vg.data.flatMap((d: any) => d.transform ?? []).find((t: any) => t.type === 'aggregate')
const styles = (vg: any): string[] => {
  const out: string[] = []
  const walk = (m: any): void => (m.type === 'group' ? m.marks.forEach(walk) : out.push(m.style.join(',')))
  vg.marks.forEach(walk)
  return out
}

describe('errorbar (vega-lite compositemark/errorbar.ts)', () => {
  it('defaults to the mean and its standard error, drawn as a rule', () => {
    const vg = eb('errorbar')
    expect(aggregate(vg)).toMatchObject({ groupby: ['c'], ops: ['stderr', 'mean'], fields: ['v', 'v'] })
    const calcs = transform(vg).filter((t) => t.type === 'formula' && /upper_v|lower_v/.test(t.as))
    expect(calcs.map((c: any) => c.as).sort()).toEqual(['lower_v', 'upper_v'])
    expect(styles(vg).join()).toContain('errorbar-rule')
    expect(vg.marks[0].type).toBe('rule')
  })

  it('emits the Vega aggregate for the ci, stdev and iqr extents', () => {
    expect(aggregate(eb({ type: 'errorbar', extent: 'ci' })).ops).toEqual(['ci0', 'ci1', 'mean'])
    expect(aggregate(eb({ type: 'errorbar', extent: 'stdev' })).ops).toEqual(['stdev', 'mean'])
    expect(aggregate(eb({ type: 'errorbar', extent: 'iqr' })).ops).toEqual(['q1', 'q3', 'median'])
  })

  it('draws ticks on request, with the part and mark options', () => {
    const vg = eb({ type: 'errorbar', ticks: { size: 9 }, thickness: 3, color: 'teal' })
    const kinds = styles(vg)
    expect(kinds.filter((s) => s === 'tick,errorbar-ticks').length).toBe(2)
    expect(kinds).toContain('rule,errorbar-rule')
  })

  it('takes pre-aggregated bounds or error sizes without aggregating', () => {
    const ul = eb('errorbar', { x: cn, y: { field: 'x', type: 'quantitative' }, y2: { field: 'y' } })
    expect(aggregate(ul)).toBeUndefined()
    const err = eb('errorbar', { x: cn, y: v, yError: { field: 'x' } })
    expect(transform(err).find((t) => t.as === 'upper_v').expr).toBe('datum["v"] + datum["x"]')
    expect(transform(err).find((t) => t.as === 'lower_v').expr).toBe('datum["v"] - datum["x"]')
  })

  it('is horizontal when x is the continuous axis', () => {
    const vg = eb('errorbar', { y: cn, x: v })
    expect(vg.scales.find((s: any) => s.name === 'x').type).toBe('linear')
    expect(vg.marks[0].encode.update.x2).toBeDefined()
  })

  it('works inside a layer and over a time unit', () => {
    const layered = compileFrozen({ data: DATA, layer: [{ mark: 'errorbar', encoding: { x: cn, y: v } }, { mark: 'point', encoding: { x: cn, y: { ...v, aggregate: 'mean' } } }] })
    expect(layered.marks.length).toBe(2)
    const tu = eb('errorbar', { x: { field: 't', type: 'temporal', timeUnit: 'month' }, y: v })
    expect(transform(tu).some((t) => t.type === 'timeunit')).toBe(true)
  })

  it('rejects a binned channel it cannot unfold', () => {
    expect(() => eb('errorbar', { x: { field: 'x', type: 'quantitative', bin: true }, y: v })).toThrow(/binned/)
  })
})

describe('errorband (vega-lite compositemark/errorband.ts)', () => {
  it('is a rect band over one axis and an area with borders over two', () => {
    expect(eb('errorband', { y: v }).marks[0].type).toBe('rect')
    const two = eb({ type: 'errorband', borders: true }, { x: { field: 'x', type: 'quantitative' }, y: v })
    expect(styles(two)).toEqual(['area,errorband-band', 'line,errorband-borders', 'line,errorband-borders'])
  })
  it('uses the errorbar center by default and a translucent band', () => {
    const vg = eb('errorband', { x: { field: 'x', type: 'quantitative' }, y: v })
    expect(aggregate(vg).ops).toEqual(['stderr', 'mean'])
    expect(vg.marks[0].encode.update.opacity).toEqual({ value: 0.3 })
  })
})
