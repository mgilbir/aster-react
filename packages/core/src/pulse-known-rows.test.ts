/**
 * A diff against rows known to be objects (pulse.ts `OBJECT_ROWS`: an array the engine ingested as it was, or one an earlier diff
 * vouched for) compares a row that is the very same object by identity alone, and vouches for the next array in turn, which the
 * evaluation then ingests without a look at its rows. Both are only sound if they say what the careful path says: generated arrays
 * (object rows, primitive rows, `null`, `0` / `-0`, new equal objects, edits, appends, removals, inserts), the diff against a known
 * array equals the diff against an unknown copy of it, and an array it vouches for holds objects only.
 */
import { describe, expect, it } from 'vitest'
import { diffRows, noteObjectRows, objectRowsOf } from './pulse.js'

type Rnd = () => number
function mulberry32(seed: number): Rnd {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const int = (r: Rnd, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1))

function oddRow(r: Rnd): unknown {
  return [null, 0, -0, 3, 'a', undefined, () => 1][int(r, 0, 6)]
}

describe('a diff against rows known to be objects says what the careful diff says', () => {
  it('generated arrays and edits', () => {
    const bad: string[] = []
    let vouched = 0
    for (let seed = 1; seed <= 3000; seed++) {
      const r = mulberry32(seed)
      const n = int(r, 0, 12)
      const prev: unknown[] = Array.from({ length: n }, (_, i) => ({ v: i % 3 }))
      noteObjectRows(prev, prev.length)
      const next = prev.slice()
      for (let k = int(r, 0, 3); k > 0; k--) {
        const op = int(r, 0, 5)
        const at = int(r, 0, Math.max(0, next.length - 1))
        if (op === 0 && next.length) next[at] = { v: int(r, 0, 3) }
        else if (op === 1 && next.length) next[at] = { ...(next[at] as object) }
        else if (op === 2) next.push(r() < 0.5 ? { v: 9 } : oddRow(r))
        else if (op === 3 && next.length) next.splice(at, 1)
        else if (op === 4) next.splice(at, 0, r() < 0.5 ? { v: 7 } : oddRow(r))
        else if (op === 5 && next.length) next[at] = oddRow(r)
      }
      const careful = diffRows(prev.slice(), next.slice())
      const fast = diffRows(prev, next)
      if (JSON.stringify(fast) !== JSON.stringify(careful)) bad.push(`seed ${seed}: fast ${JSON.stringify(fast)} careful ${JSON.stringify(careful)}`)
      if (fast !== null && objectRowsOf(next) === next.length) {
        vouched++
        if (!next.every((x) => x !== null && typeof x === 'object')) bad.push(`seed ${seed}: vouched for a row that is not an object`)
      }
    }
    expect(bad.slice(0, 5)).toEqual([])
    expect(vouched).toBeGreaterThan(1000)
  })

  it('an array not known to hold objects is diffed row by row (`0` and `-0` are different rows)', () => {
    expect(diffRows([0, 1], [-0, 1])).toBeNull()
    expect(objectRowsOf([{ a: 1 }])).toBe(0)
  })
})
