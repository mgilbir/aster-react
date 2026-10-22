/**
 * Colour parsing and colour spaces (RGB, HSL, Lab, HCL).
 *
 * A faithful port of the `d3-color` surface the engine uses: the CSS colour
 * parser behind `rgb()`/`hsl()`/`lab()`/`hcl()` (also the expression functions
 * of the same names, which upstream re-exports from d3-color directly), the
 * conversions between the spaces, and the colour objects' formatting and
 * brighten/darken methods.
 *
 * Behaviour is pinned by vectors recorded from the pinned oracle
 * (`testdata/vectors/d3-color.json`), including the deliberate quirks:
 * channels are *not* clamped (`rgb(300, 0, 0)` stays out of gamut until it is
 * formatted), `'transparent'` parses to NaN channels with opacity 0, an
 * unparsable string converts to all-NaN channels via `rgbConvert`, and
 * `toString` is `formatRgb` — always `rgb(r, g, b)` with rounded channels.
 */

// --- shared constants --------------------------------------------------------

const radians = Math.PI / 180
const degrees = 180 / Math.PI

/** The brighten/darken factors shared by every colour space (upstream `darker = 0.7`). */
export const darker = 0.7
export const brighter = 1 / darker

// --- base class --------------------------------------------------------------

export abstract class Color {
  opacity!: number

