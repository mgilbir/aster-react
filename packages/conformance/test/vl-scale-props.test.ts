// @vitest-environment node
/**
 * Which scale properties mean something for a scale type on a channel (`scalePropApplies`): pinned over the whole input space, and
 * checked against what vega-lite 6.4.3 does with each of them.
 *
 *  - PINNED: the answer for every scale property x scale type x channel is the one the table gave when it was written down. The
 *    answers of the cells vega-lite cannot be asked about (a scale type a channel does not support, which vega-lite swaps for its own
 *    default) are Aster's own, and this is where they are held.
 *  - VEGA-LITE: for every channel and scale type that vega-lite keeps, a property is applied when the compiled scale carries it
 *    (with the value asked for, or any value other than the scale's default) and is dropped when it does not; the table must say the
 *    same. The scales are those vega-lite compiles for a field of the type the scale type needs.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { createRequire } from 'node:module'
import { scalePropApplies } from '../../vl/src/scaleprops.js'

const require = createRequire(import.meta.url)
const schema = require('vega-lite/vega-lite-schema.json').definitions
const TYPES: string[] = schema.ScaleType.enum
const PROPS: string[] = Object.keys(schema.Scale.properties)
const CHANNELS = ['x', 'y', 'x2', 'y2', 'xOffset', 'yOffset', 'theta', 'radius', 'color', 'fill', 'stroke', 'opacity', 'fillOpacity', 'strokeOpacity', 'strokeWidth', 'strokeDash', 'size', 'angle', 'shape', 'text', 'detail']

/** Per property and scale type: the channels it applies to (`*` for all of them, `-` for none). */
const PINNED: Record<string, Record<string, string>> = {
  align: { linear: '-', log: '-', pow: '-', sqrt: '-', symlog: '-', identity: '-', sequential: '-', time: '-', utc: '-', quantile: '-', quantize: '-', threshold: '-', 'bin-ordinal': '-', ordinal: '-', point: '*', band: '*' },
  base: { linear: '-', log: '*', pow: '-', sqrt: '-', symlog: '-', identity: '-', sequential: '-', time: '-', utc: '-', quantile: '-', quantize: '-', threshold: '-', 'bin-ordinal': '-', ordinal: '-', point: '-', band: '-' },
  bins: { linear: '*', log: '*', pow: '*', sqrt: '*', symlog: '*', identity: '-', sequential: '*', time: '*', utc: '*', quantile: '*', quantize: '*', threshold: '*', 'bin-ordinal': '*', ordinal: '-', point: '-', band: '-' },
  clamp: { linear: '*', log: '*', pow: '*', sqrt: '*', symlog: '*', identity: '-', sequential: '-', time: '*', utc: '*', quantile: '-', quantize: '-', threshold: '-', 'bin-ordinal': '-', ordinal: '-', point: '-', band: '-' },
  constant: { linear: '-', log: '-', pow: '-', sqrt: '-', symlog: '*', identity: '-', sequential: '-', time: '-', utc: '-', quantile: '-', quantize: '-', threshold: '-', 'bin-ordinal': '-', ordinal: '-', point: '-', band: '-' },
  domain: { linear: '*', log: '*', pow: '*', sqrt: '*', symlog: '*', identity: '*', sequential: '*', time: '*', utc: '*', quantile: '*', quantize: '*', threshold: '*', 'bin-ordinal': '*', ordinal: '*', point: '*', band: '*' },
  domainMax: { linear: '*', log: '*', pow: '*', sqrt: '*', symlog: '*', identity: '-', sequential: '-', time: '*', utc: '*', quantile: '-', quantize: '-', threshold: '-', 'bin-ordinal': '-', ordinal: '-', point: '-', band: '-' },
  domainMid: { linear: 'color,fill,stroke', log: 'color,fill,stroke', pow: 'color,fill,stroke', sqrt: 'color,fill,stroke', symlog: 'color,fill,stroke', identity: '-', sequential: '-', time: 'color,fill,stroke', utc: 'color,fill,stroke', quantile: '-', quantize: '-', threshold: '-', 'bin-ordinal': '-', ordinal: '-', point: '-', band: '-' },
  domainMin: { linear: '*', log: '*', pow: '*', sqrt: '*', symlog: '*', identity: '-', sequential: '-', time: '*', utc: '*', quantile: '-', quantize: '-', threshold: '-', 'bin-ordinal': '-', ordinal: '-', point: '-', band: '-' },
  domainRaw: { linear: '*', log: '*', pow: '*', sqrt: '*', symlog: '*', identity: '-', sequential: '-', time: '*', utc: '*', quantile: '-', quantize: '-', threshold: '-', 'bin-ordinal': '-', ordinal: '-', point: '-', band: '-' },
  exponent: { linear: '-', log: '-', pow: '*', sqrt: '-', symlog: '-', identity: '-', sequential: '-', time: '-', utc: '-', quantile: '-', quantize: '-', threshold: '-', 'bin-ordinal': '-', ordinal: '-', point: '-', band: '-' },
  interpolate: { linear: 'color,fill,stroke', log: 'color,fill,stroke', pow: 'color,fill,stroke', sqrt: 'color,fill,stroke', symlog: 'color,fill,stroke', identity: '-', sequential: 'color,fill,stroke', time: 'color,fill,stroke', utc: 'color,fill,stroke', quantile: 'color,fill,stroke', quantize: 'color,fill,stroke', threshold: 'color,fill,stroke', 'bin-ordinal': 'color,fill,stroke', ordinal: 'color,fill,stroke', point: '-', band: '-' },
  nice: { linear: '*', log: '*', pow: '*', sqrt: '*', symlog: '*', identity: '-', sequential: '-', time: '*', utc: '*', quantile: '-', quantize: '*', threshold: '*', 'bin-ordinal': '-', ordinal: '-', point: '-', band: '-' },
  padding: { linear: '*', log: '*', pow: '*', sqrt: '*', symlog: '*', identity: '-', sequential: '-', time: '*', utc: '*', quantile: '-', quantize: '-', threshold: '-', 'bin-ordinal': '-', ordinal: '-', point: '*', band: '*' },
  paddingInner: { linear: '-', log: '-', pow: '-', sqrt: '-', symlog: '-', identity: '-', sequential: '-', time: '-', utc: '-', quantile: '-', quantize: '-', threshold: '-', 'bin-ordinal': '-', ordinal: '-', point: '-', band: '*' },
  paddingOuter: { linear: '-', log: '-', pow: '-', sqrt: '-', symlog: '-', identity: '-', sequential: '-', time: '-', utc: '-', quantile: '-', quantize: '-', threshold: '-', 'bin-ordinal': '-', ordinal: '-', point: '*', band: '*' },
  range: { linear: '*', log: '*', pow: '*', sqrt: '*', symlog: '*', identity: '*', sequential: '*', time: '*', utc: '*', quantile: '*', quantize: '*', threshold: '*', 'bin-ordinal': '*', ordinal: '*', point: '*', band: '*' },
  rangeMax: { linear: '*', log: '*', pow: '*', sqrt: '*', symlog: '*', identity: '*', sequential: '*', time: '*', utc: '*', quantile: '*', quantize: '*', threshold: '*', 'bin-ordinal': '*', ordinal: '*', point: '*', band: '*' },
  rangeMin: { linear: '*', log: '*', pow: '*', sqrt: '*', symlog: '*', identity: '*', sequential: '*', time: '*', utc: '*', quantile: '*', quantize: '*', threshold: '*', 'bin-ordinal': '*', ordinal: '*', point: '*', band: '*' },
  reverse: { linear: '*', log: '*', pow: '*', sqrt: '*', symlog: '*', identity: '*', sequential: '*', time: '*', utc: '*', quantile: '*', quantize: '*', threshold: '*', 'bin-ordinal': '*', ordinal: '*', point: '*', band: '*' },
  round: { linear: '*', log: '*', pow: '*', sqrt: '*', symlog: '*', identity: '-', sequential: '-', time: '*', utc: '*', quantile: '-', quantize: '-', threshold: '-', 'bin-ordinal': '-', ordinal: '-', point: '*', band: '*' },
  scheme: { linear: 'color,fill,stroke', log: 'color,fill,stroke', pow: 'color,fill,stroke', sqrt: 'color,fill,stroke', symlog: 'color,fill,stroke', identity: '-', sequential: 'color,fill,stroke', time: 'color,fill,stroke', utc: 'color,fill,stroke', quantile: 'color,fill,stroke', quantize: 'color,fill,stroke', threshold: 'color,fill,stroke', 'bin-ordinal': 'color,fill,stroke', ordinal: 'color,fill,stroke', point: '-', band: '-' },
  type: { linear: '*', log: '*', pow: '*', sqrt: '*', symlog: '*', identity: '*', sequential: '*', time: '*', utc: '*', quantile: '*', quantize: '*', threshold: '*', 'bin-ordinal': '*', ordinal: '*', point: '*', band: '*' },
  zero: { linear: '*', log: '-', pow: '*', sqrt: '*', symlog: '*', identity: '-', sequential: '-', time: '-', utc: '-', quantile: '-', quantize: '*', threshold: '-', 'bin-ordinal': '-', ordinal: '-', point: '-', band: '-' },
  nonsense: { linear: '*', log: '*', pow: '*', sqrt: '*', symlog: '*', identity: '*', sequential: '*', time: '*', utc: '*', quantile: '*', quantize: '*', threshold: '*', 'bin-ordinal': '*', ordinal: '*', point: '*', band: '*' },
}

