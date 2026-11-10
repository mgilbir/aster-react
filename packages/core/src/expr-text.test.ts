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

describe('the readers of expression text on any text', () => {
  for (const [name, read] of READERS) {
    it(`${name} ends, in time linear in the length`, () => {
      for (const unit of UNITS) {
        // the fastest of five runs: one run's time includes whatever else the machine did meanwhile (a collection, another
        // process), which once put a linear reader at 40.7x for 10x the text; quadratic is ~100x, linear ~10x
        const at = (n: number): number => {
          const text = unit.repeat(Math.ceil(n / unit.length))
          let best = Infinity
          for (let i = 0; i < 5; i++) {
            const t0 = performance.now()
            read(text)
            best = Math.min(best, performance.now() - t0)
          }
          return best
        }
        at(100_000)
        const small = Math.max(at(100_000), 1)
        const big = at(1_000_000)
        expect(big, `${name} on ${JSON.stringify(unit)}`).toBeLessThan(5_000)
        expect(big / small, `${name} on ${JSON.stringify(unit)}`).toBeLessThan(40)
      }
    }, 120_000)
  }
})
