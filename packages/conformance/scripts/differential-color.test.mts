/**
 * GENERATED live differential of colour parsing and the colour spaces: Aster's `color.ts` against the pinned d3-color
 * in one process. Strings are well-formed and malformed (every CSS function with spacing, signs, exponents, percents,
 * wrong arity, uppercase, stray characters), plus every keyword; constructors get numbers, NaN, strings and nothing.
 * Compared: the class, every channel (NaN and -0 apart), the string forms, displayable, clamp, brighter / darker and
 * the conversion to every other space. Exact equality: both sides run the same V8.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as d3 from 'd3-color'
import { describe, expect, it, vi } from 'vitest'
import * as aster from '../../core/src/color.ts'
import { compareCases, makeRng, scaled, type Rng } from './differential-gen.mts'

vi.setConfig({ testTimeout: 60_000 })

const require = createRequire(import.meta.url)
const NAMES = Object.keys(
  Function(`${/var named = (\{[\s\S]*?\});/.exec(readFileSync(join(dirname(require.resolve('d3-color')), 'color.js'), 'utf8'))![1]!.replace(/^/, 'return ')}`)() as Record<string, number>,
)

type AnyColor = Record<string, unknown> & {
  constructor: { name: string }
  rgb(): AnyColor; brighter(k?: unknown): AnyColor; darker(k?: unknown): AnyColor; clamp?(): AnyColor; copy(c: unknown): AnyColor
  formatRgb(): string; formatHex(): string; formatHex8(): string; formatHsl(): string; displayable(): boolean; toString(): string; hex?(): string
}

const channels = (c: AnyColor): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(c).sort()) out[k] = c[k]
  return out
}

/** Everything observable about a colour; the value of `k` for brighter / darker is part of the key. */
function project(c: AnyColor | null, k: unknown): unknown {
  if (c === null || typeof c !== 'object') return c
  return {
    type: c.constructor.name,
    channels: channels(c),
    str: [c.formatRgb(), c.formatHex(), c.formatHex8(), c.formatHsl(), c.displayable(), String(c), `${c}`, c.hex?.()],
    brighter: [channels(c.brighter()), channels(c.brighter(k))],
    darker: [channels(c.darker()), channels(c.darker(k))],
    clamp: c.clamp ? channels(c.clamp()) : 'none',
    rgb: channels(c.rgb()),
    copy: channels(c.copy({ opacity: 0.25 })),
    copyType: c.copy({ opacity: 0.25 }).constructor.name,
  }
}

const SEPARATORS = [',', ', ', ' , ', ',  ', ' ', ' / ', ';', '']
const NUMBERS = ['0', '1', '7', '51', '128', '255', '256', '300', '-5', '+5', '0.5', '.5', '5.', '1e2', '1E2', '1e', '2.5e-1', '99.9', '100', '360', '-90', 'NaN', 'Infinity', '0x10', '1_0', '--1', '1.2.3', '१']

function genNumber(r: Rng, percent: boolean): string {
  const base = r.chance(0.7) ? String(r.between(0, 300)) : r.chance(0.5) ? (r.next() * 300).toFixed(r.int(4)) : r.pick(NUMBERS)
  return (r.chance(0.1) ? r.pick(['-', '+']) : '') + base + (percent ? (r.chance(0.92) ? '%' : '') : r.chance(0.04) ? '%' : '')
}

function genColorString(r: Rng): string {
  const pad = () => r.pick(['', '', '', ' ', '  ', '\t', '\n'])
  const k = r.int(14)
  if (k === 0) return pad() + r.pick(NAMES) + pad()
  if (k === 1) return r.pick([r.pick(NAMES).toUpperCase(), 'Transparent', 'TRANSPARENT', 'transparent', 'notacolor', '', ' ', 'currentcolor', 'inherit', 'none', 'RebeccaPurple', 'grey', 'gray'])
  if (k <= 3) {
    const len = r.pick([3, 3, 4, 4, 6, 6, 8, 8, 0, 1, 2, 5, 7, 9, 10])
    const digits = '0123456789abcdefABCDEF'
    return pad() + (r.chance(0.95) ? '#' : '') + r.text([...digits], len, len) + (r.chance(0.04) ? 'g' : '') + pad()
  }
  const fn = r.pick(['rgb', 'rgba', 'hsl', 'hsla', 'rgb', 'rgba', 'hsl', 'hsla', 'RGB', 'Hsla', 'lab', 'hwb', 'color', 'rgbx', ''])
  const hsl = /^hsl/i.test(fn)
  const arity = r.chance(0.85) ? (/a$/i.test(fn) ? 4 : 3) : r.between(0, 5)
  const percentAll = r.chance(0.3)
  const args: string[] = []
  for (let i = 0; i < arity; i++) {
    const last = i === 3
    const wantPercent = last ? false : hsl ? i > 0 : percentAll
    args.push(pad() + genNumber(r, wantPercent && !(r.chance(0.04))) + pad())
  }
  const sep = r.chance(0.9) ? ',' : r.pick(SEPARATORS)
  return pad() + fn + (r.chance(0.97) ? '(' : '[') + args.join(sep) + (r.chance(0.97) ? ')' : '') + (r.chance(0.03) ? ')' : '') + pad()
}