describe('scalePropApplies is the table it was', () => {
  it('knows every scale property and scale type of the schema', () => {
    expect(Object.keys(PINNED).sort()).toEqual([...PROPS, 'nonsense'].sort())
    for (const row of Object.values(PINNED)) expect(Object.keys(row).sort()).toEqual([...TYPES].sort())
  })
  for (const prop of Object.keys(PINNED)) {
    it(`${prop}`, () => {
      for (const type of TYPES) {
        const pinned = PINNED[prop]![type]!
        const on = pinned === '*' ? CHANNELS : pinned === '-' ? [] : pinned.split(',')
        for (const channel of CHANNELS) expect(scalePropApplies(channel, type, prop), `${prop} on ${type} of ${channel}`).toBe(on.includes(channel))
      }
    })
  }
})

// --- vega-lite ---------------------------------------------------------------------------------------------------------------------

const silent: any = { level: () => silent, warn: () => silent, info: () => silent, debug: () => silent, error: () => silent }
const DATA = Array.from({ length: 40 }, (_, i) => ({ q: (i * 7) % 13 + 1, q2: (i * 3) % 11 + 2, n: 'ABCD'[i % 4], o: i % 5, t: `2020-0${1 + (i % 9)}-1${i % 9}`, g: 'pq'[i % 2] }))
const FIELD_TYPE: Record<string, string> = { linear: 'quantitative', log: 'quantitative', pow: 'quantitative', sqrt: 'quantitative', symlog: 'quantitative', time: 'temporal', utc: 'temporal', sequential: 'quantitative', quantile: 'quantitative', quantize: 'quantitative', threshold: 'quantitative', 'bin-ordinal': 'quantitative', ordinal: 'nominal', band: 'nominal', point: 'nominal', identity: 'quantitative' }
const FIELD: Record<string, string> = { quantitative: 'q', temporal: 't', nominal: 'n' }
/** Values to ask each property for: the property is applied when the scale carries it with one of them (or with a value that is not the default). */
const ASK: Record<string, unknown[]> = {
  domainMax: [20], domainMin: [0], domainMid: [5], reverse: [true], round: [true], clamp: [true], nice: [5, false], zero: [true, false],
  exponent: [2], base: [10], constant: [1], padding: [0.2], paddingInner: [0.3], paddingOuter: [0.1], align: [0.7], bins: [[0, 5, 10, 15]], scheme: ['blues'], interpolate: ['rgb', 'hcl'],
}

