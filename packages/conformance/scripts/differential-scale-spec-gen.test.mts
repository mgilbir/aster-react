/**
 * GENERATED live differential for the parts of "scale spec -> built scale" the hand-written and seeded cases of
 * `differential-scale-spec` reach thinly: where a DISCRETE or QUANTILE domain comes from. Each case is a Vega spec holding
 * one scale `s`; real Vega (vega-parser + vega-encode) builds it, Aster builds it (`getChartInfo`), in one process, and the
 * two scales are projected identically (type, domain, range, outputs for the domain values, bins, thresholds, bandwidth)
 * and compared exactly. A spec Vega rejects must be rejected by Aster.
 *
 * What is drawn: columns that mix numbers, numeric strings, booleans, null, NaN and text (so `1`, `'1'` and `true` meet);
 * sorts by key, by count, by an aggregate of another column, descending, through signals, and unsupported ones; domains of
 * one field, of several fields of one dataset, of several datasets, and of literal lists and signals among the fields;
 * quantile and numeric multi-field domains; and ranges that name entries of `config.range`, chains of them and loops.
 */
import { describe, expect, it, vi } from 'vitest'
import * as vega from 'vega'
import { getChartInfo } from '../../core/src/runtime.ts'
import { attempt, quietLogger } from './differential-util.mts'
import { makeRng, scaled, type Rng } from './differential-gen.mts'

vi.setConfig({ testTimeout: 120_000 })

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyScale = ((x: unknown) => unknown) & Record<string, any>

function project(s: AnyScale, probes: unknown[]): Record<string, unknown> {
  const m = (name: string, ...args: unknown[]): unknown => s[name](...args)
  const o: Record<string, unknown> = { type: s.type }
  o.domain = attempt(() => m('domain'))
  o.range = attempt(() => m('range'))
  o.samples = probes.map((p) => attempt(() => s(p)))
  for (const name of ['bandwidth', 'step', 'thresholds', 'quantiles', 'clamp', 'round', 'padding', 'paddingInner', 'paddingOuter', 'align', 'unknown']) {
    if (typeof s[name] === 'function') o[name] = attempt(() => (name === 'quantiles' ? m('quantiles', 4) : m(name)))
  }
  o.bins = 'bins' in s ? attempt(() => s.bins) : { $: 'undef' }
  return o
}

async function vegaScale(spec: unknown): Promise<AnyScale> {
  const errors: unknown[][] = []
  const quiet = quietLogger(errors)
  const view = new vega.View(vega.parse(structuredClone(spec) as vega.Spec), { renderer: 'none', logLevel: vega.None, logger: quiet as never })
  view.logger(quiet as never)
  await view.runAsync()
  if (errors.length) throw new Error(String(errors[0]))
  return view.scale('s') as unknown as AnyScale
}

const MIXED: unknown[] = ['a', 'b', 'c', 'a b', 'A', '', ' ', 1, 2, 10, '1', '2', '10', 0, '0', true, false, 'true', null, NaN, 'NaN', 1.5, -1, '-1', 'x', 'y']
const SORT_OPS = ['count', 'sum', 'min', 'max', 'mean', 'median', 'distinct', 'valid', 'missing', 'q1', 'average', 'bogus']

function column(r: Rng, pool: readonly unknown[]): unknown[] {
  return Array.from({ length: r.between(0, 14) }, () => r.pick(pool))
}

function rowsFor(r: Rng): Record<string, unknown>[] {
  const n = r.between(0, 14)
  return Array.from({ length: n }, () => ({
    a: r.pick(MIXED),
    c: r.pick(MIXED.slice(0, 12)),
    b: r.chance(0.1) ? r.pick([null, NaN, 'z']) : r.between(-5, 30),
    t: r.pick(['p', 'q', 'r']),
  }))
}

