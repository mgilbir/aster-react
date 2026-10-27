import { describe, it, expect } from 'vitest'
import { compile } from '../src/index.js'

const DATA = { values: [{ a: 1, b: 3, c: 'x' }, { a: 2, b: 5, c: 'y' }] }
const xy = { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' } }
const unit = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ width: 100, height: 80, mark: 'point', encoding: xy, ...extra })
const names = (list: unknown): string[] => ((list as Array<{ name: string }> | undefined) ?? []).map((s) => s.name)
const compiled = (spec: Record<string, unknown>): any => compile(spec as never)

describe('selections inside concat, facet and repeat views are the group scopes\' signals', () => {
  it('a concat unit declares its signals in its group, and the selection\'s own at the root', () => {
    const vg = compiled({ data: DATA, hconcat: [unit({ params: [{ name: 'brush', select: 'interval' }] }), unit({ transform: [{ filter: { param: 'brush' } }] })] })
    expect(names(vg.signals)).toEqual(['childWidth', 'unit', 'brush'])
    expect(names(vg.marks[0].signals)).toContain('brush_x')
    expect(names(vg.marks[0].signals)).toContain('brush_modify')
    expect(vg.marks[1].signals).toBeUndefined()
    expect(vg.data.filter((d: any) => d.name === 'brush_store')).toHaveLength(1)
    // the brush marks are the selection's, named after it, not after the view
    expect(vg.marks[0].marks.map((m: any) => m.name)).toEqual(['brush_brush_bg', 'concat_0_marks', 'brush_brush'])
    // the unit's name is the view's
    expect(JSON.stringify(vg.marks[0].signals)).toContain('unit: \\"concat_0\\"')
  })

  it('a selection declared on the composition is given to every unit below it, once each, with one store', () => {
    const vg = compiled({ data: DATA, params: [{ name: 'brush', select: 'interval' }], hconcat: [unit(), unit()] })
    expect(names(vg.marks[0].signals)).toContain('brush_x')
    expect(names(vg.marks[1].signals)).toContain('brush_x')
    expect(vg.data.filter((d: any) => d.name === 'brush_store')).toHaveLength(1)
    expect(names(vg.signals).filter((n) => n === 'brush')).toHaveLength(1)
    expect(JSON.stringify(vg.marks[1].signals)).toContain('unit: \\"concat_1\\"')
  })

  it('a facet\'s cells declare the signals, with the facet signal first and the cell in the unit name', () => {
    const vg = compiled({ data: DATA, facet: { column: { field: 'c', type: 'nominal' } }, spec: unit({ params: [{ name: 'pick', select: 'point' }] }) })
    const cell = vg.marks.find((m: any) => m.name === 'cell')
    expect(names(cell.signals)[0]).toBe('facet')
    expect(JSON.stringify(cell.signals)).toContain('child\\" + \'__facet_column_\' + (facet[\\"c\\"])')
    expect(cell.signals[0].on[0].update).toBe('isTuple(facet) ? facet : group("cell").datum')
  })

  it('a repeated view declares its own copy, sharing one store; bound scales push to the view\'s signals', () => {
    const vg = compiled({ data: DATA, repeat: { column: ['a', 'b'] }, spec: unit({ params: [{ name: 'grid', select: 'interval', bind: 'scales' }], encoding: { x: { field: { repeat: 'column' }, type: 'quantitative' }, y: { field: 'b', type: 'quantitative' } } }) })
    expect(vg.data.filter((d: any) => d.name === 'grid_store')).toHaveLength(1)
    for (const g of vg.marks) {
      const pushed = (g.signals as any[]).filter((s) => s.push === 'outer')
      expect(pushed.length).toBeGreaterThan(0)
      for (const s of pushed) { expect(s.value).toBeUndefined(); expect(s.update).toBeUndefined() }
    }
    // the view's own signals: the ones the units push to, and the named selection assembled from them
    expect(names(vg.signals)).toEqual(expect.arrayContaining(['grid_a', 'grid_b', 'grid']))
    expect(vg.signals.find((s: any) => s.name === 'grid').update).toMatch(/^\{.*"a": grid_a/)
  })

  it('a unit that no selection touches is not interactive unless some unit of the view declares one', () => {
    const plain = compiled({ data: DATA, hconcat: [unit(), unit()] })
    expect(plain.marks[0].marks.some((m: any) => m.interactive === false)).toBe(false)
    const withSel = compiled({ data: DATA, hconcat: [unit({ params: [{ name: 'brush', select: 'interval' }] }), unit()] })
    expect(withSel.marks[1].marks.find((m: any) => /marks$/.test(m.name)).interactive).toBe(false)
  })
})
