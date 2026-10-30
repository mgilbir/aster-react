/**
 * Colours: the CSS-ish string parser and five colour spaces (RGB, HSL, Lab, HCL, Cubehelix).
 *
 * Aster reads exactly the strings d3-color reads and produces exactly its numbers, because the expression functions
 * `rgb() hsl() lab() hcl()`, scale interpolation in those spaces and the schemes all hand colours to user code and
 * to the SVG. The vectors in `testdata/vectors/d3-color.json` and the generated differential
 * (`packages/conformance/scripts/differential-color.test.mts`) hold that.
 *
 * What is shaped by that contract rather than by taste:
 * - channels are never clamped on construction (`rgb(300, 0, 0)` is out of gamut until it is formatted);
 * - an unparsable string converts to a colour whose channels are all NaN, and `transparent` to NaN channels with
 *   opacity 0 (`rgba(..., 0)` discards its channels too);
 * - arithmetic keeps its operand order (the last bit of a Lab or Cubehelix channel depends on it);
 * - a space's factory with exactly one argument converts, with any other count it constructs, so `rgb()` is a colour
 *   of NaN channels and `rgb(undefined)` is a conversion of nothing;
 * - `toString` is `formatRgb` for every space.
 */

export const darker = 0.7
export const brighter = 1 / darker

const RADIANS = Math.PI / 180
const DEGREES = 180 / Math.PI

/** The brighten / darken multiplier for `steps` applications of `base` (one when no count is given). */
const gain = (base: number, steps: number | null | undefined): number => (steps == null ? base : Math.pow(base, steps))

// --- channel clamps and the text forms --------------------------------------------

const clampOpacity = (a: number): number => (isNaN(a) ? 1 : Math.max(0, Math.min(1, a)))
const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v) || 0))
const clampUnit = (v: number): number => Math.max(0, Math.min(1, v || 0))
const clampHue = (h: number): number => {
  const wrapped = (h || 0) % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}
const hexByte = (v: number): string => {
  const b = clampByte(v)
  return (b < 16 ? '0' : '') + b.toString(16)
}

/** `name(args)` or `name(args, alpha)`, with the alpha dropped when it is exactly 1. */
function cssFunction(name: string, args: readonly (number | string)[], opacity: number): string {
  const alpha = clampOpacity(opacity)
  return alpha === 1 ? `${name}(${args.join(', ')})` : `${name}a(${args.join(', ')}, ${alpha})`
}

// --- the base ---------------------------------------------------------------------

export abstract class Color {
  opacity!: number

  abstract rgb(): Rgb

  copy(channels: Record<string, unknown>): Color {
    const Concrete = this.constructor as new () => Color
    return Object.assign(new Concrete(), this, channels)
  }

  displayable(): boolean {
    return this.rgb().displayable()
  }

  hex(): string {
    return this.formatHex()
  }

  formatHex(): string {
    return this.rgb().formatHex()
  }

  formatHex8(): string {
    return this.rgb().formatHex8()
  }

  formatHsl(): string {
    return hslConvert(this).formatHsl()
  }

  formatRgb(): string {
    return this.rgb().formatRgb()
  }

  toString(): string {
    return this.formatRgb()
  }
}

// --- parsing ----------------------------------------------------------------------

const INTEGER = '[+-]?\\d+'
const DECIMAL = '[+-]?(?:\\d*\\.)?\\d+(?:[eE][+-]?\\d+)?'

/** One captured, whitespace-tolerant argument of a CSS function. */
const slot = (pattern: string, unit = ''): string => `\\s*(${pattern})${unit}\\s*`

/** `^name(slot,slot,...)$`; the argument list is comma-separated and nothing else is allowed around it. */
const functional = (name: string, ...slots: string[]): RegExp => new RegExp(`^${name}\\(${slots.join(',')}\\)$`)

const int = slot(INTEGER)
const num = slot(DECIMAL)
const pct = slot(DECIMAL, '%')

const HEX = /^#([0-9a-f]{3,8})$/
const RGB_INT = functional('rgb', int, int, int)
const RGB_PCT = functional('rgb', pct, pct, pct)
const RGBA_INT = functional('rgba', int, int, int, num)
const RGBA_PCT = functional('rgba', pct, pct, pct, num)
const HSL = functional('hsl', num, pct, pct)
const HSLA = functional('hsla', num, pct, pct, num)

/** The 148 CSS keywords, as `name:rrggbb` pairs; unpacked on first use. */
const KEYWORDS = 'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32'