function genSort(r: Rng): unknown {
  switch (r.int(17)) {
    case 14:
    case 15: return { field: 'count' }
    case 16: return { field: 'count', order: 'descending' }
    case 0: return true
    case 1: return { order: 'descending' }
    case 2: return { field: 'b' }
    case 3: return { field: 'count', order: 'descending' }
    case 4: return { field: 'key', order: 'descending' }
    case 5: return { op: 'count' }
    case 6: return { op: 'count', order: 'descending' }
    case 7: return { op: r.pick(SORT_OPS), field: 'b', order: r.pick(['ascending', 'descending']) }
    case 8: return { op: r.pick(SORT_OPS) }
    case 9: return { op: { signal: 'sop' }, field: { signal: 'sfield' }, order: { signal: 'sord' } }
    case 10: return { field: 'a' }
    case 11: return { op: 'sum', field: 'a' }
    case 12: return { order: { signal: 'sord' } }
    default: return false
  }
}

function genMember(r: Rng, fieldPool: string[]): unknown {
  switch (r.int(8)) {
    case 0: return ['lit', 'a', 1, '1', null]
    case 1: return { signal: 'sig' }
    case 2: return { signal: 'scalar' }
    case 3: return { data: 'e', field: r.pick(fieldPool) }
    default: return r.pick(fieldPool)
  }
}

function genDomain(r: Rng, type: string): unknown {
  const fields = ['a', 'c', 't']
  switch (r.int(10)) {
    case 0: return ['x', 'y', 1, '1', 'x']
    case 1: return { signal: 'sig' }
    case 2:
    case 3:
    case 4: return { data: 'd', field: r.pick(fields), ...(r.chance(0.7) ? { sort: genSort(r) } : {}) }
    case 5:
    case 6: return { data: 'd', fields: [r.pick(fields), r.pick(fields)], ...(r.chance(0.7) ? { sort: genSort(r) } : {}) }
    case 7:
    case 8: return { fields: [{ data: 'd', field: r.pick(fields) }, genMember(r, fields)], data: 'd', ...(r.chance(0.7) ? { sort: genSort(r) } : {}) }
    default: return type === 'quantile' ? { data: 'd', fields: ['b', 'b'] } : { data: 'nowhere', field: 'a' }
  }
}

function genSpec(r: Rng): { spec: unknown; probes: unknown[] } {
  const type = r.pick(['ordinal', 'ordinal', 'band', 'point', 'quantile', 'bin-ordinal', 'linear', 'ordinal'])
  const s: Record<string, unknown> = { name: 's', type }
  s.domain = genDomain(r, type)
  const config: Record<string, unknown> = {}
  switch (r.int(8)) {
    case 0: s.range = 'category'; break
    case 1: s.range = { scheme: r.pick(['tableau10', 'blues', 'set1']) }; break
    case 2: s.range = 'ramp'; break
    case 3: s.range = 'chain'; config.range = { chain: 'hop1', hop1: 'hop2', hop2: 'hop3', hop3: { scheme: 'set2' } }; break
    case 4: s.range = 'loop'; config.range = { loop: 'loop' }; break
    case 5: s.range = 'mine'; config.range = { mine: ['red', 'green', 'blue'] }; break
    case 6: s.range = type === 'band' || type === 'point' ? [0, 300] : ['red', 'green', 'blue', 'black']; break
    default: s.range = { scheme: 'category10', count: 3 }; break
  }
  if (r.chance(0.2)) s.domainImplicit = r.chance(0.5)
  if (r.chance(0.2)) s.padding = r.pick([0, 0.2, 0.5])
  const signals = [
    { name: 'sig', value: ['p', 1, '1', 'q', 'a'] },
    { name: 'scalar', value: r.pick([5, 'five', null]) },
    { name: 'sop', value: r.pick(['count', 'sum', 'max', 'min']) },
    { name: 'sfield', value: r.pick(['b', 'a', 'key', 'count']) },
    { name: 'sord', value: r.pick(['ascending', 'descending']) },
  ]
  const spec = {
    width: 300,
    height: 200,
    ...(Object.keys(config).length ? { config } : {}),
    signals,
    data: [{ name: 'd', values: rowsFor(r) }, { name: 'e', values: rowsFor(r) }],
    scales: [s],
  }
  return { spec, probes: [...MIXED.slice(0, 12), 'p', 'q', 'lit', undefined, null] }
}

