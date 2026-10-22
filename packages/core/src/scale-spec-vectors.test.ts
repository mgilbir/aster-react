/**
 * Replay of the "scale spec -> built scale" oracle vectors
 * (`packages/conformance/scripts/gen-scale-spec-vectors.mjs` ->
 * `testdata/vectors/spec-level/vega-scale-spec.json`).
 *
 * Each case is a Vega spec holding one scale `s`. The vector records what real
 * vega (vega-parser + vega-encode's Scale transform) built from it: the type,
 * the domain and range, sampled outputs, bins, thresholds, ticks. Aster must
 * build the same scale; a spec vega rejects must throw here too.
 *
 * Local-time (`time`) cases were recorded under each zone in `wantByTz`; this
 * file never pins TZ, so running it under another zone (see `pnpm test:tz`)
 * checks the UTC/numeric scales are zone independent and the local ones follow
 * the process zone exactly as vega's do.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getChartInfo } from './runtime.js'
import type { VgSpec } from './types.js'

// Local-time (`time`) cases are recorded per zone. A run that names no zone is
// pinned to UTC like the other vector replays (so a laptop in any zone passes);
// `pnpm test:tz` names the zone explicitly and it is honoured.
process.env.TZ ??= 'UTC'

interface Case {
  name: string
  spec: unknown
  probes: unknown[]
  want: unknown
  wantByTz?: Record<string, unknown>
}
interface File {
  suites: Record<string, { oracle: string; cases: Case[] }>
}

const file = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'testdata', 'vectors', 'spec-level', 'vega-scale-spec.json'), 'utf8'),
) as File

function dec(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(dec)
  const tag = (v as Record<string, unknown>)['$']
  switch (tag) {
    case 'undef': return undefined
    case 'nan': return NaN
    case 'inf': return Infinity
    case '-inf': return -Infinity
    case '-0': return -0
    case 'date': return new Date((v as { ms: number }).ms)
    case 'baddate': return new Date(NaN)
    default: {
      const o: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = dec(val)
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
  if (typeof v === 'symbol') return { $: 'symbol', desc: v.description ?? null }
  if (Array.isArray(v)) return v.map(enc)
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) o[k] = enc((v as Record<string, unknown>)[k])
    return o
  }
  return v
}

const attempt = (f: () => unknown): unknown => {
  try {
    return enc(f())
  } catch {
    return { $: 'throw' }
  }
}

type AnyScale = ((x: unknown) => unknown) & Record<string, unknown>

function project(s: AnyScale, probes: unknown[]): Record<string, unknown> {
  const m = (name: string, ...args: unknown[]): unknown => (s[name] as (...a: unknown[]) => unknown)(...args)
  const o: Record<string, unknown> = {}
  o.type = s.type
  o.domain = attempt(() => m('domain'))
  o.range = attempt(() => (typeof s.range === 'function' ? m('range') : undefined))
  o.samples = probes.map((p) => attempt(() => s(p)))
  for (const name of ['bandwidth', 'step', 'thresholds', 'quantiles', 'clamp', 'round', 'exponent', 'base', 'constant', 'padding', 'paddingInner', 'paddingOuter', 'align', 'unknown']) {
    if (typeof s[name] === 'function') o[name] = attempt(() => (name === 'quantiles' ? m('quantiles', 4) : m(name)))
  }
  o.bins = 'bins' in s ? attempt(() => s.bins) : { $: 'undef' }
  if (typeof s.ticks === 'function') o.ticks = attempt(() => m('ticks', 5))
  if (typeof s.invertExtent === 'function') {
    const r = (() => { try { return m('range') } catch { return [] } })()
    if (Array.isArray(r)) o.invertExtent = r.slice(0, 12).map((x) => attempt(() => m('invertExtent', x)))
  }
  return o
}

function build(spec: unknown, probes: unknown[]): unknown {
  try {
    const info = getChartInfo(dec(spec) as VgSpec)
    const s = info.scales.get('s') as AnyScale | undefined
    if (!s) return { $: 'throw' }
    return project(s, probes)
  } catch {
    return { $: 'throw' }
  }
}

const zone = process.env.TZ && process.env.TZ !== 'UTC' ? process.env.TZ : 'UTC'

describe('scale-spec oracle vectors', () => {
  it('runs in the zone the runner asked for', () => {
    const offsets: Record<string, number> = { UTC: 0, 'America/New_York': 300, 'Asia/Kolkata': -330 }
    const asked = process.env.TZ
    if (asked && asked in offsets) expect(new Date(0).getTimezoneOffset()).toBe(offsets[asked])
  })
  for (const [suite, { oracle, cases }] of Object.entries(file.suites)) {
    describe(`${suite} (${oracle})`, () => {
      for (const c of cases) {
        it(c.name, () => {
          const want = zone === 'UTC' ? c.want : (c.wantByTz?.[zone] ?? c.want)
          const probes = c.probes.map(dec)
          expect(build(c.spec, probes)).toEqual(want)
        })
      }
    })
  }
})
