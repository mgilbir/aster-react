// @vitest-environment node
/**
 * What each scale property does to the scale it is given on, against vega-lite 6.4.3: for every channel, scale type and property, the
 * change the property makes to the compiled scale (the properties that appear, change or go) must be the change vega-lite makes. The
 * change is compared, and not the scale, so that the rest of the scale (its range, its name, its default zero) does not have to be
 * the same for the property to be forwarded the same. Only the scale types vega-lite keeps on the channel are asked.
 *
 * (fillOpacity and strokeOpacity driven by data compile and are asked in vl-scale-forwarding-more.test.ts, as are scheme and interpolate on every colour scale type.)
 *
 * It covers every scale property of the schema but `domainRaw` (a literal one is refused, DECISIONS Q9) on every channel that has a
 * scale and every scale type vega-lite keeps there: the continuous colour scales (round, clamp, nice, padding, ...), `zero` on a log
 * scale (dropped), `nice` on a time scale (kept), `rangeMin` and `rangeMax` on the scale types that take them and on those that drop
 * them, and `reverse` on a band or point scale of a polar channel.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile } from '@aster-charts/vl'

const silent: any = { level: () => silent, warn: () => silent, info: () => silent, debug: () => silent, error: () => silent }
const DATA = Array.from({ length: 40 }, (_, i) => ({ q: (i * 7) % 13 + 1, q2: (i * 3) % 11 + 2, n: 'ABCD'[i % 4], o: i % 5, t: `2020-0${1 + (i % 9)}-1${i % 9}`, g: 'pq'[i % 2] }))
const FIELD_TYPE: Record<string, string> = { linear: 'quantitative', log: 'quantitative', pow: 'quantitative', sqrt: 'quantitative', symlog: 'quantitative', time: 'temporal', utc: 'temporal', sequential: 'quantitative', quantile: 'quantitative', quantize: 'quantitative', threshold: 'quantitative', 'bin-ordinal': 'quantitative', ordinal: 'nominal', band: 'nominal', point: 'nominal', identity: 'quantitative' }
const FIELD = (t: string): string => (t === 'quantitative' ? 'q' : t === 'temporal' ? 't' : 'n')
const COLOUR = new Set(['color', 'fill', 'stroke'])
const PROPS = (channel: string): Record<string, unknown[]> => ({
  domainMax: [20], domainMin: [0], domainMid: [5], reverse: [true], round: [true], clamp: [true], nice: [5, true, false], zero: [true, false],
  exponent: [2], base: [10], constant: [1], padding: [0.2], paddingInner: [0.3], paddingOuter: [0.1], align: [0.7], interpolate: ['rgb', 'hcl'],
  rangeMin: [COLOUR.has(channel) ? 'red' : 3], rangeMax: [COLOUR.has(channel) ? 'blue' : 50], scheme: ['blues'], bins: [[0, 5, 10, 15]],
})
const CONTINUOUS = ['linear', 'log', 'pow', 'sqrt', 'symlog', 'quantile', 'quantize', 'threshold']
/** The scale types asked on each channel: all of them (a scale type the channel does not keep is skipped where vega-lite gives another). */
const TYPES: Record<string, string[]> = Object.fromEntries(['x', 'y', 'xOffset', 'yOffset', 'theta', 'radius', 'color', 'fill', 'stroke', 'opacity', 'size', 'strokeWidth', 'angle', 'strokeDash', 'shape'].map((c) => [c, Object.keys(FIELD_TYPE)]))
const CHANNELS = Object.keys(TYPES)

const sortKeys = (v: any): any => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v)
const spec = (channel: string, type: string, scale: Record<string, unknown>): Record<string, unknown> => {
  const ft = FIELD_TYPE[type]!
  const encoding: Record<string, unknown> = { x: { field: 'q2', type: 'quantitative' }, y: { field: 'o', type: 'ordinal' } }
  if (channel === 'xOffset') { encoding.x = { field: 'g', type: 'nominal' }; encoding.y = { field: 'q2', type: 'quantitative' } }
  if (channel === 'yOffset') { encoding.y = { field: 'g', type: 'nominal' }; encoding.x = { field: 'q2', type: 'quantitative' } }
  if (channel === 'theta' || channel === 'radius') { delete encoding.x; delete encoding.y }
  encoding[channel] = { field: FIELD(ft), type: ft, scale }
  return { data: { values: DATA }, mark: channel === 'xOffset' || channel === 'yOffset' ? 'bar' : channel === 'theta' || channel === 'radius' ? 'arc' : 'point', encoding }
}
const scaleOf = (compiled: any, type: string): any => {
  const sc = (compiled.scales ?? []).find((s: any) => JSON.stringify(s.domain ?? {}).includes(`"${FIELD(FIELD_TYPE[type]!)}"`))
  if (!sc) return undefined
  const { name: _n, ...rest } = sc
  return sortKeys(JSON.parse(JSON.stringify(rest).replace(/"(source|data)_\d+"/g, '"d"')))
}
const oracle = (channel: string, type: string, scale: Record<string, unknown>): any => { try { return scaleOf((vl as any).compile(spec(channel, type, scale), { logger: silent }).spec, type) } catch { return undefined } }
const ours = (channel: string, type: string, scale: Record<string, unknown>): any => {
  try { return scaleOf(compile(JSON.parse(JSON.stringify(spec(channel, type, scale)))), type) } catch (e) { return { THROWS: String(e).slice(0, 120) } }
}
const change = (base: any, got: any): Record<string, [unknown, unknown]> => {
  const out: Record<string, [unknown, unknown]> = {}
  for (const k of new Set([...Object.keys(base ?? {}), ...Object.keys(got ?? {})])) if (JSON.stringify(base?.[k]) !== JSON.stringify(got?.[k])) out[k] = [base?.[k], got?.[k]]
  return out
}

describe('a scale property does to the scale what it does in vega-lite', () => {
  let asked = 0
  for (const channel of CHANNELS) {
    describe(channel, () => {
      for (const type of TYPES[channel]!) {
        const base = oracle(channel, type, { type })
        // (a channel that does not support the scale type gets vega-lite's own default: nothing to ask there)
        if (!base || base.type !== type) continue
        it(type, () => {
          const mine = ours(channel, type, { type })
          for (const [prop, values] of Object.entries(PROPS(channel))) {
            for (const value of values) {
              const got = oracle(channel, type, { type, [prop]: value })
              // (a property that makes vega-lite change the type of the scale is not a property of this type)
              if (!got || got.type !== type) continue
              expect(change(mine, ours(channel, type, { type, [prop]: value })), `${prop}=${JSON.stringify(value)} on ${type} of ${channel}`).toEqual(change(base, got))
              asked++
            }
          }
        })
      }
    })
  }
  it('asked a good part of the space', () => {
    expect(asked).toBeGreaterThan(1100)
  })
})
