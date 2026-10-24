// @vitest-environment node
/**
 * An explicit `scale.domain` compiles like vega-lite's (scale/domain.ts parseSingleChannelDomain, properties.ts
 * zero() / nice()): the emitted scale's domain, zero and nice equal vega-lite's, and real vega renders the two Vega
 * specs to the same document. A domain that is neither an array nor "unaggregated" is emitted as written and fails
 * in vega (`Undefined data set name`) -- and in Aster's runtime.
 */
import { describe, it, expect } from 'vitest'
import * as vega from 'vega'
import { compile as vlCompile } from 'vega-lite'
import { compile } from '@aster/vl'
import { renderSpec } from '@aster/core'
import '@aster/core/transforms'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Obj = Record<string, unknown>
const DATA = { values: [{ c: 'a', v: 1, w: 30, t: '2024-01-05' }, { c: 'b', v: 2, w: 60, t: '2024-03-05' }, { c: 'c', v: 7, w: 90, t: '2024-05-05' }] }
const unit = (mark: string, encoding: Obj, extra: Obj = {}): Obj => ({ $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 200, height: 120, data: DATA, mark, encoding, ...extra })
const scaleOf = (vg: unknown, name: string): Obj | undefined => ((vg as { scales?: Obj[] }).scales ?? []).find((s) => s.name === name)
const pick = (s: Obj | undefined): Obj => ({ domain: s?.domain, zero: s?.zero, nice: s?.nice, type: s?.type })

async function svgOf(vg: unknown): Promise<string> {
  const log = console.error
  console.error = () => {}
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(vega.parse(vg as never), { renderer: 'none' })
  try { await view.runAsync(); return await view.toSVG() } finally { console.error = log; view.finalize() }
}

const Y = (scale: Obj, type = 'quantitative', field = 'v', extra: Obj = {}): Obj => ({ x: { field: 'c', type: 'nominal' }, y: { field, type, scale, ...extra } })

const CASES: Array<[string, Obj]> = [
  ['quantitative [0, 50]', unit('point', Y({ domain: [0, 50] }))],
  ['quantitative [5, 50]: zero off', unit('point', Y({ domain: [5, 50] }))],
  ['quantitative [-5, 5]: spans zero', unit('point', Y({ domain: [-5, 5] }))],
  ['quantitative [5, 50] with zero: true', unit('point', Y({ domain: [5, 50], zero: true }))],
  ['quantitative [5, 50] with nice: true', unit('point', Y({ domain: [5, 50], nice: true }))],
  ['quantitative [5, 50] with domainMin', unit('point', Y({ domain: [5, 50], domainMin: 2 }))],
  ['quantitative three values', unit('point', Y({ domain: [0, 5, 50] }))],
  ['quantitative, empty', unit('point', Y({ domain: [] }))],
  ['quantitative, an expression endpoint', unit('point', Y({ domain: [{ expr: '3' }, 50] }))],
  ['bar over an explicit domain', unit('bar', Y({ domain: [1, 9] }))],
  ['log scale', unit('point', Y({ domain: [1, 50], type: 'log' }))],
  ['sqrt scale', unit('point', Y({ domain: [0, 50], type: 'sqrt' }))],
  ['domainMax alone keeps its nice off', unit('point', Y({ domainMax: 20 }))],
  ['x quantitative', unit('point', { x: { field: 'v', type: 'quantitative', scale: { domain: [0, 20] } }, y: { field: 'w', type: 'quantitative' } })],
  ['temporal strings', unit('point', Y({ domain: ['2024-01-01', '2024-06-01'] }, 'temporal', 't'))],
  ['temporal timestamps', unit('point', Y({ domain: [1704067200000, 1717200000000] }, 'temporal', 't'))],
  ['temporal DateTime objects', unit('point', Y({ domain: [{ year: 2024, month: 'jan', date: 1 }, { year: 2024, month: 'jun', date: 1 }] }, 'temporal', 't'))],
  ['temporal with a time unit', unit('point', Y({ domain: [1, 5] }, 'temporal', 't', { timeUnit: 'month' }))],
  ['nominal, reordered', unit('point', Y({ domain: ['b', 'a'] }, 'nominal', 'c'))],
  ['size', unit('point', { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, size: { field: 'w', type: 'quantitative', scale: { domain: [0, 200] } } })],
  ['size over a domain that excludes zero', unit('point', { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, size: { field: 'w', type: 'quantitative', scale: { domain: [10, 100] } } })],
  ['opacity', unit('point', { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, opacity: { field: 'w', type: 'quantitative', scale: { domain: [0, 100] } } })],
  ['color', unit('point', { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, color: { field: 'w', type: 'quantitative', scale: { domain: [0, 100] } } })],
  ['color, nominal', unit('point', { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, color: { field: 'c', type: 'nominal', scale: { domain: ['c', 'b', 'a'] } } })],
]

describe('explicit scale domains', () => {
  for (const [label, spec] of CASES) {
    it(label, async () => {
      const oracle = vlCompile(spec as never).spec as unknown
      const ours = compile(spec as never) as unknown
      for (const name of ['x', 'y', 'size', 'opacity', 'color']) expect(pick(scaleOf(ours, name)), name).toEqual(pick(scaleOf(oracle, name)))
      expect(diffCanonical(canonicalizeSvg(await svgOf(oracle)), canonicalizeSvg(await svgOf(ours)))).toEqual([])
    })
  }
})

describe('a domain that is neither an array nor "unaggregated"', () => {
  for (const [label, domain] of [['a string', 'Aa'], ['a number', 42], ['true', true]] as const) {
    for (const channel of ['x', 'y', 'color'] as const) {
      it(`${label} on ${channel}: emitted as written, refused by vega and by the runtime`, async () => {
        const enc: Obj = { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } }
        enc[channel] = { ...(enc[channel] as Obj), scale: { domain } }
        const spec = unit('bar', enc)
        const oracle = vlCompile(spec as never).spec as unknown
        const ours = compile(spec as never) as unknown
        expect(scaleOf(ours, channel)?.domain).toEqual(scaleOf(oracle, channel)?.domain)
        await expect(svgOf(oracle)).rejects.toThrow(/Undefined data set name/)
        expect(() => renderSpec(ours as never)).toThrow()
      })
    }
  }
})