  copy(channels: Record<string, unknown>): Color {
    // Object.assign onto a fresh instance of the concrete class, as upstream.
    const Ctor = this.constructor as new () => Color
    return Object.assign(new Ctor(), this, channels)
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

  abstract rgb(): Rgb
}

// --- parsing -----------------------------------------------------------------

const reI = '\\s*([+-]?\\d+)\\s*'
const reN = '\\s*([+-]?(?:\\d*\\.)?\\d+(?:[eE][+-]?\\d+)?)\\s*'
const reP = '\\s*([+-]?(?:\\d*\\.)?\\d+(?:[eE][+-]?\\d+)?)%\\s*'
const reHex = /^#([0-9a-f]{3,8})$/
const reRgbInteger = new RegExp(`^rgb\\(${reI},${reI},${reI}\\)$`)
const reRgbPercent = new RegExp(`^rgb\\(${reP},${reP},${reP}\\)$`)
const reRgbaInteger = new RegExp(`^rgba\\(${reI},${reI},${reI},${reN}\\)$`)
const reRgbaPercent = new RegExp(`^rgba\\(${reP},${reP},${reP},${reN}\\)$`)
const reHslPercent = new RegExp(`^hsl\\(${reN},${reP},${reP}\\)$`)
const reHslaPercent = new RegExp(`^hsla\\(${reN},${reP},${reP},${reN}\\)$`)

/** The 148 CSS colour keywords upstream knows, as `0xRRGGBB` literals. */
const named: Record<string, number> = {
  aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4,
  azure: 0xf0ffff, beige: 0xf5f5dc, bisque: 0xffe4c4, black: 0x000000,
  blanchedalmond: 0xffebcd, blue: 0x0000ff, blueviolet: 0x8a2be2, brown: 0xa52a2a,
  burlywood: 0xdeb887, cadetblue: 0x5f9ea0, chartreuse: 0x7fff00, chocolate: 0xd2691e,
  coral: 0xff7f50, cornflowerblue: 0x6495ed, cornsilk: 0xfff8dc, crimson: 0xdc143c,
  cyan: 0x00ffff, darkblue: 0x00008b, darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b,
  darkgray: 0xa9a9a9, darkgreen: 0x006400, darkgrey: 0xa9a9a9, darkkhaki: 0xbdb76b,
  darkmagenta: 0x8b008b, darkolivegreen: 0x556b2f, darkorange: 0xff8c00, darkorchid: 0x9932cc,
  darkred: 0x8b0000, darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f, darkslateblue: 0x483d8b,
  darkslategray: 0x2f4f4f, darkslategrey: 0x2f4f4f, darkturquoise: 0x00ced1, darkviolet: 0x9400d3,
  deeppink: 0xff1493, deepskyblue: 0x00bfff, dimgray: 0x696969, dimgrey: 0x696969,
  dodgerblue: 0x1e90ff, firebrick: 0xb22222, floralwhite: 0xfffaf0, forestgreen: 0x228b22,
  fuchsia: 0xff00ff, gainsboro: 0xdcdcdc, ghostwhite: 0xf8f8ff, gold: 0xffd700,
  goldenrod: 0xdaa520, gray: 0x808080, green: 0x008000, greenyellow: 0xadff2f,
  grey: 0x808080, honeydew: 0xf0fff0, hotpink: 0xff69b4, indianred: 0xcd5c5c,
  indigo: 0x4b0082, ivory: 0xfffff0, khaki: 0xf0e68c, lavender: 0xe6e6fa,
  lavenderblush: 0xfff0f5, lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd, lightblue: 0xadd8e6,
  lightcoral: 0xf08080, lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2, lightgray: 0xd3d3d3,
  lightgreen: 0x90ee90, lightgrey: 0xd3d3d3, lightpink: 0xffb6c1, lightsalmon: 0xffa07a,
  lightseagreen: 0x20b2aa, lightskyblue: 0x87cefa, lightslategray: 0x778899, lightslategrey: 0x778899,
  lightsteelblue: 0xb0c4de, lightyellow: 0xffffe0, lime: 0x00ff00, limegreen: 0x32cd32,
  linen: 0xfaf0e6, magenta: 0xff00ff, maroon: 0x800000, mediumaquamarine: 0x66cdaa,
  mediumblue: 0x0000cd, mediumorchid: 0xba55d3, mediumpurple: 0x9370db, mediumseagreen: 0x3cb371,
  mediumslateblue: 0x7b68ee, mediumspringgreen: 0x00fa9a, mediumturquoise: 0x48d1cc,
  mediumvioletred: 0xc71585, midnightblue: 0x191970, mintcream: 0xf5fffa, mistyrose: 0xffe4e1,
  moccasin: 0xffe4b5, navajowhite: 0xffdead, navy: 0x000080, oldlace: 0xfdf5e6,
  olive: 0x808000, olivedrab: 0x6b8e23, orange: 0xffa500, orangered: 0xff4500,
  orchid: 0xda70d6, palegoldenrod: 0xeee8aa, palegreen: 0x98fb98, paleturquoise: 0xafeeee,
  palevioletred: 0xdb7093, papayawhip: 0xffefd5, peachpuff: 0xffdab9, peru: 0xcd853f,
  pink: 0xffc0cb, plum: 0xdda0dd, powderblue: 0xb0e0e6, purple: 0x800080,
  rebeccapurple: 0x663399, red: 0xff0000, rosybrown: 0xbc8f8f, royalblue: 0x4169e1,
  saddlebrown: 0x8b4513, salmon: 0xfa8072, sandybrown: 0xf4a460, seagreen: 0x2e8b57,
  seashell: 0xfff5ee, sienna: 0xa0522d, silver: 0xc0c0c0, skyblue: 0x87ceeb,
  slateblue: 0x6a5acd, slategray: 0x708090, slategrey: 0x708090, snow: 0xfffafa,
  springgreen: 0x00ff7f, steelblue: 0x4682b4, tan: 0xd2b48c, teal: 0x008080,
  thistle: 0xd8bfd8, tomato: 0xff6347, turquoise: 0x40e0d0, violet: 0xee82ee,
  wheat: 0xf5deb3, white: 0xffffff, whitesmoke: 0xf5f5f5, yellow: 0xffff00,
  yellowgreen: 0x9acd32,
}

/**
 * Parse a CSS colour string. Returns `null` for anything the grammar above
 * rejects — including modern CSS syntax (e.g. `rgb(1 2 3)`, `color(display-p3 …)`)
 * upstream does not know.
 */
export function color(format: unknown): Color | null {
  let m: RegExpExecArray | null
  format = (format + '').trim().toLowerCase()
  if ((m = reHex.exec(format as string))) return hexBody(m)
  if ((m = reRgbInteger.exec(format as string))) return new Rgb(+m[1]!, +m[2]!, +m[3]!, 1)
  if ((m = reRgbPercent.exec(format as string))) return new Rgb(+m[1]! * 255 / 100, +m[2]! * 255 / 100, +m[3]! * 255 / 100, 1)
  if ((m = reRgbaInteger.exec(format as string))) return rgba(+m[1]!, +m[2]!, +m[3]!, +m[4]!)
  if ((m = reRgbaPercent.exec(format as string))) return rgba(+m[1]! * 255 / 100, +m[2]! * 255 / 100, +m[3]! * 255 / 100, +m[4]!)
  if ((m = reHslPercent.exec(format as string))) return hsla(+m[1]!, +m[2]! / 100, +m[3]! / 100, 1)
  if ((m = reHslaPercent.exec(format as string))) return hsla(+m[1]!, +m[2]! / 100, +m[3]! / 100, +m[4]!)
  if (Object.prototype.hasOwnProperty.call(named, format as string)) return rgbn((named as Record<string, number>)[format as string]!)
  if (format === 'transparent') return new Rgb(NaN, NaN, NaN, 0)
  return null
}

/** Expand a hex match into a colour, or `null` for an invalid length. */
function hexBody(m: RegExpExecArray): Color | null {
  const l = m[1]!.length
  const n = parseInt(m[1]!, 16)
  return l === 6 ? rgbn(n)
    : l === 3 ? new Rgb((n >> 8 & 0xf) | (n >> 4 & 0xf0), (n >> 4 & 0xf) | (n & 0xf0), ((n & 0xf) << 4) | (n & 0xf), 1)
    : l === 8 ? rgba(n >> 24 & 0xff, n >> 16 & 0xff, n >> 8 & 0xff, (n & 0xff) / 0xff)
    : l === 4 ? rgba((n >> 12 & 0xf) | (n >> 8 & 0xf0), (n >> 8 & 0xf) | (n >> 4 & 0xf0), (n >> 4 & 0xf) | (n & 0xf0), (((n & 0xf) << 4) | (n & 0xf)) / 0xff)
    : null
}

function rgbn(n: number): Rgb {
  return new Rgb(n >> 16 & 0xff, n >> 8 & 0xff, n & 0xff, 1)
}

function rgba(r: number, g: number, b: number, a: number): Rgb {
  if (a <= 0) r = g = b = NaN
  return new Rgb(r, g, b, a)
}

// --- RGB ---------------------------------------------------------------------

/** Coerce anything (spec string or colour) to an `Rgb`; unparsable input is all-NaN. */
export function rgbConvert(o: unknown): Rgb {
  const c: Color | null = o instanceof Color ? o : color(o)
  if (!c) return new Rgb()
  const r = c.rgb()
  return new Rgb(r.r, r.g, r.b, r.opacity)
}

/** The `rgb()` colour factory: one argument parses, four construct. */
export function rgb(r?: unknown, g?: unknown, b?: unknown, opacity?: unknown): Rgb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return arguments.length === 1 ? rgbConvert(r) : new Rgb(r as any, g as any, b as any, opacity == null ? 1 : (opacity as number))
}

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

  brighter(k?: number): Rgb {
    const m = k == null ? brighter : Math.pow(brighter, k)
    return new Rgb(this.r * m, this.g * m, this.b * m, this.opacity)
  }

  darker(k?: number): Rgb {
    const m = k == null ? darker : Math.pow(darker, k)
    return new Rgb(this.r * m, this.g * m, this.b * m, this.opacity)
  }

  override rgb(): Rgb {
    return this
  }

  clamp(): Rgb {
    return new Rgb(clampi(this.r), clampi(this.g), clampi(this.b), clampa(this.opacity))
  }

  override displayable(): boolean {
    return (-0.5 <= this.r && this.r < 255.5)
      && (-0.5 <= this.g && this.g < 255.5)
      && (-0.5 <= this.b && this.b < 255.5)
      && (0 <= this.opacity && this.opacity <= 1)
  }

  override formatHex(): string {
    return `#${hex(this.r)}${hex(this.g)}${hex(this.b)}`
  }

  override formatHex8(): string {
    return `#${hex(this.r)}${hex(this.g)}${hex(this.b)}${hex((isNaN(this.opacity) ? 1 : this.opacity) * 255)}`
  }

  override formatRgb(): string {
    const a = clampa(this.opacity)
    return `${a === 1 ? 'rgb(' : 'rgba('}${clampi(this.r)}, ${clampi(this.g)}, ${clampi(this.b)}${a === 1 ? ')' : `, ${a})`}`
  }
}

