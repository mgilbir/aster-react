// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { compile } from '../src/index.js'

// Issue #135: layers that sort a shared scale differently are refused (vega-lite only warns and picks one); the error names
// each layer (or view), its mark, and the sort it ended up with, which the spec may never write: a sort written once in a shared
// encoding gets each layer's default `op` (a bar sums, a text takes the minimum).
const enc = { y: { field: 'label', type: 'ordinal', sort: { field: 'order' } }, x: { field: 'count', type: 'quantitative' } }
const text = { mark: 'text', encoding: { text: { field: 'count', type: 'quantitative' } } }
const message = (spec: unknown): string => {
  try {
    compile(spec as never)
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('the spec compiled')
}

describe('layers that sort a shared scale differently (#135)', () => {
  it('names each layer, its mark and its sort, and says when only the op differs', () => {
    expect(message({ data: { name: 'values' }, encoding: enc, layer: [{ mark: 'bar' }, text] })).toBe(
      '[aster/vl] layers sort the shared scale "y" differently: layer 0 (bar) {"op":"sum","field":"order"}, '
      + 'layer 1 (text) {"op":"min","field":"order"}; they differ only in "op": give the sort an explicit "op"',
    )
  })

  it('an explicit op, as the message suggests, compiles', () => {
    const y = { ...enc.y, sort: { field: 'order', op: 'min' } }
    expect(() => compile({ data: { name: 'values' }, encoding: { ...enc, y }, layer: [{ mark: 'bar' }, text] } as never)).not.toThrow()
  })

  it('a nested layer is named by its path', () => {
    expect(message({ data: { name: 'values' }, encoding: enc, layer: [{ mark: 'bar' }, { layer: [{ mark: 'point' }, text] }] })).toContain(
      'layer 0 (bar) {"op":"sum","field":"order"}, layer 1.0 (point) {"op":"min","field":"order"}, layer 1.1 (text) {"op":"min","field":"order"}',
    )
  })

  it('sorts by different fields get no op hint', () => {
    const by = (field: string) => ({ mark: 'bar', encoding: { ...enc, y: { ...enc.y, sort: { field, op: 'sum' } } } })
    const m = message({ data: { name: 'values' }, layer: [by('order'), by('rank')] })
    expect(m).toBe('[aster/vl] layers sort the shared scale "y" differently: layer 0 (bar) {"op":"sum","field":"order"}, layer 1 (bar) {"op":"sum","field":"rank"}')
  })

  it('the views of a composition sharing a scale are named as views', () => {
    const by = (op: string) => ({ mark: 'bar', encoding: { ...enc, y: { ...enc.y, sort: { field: 'order', op } } } })
    expect(message({ data: { name: 'values' }, resolve: { scale: { y: 'shared' } }, hconcat: [by('sum'), by('max')] })).toBe(
      '[aster/vl] views sort the shared scale "y" differently: view concat_0 {"op":"sum","field":"order"}, '
      + 'view concat_1 {"op":"max","field":"order"}; they differ only in "op": give the sort an explicit "op"',
    )
  })

  it('a sort of any size is cut in the message', () => {
    const long = 'f'.repeat(1000)
    const by = (field: string) => ({ mark: 'bar', encoding: { ...enc, y: { ...enc.y, sort: { field, op: 'sum' } } } })
    const m = message({ data: { name: 'values' }, layer: [by(long), by('order')] })
    expect(m.length).toBeLessThan(400)
    expect(m).toContain('…')
  })
})
