import { describe, expect, it } from 'vitest'
import { QuadTree, type Cell } from './quadtree.js'

interface P { x: number; y: number; name: string }
const tree = (pts: Array<[number, number, string]>): QuadTree<P> =>
  new QuadTree<P>(pts.map(([x, y, name]) => ({ x, y, name })), (p) => p.x, (p) => p.y)
/** The visit order as `name@x0,y0,x1,y1` (a branch is `*`). */
const visits = (t: QuadTree<P>): string[] => {
  const out: string[] = []
  t.walk((c, x0, y0, x1, y1) => { out.push(`${c.body ? c.body.name : '*'}@${x0},${y0},${x1},${y1}`) })
  return out
}
const chain = (c: Cell<P>): string[] => { const out: string[] = []; for (let l: Cell<P> | null = c; l; l = l.next) out.push(l.body!.name); return out }

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
    t.walk((c) => { if (c.body) heads.push(chain(c).join('>')) })
    expect(heads).toEqual(['third>second>first', 'far'])
    const seen: string[] = []
    t.walk((c) => { seen.push(c.body ? c.body.name : '*'); return !c.body }) // skip everything below the root
    expect(seen).toEqual(['*'])
  })

  it('splits close points down to where they separate, and visits a post-order from the leaves up', () => {
    const t = tree([[1, 1, 'a'], [1.001, 1, 'b'], [20, 20, 'c']])
    const up: string[] = []
    t.walkUp((c) => { up.push(c.body ? c.body.name : '*') })
    expect(up[up.length - 1]).toBe('*')
    expect(up.filter((u) => u !== '*').sort()).toEqual(['a', 'b', 'c'])
    // every branch comes after the cells below it
    expect(up.indexOf('a')).toBeLessThan(up.indexOf('*'))
  })

  it('leaves out a body whose point is not a finite number', () => {
    const t = tree([[NaN, 1, 'nan'], [1, Infinity, 'inf'], [-Infinity, 0, 'minf'], [3, 4, 'ok']])
    expect(visits(t)).toEqual(['ok@3,4,4,5'])
    expect(visits(tree([[NaN, NaN, 'x']]))).toEqual([])
  })

  it('terminates on points so large that the root square overflows', () => {
    const t = tree([[1.7e308, 0, 'a'], [1.6e308, 0, 'b']])
    const names: string[] = []
    t.walk((c) => { if (c.body) names.push(...chain(c)) })
    expect(names.sort()).toEqual(['a', 'b'])
  })
})
