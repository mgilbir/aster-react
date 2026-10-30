import { describe, expect, it } from 'vitest'
import { resquarified, squarified } from './treemap-tiling.js'
import type { HierNode } from './transform.js'

const parentOf = (values: number[]): HierNode => {
  const children = values.map((value) => ({ value, children: [] as HierNode[], depth: 1 } as unknown as HierNode))
  return { value: values.reduce((a, b) => a + b, 0), children, depth: 0 } as unknown as HierNode
}
const boxes = (p: HierNode): string[] => p.children.map((c) => [c.x0, c.y0, c.x1, c.y1].map((n) => n!.toFixed(4)).join(','))
const VALUES = [6, 6, 4, 3, 2, 2, 1]

describe('resquarified', () => {
  const landscape = [0, 0, 600, 400] as const
  const portrait = [0, 0, 100, 700] as const
  const fresh = (box: readonly number[]): string[] => { const p = parentOf(VALUES); squarified(1.618)(p, ...(box as [number, number, number, number])); return boxes(p) }

  it('the two shapes are laid out differently by a fresh squarify (so the test can tell a replay from a new layout)', () => {
    expect(fresh(landscape)).not.toEqual(fresh(portrait))
  })

  it('replays the rows of its first layout in a new rectangle, instead of squarifying again', () => {
    const p = parentOf(VALUES)
    const tile = resquarified(1.618)
    tile(p, ...landscape)
    expect(boxes(p)).toEqual(fresh(landscape))
    tile(p, ...portrait)
    expect(boxes(p)).not.toEqual(fresh(portrait))
    // the rows are the same groups of children, stretched: children that shared a row's edge still do
    const first = parentOf(VALUES)
    squarified(1.618)(first, ...landscape)
    for (let i = 0; i < VALUES.length; ++i) {
      for (let j = i + 1; j < VALUES.length; ++j) {
        const sameRowBefore = first.children[i]!.y0 === first.children[j]!.y0 && first.children[i]!.y1 === first.children[j]!.y1
        const sameRowAfter = p.children[i]!.y0 === p.children[j]!.y0 && p.children[i]!.y1 === p.children[j]!.y1
        expect(sameRowAfter).toBe(sameRowBefore)
      }
    }
  })

  it('starts afresh for a different ratio, and squarified keeps no rows', () => {
    const p = parentOf(VALUES)
    resquarified(1.618)(p, ...landscape)
    resquarified(3)(p, ...portrait)
    const q = parentOf(VALUES)
    squarified(3)(q, ...portrait)
    expect(boxes(p)).toEqual(boxes(q))
    const r = parentOf(VALUES)
    const sq = squarified(1.618)
    sq(r, ...landscape)
    sq(r, ...portrait)
    expect(boxes(r)).toEqual(fresh(portrait))
  })
})