function clampa(opacity: number): number {
  return isNaN(opacity) ? 1 : Math.max(0, Math.min(1, opacity))
}

function clampi(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value) || 0))
}

function hex(value: number): string {
  value = clampi(value)
  return (value < 16 ? '0' : '') + value.toString(16)
}

// --- HSL ---------------------------------------------------------------------

function hsla(h: number, s: number, l: number, a: number): Hsl {
  if (a <= 0) h = s = l = NaN
  else if (l <= 0 || l >= 1) h = s = NaN
  else if (s <= 0) h = NaN
  return new Hsl(h, s, l, a)
}

export function hslConvert(o: unknown): Hsl {
  if (o instanceof Hsl) return new Hsl(o.h, o.s, o.l, o.opacity)
  const c: Color | null = o instanceof Color ? o : color(o)
  if (!c) return new Hsl()
  if (c instanceof Hsl) return c
  const rgbC = c.rgb()
  const r = rgbC.r / 255
  const g = rgbC.g / 255
  const b = rgbC.b / 255
  const min = Math.min(r, g, b)
  const max = Math.max(r, g, b)
  let h = NaN
  let s = max - min
  const l = (max + min) / 2
  if (s) {
    if (r === max) h = (g - b) / s + (g < b ? 1 : 0) * 6
    else if (g === max) h = (b - r) / s + 2
    else h = (r - g) / s + 4
    s /= l < 0.5 ? max + min : 2 - max - min
    h *= 60
  } else {
    s = l > 0 && l < 1 ? 0 : h
  }
  return new Hsl(h, s, l, rgbC.opacity)
}

