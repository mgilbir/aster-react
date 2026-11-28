// @vitest-environment node
/**
 * The animation forms vega-lite 6.4.3 compiles and vega runs, against vega-lite (ROUTED a22 -> a16: nine specs Aster refused). A timer
 * selection and the `time` channel come in many shapes - a timer with no time channel, `fields` and `encodings` together, `encodings`
 * other than `time`, a time unit, a second timer, an option a timer does not need, a bound timer, an aggregate on the time channel, a unit
 * of a layer - GENERATED here from a seed, then:
 *  - the output of vega-lite is run in vega: when it does not run (a dataset it never defines, a signal it declares twice) @aster-charts/vl
 *    must refuse the spec; when it runs, the compile must be accepted, and
 *  - the parts of the animation (the signals of the clock and the tuple, the store and the frame datasets, the time scale, what the marks
 *    read) are vega-lite's, and
 *  - the scene at several clock values is the same in both (the clock is set, with the timers stopped, and the view run again).
 */
import { describe, it, expect } from 'vitest'
import * as vega from 'vega'
import { compile, VLCompileError } from '@aster-charts/vl'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { oracleOf, plain, runs } from './vl-a16-helpers.js'
import { ROWS, genSpec } from './vl-anim-forms-space.js'

/** The parts of an animation in a compiled Vega: its signals, its datasets, the time scale and what the marks read (dataset names made equal). */
function parts(vg: any, selection: string): unknown {
  const sig = (n: string): unknown => (vg.signals ?? []).find((x: any) => x.name === n) ?? null
  const names = ['unit', 'anim_clock', 'last_tick_at', 'is_playing', 'eased_anim_clock', 'min_extent', 'max_range_extent', 'anim_value', selection, `${selection}_domain`, `${selection}_tuple`, `${selection}_tuple_fields`, `${selection}_modify`]
  const main = (s: string | undefined): string | undefined => (s === undefined ? s : s.endsWith('_curr') ? 'frame' : 'main')
  const marks: unknown[] = []
  const walk = (ms: any[]): void => {
    for (const m of ms ?? []) {
      marks.push({ type: m.type, from: m.from ? { ...m.from, ...(m.from.data !== undefined ? { data: main(m.from.data) } : {}), ...(m.from.facet ? { facet: { groupby: m.from.facet.groupby, data: main(m.from.facet.data) } } : {}) } : undefined, interactive: m.interactive, cursor: m.encode?.update?.cursor })
      walk(m.marks)
    }
  }
  walk(vg.marks)
  const data = (vg.data ?? []).filter((d: any) => d.name === `${selection}_store` || d.name.endsWith('_curr'))
  const time = (vg.scales ?? []).find((s: any) => /(^|_)time$/.test(s.name))
  return {
    signals: Object.fromEntries(names.map((n) => [n, JSON.parse(JSON.stringify(sig(n)))])),
    data: data.map((d: any) => ({ name: main(d.name), source: main(d.source), transform: d.transform })),
    scale: time ? { type: time.type, field: time.domain?.field, sort: time.domain?.sort, range: time.range } : null,
    marks,
  }
}

/** Run a Vega spec with its timers stopped and read its picture at each clock value. */
async function frames(vg: Record<string, unknown>, clocks: number[]): Promise<string[]> {
  const view = new vega.View(vega.parse(plain(vg) as never), { renderer: 'none' })
  const out: string[] = []
  try {
    await view.runAsync()
    view.finalize()
    out.push(await view.toSVG())
    for (const t of clocks) {
      view.signal('anim_clock', t)
      await view.runAsync()
      out.push(await view.toSVG())
    }
  } finally {
    view.finalize()
  }
  return out
}

const SEEDS = Array.from({ length: 160 }, (_, i) => 9100 + i * 7)
const CLOCKS = [0, 500, 1000, 1500]

describe('animation forms: vega-lite refuses or breaks, or its output is what is drawn', () => {
  for (const seed of SEEDS) {
    const spec = genSpec(seed)
    it(`seed ${seed}`, async () => {
      const oracle = oracleOf(spec)
      if ('refused' in oracle || !(await runs(oracle.vega))) {
        expect(() => compile(plain(spec) as never), 'vega-lite breaks on this spec').toThrow(VLCompileError)
        return
      }
      const ours = compile(plain(spec) as never) as Record<string, any>
      const selection = (spec.params ?? spec.layer?.[0]?.params)[0].name as string
      // (a second timer selection is dropped by both; a named view prefixes nothing here)
      expect(parts(ours, selection)).toEqual(parts(oracle.vega, selection))
      const [a, b] = await Promise.all([frames(oracle.vega, CLOCKS), frames(ours, CLOCKS)])
      a.forEach((svg, i) => expect(diffCanonical(canonicalizeSvg(svg), canonicalizeSvg(b[i]!)), `clock ${i === 0 ? 'start' : CLOCKS[i - 1]}`).toEqual([]))
    }, 30_000)
  }
})

describe('the nine animation specs vega-lite compiles and vega runs', () => {
  const timer = (extra: Record<string, unknown> = {}, name = 'anim') => ({ name, select: { type: 'point', on: 'timer', fields: ['year'], ...extra } })
  const anim = (over: Record<string, unknown> = {}): Record<string, any> => ({
    data: { values: ROWS }, params: [timer()], transform: [{ filter: { param: 'anim' } }], mark: 'point',
    encoding: { x: { field: 'life', type: 'quantitative' }, y: { field: 'fert', type: 'quantitative' }, time: { field: 'year', type: 'ordinal' } }, ...over,
  })
  const nine: Array<[string, Record<string, any>]> = [
    ['a timer selection without a time channel', anim({ encoding: { x: { field: 'life', type: 'quantitative' } } })],
    ['fields and encodings together', anim({ params: [timer({ encodings: ['time'] })] })],
    ['encodings other than time', anim({ params: [{ name: 'anim', select: { type: 'point', on: 'timer', encodings: ['x'] } }] })],
    ['a time unit projected through encodings', anim({ params: [{ name: 'anim', select: { type: 'point', on: 'timer', encodings: ['time'] } }], encoding: { x: { field: 'life', type: 'quantitative' }, time: { field: 'date', type: 'temporal', timeUnit: 'year' } } })],
    ['a second timer selection', anim({ params: [timer(), timer({}, 'other')] })],
    ['a toggle on the timer', anim({ params: [timer({ toggle: true })] })],
    ['a bound timer', anim({ params: [{ ...timer(), bind: { input: 'checkbox' } }] })],
    ['a time channel with an aggregate', anim({ encoding: { x: { field: 'life', type: 'quantitative' }, time: { field: 'year', type: 'ordinal', aggregate: 'max' } } })],
    ['an animated layer', { data: { values: ROWS }, layer: [anim()] }],
  ]
  for (const [name, spec] of nine) {
    it(name, async () => {
      const oracle = oracleOf(spec)
      expect('vega' in oracle && (await runs(oracle.vega)), 'vega-lite compiles it and vega runs it').toBe(true)
      const ours = compile(plain(spec) as never) as Record<string, any>
      const [a, b] = await Promise.all([frames((oracle as { vega: Record<string, any> }).vega, CLOCKS), frames(ours, CLOCKS)])
      a.forEach((svg, i) => expect(diffCanonical(canonicalizeSvg(svg), canonicalizeSvg(b[i]!)), `clock ${i === 0 ? 'start' : CLOCKS[i - 1]}`).toEqual([]))
    }, 30_000)
  }
})
