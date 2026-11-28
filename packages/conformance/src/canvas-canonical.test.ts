/**
 * The canonical form of a canvas drawing takes a stroke or fill of several circles for those circles one by one only where no two
 * painted boxes meet, and a circle has no corner for a join to miter: the batches of core's overlap-batch.ts, which keep a pixel and a
 * half of stroke reach between their members, are seen through; circles that meet are not.
 */
import { describe, expect, it } from 'vitest'
import { canonicalPaints } from './canvas-canonical.js'
import type { Painted } from './canvas-recorder.js'

const circle = (cx: number, cy: number, r: number): string => `M${cx + r},${cy} O${cx},${cy},${r},+`
const state = 'alpha=0.5 blend=source-over width=1.5 cap=butt join=miter miter=4'
const stroke = (path: string): Painted => ({ op: 'stroke', style: '#222', path, state }) as Painted

describe('canonicalPaints: a batch of circles', () => {
  const circles = (...xs: number[]): number[][] => xs.map((x) => [x, 30, 4])
  const batch = (...xs: number[]): string[] => canonicalPaints([stroke(circles(...xs).map(([x, y, r]) => circle(x!, y!, r!)).join(' '))])
  const each = (...xs: number[]): string[] => canonicalPaints(circles(...xs).map(([x, y, r]) => stroke(circle(x!, y!, r!))))

  it('is its circles when they are apart', () => {
    expect(batch(20, 40, 70)).toEqual(each(20, 40, 70))
  })
  it('is its circles from the gap their stroke and a pixel leave (4 + 4 + 2 * (0.75 + 1) = 11.5 apart)', () => {
    expect(batch(20, 31.6)).toEqual(each(20, 31.6))
    expect(batch(20, 31.4)).not.toEqual(each(20, 31.4))
  })
  it('is not its circles when they overlap', () => {
    expect(batch(20, 25)).not.toEqual(each(20, 25))
  })
})