export function hsl(h?: unknown, s?: unknown, l?: unknown, opacity?: unknown): Hsl {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return arguments.length === 1 ? hslConvert(h) : new Hsl(h as any, s as any, l as any, opacity == null ? 1 : (opacity as number))
}

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

  brighter(k?: number): Hsl {
    const m = k == null ? brighter : Math.pow(brighter, k)
    return new Hsl(this.h, this.s, this.l * m, this.opacity)
  }

  darker(k?: number): Hsl {
    const m = k == null ? darker : Math.pow(darker, k)
    return new Hsl(this.h, this.s, this.l * m, this.opacity)
  }

  override rgb(): Rgb {
    const h = this.h % 360 + (this.h < 0 ? 1 : 0) * 360
    const s = isNaN(h) || isNaN(this.s) ? 0 : this.s
    const l = this.l
    const m2 = l + (l < 0.5 ? l : 1 - l) * s
    const m1 = 2 * l - m2
    return new Rgb(
      hsl2rgb(h >= 240 ? h - 240 : h + 120, m1, m2),
      hsl2rgb(h, m1, m2),
      hsl2rgb(h < 120 ? h + 240 : h - 120, m1, m2),
      this.opacity,
    )
  }

  clamp(): Hsl {
    return new Hsl(clamph(this.h), clampt(this.s), clampt(this.l), clampa(this.opacity))
  }

  override displayable(): boolean {
    return (0 <= this.s && this.s <= 1 || isNaN(this.s))
      && (0 <= this.l && this.l <= 1)
      && (0 <= this.opacity && this.opacity <= 1)
  }

  override formatHsl(): string {
    const a = clampa(this.opacity)
    return `${a === 1 ? 'hsl(' : 'hsla('}${clamph(this.h)}, ${clampt(this.s) * 100}%, ${clampt(this.l) * 100}%${a === 1 ? ')' : `, ${a})`}`
  }
}

