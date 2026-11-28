// @vitest-environment node
/**
 * A long differential suite must let its vitest worker's event loop turn (scripts/lib/turn.mjs): the worker reads the host's
 * replies only when it does, and a worker that does not for a minute is reported as `Timeout calling "onTaskUpdate"`.
 * `compareCasesAsync` turns the loop between cases; the synchronous `compareCases` is the contrast (it cannot).
 */
import { describe, expect, it } from 'vitest'
import { compareCases, compareCasesAsync, type Case } from './differential-gen.mts'

const same = (i: number): Case => ({ label: `#${i}`, oracle: () => i, aster: () => i })

describe('compareCasesAsync turns the event loop between cases', () => {
  it('a timer that is due while it runs fires inside it; the synchronous version starves it', async () => {
    let fired = false
    setTimeout(() => { fired = true }, 0)
    await new Promise((r) => setTimeout(r, 5))
    expect(fired, 'the timer fired while the test was idle: the probe proves nothing').toBe(true)

    const during = async (run: (gen: (i: number) => Case) => unknown): Promise<boolean> => {
      let seen = false
      let flag = false
      setTimeout(() => { flag = true }, 0)
      // (busy until the timer is due: it can only fire once the loop turns)
      const until = Date.now() + 3
      while (Date.now() < until) { /* spin */ }
      await run((i) => { if (i === 40) seen = flag; return same(i) })
      await new Promise((r) => setTimeout(r, 2))
      return seen
    }
    expect(await during((gen) => compareCasesAsync('async', 80, gen))).toBe(true)
    expect(await during((gen) => compareCases('sync', 80, gen))).toBe(false)
  })

  it('reports the same mismatches as compareCases', async () => {
    const bad = (i: number): Case => ({ label: `#${i}`, oracle: () => i, aster: () => (i === 3 ? -1 : i) })
    const sync = (): unknown => { try { compareCases('x', 10, bad) } catch (e) { return (e as Error).message } return null }
    let asyncMessage: unknown = null
    try { await compareCasesAsync('x', 10, bad) } catch (e) { asyncMessage = (e as Error).message }
    expect(asyncMessage).toBe(sync())
    expect(asyncMessage).toMatch(/1\/10 cases differ/)
  })
})
