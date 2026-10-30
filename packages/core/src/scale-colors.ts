/**
 * Colour for scales: the table of interpolators a spec names (`rgb`, `hcl-long`, `cubehelix`, ...), colour schemes (the
 * named palettes), ramps built from a list of colours, and the helpers legends use to draw a scale as a gradient.
 *
 * What callers observe, and so what is fixed here: an interpolator is looked up by its name with each dash-separated word
 * capitalised (`rgb-basis-closed` is the closed rgb spline), and a name that is not in the table is simply undefined; a gamma
 * applies only to the interpolators that take one (rgb and cubehelix); a scheme is a list of colours or, for the
 * continuous palettes, a ramp over [0, 1] built from the hex runs; scheme names are lower-cased and are looked up
 * only among the registered ones, never up a prototype chain.
 */
import { peek } from './arr.js'
import { boundedCount } from './limits.js'
import {
  interpolateArray,
  interpolateBasis,
  interpolateBasisClosed,
  interpolateCubehelix,
  interpolateCubehelixLong,
  interpolateDate,
  interpolateDiscrete,
  interpolateHcl,
  interpolateHclLong,
  interpolateHsl,
  interpolateHslLong,
  interpolateHue,
  interpolateLab,
  interpolateNumber,
  interpolateNumberArray,
  interpolateObject,
  interpolateRgb,
  interpolateRgbBasis,
  interpolateRgbBasisClosed,
  interpolateRound,
  interpolateString,
  interpolateZoom,
  piecewise,
} from './interp.js'
import { scale as lookup, type Scale } from './scale-registry.js'
import { continuousPalettes, discretePalettes } from './scale-schemes.js'

// ---- interpolators by name ---------------------------------------------------------------------------------

/** The interpolators a spec can name, keyed by the capitalised, dash-joined form of the name. */
const INTERPOLATORS = new Map<string, unknown>(
  Object.entries({
    Array: interpolateArray,
    Basis: interpolateBasis,
    BasisClosed: interpolateBasisClosed,
    Cubehelix: interpolateCubehelix,
    CubehelixLong: interpolateCubehelixLong,
    Date: interpolateDate,
    Discrete: interpolateDiscrete,
    Hcl: interpolateHcl,
    HclLong: interpolateHclLong,
    Hsl: interpolateHsl,
    HslLong: interpolateHslLong,
    Hue: interpolateHue,
    Lab: interpolateLab,
    Number: interpolateNumber,
    NumberArray: interpolateNumberArray,
    Object: interpolateObject,
    Rgb: interpolateRgb,
    RgbBasis: interpolateRgbBasis,
    RgbBasisClosed: interpolateRgbBasisClosed,
    Round: interpolateRound,
    String: interpolateString,
    Zoom: interpolateZoom,
  }),
)

/** The interpolator named by a spec (with a gamma, when it takes one); undefined for a name that is not one. */
export function interpolate(type?: string, gamma?: number): unknown {
  const key = type!
    .toLowerCase()
    .split('-')
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join('')
  const blend = INTERPOLATORS.get(key) as { gamma?: (g: number) => unknown } | undefined
  return gamma != null && blend && blend.gamma ? blend.gamma(gamma) : blend
}

/** One ramp through a list of colours, blended in the named space (rgb by default). */
export function interpolateColors(colors: string[], type?: string, gamma?: number): (t: number) => string {
  return piecewise(interpolate(type || 'rgb', gamma) as (a: unknown, b: unknown) => (t: number) => unknown, colors) as (t: number) => string
}

/** A ramp restricted to the part of [0, 1] that `range` spans (reversed when it runs backward). */
export function interpolateRange(ramp: (t: number) => unknown, range: number[]): (i: number) => unknown {
  const start = range[0]!
  const span = peek(range) - start
  return (i) => ramp(start + i * span)
}

/** `count` evenly spaced samples of a ramp, none at either end of [0, 1]. */
export function quantizeInterpolator(ramp: (t: number) => unknown, count: number): unknown[] {
  boundedCount(count, 'quantized colour samples')
  const samples = new Array(count)
  const n = count + 1
  for (let i = 0; i < count; ) samples[i] = ramp(++i / n)
  return samples
}

// ---- gradients ---------------------------------------------------------------------------------------------

/** The members a derived scale copies from the scale it stands for. */
const SHARED_MEMBERS = ['clamp', 'base', 'constant', 'exponent']

/** Where along [0, 1] a value of `source` sits when its domain is first rescaled to [min, max]. */
export function scaleFraction(source: Scale, min: number, max: number): (t: number) => unknown {
  const delta = max - min
  if (!delta || !Number.isFinite(delta)) return () => 0.5
  const dash = (source.type as string).indexOf('-')
  const kind = dash < 0 ? source.type : (source.type as string).slice(dash + 1)
  const unit = lookup(kind)!().domain([min, max]).range([0, 1])
  for (const member of SHARED_MEMBERS) if (source[member]) unit[member](source[member]())
  return unit
}

/**
 * The stops of a gradient legend for a scale: its tick values (`count`, else 15) with the domain ends added when they are
 * missing, each at the fraction `scaleFraction` gives and with the colour the scale gives. Scales without ticks use
 * their domain as stops. A domain of zero width is stretched onto [0, 1] first.
 */
export function scaleGradientStops(source: Scale, count?: number): Array<{ offset: number; color: string }> {
  let drawn: Scale = source
  let stops: number[] = source.domain()
  let min = stops[0]!
  let max = peek(stops)
  let fraction: (t: number) => unknown = (t) => t
  if (!(max - min)) {
    drawn = (source.interpolator
      ? lookup('sequential')!().interpolator(source.interpolator())
      : lookup('linear')!().interpolate(source.interpolate()).range(source.range())
    ).domain([(min = 0), (max = 1)])
  } else {
    fraction = scaleFraction(source, min, max)
  }
  if (drawn.ticks) {
    stops = drawn.ticks(+(count as number) || 15)
    if (min !== stops[0]) stops.unshift(min)
    if (max !== peek(stops)) stops.push(max)
  }
  return stops.map((v) => ({ offset: Number(fraction(v)), color: String(drawn(v)) }))
}

// ---- schemes -----------------------------------------------------------------------------------------------

const schemes = new Map<string, unknown>()

/** The colours of a palette given as hex runs of six digits, or as a list already. */
function paletteColors(palette: unknown): string[] {
  if (Array.isArray(palette)) return palette as string[]
  const hex = palette as string
  const colors: string[] = []
  for (let i = 0; i + 6 <= hex.length; i += 6) colors.push('#' + hex.slice(i, i + 6))
  return colors
}

for (const [name, palette] of Object.entries(discretePalettes)) schemes.set(name.toLowerCase(), paletteColors(palette))
for (const [name, palette] of Object.entries(continuousPalettes)) schemes.set(name.toLowerCase(), interpolateColors(paletteColors(palette)))

/** The named scheme (a colour list or a ramp over [0, 1]), or undefined. */
export function scheme(name: string): unknown {
  return schemes.get(name && name.toLowerCase())
}
