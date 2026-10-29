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

// The messages a composite mark's refusals show are Aster's own text (the rewrite of composite marks must keep them).
describe('composite marks refuse with their own messages', () => {
  const q = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'quantitative', ...extra })
  const n = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'nominal', ...extra })
  const refusals: Array<[string, unknown, Record<string, unknown>, RegExp]> = [
    ['a boxplot over two discrete axes', 'boxplot', { x: n('c'), y: n('g') }, /^\[aster\/vl\] boxplot needs a continuous x or y axis$/],
    ['an errorbar over two discrete axes', 'errorbar', { x: n('c'), y: n('g') }, /^\[aster\/vl\] errorbar needs a continuous x or y axis$/],
    ['an errorband with x2 and y2', 'errorband', { x: q('x'), x2: { field: 'v' }, y: q('v'), y2: { field: 'w' } }, /^\[aster\/vl\] errorband cannot have both x2 and y2$/],
    ['an errorbar with y2 over a nominal y', 'errorbar', { x: n('c'), y: n('g'), y2: { field: 'v' } }, /^\[aster\/vl\] both y and y2 have to be quantitative in errorbar$/],
    ['an errorbar with x2 over a nominal x', 'errorbar', { x: n('c'), x2: { field: 'v' } }, /^\[aster\/vl\] both x and x2 have to be quantitative in errorbar$/],
    ['an errorbar with y2 and an error', 'errorbar', { x: n('c'), y: q('v'), y2: { field: 'w' }, yError: { field: 'x' } }, /^\[aster\/vl\] errorbar cannot be both aggregated-upper-lower and aggregated-error$/],
    ['an errorbar with xError2 alone', 'errorbar', { y: n('c'), x: q('v'), xError2: { field: 'x' } }, /^\[aster\/vl\] errorbar cannot have xError2 without xError$/],
    ['an errorbar with yError2 alone', 'errorbar', { x: n('c'), y: q('v'), yError2: { field: 'x' } }, /^\[aster\/vl\] errorbar cannot have yError2 without yError$/],
    ['an errorbar with xError and yError', 'errorbar', { x: q('x'), xError: { field: 'v' }, y: q('v'), yError: { field: 'w' } }, /^\[aster\/vl\] errorbar cannot have both xError and yError$/],
    ['an errorbar with xError over a nominal x', 'errorbar', { x: n('c'), y: q('v'), xError: { field: 'x' } }, /^\[aster\/vl\] x, xError and xError2 have to be quantitative$/],
    ['an errorbar with yError over a nominal y', 'errorbar', { y: n('c'), x: q('v'), yError: { field: 'x' } }, /^\[aster\/vl\] y, yError and yError2 have to be quantitative$/],
    ['a boxplot over a binned dimension', 'boxplot', { x: q('x', { bin: true }), y: q('v') }, /^\[aster\/vl\] boxplot over a binned x channel is not supported$/],
    ['a boxplot with an argmax colour', 'boxplot', { x: n('c'), y: q('v'), color: n('g', { aggregate: { argmax: 'v' } }) }, /^\[aster\/vl\] boxplot: argmin\/argmax on color is not supported$/],
    ['a boxplot with a negative extent', { type: 'boxplot', extent: -1 }, { x: n('c'), y: q('v') }, /^\[aster\/vl\] mark\.extent must be a non-negative number or "min-max", got -1$/],
    ['a boxplot with no field on the continuous axis', 'boxplot', { x: n('c'), y: { aggregate: 'count', type: 'quantitative' } }, /^\[aster\/vl\] boxplot: the y channel needs a field$/],
    ['a boxplot told its orient with no channel on it', { type: 'boxplot', orient: 'vertical' }, { x: n('c') }, /^\[aster\/vl\] boxplot: the y channel needs a field$/],
  ]
  for (const [name, mark, encoding, message] of refusals) {
    it(name, () => {
      expect(() => compileFrozen({ data: DATA, mark, encoding })).toThrow(message)
    })
  }
})
