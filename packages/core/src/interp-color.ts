/**
 * Colour interpolators: two colours blended in rgb (with a gamma), hsl, hcl, lab or cubehelix, and splines through a list of colours.
 * Part of the engine's colour family (engine-parts.ts: `color`), with the colour spaces of color.ts; interp.ts reads it for a text or a
 * colour, scale.ts for an interpolator named by a spec and for the colours of a scheme.
 *
 * What is fixed by the output is said in interp.ts: every channel's arithmetic, in its exact form.
 */
import { color, Color, Cubehelix, cubehelix, Hcl, hcl, Hsl, hsl, Lab, lab, Rgb, rgbConvert } from './color.js'
import { inGamma, interpolateBasis, interpolateBasisClosed, interpolateString, shortestHue, straight, type Blend, type Ramp } from './interp.js'

// ---- two colours ----------------------------------------------------------------------------------------------

type RgbBlend = Blend<string> & { gamma(y: number): RgbBlend }

function rgbInGamma(y: number): RgbBlend {
  const channel = inGamma(y)
  const blend = ((from: unknown, to: unknown) => {
    const a = rgbConvert(from)
    const b = rgbConvert(to)
    const r = channel(a.r, b.r)
    const g = channel(a.g, b.g)
    const bl = channel(a.b, b.b)
    const alpha = straight(a.opacity, b.opacity)
    return (t: number) => new Rgb(r(t), g(t), bl(t), alpha(t)) + ''
  }) as RgbBlend
  blend.gamma = rgbInGamma
  return blend
}

export const interpolateRgb = rgbInGamma(1)

type Triple = readonly [number, number, number]
type Channel = (a: number, b: number) => Ramp<number>

/**
 * Blend two colours in a space of three channels plus opacity. `lift` is the power the position is raised to before
 * it drives the third channel (the cubehelix gamma); 1 leaves it be.
 */
function blendIn<C extends Color>(
  convert: (v: unknown) => C,
  read: (c: C) => Triple,
  make: (c0: number, c1: number, c2: number, opacity: number) => C,
  channels: readonly [Channel, Channel, Channel],
  lift = 1,
): Blend<string> {
  return (from, to) => {
    const a = convert(from)
    const b = convert(to)
    const [a0, a1, a2] = read(a)
    const [b0, b1, b2] = read(b)
    const r0 = channels[0](a0, b0)
    const r1 = channels[1](a1, b1)
    const r2 = channels[2](a2, b2)
    const alpha = straight(a.opacity, b.opacity)
    return (t) => make(r0(t), r1(t), r2(lift === 1 ? t : Math.pow(t, lift)), alpha(t)) + ''
  }
}

const hslBlend = (hue: Channel): Blend<string> =>
  blendIn(hsl as (v: unknown) => Hsl, (c) => [c.h, c.s, c.l], (h, s, l, o) => new Hsl(h, s, l, o), [hue, straight, straight])

const hclBlend = (hue: Channel): Blend<string> =>
  blendIn(hcl as (v: unknown) => Hcl, (c) => [c.h, c.c, c.l], (h, c, l, o) => new Hcl(h, c, l, o), [hue, straight, straight])

type CubehelixBlend = Blend<string> & { gamma(y: number): CubehelixBlend }

function cubehelixBlend(hue: Channel, y = 1): CubehelixBlend {
  const blend = blendIn(cubehelix as (v: unknown) => Cubehelix, (c) => [c.h, c.s, c.l], (h, s, l, o) => new Cubehelix(h, s, l, o), [hue, straight, straight], +y) as CubehelixBlend
  blend.gamma = (next) => cubehelixBlend(hue, next)
  return blend
}

export const interpolateHsl = hslBlend(shortestHue)
export const interpolateHslLong = hslBlend(straight)
export const interpolateHcl = hclBlend(shortestHue)
export const interpolateHclLong = hclBlend(straight)
export const interpolateCubehelix = cubehelixBlend(shortestHue)
export const interpolateCubehelixLong = cubehelixBlend(straight)
export const interpolateLab: Blend<string> = blendIn(lab as (v: unknown) => Lab, (c) => [c.l, c.a, c.b], (l, a, b, o) => new Lab(l, a, b, o), [straight, straight, straight])

/** A spline through the red, green and blue of a list of colours. The result is opaque, and an empty list is an error. */
function rgbSpline(spline: (values: ArrayLike<number>) => Ramp<number>): (colors: ArrayLike<unknown>) => Ramp<string> {
  return (colors) => {
    const n = colors.length
    const reds = new Array<number>(n)
    const greens = new Array<number>(n)
    const blues = new Array<number>(n)
    let last: Rgb | undefined
    for (let i = 0; i < n; ++i) {
      last = rgbConvert(colors[i])
      reds[i] = last.r || 0
      greens[i] = last.g || 0
      blues[i] = last.b || 0
    }
    const r = spline(reds)
    const g = spline(greens)
    const b = spline(blues)
    // (a spline has no fourth channel: the output is opaque; an empty list has no colour to take that from)
    ;(last as { opacity: number }).opacity = 1
    return (t) => new Rgb(r(t), g(t), b(t), 1) + ''
  }
}

export const interpolateRgbBasis = rgbSpline(interpolateBasis)
export const interpolateRgbBasisClosed = rgbSpline(interpolateBasisClosed)

/** A text as `interpolateValue` takes it: a colour blended in rgb, any other text by the numbers inside it. */
export function interpolateText(a: unknown, b: string): Ramp {
  const parsed = color(b)
  return parsed ? interpolateRgb(a, parsed) : interpolateString(a as string, b)
}

/** Whether a value is a colour object (what `rgb()`, `hsl()` and the like return). */
export const isColor = (value: unknown): boolean => value instanceof Color
