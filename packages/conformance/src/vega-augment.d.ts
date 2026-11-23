import 'vega'

// Members the vega runtime exports (vega-statistics, vega-scale) that vega's own typings leave out; the differentials call them.
declare module 'vega' {
  /** A seeded linear congruential generator: the reproducible `Math.random` replacement vega's transforms draw from. */
  export function randomLCG(seed: number): () => number
  /** Replace the random source every vega transform draws from. */
  export function setRandom(source: () => number): void
  /** vega-scale's interpolator factory (`interpolate(name, gamma)` etc.). */
  export function interpolate(type: string, gamma?: number): (a: unknown, b: unknown) => (t: number) => unknown
}
