/**
 * Mark geometry against real vega: see geometry-oracle.ts for what is compared and how items are named.
 */
import { describe, expect, it } from 'vitest'
import { Bounds, itemBounds } from '../../core/src/bounds.js'
import type { SceneItem } from '../../core/src/types.js'
import { genItem, rng } from './geometry-specs.js'
import { boxText, sameBox } from './geometry-keys.js'
import { V, compareSpec, type Counts } from './geometry-oracle.js'

type Box = { x1: number; y1: number; x2: number; y2: number }

describe('item bounds: vega\'s mark bound against Aster\'s itemBounds, hand-built items of every mark type', () => {
  for (const type of ['rect', 'symbol', 'arc', 'rule', 'text', 'path', 'image']) {
    it(`${type}: 4000 items, the wild value classes in every channel, bit for bit`, () => {
      const diffs: string[] = []
      let compared = 0
      for (let s = 1; s <= 4000; s++) {
        const item = genItem(rng(s * 31 + type.length), type)
        let want: Box
        try { want = V.Marks[type]!.bound(new V.Bounds(), { ...item, mark: { marktype: type, items: [] } }) } catch { continue }
        const got = itemBounds(new Bounds(), type, { ...item } as SceneItem)
        compared++
        if (!sameBox(want, got) && diffs.length < 8) diffs.push(`${JSON.stringify(item, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v === undefined ? 'undefined' : v))}: vega ${boxText(want)} aster ${boxText(got)}`)
      }
      expect(diffs).toEqual([])
      expect(compared).toBeGreaterThan(3900)
    })
  }
})

/** [from, to] in runs of `size`: each run is its own test, so no test holds the worker for long. */
const runs = (from: number, to: number, size: number): Array<[number, number]> => {
  const out: Array<[number, number]> = []
  for (let a = from; a <= to; a += size) out.push([a, Math.min(to, a + size - 1)])
  return out
}

describe('generated specs: bounds, the view, intersect() against vega', () => {
  for (const [lo, hi] of runs(1, 400, 50)) {
    it(`seeds ${lo}-${hi}`, async () => {
      const counts: Counts = { specs: 0, crashes: 0, items: 0, marks: 0, groups: 0, boxes: 0, hits: 0, refused: 0 }
      const diffs: string[] = []
      for (let seed = lo; seed <= hi; seed++) await compareSpec(seed, counts, diffs)
      expect(diffs.slice(0, 30)).toEqual([])
      // what was compared: most specs run in vega; their items, marks, group items and boxes; and the boxes find something
      expect(counts.specs).toBeGreaterThan(0.9 * (hi - lo + 1))
      expect(counts.items).toBeGreaterThan(20 * (hi - lo + 1))
      expect(counts.marks).toBeGreaterThan(3 * (hi - lo + 1))
      expect(counts.groups).toBeGreaterThan(hi - lo + 1)
      expect(counts.hits).toBeGreaterThan(5 * (hi - lo + 1))
    }, 120_000)
  }
})
