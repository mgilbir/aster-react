// @vitest-environment node
/**
 * The id of a group item's signal scope and its key path hold the keys of the items above it, which come from the data: keys that
 * hold the characters the ids join their parts with must not make two items' ids one (C383): `a]/7[b` over `c`, and `a` over
 * `b]/7[c`, were both `.../7[a]/7[b]/7[c]`, so the two cells shared their scope signals' state.
 */
import { describe, expect, it } from 'vitest'
import { compileChart, evaluateChart, type SceneGroup, type VgSpec } from './index.js'

const spec = (rows: unknown[]): VgSpec => ({
  width: 100, height: 100, data: [{ name: 't', values: rows }],
  marks: [{
    type: 'group', from: { facet: { data: 't', name: 'f1', groupby: 'k1' } }, signals: [{ name: 'outer', value: 1 }],
    marks: [{ type: 'group', from: { facet: { data: 'f1', name: 'f2', groupby: 'k2' } }, signals: [{ name: 'inner', value: 2 }], marks: [] }],
  }],
}) as unknown as VgSpec

function ids(node: { items?: unknown[] }, out: string[] = []): string[] {
  for (const n of (node.items ?? []) as SceneGroup[]) {
    if (n.scopeSignals) out.push(n.scopeSignals.id)
    if (Array.isArray(n.items)) ids(n, out)
  }
  return out
}

describe('scope ids and key paths over keys that hold their separators (C383)', () => {
  // (the inner group mark is the outer's mark 0: its items' ids end `/@1[<key>]`)
  for (const [outer1, inner1, outer2, inner2] of [['a]/@1[b', 'c', 'a', 'b]/@1[c'], ['x]/@1[', 'y', 'x', ']/@1[y'], ['p', 'q]/@1[r', 'p]/@1[q', 'r']]) {
    it(`${JSON.stringify(outer1)} over ${JSON.stringify(inner1)} against ${JSON.stringify(outer2)} over ${JSON.stringify(inner2)}`, () => {
      const rows = [{ k1: outer1, k2: inner1 }, { k1: outer2, k2: inner2 }]
      const all = ids(evaluateChart(compileChart(spec(rows))))
      expect(all.length).toBe(4)
      expect(new Set(all).size).toBe(4)
    })
  }
  it('a key without separators is written as it is', () => {
    expect(ids(evaluateChart(compileChart(spec([{ k1: 'plain', k2: 'key' }])))).some((id) => id.includes('[plain]'))).toBe(true)
  })
})