function clamph(value: number): number {
  value = (value || 0) % 360
  return value < 0 ? value + 360 : value
}

function clampt(value: number): number {
  return Math.max(0, Math.min(1, value || 0))
}

/* From FvD 13.37, CSS Color Module Level 3 */
function hsl2rgb(h: number, m1: number, m2: number): number {
  return (h < 60 ? m1 + (m2 - m1) * h / 60
    : h < 180 ? m2
    : h < 240 ? m1 + (m2 - m1) * (240 - h) / 60
    : m1) * 255
}

// --- Lab / HCL ---------------------------------------------------------------

// https://observablehq.com/@mbostock/lab-and-rgb
const K = 18
const Xn = 0.96422
const Yn = 1
const Zn = 0.82521
const t0 = 4 / 29
const t1 = 6 / 29
const t2 = 3 * t1 * t1
const t3 = t1 * t1 * t1

function labConvert(o: unknown): Lab {
  if (o instanceof Lab) return new Lab(o.l, o.a, o.b, o.opacity)
  if (o instanceof Hcl) return hcl2lab(o)
  const c = o instanceof Rgb ? o : rgbConvert(o)
  const r = rgb2lrgb(c.r)
  const g = rgb2lrgb(c.g)
  const b = rgb2lrgb(c.b)
  const y = xyz2lab((0.2225045 * r + 0.7168786 * g + 0.0606169 * b) / Yn)
  let x: number
  let z: number
  if (r === g && g === b) x = z = y
  else {
    x = xyz2lab((0.4360747 * r + 0.3850649 * g + 0.1430804 * b) / Xn)
    z = xyz2lab((0.0139322 * r + 0.0971045 * g + 0.7141733 * b) / Zn)
  }
  return new Lab(116 * y - 16, 500 * (x - y), 200 * (y - z), c.opacity)
}

export function gray(l: number, opacity?: number): Lab {
  return new Lab(l, 0, 0, opacity == null ? 1 : opacity)
}

export function lab(l?: unknown, a?: unknown, b?: unknown, opacity?: unknown): Lab {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return arguments.length === 1 ? labConvert(l) : new Lab(l as any, a as any, b as any, opacity == null ? 1 : (opacity as number))
}

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

  brighter(k?: number): Lab {
    return new Lab(this.l + K * (k == null ? 1 : k), this.a, this.b, this.opacity)
  }

  darker(k?: number): Lab {
    return new Lab(this.l - K * (k == null ? 1 : k), this.a, this.b, this.opacity)
  }

  override rgb(): Rgb {
    let y = (this.l + 16) / 116
    let x = isNaN(this.a) ? y : y + this.a / 500
    let z = isNaN(this.b) ? y : y - this.b / 200
    x = Xn * lab2xyz(x)
    y = Yn * lab2xyz(y)
    z = Zn * lab2xyz(z)
    return new Rgb(
      lrgb2rgb(3.1338561 * x - 1.6168667 * y - 0.4906146 * z),
      lrgb2rgb(-0.9787684 * x + 1.9161415 * y + 0.0334540 * z),
      lrgb2rgb(0.0719453 * x - 0.2289914 * y + 1.4052427 * z),
      this.opacity,
    )
  }
}

function xyz2lab(t: number): number {
  return t > t3 ? Math.pow(t, 1 / 3) : t / t2 + t0
}

function lab2xyz(t: number): number {
  return t > t1 ? t * t * t : t2 * (t - t0)
}

function lrgb2rgb(x: number): number {
  return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)
}

function rgb2lrgb(x: number): number {
  return (x /= 255) <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
}

