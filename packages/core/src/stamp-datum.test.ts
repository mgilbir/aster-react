import { describe, expect, it } from 'vitest'
import { stampDatumAttrs } from './signals.js'
import type { SceneGroup, SceneItem } from './types.js'

const stamped = (datum: unknown): string | undefined => {
  const item = { datum } as unknown as SceneItem
  stampDatumAttrs([{ marktype: 'rect', items: [item] } as unknown as SceneGroup])
  return (item as unknown as { dataDatum?: string }).dataDatum
}

describe('stampDatumAttrs', () => {
  it('writes the datum as JSON', () => {
    expect(stamped({ a: 1, b: [2, { c: 'x' }] })).toBe('{"a":1,"b":[2,{"c":"x"}]}')
  })

  it('a datum that holds itself (joinaggregate ops: ["values"]) is stamped with the references that close the circle left out (null in an array)', () => {
    const row: Record<string, unknown> = { k: 'a', v: 1 }
    const other: Record<string, unknown> = { k: 'a', v: 2 }
    row.group = [row, other]
    other.group = row.group
    expect(stamped(row)).toBe('{"k":"a","v":1,"group":[null,{"k":"a","v":2}]}')
  })

  it('a value used twice (not a cycle) is written both times', () => {
    const shared = { n: 1 }
    expect(stamped({ a: shared, b: shared })).toBe('{"a":{"n":1},"b":{"n":1}}')
  })
})
