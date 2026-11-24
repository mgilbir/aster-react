/**
 * The readers of expression text added for the keys and dependencies (`lexedText`, `namesIn`, `identifiersIn`, `datasetsReadIn`,
 * `scalesReadIn`) run on spec text, which may be untrusted: patterns whose alternatives do not overlap, read once, and walks of a
 * parsed tree with a stack of its own. They end on any text, in time linear in its length.
 */
import { describe, expect, it } from 'vitest'
import { lexedText } from './expr-text.js'
import { datasetsReadIn, identifiersIn, namesIn, scalesReadIn } from './step-reuse.js'

const B = String.fromCharCode(92)
const UNITS = [`'a`, `"${B}"`, B, `${B}u12`, `${B}u{`, '/a[/', 'abc + ', '1.5e3+', String.fromCharCode(0), `${String.fromCharCode(0xd800)}x`, `${B}u0061`, `"'${B}/[(`, 'data("', 'scale(1,']
const READERS: Array<[string, (t: string) => unknown]> = [
  ['lexedText', lexedText], ['namesIn', (t) => namesIn(t, new Set())], ['identifiersIn', identifiersIn],
  ['datasetsReadIn', datasetsReadIn], ['scalesReadIn', scalesReadIn],
]

/**
 * How the time per character grows with the length. A ratio of two times is only a growth rate when both are well above the timer's
 * noise: the guard this replaces floored a sub-millisecond time at 1 ms, so a quadratic reader that took 0.2 ms at 100k characters
 * (20 ms at 1M) read as a ratio of 20 and passed (C105). Linear readers are not flat either: past the caches and the young
 * generation a character costs 2-4x what it did at 100k (measured on these readers from 32k to 16M characters), a step that ends;
 * a quadratic reader's cost per character doubles with every doubling, without end.
 */
/** The base size is the first, doubling from 32k, at which the reader takes this long. */
const MEASURABLE_MS = 1
/** The largest base. A reader under 1 ms on 2M characters is under 0.5 ns per character: no quadratic reader is. */
const MAX_BASE = 1 << 21
/** The sizes go on doubling to 32x the base (at most 32M characters): a quadratic reader costs 32x more per character there. */
const RANGE = 32
const MAX_SIZE = 1 << 25
/** The growth of the cost per character allowed: twice the memory step measured, a quarter of what a quadratic shows at 32x. */
const MAX_GROWTH = 8

/** The fastest of `runs` runs: one run's time includes whatever else the machine did meanwhile (a collection, another process). */
function fastest(read: (t: string) => unknown, unit: string, n: number, runs: number): number {
  const text = unit.repeat(Math.ceil(n / unit.length))
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    read(text)
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

interface Growth { base: number; baseMs: number; worst: number; worstAt: number; worstMs: number }

/**
 * The cost per character of `read` over `unit` repeated, at each doubling from the base size to 32x it, divided by the cost per
 * character at the base: the worst of them. It stops at the first size past the allowed growth (a quadratic reader would otherwise
 * run for minutes at 32M characters).
 */
function growth(read: (t: string) => unknown, unit: string): Growth {
  let base = 1 << 15
  fastest(read, unit, base, 5) // warm the code up
  let baseMs = fastest(read, unit, base, 5)
  while (baseMs < MEASURABLE_MS && base < MAX_BASE) {
    base *= 2
    baseMs = fastest(read, unit, base, 5)
  }
  const basePerChar = Math.max(baseMs, MEASURABLE_MS) / base
  const g: Growth = { base, baseMs, worst: 0, worstAt: base, worstMs: baseMs }
  for (let n = base * 2; n <= Math.min(base * RANGE, MAX_SIZE); n *= 2) {
    const ms = fastest(read, unit, n, 3)
    const ratio = ms / n / basePerChar
    if (ratio > g.worst) Object.assign(g, { worst: ratio, worstAt: n, worstMs: ms })
    if (ratio > MAX_GROWTH) break
  }
  return g
}

const show = (g: Growth): string => `${g.baseMs.toFixed(2)} ms at ${g.base}, ${g.worstMs.toFixed(2)} ms at ${g.worstAt}: cost per character x${g.worst.toFixed(2)}`

describe('the readers of expression text on any text', () => {
  for (const [name, read] of READERS) {
    it(`${name} ends, in time linear in the length`, () => {
      for (const unit of UNITS) {
        const g = growth(read, unit)
        const label = `${name} on ${JSON.stringify(unit)}: ${show(g)}`
        expect(g.worstMs, label).toBeLessThan(5_000)
        expect(g.worst, label).toBeLessThan(MAX_GROWTH)
      }
    }, 120_000)
  }

  it('the guard tells a quadratic reader from a linear one, both faster than the old guard could see', () => {
    // Each costs about 0.1 ms at 100k characters, under the 1 ms the old guard floored to.
    const linear = (t: string): number => {
      let s = 0
      for (let i = 0; i < t.length; i += 4) s += t.charCodeAt(i)
      return s
    }
    const quadratic = (t: string): number => {
      let s = 0
      for (let i = 0; i < t.length; i += 256) for (let j = 0; j < i; j += 256) s += t.charCodeAt(j)
      return s
    }
    const l = growth(linear, 'ab')
    expect(l.worst, show(l)).toBeLessThan(MAX_GROWTH)
    const q = growth(quadratic, 'ab')
    expect(q.worst, show(q)).toBeGreaterThan(MAX_GROWTH)
  }, 120_000)
})