let keywordTable: Map<string, number> | undefined
function keywordRgb(name: string): number | undefined {
  if (!keywordTable) {
    keywordTable = new Map()
    for (const pair of KEYWORDS.split(',')) {
      const at = pair.indexOf(':')
      keywordTable.set(pair.slice(0, at), parseInt(pair.slice(at + 1), 16))
    }
  }
  return keywordTable.get(name)
}

/** Opaque colour of a 24-bit integer. */
const fromRgb24 = (n: number): Rgb => new Rgb(n >> 16 & 0xff, n >> 8 & 0xff, n & 0xff, 1)

/** A colour with an alpha; a fully transparent one has no meaningful channels. */
const withAlpha = (r: number, g: number, b: number, alpha: number): Rgb =>
  alpha <= 0 ? new Rgb(NaN, NaN, NaN, alpha) : new Rgb(r, g, b, alpha)

/** An HSL colour whose undefined components follow from the others (black, white and grey have no hue). */
function hslWithAlpha(h: number, s: number, l: number, alpha: number): Hsl {
  if (alpha <= 0) return new Hsl(NaN, NaN, NaN, alpha)
  if (l <= 0 || l >= 1) return new Hsl(NaN, NaN, l, alpha)
  if (s <= 0) return new Hsl(NaN, s, l, alpha)
  return new Hsl(h, s, l, alpha)
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`; five- and seven-digit forms are refused. */
function parseHex(digits: string): Rgb | null {
  const n = digits.length
  if (n === 5 || n === 7) return null
  const full = n <= 4 ? digits.replace(/./g, '$&$&') : digits
  const value = parseInt(full, 16)
  if (full.length === 6) return fromRgb24(value)
  return withAlpha(value >> 24 & 0xff, value >> 16 & 0xff, value >> 8 & 0xff, (value & 0xff) / 0xff)
}

const percentToByte = (p: string): number => +p * 255 / 100

/** Parse a colour string; `null` for anything outside the grammar (modern CSS syntax included). */
export function color(format: unknown): Color | null {
  const text = (format + '').trim().toLowerCase()
  let m: RegExpExecArray | null
  if ((m = HEX.exec(text))) return parseHex(m[1]!)
  if ((m = RGB_INT.exec(text))) return new Rgb(+m[1]!, +m[2]!, +m[3]!, 1)
  if ((m = RGB_PCT.exec(text))) return new Rgb(percentToByte(m[1]!), percentToByte(m[2]!), percentToByte(m[3]!), 1)
  if ((m = RGBA_INT.exec(text))) return withAlpha(+m[1]!, +m[2]!, +m[3]!, +m[4]!)
  if ((m = RGBA_PCT.exec(text))) return withAlpha(percentToByte(m[1]!), percentToByte(m[2]!), percentToByte(m[3]!), +m[4]!)
  if ((m = HSL.exec(text))) return hslWithAlpha(+m[1]!, +m[2]! / 100, +m[3]! / 100, 1)
  if ((m = HSLA.exec(text))) return hslWithAlpha(+m[1]!, +m[2]! / 100, +m[3]! / 100, +m[4]!)
  const keyword = keywordRgb(text)
  if (keyword !== undefined) return fromRgb24(keyword)
  return text === 'transparent' ? new Rgb(NaN, NaN, NaN, 0) : null
}

/** What a space's factory does: one argument converts it, any other number of arguments builds from channels. */
function colorFactory<C extends Color>(
  convert: (input: unknown) => C,
  build: (a: unknown, b: unknown, c: unknown, opacity: unknown) => C,
): (...args: unknown[]) => C {
  return (...args) => (args.length === 1 ? convert(args[0]) : build(args[0], args[1], args[2], args[3] == null ? 1 : args[3]))
}

// --- RGB --------------------------------------------------------------------------

export class Rgb extends Color {
  declare readonly r: number
  declare readonly g: number
  declare readonly b: number
  declare opacity: number

  constructor(r?: unknown, g?: unknown, b?: unknown, opacity?: unknown) {
    super()
    this.r = +(r as number)
    this.g = +(g as number)
    this.b = +(b as number)
    this.opacity = +(opacity as number)
  }

  private scaled(m: number): Rgb {
    return new Rgb(this.r * m, this.g * m, this.b * m, this.opacity)
  }

  brighter(steps?: number | null): Rgb {
    return this.scaled(gain(brighter, steps))
  }

  darker(steps?: number | null): Rgb {
    return this.scaled(gain(darker, steps))
  }

  override rgb(): Rgb {
    return this
  }

  clamp(): Rgb {
    return new Rgb(clampByte(this.r), clampByte(this.g), clampByte(this.b), clampOpacity(this.opacity))
  }

  override displayable(): boolean {
    const inGamut = (v: number) => -0.5 <= v && v < 255.5
    return inGamut(this.r) && inGamut(this.g) && inGamut(this.b) && 0 <= this.opacity && this.opacity <= 1
  }

  override formatHex(): string {
    return '#' + hexByte(this.r) + hexByte(this.g) + hexByte(this.b)
  }

  override formatHex8(): string {
    return this.formatHex() + hexByte((isNaN(this.opacity) ? 1 : this.opacity) * 255)
  }

  override formatRgb(): string {
    return cssFunction('rgb', [clampByte(this.r), clampByte(this.g), clampByte(this.b)], this.opacity)
  }
}

export function rgbConvert(input: unknown): Rgb {
  const parsed = input instanceof Color ? input : color(input)
  if (!parsed) return new Rgb()
  const { r, g, b, opacity } = parsed.rgb()
  return new Rgb(r, g, b, opacity)
}

export const rgb = colorFactory(rgbConvert, (r, g, b, o) => new Rgb(r, g, b, o))

// --- HSL --------------------------------------------------------------------------

export class Hsl extends Color {
  declare readonly h: number
  declare readonly s: number
  declare readonly l: number
  declare opacity: number

  constructor(h?: unknown, s?: unknown, l?: unknown, opacity?: unknown) {
    super()
    this.h = +(h as number)
    this.s = +(s as number)
    this.l = +(l as number)
    this.opacity = +(opacity as number)
  }

  brighter(steps?: number | null): Hsl {
    return new Hsl(this.h, this.s, this.l * gain(brighter, steps), this.opacity)
  }

  darker(steps?: number | null): Hsl {
    return new Hsl(this.h, this.s, this.l * gain(darker, steps), this.opacity)
  }

  override rgb(): Rgb {
    const h = this.h % 360 + (this.h < 0 ? 1 : 0) * 360
    const s = isNaN(h) || isNaN(this.s) ? 0 : this.s
    const l = this.l
    const upper = l + (l < 0.5 ? l : 1 - l) * s
    const lower = 2 * l - upper
    return new Rgb(
      hslChannel(h >= 240 ? h - 240 : h + 120, lower, upper),
      hslChannel(h, lower, upper),
      hslChannel(h < 120 ? h + 240 : h - 120, lower, upper),
      this.opacity,
    )
  }

  clamp(): Hsl {
    return new Hsl(clampHue(this.h), clampUnit(this.s), clampUnit(this.l), clampOpacity(this.opacity))
  }

  override displayable(): boolean {
    return (0 <= this.s && this.s <= 1 || isNaN(this.s)) && 0 <= this.l && this.l <= 1 && 0 <= this.opacity && this.opacity <= 1
  }

  override formatHsl(): string {
    return cssFunction('hsl', [clampHue(this.h), clampUnit(this.s) * 100 + '%', clampUnit(this.l) * 100 + '%'], this.opacity)
  }
}

/** One RGB channel (0..255) of a hue sector, given the lower and upper lightness bounds. */
function hslChannel(hue: number, lower: number, upper: number): number {
  const unit = hue < 60 ? lower + (upper - lower) * hue / 60
    : hue < 180 ? upper
    : hue < 240 ? lower + (upper - lower) * (240 - hue) / 60
    : lower
  return unit * 255
}

export function hslConvert(input: unknown): Hsl {
  if (input instanceof Hsl) return new Hsl(input.h, input.s, input.l, input.opacity)
  const parsed = input instanceof Color ? input : color(input)
  if (!parsed) return new Hsl()
  if (parsed instanceof Hsl) return parsed
  const rgbColor = parsed.rgb()
  const r = rgbColor.r / 255
  const g = rgbColor.g / 255
  const b = rgbColor.b / 255
  const lo = Math.min(r, g, b)
  const hi = Math.max(r, g, b)
  const l = (hi + lo) / 2
  let h = NaN
  let s = hi - lo
  if (s) {
    h = r === hi ? (g - b) / s + (g < b ? 1 : 0) * 6
      : g === hi ? (b - r) / s + 2
      : (r - g) / s + 4
    s /= l < 0.5 ? hi + lo : 2 - hi - lo
    h *= 60
  } else {
    s = l > 0 && l < 1 ? 0 : h
  }
  return new Hsl(h, s, l, rgbColor.opacity)
}

export const hsl = colorFactory(hslConvert, (h, s, l, o) => new Hsl(h, s, l, o))

// --- Lab and HCL (CIE Lab under the D50 white point) --------------------------------

const LAB_STEP = 18
const WHITE_X = 0.96422
const WHITE_Y = 1
const WHITE_Z = 0.82521
const KNEE = 6 / 29
const LOW_OFFSET = 4 / 29
const LOW_SLOPE = 3 * KNEE * KNEE
const KNEE_CUBED = KNEE * KNEE * KNEE

/** Linear sRGB to D50 XYZ, one row per output. */
const LINEAR_TO_XYZ = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733],
] as const
/** D50 XYZ to linear sRGB. */
const XYZ_TO_LINEAR = [
  [3.1338561, -1.6168667, -0.4906146],
  [-0.9787684, 1.9161415, 0.0334540],
  [0.0719453, -0.2289914, 1.4052427],
] as const

const dot = (row: readonly number[], a: number, b: number, c: number): number => row[0]! * a + row[1]! * b + row[2]! * c

const encodeGamma = (v: number): number => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)
const decodeGamma = (byte: number): number => ((byte /= 255) <= 0.04045 ? byte / 12.92 : Math.pow((byte + 0.055) / 1.055, 2.4))
const labCompress = (t: number): number => (t > KNEE_CUBED ? Math.pow(t, 1 / 3) : t / LOW_SLOPE + LOW_OFFSET)
const labExpand = (t: number): number => (t > KNEE ? t * t * t : LOW_SLOPE * (t - LOW_OFFSET))

export class Lab extends Color {
  declare readonly l: number
  declare readonly a: number
  declare readonly b: number
  declare opacity: number

  constructor(l?: unknown, a?: unknown, b?: unknown, opacity?: unknown) {
    super()
    this.l = +(l as number)
    this.a = +(a as number)
    this.b = +(b as number)
    this.opacity = +(opacity as number)
  }

  brighter(steps?: number | null): Lab {
    return new Lab(this.l + LAB_STEP * (steps == null ? 1 : steps), this.a, this.b, this.opacity)
  }

  darker(steps?: number | null): Lab {
    return new Lab(this.l - LAB_STEP * (steps == null ? 1 : steps), this.a, this.b, this.opacity)
  }

  override rgb(): Rgb {
    const fy = (this.l + 16) / 116
    const fx = isNaN(this.a) ? fy : fy + this.a / 500
    const fz = isNaN(this.b) ? fy : fy - this.b / 200
    const x = WHITE_X * labExpand(fx)
    const y = WHITE_Y * labExpand(fy)
    const z = WHITE_Z * labExpand(fz)
    return new Rgb(
      encodeGamma(dot(XYZ_TO_LINEAR[0], x, y, z)),
      encodeGamma(dot(XYZ_TO_LINEAR[1], x, y, z)),
      encodeGamma(dot(XYZ_TO_LINEAR[2], x, y, z)),
      this.opacity,
    )
  }
}

function labConvert(input: unknown): Lab {
  if (input instanceof Lab) return new Lab(input.l, input.a, input.b, input.opacity)
  if (input instanceof Hcl) return hclToLab(input)
  const { r, g, b, opacity } = input instanceof Rgb ? input : rgbConvert(input)
  const lr = decodeGamma(r)
  const lg = decodeGamma(g)
  const lb = decodeGamma(b)
  const fy = labCompress(dot(LINEAR_TO_XYZ[1], lr, lg, lb) / WHITE_Y)
  // a neutral colour has identical X, Y and Z ratios; skip the matrix rows that would round them apart
  const neutral = lr === lg && lg === lb
  const fx = neutral ? fy : labCompress(dot(LINEAR_TO_XYZ[0], lr, lg, lb) / WHITE_X)
  const fz = neutral ? fy : labCompress(dot(LINEAR_TO_XYZ[2], lr, lg, lb) / WHITE_Z)
  return new Lab(116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz), opacity)
}

export const lab = colorFactory(labConvert, (l, a, b, o) => new Lab(l, a, b, o))

export function gray(l: number, opacity?: number): Lab {
  return new Lab(l, 0, 0, opacity == null ? 1 : opacity)
}

export class Hcl extends Color {
  declare readonly h: number
  declare readonly c: number
  declare readonly l: number
  declare opacity: number

  constructor(h?: unknown, c?: unknown, l?: unknown, opacity?: unknown) {
    super()
    this.h = +(h as number)
    this.c = +(c as number)
    this.l = +(l as number)
    this.opacity = +(opacity as number)
  }

  brighter(steps?: number | null): Hcl {
    return new Hcl(this.h, this.c, this.l + LAB_STEP * (steps == null ? 1 : steps), this.opacity)
  }

  darker(steps?: number | null): Hcl {
    return new Hcl(this.h, this.c, this.l - LAB_STEP * (steps == null ? 1 : steps), this.opacity)
  }

  override rgb(): Rgb {
    return hclToLab(this).rgb()
  }
}

function hclToLab(c: Hcl): Lab {
  if (isNaN(c.h)) return new Lab(c.l, 0, 0, c.opacity)
  const angle = c.h * RADIANS
  return new Lab(c.l, Math.cos(angle) * c.c, Math.sin(angle) * c.c, c.opacity)
}

function hclConvert(input: unknown): Hcl {
  if (input instanceof Hcl) return new Hcl(input.h, input.c, input.l, input.opacity)
  const { l, a, b, opacity } = input instanceof Lab ? input : labConvert(input)
  if (a === 0 && b === 0) return new Hcl(NaN, 0 < l && l < 100 ? 0 : NaN, l, opacity)
  const h = Math.atan2(b, a) * DEGREES
  return new Hcl(h < 0 ? h + 360 : h, Math.sqrt(a * a + b * b), l, opacity)
}

export const hcl = colorFactory(hclConvert, (h, c, l, o) => new Hcl(h, c, l, o))
/** `lch(l, c, h)` is `hcl(h, c, l)` with the channels in the other order. */
export const lch = colorFactory(hclConvert, (l, c, h, o) => new Hcl(h, c, l, o))

// --- Cubehelix --------------------------------------------------------------------

const CH_A = -0.14861
const CH_B = +1.78277
const CH_C = -0.29227
const CH_D = -0.90649
const CH_E = +1.97294
const CH_ED = CH_E * CH_D
const CH_EB = CH_E * CH_B
const CH_BC_DA = CH_B * CH_C - CH_D * CH_A

export class Cubehelix extends Color {
  declare readonly h: number
  declare readonly s: number
  declare readonly l: number
  declare opacity: number

  constructor(h?: unknown, s?: unknown, l?: unknown, opacity?: unknown) {
    super()
    this.h = +(h as number)
    this.s = +(s as number)
    this.l = +(l as number)
    this.opacity = +(opacity as number)
  }

  brighter(steps?: number | null): Cubehelix {
    return new Cubehelix(this.h, this.s, this.l * gain(brighter, steps), this.opacity)
  }

  darker(steps?: number | null): Cubehelix {
    return new Cubehelix(this.h, this.s, this.l * gain(darker, steps), this.opacity)
  }

  override rgb(): Rgb {
    const angle = isNaN(this.h) ? 0 : (this.h + 120) * RADIANS
    const l = +this.l
    const amp = isNaN(this.s) ? 0 : this.s * l * (1 - l)
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    return new Rgb(
      255 * (l + amp * (CH_A * cos + CH_B * sin)),
      255 * (l + amp * (CH_C * cos + CH_D * sin)),
      255 * (l + amp * (CH_E * cos)),
      this.opacity,
    )
  }
}

function cubehelixConvert(input: unknown): Cubehelix {
  if (input instanceof Cubehelix) return new Cubehelix(input.h, input.s, input.l, input.opacity)
  const source = input instanceof Rgb ? input : rgbConvert(input)
  const r = source.r / 255
  const g = source.g / 255
  const b = source.b / 255
  const l = (CH_BC_DA * b + CH_ED * r - CH_EB * g) / (CH_BC_DA + CH_ED - CH_EB)
  const bl = b - l
  const k = (CH_E * (g - l) - CH_C * bl) / CH_D
  const s = Math.sqrt(k * k + bl * bl) / (CH_E * l * (1 - l))
  const h = s ? Math.atan2(k, bl) * DEGREES - 120 : NaN
  return new Cubehelix(h < 0 ? h + 360 : h, s, l, source.opacity)
}

export const cubehelix = colorFactory(cubehelixConvert, (h, s, l, o) => new Cubehelix(h, s, l, o))
