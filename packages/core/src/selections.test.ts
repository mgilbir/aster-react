import { describe, expect, it } from 'vitest'
import { selectionResolve, selectionTest } from './selections.js'

describe('selection functions (properties the live differentials cannot reach)', () => {
  it('a field definition whose type changes between tests is read with its new type', () => {
    const def = { field: 'a', type: 'E-LT' }
    const rows: Array<{ unit: string; fields: Array<{ field: string; type: string }>; values: unknown[] }> = [{ unit: '', fields: [def], values: [5] }]
    expect(selectionTest(rows, { a: 3 })).toBe(true)
    def.type = 'E-GT'
    expect(selectionTest(rows, { a: 3 })).toBe(false)
    def.field = 'a'
    def.type = 'R'
    rows[0]!.values = [[1, 4]]
    expect(selectionTest(rows, { a: 3 })).toBe(true)
  })

  it('a unit or field called __proto__ is data, and Object.prototype stays clean', () => {
    const rows = [
      { unit: '__proto__', fields: [{ field: '__proto__', type: 'E' }], values: ['x'] },
      { unit: 'u', fields: [{ field: '__proto__', type: 'E' }], values: ['y'] },
    ]
    const out = selectionResolve(rows, 'union', true)
    expect(Object.keys(out)).toContain('__proto__')
    expect(({} as Record<string, unknown>).x).toBeUndefined()
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })

  it('a store is not rewritten by resolve', () => {
    const values = ['x', 'y']
    const rows = [
      { unit: 'u1', fields: [{ field: 'a', type: 'E' }], values: [values] },
      { unit: 'u2', fields: [{ field: 'a', type: 'E' }], values: [['z']] },
    ]
    selectionResolve(rows, 'union')
    expect(values).toEqual(['x', 'y'])
  })
})
