/**
 * The seeded random source of the gallery gate: ONE generator, given to BOTH engines per spec, so a spec that draws random
 * numbers has an oracle that is a function of its inputs and the draws can be compared exactly.
 *
 *   oracle  vega: `setRandom(seeded())` (vega-statistics' `random`, which expression `random()`, `sampleNormal`/`LogNormal`/
 *           `Uniform`, the `sample` transform, the bootstrap `ci0`/`ci1`, `randomKDE` and the wordcloud layout read), plus a
 *           seeded `Math.random` for the call sites that read it directly (vega-interpreter's default table);
 *   aster   `RuntimeInput.random` / `<Chart random>`: the same function type, explicit and per view.
 *
 * Every consumer must draw the same numbers in the same order and count; any remaining difference is a real divergence.
 */
import * as vega from 'vega'

/** vega exports vega-statistics' `setRandom` and `sampleNormal` at runtime; vega-typings does not declare them. */
const statistics = vega as unknown as { setRandom(random: () => number): void; sampleNormal(mean?: number, stdev?: number): number }

export const GALLERY_SEED = 0x5eed

/** mulberry32: a small, well-distributed 32-bit generator (the glibc LCG vega ships correlates its low bits). */
export function seededRandom(seed: number = GALLERY_SEED): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * vega-statistics keeps the second number of a Box-Muller pair in a module variable shared by every view, so the first
 * `sampleNormal` of a spec would read whatever the spec before it left. Consume a stale pair before seeding.
 */
function drainSampleNormal(): void {
  let draws = 0
  statistics.setRandom(() => { draws++; return 0.75 })
  statistics.sampleNormal()
  if (draws > 0) statistics.sampleNormal() // that call stored a pair; this one takes it
}

/** Run `fn` with vega (and `Math.random`) drawing from a fresh seeded stream; both are restored afterwards. */
export async function withOracleRandom<T>(fn: () => Promise<T>, seed: number = GALLERY_SEED): Promise<T> {
  const mathRandom = Math.random
  try {
    drainSampleNormal()
    const r = seededRandom(seed)
    statistics.setRandom(r)
    Math.random = r
    return await fn()
  } finally {
    statistics.setRandom(mathRandom)
    Math.random = mathRandom
  }
}

/** The instant the gallery's clock stands at (2023-11-14T22:13:20Z), and what `performance.now()` reads there. */
export const FROZEN_EPOCH_MS = 1_700_000_000_000
export const FROZEN_PERFORMANCE_MS = 1_000

/**
 * Run `fn` with `Date.now()` and `performance.now()` frozen, for both engines: a spec that reads `now()` sees the same instant
 * in vega and in Aster, and a first frame (no timer tick between the run and the serialisation) is a function of its inputs.
 */
export function withFrozenClock<T>(fn: () => T): T {
  const dateNow = Date.now
  const perfNow = performance.now.bind(performance)
  Date.now = () => FROZEN_EPOCH_MS
  performance.now = () => FROZEN_PERFORMANCE_MS
  const restore = (): void => { Date.now = dateNow; performance.now = perfNow }
  let result: T
  try {
    result = fn()
  } catch (e) {
    restore()
    throw e
  }
  if (result instanceof Promise) return result.finally(restore) as T
  restore()
  return result
}