function spec(channel: string, type: string, scale: Record<string, unknown>): Record<string, unknown> {
  const fieldType = FIELD_TYPE[type]!
  const encoding: Record<string, unknown> = { x: { field: 'q2', type: 'quantitative' }, y: { field: 'o', type: 'ordinal' } }
  if (channel === 'xOffset' || channel === 'yOffset') { encoding.x = { field: 'g', type: 'nominal' }; encoding.y = { field: 'q2', type: 'quantitative' } }
  encoding[channel] = { field: FIELD[fieldType], type: fieldType, scale }
  return { data: { values: DATA }, mark: channel === 'theta' || channel === 'radius' ? 'arc' : 'point', encoding }
}
const scaleOf = (compiled: any, channel: string, type: string): any => {
  const field = FIELD[FIELD_TYPE[type]!]!
  return (compiled.scales ?? []).find((s: any) => JSON.stringify(s.domain ?? {}).includes(`"${field}"`) && (channel !== 'x' && channel !== 'y' ? s.name !== 'x' && s.name !== 'y' || channel === 'xOffset' || channel === 'yOffset' : true))
}
function compileScale(channel: string, type: string, scale: Record<string, unknown>): any {
  try { return scaleOf((vl as any).compile(spec(channel, type, scale), { logger: silent }).spec, channel, type) } catch { return undefined }
}

describe('scalePropApplies is what vega-lite does', () => {
  let compared = 0
  for (const channel of CHANNELS) {
    for (const type of TYPES) {
      const base = compileScale(channel, type, { type })
      // (a channel that does not support the scale type gets vega-lite's own default: nothing to ask there)
      if (!base || base.type !== type) continue
      it(`${type} on ${channel}`, () => {
        for (const [prop, values] of Object.entries(ASK)) {
          let applied = false
          for (const value of values) {
            const got = compileScale(channel, type, { type, [prop]: value })
            if (!got) continue
            const read = (s: any): unknown => (prop === 'scheme' ? s.range?.scheme : s[prop])
            if (JSON.stringify(read(got)) !== JSON.stringify(read(base)) && read(got) !== undefined) applied = true
          }
          expect(scalePropApplies(channel, type, prop), `${prop} on ${type} of ${channel}`).toBe(applied)
        }
        compared++
      })
    }
  }
  it('looked at a good part of the space', () => {
    expect(compared).toBeGreaterThan(150)
  })
})