function hclConvert(o: unknown): Hcl {
  if (o instanceof Hcl) return new Hcl(o.h, o.c, o.l, o.opacity)
  const c = o instanceof Lab ? o : labConvert(o)
  if (c.a === 0 && c.b === 0) return new Hcl(NaN, 0 < c.l && c.l < 100 ? 0 : NaN, c.l, c.opacity)
  const h = Math.atan2(c.b, c.a) * degrees
  return new Hcl(h < 0 ? h + 360 : h, Math.sqrt(c.a * c.a + c.b * c.b), c.l, c.opacity)
}

export function lch(l?: unknown, c?: unknown, h?: unknown, opacity?: unknown): Hcl {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return arguments.length === 1 ? hclConvert(l) : new Hcl(h as any, c as any, l as any, opacity == null ? 1 : (opacity as number))
}

export function hcl(h?: unknown, c?: unknown, l?: unknown, opacity?: unknown): Hcl {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return arguments.length === 1 ? hclConvert(h) : new Hcl(h as any, c as any, l as any, opacity == null ? 1 : (opacity as number))
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

  brighter(k?: number): Hcl {
    return new Hcl(this.h, this.c, this.l + K * (k == null ? 1 : k), this.opacity)
  }

  darker(k?: number): Hcl {
    return new Hcl(this.h, this.c, this.l - K * (k == null ? 1 : k), this.opacity)
  }

  override rgb(): Rgb {
    return hcl2lab(this).rgb()
  }
}

function hcl2lab(o: Hcl): Lab {
  if (isNaN(o.h)) return new Lab(o.l, 0, 0, o.opacity)
  const h = o.h * radians
  return new Lab(o.l, Math.cos(h) * o.c, Math.sin(h) * o.c, o.opacity)
}

// --- Cubehelix ---------------------------------------------------------------

const CH_A = -0.14861
const CH_B = +1.78277
const CH_C = -0.29227
const CH_D = -0.90649
const CH_E = +1.97294
const CH_ED = CH_E * CH_D
const CH_EB = CH_E * CH_B
const CH_BC_DA = CH_B * CH_C - CH_D * CH_A

function cubehelixConvert(o: unknown): Cubehelix {
  if (o instanceof Cubehelix) return new Cubehelix(o.h, o.s, o.l, o.opacity)
  const c = o instanceof Rgb ? o : rgbConvert(o)
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const l = (CH_BC_DA * b + CH_ED * r - CH_EB * g) / (CH_BC_DA + CH_ED - CH_EB)
  const bl = b - l
  const k = (CH_E * (g - l) - CH_C * bl) / CH_D
  const s = Math.sqrt(k * k + bl * bl) / (CH_E * l * (1 - l)) // NaN if l=0 or l=1
  const h = s ? Math.atan2(k, bl) * degrees - 120 : NaN
  return new Cubehelix(h < 0 ? h + 360 : h, s, l, c.opacity)
}

/** d3-color's `cubehelix`: one argument parses/converts, four construct. */
export function cubehelix(h?: unknown, s?: unknown, l?: unknown, opacity?: unknown): Cubehelix {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return arguments.length === 1 ? cubehelixConvert(h) : new Cubehelix(h as any, s as any, l as any, opacity == null ? 1 : (opacity as number))
}

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

  brighter(k?: number): Cubehelix {
    const m = k == null ? brighter : Math.pow(brighter, k)
    return new Cubehelix(this.h, this.s, this.l * m, this.opacity)
  }

  darker(k?: number): Cubehelix {
    const m = k == null ? darker : Math.pow(darker, k)
    return new Cubehelix(this.h, this.s, this.l * m, this.opacity)
  }

  override rgb(): Rgb {
    const h = isNaN(this.h) ? 0 : (this.h + 120) * radians
    const l = +this.l
    const a = isNaN(this.s) ? 0 : this.s * l * (1 - l)
    const cosh = Math.cos(h)
    const sinh = Math.sin(h)
    return new Rgb(
      255 * (l + a * (CH_A * cosh + CH_B * sinh)),
      255 * (l + a * (CH_C * cosh + CH_D * sinh)),
      255 * (l + a * (CH_E * cosh)),
      this.opacity,
    )
  }
}
