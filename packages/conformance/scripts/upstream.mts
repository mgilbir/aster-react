/**
 * The upstream libraries the live differentials compare against, reached through the dependency chain of the
 * pinned `vega` (so they are exactly the versions vega 6.3.1 runs on, with no extra devDependency to keep in step),
 * plus a small seeded generator for the generated cases.
 */
import { createRequire } from 'node:module'

/** Resolve `names[n]` starting from this package, each next one from where the previous one lives. */
export function resolveChain(...names: string[]): string {
  let req = createRequire(import.meta.url)
  let at = ''
  for (const name of names) {
    at = req.resolve(name)
    req = createRequire(at)
  }
  return at
}

export async function importChain<T = any>(...names: string[]): Promise<T> {
  return (await import(resolveChain(...names))) as T
}

/** A small deterministic generator (mulberry32) with the helpers the generated cases share. */
export function seeded(seed: number) {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number): number => Math.floor(next() * n)
  const pick = <T,>(list: readonly T[]): T => list[int(list.length)]!
  return { next, int, pick }
}
