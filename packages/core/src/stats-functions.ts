/**
 * The distribution functions of the expression language: `sample*`, `density*`, `cumulative*` and `quantile*` for the
 * normal, log-normal and uniform distributions. Registered by the transforms addon, which is where the `quantile` /
 * `kde` / `density` transforms that go with them live; `transform-stats.ts` builds its distributions on the same
 * functions.
 *
 * Numbers, not shapes, are what these must reproduce: every function evaluates its formula in one fixed order, because the
 * last bit of the result is observable (a density drawn into a path, a quantile used as a scale bound), and the samplers
 * draw from the random source in one fixed count and order, because a seeded source must give the same chart as it gives
 * any other implementation of the expression language.
 *
 * Provenance of the numerical parts: the cumulative normal is the double-precision approximation of West (2009), "Better
 * approximations to cumulative normal functions"; the inverse error function is the rational-minimax approximation of Giles
 * (2010), "Approximating the erfinv function" (GPU Computing Gems, vol. 2), with the coefficients Apache Commons Math
 * publishes for `Erf.erfInv` (Apache-2.0; its NOTICE is in THIRD_PARTY_NOTICES.md); the normal sampler is the polar
 * form of the Box-Muller transform.
 */
import { registerExpressionFunction, registerRuntimeExpressionFunction } from './expression.js'
import { normalPairs } from './random-tape.js'

export const SQRT2PI = Math.sqrt(2 * Math.PI)
const SQRT2 = Math.SQRT2

/** A source of numbers in [0, 1): `Math.random`, or the one a host injected ({@link ExpressionRuntime.random}). */
type Random = () => number
const MATH_RANDOM: Random = () => Math.random()

// --- parameters ------------------------------------------------------------------------------------------------
// An argument that is missing, null, NaN or 0 is "no mean"; only a missing or null spread is "no spread" (a spread of 0 or NaN
// is used as given). The uniform bounds take a lone argument as the upper bound.

const centre = (mean: number | undefined): number => mean || 0
const spread = (stdev: number | undefined): number => (stdev == null ? 1 : stdev)
const upper = (min: number | undefined, max: number | undefined): number => (max == null ? (min == null ? 1 : min) : max)
const lower = (min: number | undefined, max: number | undefined): number => (max == null ? 0 : (min as number))

/** Evaluate the polynomial with these coefficients (highest degree first) at `at`, one multiply and one add per step. */
function horner(coefficients: readonly number[], at: number): number {
  let p = coefficients[0]!
  for (let i = 1; i < coefficients.length; i++) p = coefficients[i]! + p * at
  return p
}

// --- normal ----------------------------------------------------------------------------------------------------

/**
 * A standard normal number, scaled and shifted, from `random`. Each polar Box-Muller round turns two uniform draws (repeated until
 * they fall inside the unit circle) into two normals; the second is kept for the next call. The kept number belongs to the SOURCE
 * it was drawn from (one entry per injected source), so a view given its own stream starts clean and replays the same numbers
 * however many views came before it. `Math.random`'s entry is shared by every view, as one stream is.
 */
export function sampleNormalFrom(random: Random, mean?: number, stdev?: number): number {
  const kept = normalPairs.get(random) ?? NaN
  let z: number
  if (kept === kept) {
    z = kept
    normalPairs.set(random, NaN)
  } else {
    let u: number
    let v: number
    let r2: number
    do {
      u = random() * 2 - 1
      v = random() * 2 - 1
      r2 = u * u + v * v
    } while (r2 === 0 || r2 > 1)
    const k = Math.sqrt(-2 * Math.log(r2) / r2)
    z = u * k
    normalPairs.set(random, v * k)
  }
  return centre(mean) + z * spread(stdev)
}

export function sampleNormal(mean?: number, stdev?: number): number {
  return sampleNormalFrom(MATH_RANDOM, mean, stdev)
}

export function densityNormal(value: number, mean?: number, stdev?: number): number {
  const sd = spread(stdev)
  const z = (value - centre(mean)) / sd
  return Math.exp(-0.5 * z * z) / (sd * SQRT2PI)
}