const SPACES = ['rgb', 'hsl', 'lab', 'hcl', 'lch', 'cubehelix'] as const

function genChannel(r: Rng, kind: 'rgb' | 'unit' | 'angle' | 'lab' | 'chroma'): unknown {
  if (r.chance(0.05)) return r.pick<unknown>([NaN, undefined, null, '12', 'x', '', true, [3], Infinity, -Infinity, -0, {}])
  switch (kind) {
    case 'rgb': return r.chance(0.5) ? r.between(-30, 300) : r.next() * 330 - 30
    case 'unit': return r.chance(0.2) ? r.pick([0, 1, -0.5, 1.5]) : r.next() * 1.4 - 0.2
    case 'angle': return r.chance(0.5) ? r.between(-400, 800) : r.next() * 900 - 270
    case 'lab': return r.next() * 240 - 90
    default: return r.next() * 150 - 10
  }
}

function genArgs(r: Rng, space: (typeof SPACES)[number]): unknown[] {
  const o = r.pick([undefined, 1, 0, 0.5, 0.3, -1, 2, NaN, null, '0.5'])
  const kinds: Record<string, ['rgb' | 'unit' | 'angle' | 'lab' | 'chroma', 'rgb' | 'unit' | 'angle' | 'lab' | 'chroma', 'rgb' | 'unit' | 'angle' | 'lab' | 'chroma']> = {
    rgb: ['rgb', 'rgb', 'rgb'], hsl: ['angle', 'unit', 'unit'], lab: ['unit', 'lab', 'lab'], hcl: ['angle', 'chroma', 'lab'], lch: ['lab', 'chroma', 'angle'], cubehelix: ['angle', 'unit', 'unit'],
  }
  const [a, b, c] = kinds[space]!
  const l100 = (kind: string) => (space === 'lab' && kind === 'unit' ? r.next() * 110 - 5 : undefined)
  const args = [l100(a) ?? genChannel(r, a), genChannel(r, b), genChannel(r, c)]
  return r.chance(0.5) ? [...args, o] : args
}

type Lib = typeof d3 & Record<string, unknown>

/** A colour made one of the ways the API offers: string, 1 argument of any kind, 3 or 4 channels, a conversion. */
function make(lib: Lib, spec: { space: (typeof SPACES)[number]; mode: number; text: string; args: unknown[]; via: (typeof SPACES)[number]; junk: unknown }): AnyColor | null {
  const f = lib[spec.space] as (...a: unknown[]) => AnyColor
  switch (spec.mode) {
    case 0: return lib.color(spec.text) as AnyColor | null
    case 1: return f(spec.text)
    case 2: return f(...spec.args)
    case 3: return f(lib[spec.via]!(...(spec.args.slice(0, 3) as unknown[])) as unknown) // a colour of another space, converted
    case 4: return f(lib.color(spec.text)) // a parsed colour (or null)
    default: return f(spec.junk)
  }
}

