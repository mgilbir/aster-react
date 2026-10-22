/**
 * Replay of the d3-interpolate table vega-scale's `interpolate(type, gamma)` reads
 * (`packages/conformance/scripts/gen-interpolate-vectors.mjs` ->
 * `testdata/vectors/spec-level/vega-interpolate.json`). `interpolate('hcl')` used
 * to be undefined (the table held only rgb), which scales.ts worked around with a
 * second copy of the colour logic (audit C95).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { interpolate } from './scale.js'

interface File {
  oracle: string
  t: number[]
  cases: Array<{ name: string; gamma: number | null; args: unknown[]; want: unknown }>
}
const file = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'testdata', 'vectors', 'spec-level', 'vega-interpolate.json'), 'utf8'),
) as File

function dec(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(dec)
  switch ((v as Record<string, unknown>)['$']) {
    case 'undef': return undefined
    case 'nan': return NaN
    case 'inf': return Infinity
    case '-inf': return -Infinity
    case '-0': return -0
    case 'date': return new Date((v as { ms: number }).ms)
    case 'baddate': return new Date(NaN)
    default: {
      const o: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = dec(x)
      return o
    }
  }
}

function enc(v: unknown): unknown {
  if (v === undefined) return { $: 'undef' }
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $: 'nan' }
    if (v === Infinity) return { $: 'inf' }
    if (v === -Infinity) return { $: '-inf' }
    if (v === 0 && 1 / v < 0) return { $: '-0' }
    return v
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? { $: 'baddate' } : { $: 'date', ms: v.getTime() }
  if (typeof v === 'function') return { $: 'fn' }
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v as ArrayLike<unknown>, enc)
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) o[k] = enc((v as Record<string, unknown>)[k])
    return o
  }
  return v
}

describe(`interpolator table (${file.oracle})`, () => {
  for (const [i, c] of file.cases.entries()) {
    it(`${i} ${c.name || '(generic)'}${c.gamma != null ? ` gamma ${c.gamma}` : ''} ${JSON.stringify(c.args).slice(0, 60)}`, () => {
      let got: unknown
      try {
        const f = interpolate(c.name, c.gamma ?? undefined) as (...a: unknown[]) => (t: number) => unknown
        const g = f(...c.args.map(dec)) as ((t: number) => unknown) & { duration?: number }
        const r = file.t.map((t) => g(t))
        got = enc(c.name === 'zoom' ? { v: r, duration: g.duration } : r)
      } catch {
        got = { $: 'throw' }
      }
      expect(got).toEqual(c.want)
    })
  }
})