// West (2009): a rational function of |z| below 7.07106781186547 (the numerator and denominator polynomials, highest degree
// first), and a continued fraction beyond it; nothing is left of the tail past 37 standard deviations.
const WEST_NEAR_NUMERATOR = [
  3.52624965998911e-02, 0.700383064443688, 6.37396220353165, 33.912866078383, 112.079291497871, 221.213596169931, 220.206867912376,
]
const WEST_NEAR_DENOMINATOR = [
  8.83883476483184e-02, 1.75566716318264, 16.064177579207, 86.7807322029461, 296.564248779674, 637.333633378831, 793.826512519948, 440.413735824752,
]
const WEST_TAIL_START = 0.65
const WEST_TAIL_TERMS = [4, 3, 2, 1]
const SQRT2PI_ROUNDED = 2.506628274631

export function cumulativeNormal(value: number, mean?: number, stdev?: number): number {
  const z = (value - centre(mean)) / spread(stdev)
  const a = Math.abs(z)
  let tail: number // P(Z > a)
  if (a > 37) {
    tail = 0
  } else {
    const e = Math.exp(-a * a / 2)
    if (a < 7.07106781186547) {
      tail = e * horner(WEST_NEAR_NUMERATOR, a)
      tail = tail / horner(WEST_NEAR_DENOMINATOR, a)
    } else {
      let fraction = a + WEST_TAIL_START
      for (const term of WEST_TAIL_TERMS) fraction = a + term / fraction
      tail = e / fraction / SQRT2PI_ROUNDED
    }
  }
  return z > 0 ? 1 - tail : tail
}

// --- inverse error function ------------------------------------------------------------------------------------
// Giles: three polynomial approximations of erfinv(x) / x, chosen by w = -ln(1 - x^2) and evaluated in a shifted variable. Their
// coefficients are listed from the highest degree down.

const ERFINV_A = [
  -3.6444120640178196996e-21,
  -1.685059138182016589e-19,
  1.2858480715256400167e-18,
  1.115787767802518096e-17,
  -1.333171662854620906e-16,
  2.0972767875968561637e-17,
  6.6376381343583238325e-15,
  -4.0545662729752068639e-14,
  -8.1519341976054721522e-14,
  2.6335093153082322977e-12,
  -1.2975133253453532498e-11,
  -5.4154120542946279317e-11,
  1.051212273321532285e-09,
  -4.1126339803469836976e-09,
  -2.9070369957882005086e-08,
  4.2347877827932403518e-07,
  -1.3654692000834678645e-06,
  -1.3882523362786468719e-05,
  0.0001867342080340571352,
  -0.00074070253416626697512,
  -0.0060336708714301490533,
  0.24015818242558961693,
  1.6536545626831027356,
]
const ERFINV_B = [
  2.2137376921775787049e-09,
  9.0756561938885390979e-08,
  -2.7517406297064545428e-07,
  1.8239629214389227755e-08,
  1.5027403968909827627e-06,
  -4.013867526981545969e-06,
  2.9234449089955446044e-06,
  1.2475304481671778723e-05,
  -4.7318229009055733981e-05,
  6.8284851459573175448e-05,
  2.4031110387097893999e-05,
  -0.0003550375203628474796,
  0.00095328937973738049703,
  -0.0016882755560235047313,
  0.0024914420961078508066,
  -0.0037512085075692412107,
  0.005370914553590063617,
  1.0052589676941592334,
  3.0838856104922207635,
]
const ERFINV_C = [
  -2.7109920616438573243e-11,
  -2.5556418169965252055e-10,
  1.5076572693500548083e-09,
  -3.7894654401267369937e-09,
  7.6157012080783393804e-09,
  -1.4960026627149240478e-08,
  2.9147953450901080826e-08,
  -6.7711997758452339498e-08,
  2.2900482228026654717e-07,
  -9.9298272942317002539e-07,
  4.5260625972231537039e-06,
  -1.9681778105531670567e-05,
  7.5995277030017761139e-05,
  -0.00021503011930044477347,
  -0.00013871931833623122026,
  1.0103004648645343977,
  4.8499064014085844221,
]