describe('colour parsing and spaces vs d3-color (generated, live)', () => {
  it('color(string): the class, channels, string forms, brighter / darker, clamp, copy', () => {
    const r = makeRng(0xc0a1)
    const stats = compareCases('color()', scaled(30000), () => {
      const text = genColorString(r)
      const k = r.pick<unknown>([undefined, 0, 1, 2, 0.5, -1, 1.3, NaN, '2', null])
      return {
        label: JSON.stringify(text) + ` k=${String(k)}`,
        oracle: () => project(d3.color(text) as AnyColor | null, k),
        aster: () => project(aster.color(text) as unknown as AnyColor | null, k),
      }
    })
    expect(stats.informative).toBeGreaterThan(stats.cases * 0.3)
    expect(stats.informative).toBeLessThan(stats.cases * 0.9)
  })

  it('every keyword, in several spellings', () => {
    compareCases('keywords', NAMES.length * 4, (i) => {
      const name = NAMES[i % NAMES.length]!
      const text = [name, name.toUpperCase(), ` ${name}\n`, name[0]!.toUpperCase() + name.slice(1)][i % 4]!
      return { label: JSON.stringify(text), oracle: () => project(d3.color(text) as AnyColor | null, 1), aster: () => project(aster.color(text) as unknown as AnyColor | null, 1) }
    })
    expect(NAMES.length).toBe(148)
  })

  it('non-string input is read through String()', () => {
    const odd: unknown[] = [undefined, null, 5, {}, [], ['red'], { toString: () => '#abc' }, true, NaN, Symbol.iterator.description]
    compareCases('color(non-string)', odd.length, (i) => ({
      label: String(odd[i]),
      oracle: () => project(d3.color(odd[i] as string) as AnyColor | null, 1),
      aster: () => project(aster.color(odd[i]) as unknown as AnyColor | null, 1),
    }))
  })

  it('rgb, hsl, lab, hcl, lch, cubehelix: strings, colours, channels, other spaces', () => {
    const r = makeRng(0xc0a2)
    compareCases('spaces', scaled(24000), () => {
      const spec = {
        space: r.pick(SPACES), mode: r.int(6), text: genColorString(r), args: [] as unknown[], via: r.pick(SPACES), junk: r.pick<unknown>([undefined, null, 5, {}, [1, 2, 3], NaN, true]),
      }
      spec.args = genArgs(r, spec.mode === 3 ? spec.via : spec.space)
      const k = r.pick<unknown>([undefined, 1, 2, 0.5, -1, 1.3, NaN])
      return {
        label: `${spec.space} mode ${spec.mode} ${JSON.stringify(spec.text)} ${spec.mode === 3 ? spec.via : ''} ${spec.args.map(String)} k=${String(k)}`,
        oracle: () => project(make(d3 as Lib, spec), k),
        aster: () => project(make(aster as unknown as Lib, spec), k),
      }
    })
  })

  it('gray(l, opacity)', () => {
    const r = makeRng(0xc0a3)
    compareCases('gray', scaled(1500), () => {
      const l = genChannel(r, 'lab') as number
      const o = r.pick<unknown>([undefined, 1, 0.5, null, NaN, '0.3', 0])
      return { label: `${String(l)} ${String(o)}`, oracle: () => project(d3.gray(l, o as number) as AnyColor, 1), aster: () => project(aster.gray(l, o as number) as unknown as AnyColor, 1) }
    })
  })

  it('conversions chained through several spaces keep every channel', () => {
    const r = makeRng(0xc0a4)
    compareCases('chains', scaled(8000), () => {
      const text = r.chance(0.5) ? genColorString(r) : `rgb(${r.between(0, 255)},${r.between(0, 255)},${r.between(0, 255)})`
      const chain = Array.from({ length: r.between(2, 5) }, () => r.pick(SPACES))
      const run = (lib: Lib) => {
        let c: unknown = lib.color(text)
        const seen: unknown[] = []
        for (const space of chain) {
          c = (lib[space] as (x: unknown) => AnyColor)(c)
          seen.push(channels(c as AnyColor), (c as AnyColor).formatHex8())
        }
        return seen
      }
      return { label: `${JSON.stringify(text)} ${chain.join('>')}`, oracle: () => run(d3 as Lib), aster: () => run(aster as unknown as Lib) }
    })
  })

  it('d3-color instances are not Aster instances (no shared prototype to confuse)', () => {
    expect(aster.color('red')).toBeInstanceOf(aster.Color)
    expect(aster.rgb('red')).toBeInstanceOf(aster.Rgb)
    expect(aster.hsl('red')).toBeInstanceOf(aster.Hsl)
    expect(aster.lab('red')).toBeInstanceOf(aster.Lab)
    expect(aster.hcl('red')).toBeInstanceOf(aster.Hcl)
    expect(aster.cubehelix('red')).toBeInstanceOf(aster.Cubehelix)
    expect(aster.darker).toBe(0.7)
    expect(aster.brighter).toBe(1 / 0.7)
  })
})