/** Run `count` generated specs through both sides; returns the first mismatches and how many were built / refused. */
async function sweep(count: number, gen: () => { spec: unknown; probes: unknown[] }): Promise<{ bad: string; built: number; refused: number }> {
  let refused = 0
  let built = 0
  const bad: string[] = []
  for (let i = 0; i < count; i++) {
    const { spec, probes } = gen()
    let want: unknown
    try {
      want = project(await vegaScale(spec), probes)
      built++
    } catch {
      want = { $: 'throw' }
      refused++
    }
    let got: unknown
    try {
      const s = getChartInfo(structuredClone(spec) as never).scales.get('s') as AnyScale | undefined
      got = s ? project(s, probes) : { $: 'throw' }
    } catch {
      got = { $: 'throw' }
    }
    if (JSON.stringify(want) !== JSON.stringify(got) && bad.length < 4) {
      const sp = spec as { scales: unknown[]; config?: unknown; signals: unknown[]; data: unknown[] }
      bad.push(`#${i} ${JSON.stringify(sp.scales)} config=${JSON.stringify(sp.config)}\n   signals=${JSON.stringify(sp.signals)}\n   data=${JSON.stringify(sp.data)?.slice(0, 400)}\n   vega  ${JSON.stringify(want)?.slice(0, 300)}\n   aster ${JSON.stringify(got)?.slice(0, 300)}`)
    }
  }
  return { bad: bad.join('\n'), built, refused }
}

describe(`discrete and quantile domains from specs vs vega@${vega.version} (generated, live)`, () => {
  it('covers every kind of domain source and refuses what vega refuses', async () => {
    const r = makeRng(0x5ec1)
    const count = scaled(1500)
    const out = await sweep(count, () => genSpec(r))
    expect(out.bad).toBe('')
    // both outcomes must be common, or the sweep says little
    expect(out.built).toBeGreaterThan(count * 0.4)
    expect(out.refused).toBeGreaterThan(count * 0.03)
  })

  it('several fields that share values, sorted by how many fields hold them, by key or by an aggregate', async () => {
    const r = makeRng(0x5ec2)
    const count = scaled(500)
    const out = await sweep(count, () => {
      const pool = ['a', 'b', 'c', 1, '1', 2, true, 'true', null]
      const rows = (): Record<string, unknown>[] => Array.from({ length: r.between(1, 8) }, () => ({ p: r.pick(pool), q: r.pick(pool), b: r.between(0, 9) }))
      const sort = r.pick<unknown>([{ field: 'count' }, { field: 'count', order: 'descending' }, { field: 'key', order: 'descending' }, { op: 'count' }, { op: 'max', field: 'b' }, { op: 'min', field: 'b', order: 'descending' }, { op: 'sum', field: 'b' }, true, undefined])
      const spec = {
        width: 100,
        height: 100,
        signals: [],
        data: [{ name: 'd', values: rows() }, { name: 'e', values: rows() }],
        scales: [{ name: 's', type: 'ordinal', domain: { fields: [{ data: 'd', field: 'p' }, { data: 'd', field: 'q' }, ...(r.chance(0.5) ? [{ data: 'e', field: 'p' }] : [])], ...(sort === undefined ? {} : { sort }) }, range: ['red', 'green', 'blue', 'black', 'white'] }],
      }
      return { spec, probes: pool }
    })
    expect(out.bad).toBe('')
    expect(out.built).toBeGreaterThan(count * 0.5)
  })
})
