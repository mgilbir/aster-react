// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readData } from './data-format.js'
import { renderSpec } from './index.js'
import type { VgSpec } from './types.js'

// The rows a spec carries inline (and that a compiled Vega-Lite spec hands through as the user's own) belong to the caller:
// reading them never writes to the array or to a row.
describe('reading inline rows leaves the caller\'s array as it is', () => {
  const annotated = (): Array<Record<string, unknown>> => {
    const rows = [{ a: 1 }, { a: 2 }] as Array<Record<string, unknown>> & { columns?: string[] }
    rows.columns = ['a'] // the d3-dsv annotation vega-loader's read drops
    return Object.freeze(rows) as Array<Record<string, unknown>>
  }

  it('readData drops the `columns` annotation from what it returns, not from the caller\'s array', () => {
    const rows = annotated()
    const out = readData(rows, { type: 'json' })
    expect(Object.hasOwn(out, 'columns')).toBe(false)
    expect(out).toEqual([{ a: 1 }, { a: 2 }])
    expect((rows as { columns?: unknown }).columns).toEqual(['a'])
  })

  it('a spec whose inline values carry `columns` renders from a frozen array', () => {
    const values = annotated()
    const spec = { width: 20, height: 20, data: [{ name: 't', values }], marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { field: 'a' }, width: { value: 1 }, height: { value: 1 } } } }] } as unknown as VgSpec
    expect(() => renderSpec(spec)).not.toThrow()
    expect((values as { columns?: unknown }).columns).toEqual(['a'])
  })
})
