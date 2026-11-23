/**
 * `translatePathData` (core dom.ts, a documented public export of `@aster-charts/core/dom`) against vega-scenegraph's own replay
 * of path text: translating a path by (dx, dy) and drawing it must draw what vega draws of the original path moved by (dx, dy), for
 * every valid path text, however its numbers are written (a sign, a leading or trailing dot, an exponent, numbers run together,
 * `.5.5` as two numbers), packed arc flags, implicit repeats, relative and absolute commands, and a first moveto written `m`
 * (absolute by SVG's rule).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { translatePathData } from '../../core/src/dom.js'
import type { PathCommand } from '../../core/src/path-data.js'

const vegaParse = (vega as unknown as { pathParse(d: string): PathCommand[] }).pathParse
const vegaRender = (vega as unknown as { pathRender(c: unknown, p: PathCommand[], l?: number, t?: number): void }).pathRender

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, z: 0, c: 6, s: 4, q: 4, t: 2, a: 7 }
const LETTERS = Object.keys(ARITY)

/** A number written one of the ways the grammar allows, with at most three decimals (the precision the translation writes). */
function number(r: () => number): string {
  const v = Math.round((r() - 0.4) * 60000) / 1000
  const pick = r()
  if (pick < 0.25) return String(Math.round(v))
  if (pick < 0.45) return v.toFixed(3)
  if (pick < 0.55) return (v < 0 ? '-' : '+') + Math.abs(v).toFixed(2)
  if (pick < 0.7) return (v < 0 ? '-' : '') + '.' + String(100 + Math.floor(r() * 900)) // a leading dot: -.5, .625
  if (pick < 0.78) return String(Math.round(v)) + '.' // a trailing dot
  if (pick < 0.9) return (Math.round(v) / 10).toString() + 'e1' // an exponent: 1.5e1
  return String(v)
}

/** Separators between numbers: a comma, spaces, both, none where the next number's sign ends the last, or its dot when the last has one. */
function sep(r: () => number, next: string, prev: string): string {
  const pick = r()
  if (pick < 0.3) return ','
  if (pick < 0.55) return ' '
  if (pick < 0.7) return ' , '
  if (pick < 0.8) return '\n\t'
  return /^[-+]/.test(next) || (next.startsWith('.') && /[.e]/i.test(prev)) ? '' : ' '
}

function pathText(r: () => number, n: number): string {
  let out = (r() < 0.5 ? 'M' : 'm') + number(r) + ' ' + number(r)
  for (let i = 0; i < n; i++) {
    let type = LETTERS[Math.floor(r() * LETTERS.length)]!
    // (a smooth curve reflects the last control point of the curve before it: SVG's rule, which vega's replay shares only when
    // that curve is there; after a straight segment vega reflects a stale point, which is no translation of anything)
    if (type === 's' && !/[cs][^a-z]*$/i.test(out)) type = 'c'
    if (type === 't' && !/[qt][^a-z]*$/i.test(out)) type = 'q'
    const letter = r() < 0.5 ? type.toUpperCase() : type
    const groups = type === 'z' ? 1 : r() < 0.25 ? 2 : 1 // an implicit repeat now and then
    let body = ''
    for (let g = 0; g < groups; g++) {
      for (let k = 0; k < ARITY[type]!; k++) {
        const flag = type === 'a' && (k === 3 || k === 4)
        const prev = /[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.exec(body)?.[0] ?? '' // the number the next one follows
        const v = flag ? (r() < 0.5 ? '0' : '1') : type === 'a' && k < 2 ? String(1 + Math.round(r() * 30)) : number(r)
        // (packed flags, "a5 5 0 1010 0": the sweep flag follows the large-arc flag directly, and the endpoint follows the sweep
        // flag directly when it starts with a sign or a dot; a flag after the rotation would be read as its digit)
        const packed = type === 'a' && ((k === 4 && r() < 0.5) || (k === 5 && /^[-+.]/.test(v) && r() < 0.5))
        body += (body === '' ? (r() < 0.5 ? ' ' : '') : packed ? '' : sep(r, v, prev)) + v
      }
    }
    out += (r() < 0.3 ? ' ' : '') + letter + body
  }
  return out
}

/** Every call a replay makes. */
function record(commands: PathCommand[], dx: number, dy: number): number[][] {
  const calls: number[][] = []
  const rec = (code: number) => (...a: number[]): void => { calls.push([code, ...a]) }
  const sink = { beginPath: () => undefined, moveTo: rec(1), lineTo: rec(2), bezierCurveTo: rec(3), quadraticCurveTo: rec(4), closePath: rec(5) }
  vegaRender(sink, commands, dx, dy)
  return calls
}

function expectSameDrawing(d: string, dx: number, dy: number): void {
  try { vegaParse(d) } catch (e) { throw new Error(`generated text ${JSON.stringify(d)} is not valid: ${(e as Error).message}`) }
  const moved = translatePathData(d, dx, dy)
  expect(moved, `${JSON.stringify(d)} -> ${JSON.stringify(moved)}`).not.toMatch(/NaN|undefined|Infinity/)
  // (vega's own replay at the origin, every point moved: its offset arguments are not a translation of a smooth curve's reflected
  // control point, so they are not the reference)
  const want = record(vegaParse(d), 0, 0).map(([code, ...xy]) => [code!, ...xy.map((v, k) => v + (k % 2 === 0 ? dx : dy))])
  const got = record(vegaParse(moved), 0, 0)
  const label = `${JSON.stringify(d)} by (${dx}, ${dy}) -> ${JSON.stringify(moved)}`
  expect(got.length, label).toBe(want.length)
  for (let i = 0; i < want.length; i++) {
    expect(got[i]!.length, label).toBe(want[i]!.length)
    for (let k = 0; k < want[i]!.length; k++) {
      // (the translation writes three decimals, as the dense batcher always has, and an arc near its degenerate case amplifies the
      // last bits of a sum of floats to ~1e-6; a wrong reading of the path is off by a coordinate, not by 1e-4)
      expect(Math.abs(got[i]![k]! - want[i]![k]!), `${label}: call ${i} number ${k}`).toBeLessThan(1e-4 * Math.max(1, Math.abs(want[i]![k]!)))
    }
  }
}

describe('translatePathData, against vega-scenegraph path replay', () => {
  it('the cases the audit found (C218)', () => {
    for (const d of ['m10,10l5,5', 'm10,10 5,5z', 'M1e1,.5.5-1', 'M.5.5L1-1', 'M0 0A5 5 0 01 5 5', 'M0 0A5 5 0 0 1 5 5', 'M0,0 10,10', 'M5-5L-3-4', 'M0,0a5 5 0 1110 0']) {
      expectSameDrawing(d, 100, 200)
    }
  })

  it('2000 generated valid paths, moved by generated offsets, draw what vega draws of the original moved', () => {
    const r = rng(20261123)
    for (let i = 0; i < 2000; i++) {
      const d = pathText(r, 1 + Math.floor(r() * 7))
      const dx = Math.round((r() - 0.5) * 4000) / 10
      const dy = Math.round((r() - 0.5) * 4000) / 10
      expectSameDrawing(d, dx, dy)
    }
  })

  it('writes what a browser draws of a malformed path: the commands before the first error', () => {
    expect(translatePathData('M1,2L3,4X5,6', 10, 10)).toBe('M11,12L13,14')
    expect(translatePathData('M1,2L3,4,5', 10, 10)).toBe('M11,12L13,14')
  })
})