/**
 * erfinv(x). `w` is formed as -ln((1 - x)(1 + x)), which must NOT be simplified to 1 - x^2: that loses the digits near +-1 that
 * the outer two approximations exist for. Beyond |x| = 1 (w infinite) the result is infinite, and NaN stays NaN.
 */
function erfinv(x: number): number {
  const w = -Math.log((1 - x) * (1 + x))
  let p: number
  if (w < 6.25) p = horner(ERFINV_A, w - 3.125)
  else if (w < 16.0) p = horner(ERFINV_B, Math.sqrt(w) - 3.25)
  else if (Number.isFinite(w)) p = horner(ERFINV_C, Math.sqrt(w) - 5.0)
  else p = Infinity
  return p * x
}

/** The probit function: the value below which a fraction `p` of the distribution lies. */
export function quantileNormal(p: number, mean?: number, stdev?: number): number {
  if (p < 0 || p > 1) return NaN
  return centre(mean) + spread(stdev) * SQRT2 * erfinv(2 * p - 1)
}

// --- log-normal ------------------------------------------------------------------------------------------------

export function sampleLogNormalFrom(random: Random, mean?: number, stdev?: number): number {
  return Math.exp(centre(mean) + sampleNormalFrom(random) * spread(stdev))
}

export function sampleLogNormal(mean?: number, stdev?: number): number {
  return sampleLogNormalFrom(MATH_RANDOM, mean, stdev)
}

export function densityLogNormal(value: number, mean?: number, stdev?: number): number {
  if (value <= 0) return 0
  const sd = spread(stdev)
  const z = (Math.log(value) - centre(mean)) / sd
  return Math.exp(-0.5 * z * z) / (sd * SQRT2PI * value)
}

export function cumulativeLogNormal(value: number, mean?: number, stdev?: number): number {
  return cumulativeNormal(Math.log(value), mean, stdev)
}

export function quantileLogNormal(p: number, mean?: number, stdev?: number): number {
  return Math.exp(quantileNormal(p, mean, stdev))
}

// --- uniform ---------------------------------------------------------------------------------------------------

export function sampleUniformFrom(random: Random, min?: number, max?: number): number {
  const lo = lower(min, max)
  return lo + (upper(min, max) - lo) * random()
}

export function sampleUniform(min?: number, max?: number): number {
  return sampleUniformFrom(MATH_RANDOM, min, max)
}

export function densityUniform(value: number, min?: number, max?: number): number {
  const lo = lower(min, max)
  const hi = upper(min, max)
  return value >= lo && value <= hi ? 1 / (hi - lo) : 0
}

export function cumulativeUniform(value: number, min?: number, max?: number): number {
  const lo = lower(min, max)
  const hi = upper(min, max)
  return value < lo ? 0 : value > hi ? 1 : (value - lo) / (hi - lo)
}

export function quantileUniform(p: number, min?: number, max?: number): number {
  const lo = lower(min, max)
  return p >= 0 && p <= 1 ? lo + p * (upper(min, max) - lo) : NaN
}

// --- registration ----------------------------------------------------------------------------------------------

const FUNCTIONS = {
  sampleNormal, densityNormal, cumulativeNormal, quantileNormal,
  sampleLogNormal, densityLogNormal, cumulativeLogNormal, quantileLogNormal,
  sampleUniform, densityUniform, cumulativeUniform, quantileUniform,
}
// the three that draw numbers read the view's source (`runtime.random`, at call time); the rest are plain
const DRAWING: Record<string, (random: Random) => (...args: never[]) => unknown> = {
  sampleNormal: (random) => (mean?: number, stdev?: number) => sampleNormalFrom(random, mean, stdev),
  sampleLogNormal: (random) => (mean?: number, stdev?: number) => sampleLogNormalFrom(random, mean, stdev),
  sampleUniform: (random) => (min?: number, max?: number) => sampleUniformFrom(random, min, max),
}
for (const [name, fn] of Object.entries(FUNCTIONS)) {
  const draw = DRAWING[name]
  if (draw === undefined) registerExpressionFunction(name, fn as (...args: never[]) => unknown)
  else registerRuntimeExpressionFunction(name, (rt) => draw(rt.random ?? MATH_RANDOM))
}
