// @vitest-environment node
/**
 * The scale properties vl-scale-forwarding.test.ts does not ask, on the channels it does not ask them on, against vega-lite 6.4.3, by the
 * same method (the change a property makes to the compiled scale is the change vega-lite makes):
 *
 *  - `fillOpacity` and `strokeOpacity` driven by data (C750): both compile, onto an `fillOpacity` / `strokeOpacity` scale, and every
 *    property of a continuous scale must be forwarded to it as to `opacity`;
 *  - `scheme` and `interpolate` on the colour channels (colour, fill, stroke) over every scale type, the `point` and `band` ones
 *    included, where vega-lite drops them ("color-scale's scheme is dropped as it does not work with point scale") (C616);
 *  - `rangeMin` / `rangeMax`, which vega-lite honours on the scale types that take them and drops on the others.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile } from '@aster-charts/vl'

const silent: any = { level: () => silent, warn: () => silent, info: () => silent, debug: () => silent, error: () => silent }
const DATA = Array.from({ length: 40 }, (_, i) => ({ q: (i * 7) % 13 + 1, q2: (i * 3) % 11 + 2, n: 'ABCD'[i % 4], o: i % 5 }))
const sortKeys = (v: any): any => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v)
const FIELD_TYPE: Record<string, string> = { linear: 'quantitative', log: 'quantitative', pow: 'quantitative', sqrt: 'quantitative', symlog: 'quantitative', quantile: 'quantitative', quantize: 'quantitative', threshold: 'quantitative', ordinal: 'nominal', band: 'nominal', point: 'nominal' }
const FIELD = (type: string): string => (FIELD_TYPE[type] === 'quantitative' ? 'q' : 'n')
const spec = (channel: string, type: string, scale: Record<string, unknown>): Record<string, unknown> => ({
  data: { values: DATA },
  mark: 'point',
  encoding: { x: { field: 'q2', type: 'quantitative' }, y: { field: 'o', type: 'ordinal' }, [channel]: { field: FIELD(type), type: FIELD_TYPE[type], scale } },
})
const scaleOf = (compiled: any, type: string, channel: string): any => {
  const sc = (compiled.scales ?? []).find((s: any) => s.name === channel || JSON.stringify(s.domain ?? {}).includes(`"${FIELD(type)}"`) && s.name !== 'x' && s.name !== 'y')
  if (!sc) return undefined
  const { name: _n, ...rest } = sc
  return sortKeys(JSON.parse(JSON.stringify(rest).replace(/"(source|data)_\d+"/g, '"d"')))
}
const oracle = (channel: string, type: string, scale: Record<string, unknown>): any => { try { return scaleOf((vl as any).compile(spec(channel, type, scale), { logger: silent }).spec, type, channel) } catch { return undefined } }
const ours = (channel: string, type: string, scale: Record<string, unknown>): any => { try { return scaleOf(compile(JSON.parse(JSON.stringify(spec(channel, type, scale)))), type, channel) } catch (e) { return { THROWS: String(e).slice(0, 120) } } }
const change = (base: any, got: any): Record<string, [unknown, unknown]> => {
  const out: Record<string, [unknown, unknown]> = {}
  for (const k of new Set([...Object.keys(base ?? {}), ...Object.keys(got ?? {})])) if (JSON.stringify(base?.[k]) !== JSON.stringify(got?.[k])) out[k] = [base?.[k], got?.[k]]
  return out
}

const CONTINUOUS = ['linear', 'log', 'pow', 'sqrt', 'symlog', 'quantile', 'quantize', 'threshold']
const NUMERIC: Record<string, unknown[]> = {
  domainMax: [20], domainMin: [0], reverse: [true], round: [true], clamp: [true], nice: [5, true, false], zero: [true, false],
  exponent: [2], base: [10], constant: [1], rangeMin: [3], rangeMax: [50], interpolate: ['rgb'],
}
const COLOUR_PROPS: Record<string, unknown[]> = { scheme: ['blues', 'viridis'], interpolate: ['rgb', 'hcl'], reverse: [true], rangeMin: ['red'], rangeMax: ['blue'] }

function forwardsLikeVegaLite(channel: string, type: string, props: Record<string, unknown[]>): number {
  const base = oracle(channel, type, { type })
  // (a channel that does not keep the scale type gets vega-lite's own default: nothing to ask there)
  if (!base) return 0
  const mine = ours(channel, type, { type })
  let asked = 0
  for (const [prop, values] of Object.entries(props)) {
    for (const value of values) {
      const got = oracle(channel, type, { type, [prop]: value })
      if (!got) continue
      expect(change(mine, ours(channel, type, { type, [prop]: value })), `${prop}=${JSON.stringify(value)} on ${type} of ${channel}`).toEqual(change(base, got))
      asked++
    }
  }
  return asked
}

describe('fillOpacity and strokeOpacity scales forward every property as vega-lite does', () => {
  for (const channel of ['fillOpacity', 'strokeOpacity']) {
    for (const type of CONTINUOUS) it(`${channel}: ${type}`, () => expect(forwardsLikeVegaLite(channel, type, NUMERIC), 'properties asked').toBeGreaterThan(5))
  }
})

describe('a colour channel takes scheme, interpolate and the range ends of every scale type as vega-lite does (dropped on the types it does not suit)', () => {
  for (const channel of ['color', 'fill', 'stroke']) {
    for (const type of Object.keys(FIELD_TYPE)) it(`${channel}: ${type}`, () => expect(forwardsLikeVegaLite(channel, type, COLOUR_PROPS), 'properties asked').toBeGreaterThan(0))
  }
})
