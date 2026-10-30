import { describe, expect, it } from 'vitest'
import { buildQuadTree, NO_CELL, type QuadTree } from './quadtree.js'

type Pt = [number, number, string]
const names: string[] = []
const tree = (pts: Pt[]): QuadTree => {
  names.length = 0
  names.push(...pts.map((p) => p[2]))
  return buildQuadTree(pts, (p) => p[0], (p) => p[1])
}
const nameOf = (t: QuadTree, cell: number): string => (t.body[cell]! >= 0 ? names[t.body[cell]!]! : '*')
/** The visit order as `name@x0,y0,x1,y1` (a branch is `*`). */
const visits = (t: QuadTree): string[] => {
  const out: string[] = []
  t.walk((c, x0, y0, x1, y1) => { out.push(`${nameOf(t, c)}@${x0},${y0},${x1},${y1}`) })
  return out
}
const chainOf = (t: QuadTree, cell: number): string[] => {
  const out: string[] = []
  for (let c = cell; c !== NO_CELL; c = t.chain[c]!) out.push(nameOf(t, c))
  return out
}

describe('QuadTree', () => {
  it('starts at the integer corner of the lowest point and doubles to cover the highest', () => {
    expect(visits(tree([[0.5, 0.5, 'a']]))).toEqual(['a@0,0,1,1'])
    expect(visits(tree([[0.5, 0.5, 'a'], [3.2, 7.9, 'b']])).slice(0, 1)).toEqual(['*@0,0,8,8'])
    expect(visits(tree([[-2.5, 4, 'a'], [-2.5, 4.5, 'b']])).slice(0, 1)).toEqual(['*@-3,4,-2,5'])
  })

  it('visits the quadrants top-left, top-right, bottom-left, bottom-right, each before the next', () => {
    const t = tree([[7, 7, 'br'], [1, 1, 'tl'], [1, 7, 'bl'], [7, 1, 'tr']])
    expect(visits(t)).toEqual(['*@1,1,9,9', 'tl@1,1,5,5', 'tr@5,1,9,5', 'bl@1,5,5,9', 'br@5,5,9,9'])
  })

  it('chains bodies on exactly the same point, the newest first, and skips children when asked', () => {
    const t = tree([[2, 2, 'first'], [2, 2, 'second'], [9, 9, 'far'], [2, 2, 'third']])
    const heads: string[] = []
    t.walk((c) => { if (t.body[c]! >= 0) heads.push(chainOf(t, c).join('>')) })
    expect(heads).toEqual(['third>second>first', 'far'])
    const seen: string[] = []
    t.walk((c) => { seen.push(nameOf(t, c)); return t.body[c]! < 0 }) // skip everything below the root
    expect(seen).toEqual(['*'])
  })

  it('splits close points down to where they separate, and walks up from the leaves', () => {
    const t = tree([[1, 1, 'a'], [1.001, 1, 'b'], [20, 20, 'c']])
    const up: string[] = []
    t.walkUp((c) => { up.push(nameOf(t, c)) })
    expect(up[up.length - 1]).toBe('*')
    expect(up.filter((u) => u !== '*').sort()).toEqual(['a', 'b', 'c'])
    // every branch comes after the cells below it
    const seenCells = new Set<number>()
    t.walkUp((c) => {
      if (t.body[c]! < 0) for (let k = 0; k < 4; ++k) { const q = t.quad[c * 4 + k]!; if (q !== NO_CELL) expect(seenCells.has(q)).toBe(true) }
      seenCells.add(c)
    })
    expect(seenCells.size).toBe(t.size)
  })

  it('grows its cell storage past the first guess', () => {
    const pts: Pt[] = Array.from({ length: 300 }, (_, i) => [(i * 37) % 101 + (i % 7) / 8, (i * 53) % 97 + (i % 5) / 8, 'p' + i])
    const t = tree(pts)
    let leaves = 0
    t.walk((c) => { if (t.body[c]! >= 0) leaves += chainOf(t, c).length })
    expect(leaves).toBe(300)
  })

  it('leaves out a body whose point is not a finite number', () => {
    const t = tree([[NaN, 1, 'nan'], [1, Infinity, 'inf'], [-Infinity, 0, 'minf'], [3, 4, 'ok']])
    expect(visits(t)).toEqual(['ok@3,4,4,5'])
    expect(visits(tree([[NaN, NaN, 'x']]))).toEqual([])
  })

  it('terminates on points so large that the root square overflows', () => {
    const t = tree([[1.7e308, 0, 'a'], [1.6e308, 0, 'b']])
    const found: string[] = []
    t.walk((c) => { if (t.body[c]! >= 0) found.push(...chainOf(t, c)) })
    expect(found.sort()).toEqual(['a', 'b'])
  })
})
