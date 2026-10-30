/**
 * Generators and the comparison loop of the generated live differentials of the formatting layer
 * (`differential-format`, `-time-format`, `-time-intervals`, `-color`).
 *
 * Every case is drawn from a seeded generator, so a failure is reproducible from its seed and index; the report
 * names the case, not only the count. `ASTER_DIFF_SCALE` multiplies every case count (a deeper local sweep:
 * `ASTER_DIFF_SCALE=10 pnpm vitest run packages/conformance/scripts/differential-format.test.mts`).
 */
import { appendFileSync } from 'node:fs'
import { enc } from './differential-util.mts'

export type Rng = ReturnType<typeof makeRng>

/** mulberry32: a small, well-mixed 32-bit generator with a one-number state. */
export function makeRng(seed: number) {
  let s = seed >>> 0
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    /** An integer in [0, n). */
    int: (n: number): number => Math.floor(next() * n),
    /** An integer in [lo, hi]. */
    between: (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p: number): boolean => next() < p,
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)] as T
    },
    /** A string of `lo..hi` characters drawn from `alphabet`. */
    text(alphabet: readonly string[], lo: number, hi: number): string {
      const n = lo + Math.floor(next() * (hi - lo + 1))
      let out = ''
      for (let i = 0; i < n; i++) out += alphabet[Math.floor(next() * alphabet.length)]
      return out
    },
  }
}

export const scaled = (n: number): number => {
  const k = Number(process.env.ASTER_DIFF_SCALE ?? 1)
  return Math.max(1, Math.round(n * (Number.isFinite(k) && k > 0 ? k : 1)))
}

/**
 * What a call produced, comparably: the value (tagged by `enc`) or the thrown error. An Error carries its class and
 * message, so a user-visible message is held; a TypeError carries its class only, because the engine words it with the
 * source text of the failing expression (`x.map is not a function`), which is not part of any contract.
 */
export function outcome(f: () => unknown): unknown {
  try {
    return { value: enc(f()) }
  } catch (err) {
    if (err instanceof TypeError) return { threw: 'TypeError' }
    const e = err as { name?: string; message?: string }
    return { threw: e?.name ?? typeof err, message: e?.message }
  }
}

export interface Case {
  /** Printable description of the input, shown on a mismatch. */
  label: string
  oracle: () => unknown
  aster: () => unknown
}

/**
 * Run `count` generated cases; collect the first mismatches (with their label) and throw one error listing them.
 * Returns how many cases the oracle refused (threw) and how many produced a non-null value, so a generator whose
 * cases mostly refuse or parse to null can be told apart from one that exercises the code.
 */
export function compareCases(name: string, count: number, gen: (i: number) => Case): { cases: number; refused: number; informative: number } {
  const bad: string[] = []
  let refused = 0
  let informative = 0
  let failures = 0
  for (let i = 0; i < count; i++) {
    const c = gen(i)
    if (process.env.ASTER_DIFF_TRACE) appendFileSync(process.env.ASTER_DIFF_TRACE, `${name} #${i} ${c.label}\n`)
    const want = outcome(c.oracle)
    const got = outcome(c.aster)
    if ((want as { threw?: string }).threw) refused++
    else if ((want as { value?: unknown }).value !== null) informative++
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      failures++
      if (bad.length < 5) {
        bad.push(`  #${i} ${c.label}\n     oracle ${JSON.stringify(want)?.slice(0, 220)}\n     aster  ${JSON.stringify(got)?.slice(0, 220)}`)
      }
    }
  }
  if (failures) throw new Error(`${name}: ${failures}/${count} cases differ from the oracle\n${bad.join('\n')}`)
  return { cases: count, refused, informative }
}
