// @vitest-environment node
/**
 * `dotbin` and `pie` against vega over generated inputs (C130, C404, C628): values with nulls, undefined, NaN, strings and ties,
 * groups (one, several, keyed by values that stringify alike), `step` given, 0, empty or absent (vega's `||` and its autostep over
 * vega-util's extent), `smooth` as any truthy or falsy value, the `signal` a dotbin publishes read by a later dataset; a pie's
 * `startAngle` / `endAngle` given, 0, empty, null or strings, sorted or not. Datasets compared value for value, key order included.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, datasetsOfScene, evaluateChart } from '@aster-charts/core'
import '@aster-charts/core/transforms'

type Obj = Record<string, unknown>

function stream(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function viaVega(spec: Obj): Promise<Record<string, unknown>> {
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none', logLevel: vega.None })
  try {
    await view.runAsync()
    const out: Record<string, unknown> = {}
    for (const d of spec.data as Obj[]) out[d.name as string] = view.data(d.name as string)
    return out
  } finally {
    view.finalize()
  }
}
function viaAster(spec: Obj): Record<string, unknown> {
  const got = datasetsOfScene(evaluateChart(compileChart(structuredClone(spec) as never), {}))
  const out: Record<string, unknown> = {}
  for (const d of spec.data as Obj[]) out[d.name as string] = got.get(d.name as string)
  return out
}
const show = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x === undefined ? '__undef' : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x))

function values(r: () => number, n: number): unknown[] {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  return Array.from({ length: n }, () => (r() < 0.15 ? pick([null, undefined, NaN, '7', 'x', true]) : Math.round(r() * 200) / 10))
}

describe('dotbin and pie, as vega computes them', () => {
  it('300 generated dotbins', { timeout: 120_000 }, async () => {
    const bad: string[] = []
    for (let seed = 1; seed <= 300; seed++) {
      const r = stream(seed)
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
      const n = 1 + Math.floor(r() * 12)
      const v = values(r, n)
      const rows = v.map((x, i) => ({ ...(x === undefined ? {} : { v: x }), g: pick(['a', 'b', 'a,b', 1, '1']), h: pick(['p', 'q']), i }))
      const t: Obj = { type: 'dotbin', field: 'v', signal: 'db' }
      const step = pick([undefined, 0, '', 1, 2.5, 0.1, null])
      if (step !== undefined) t.step = step
      const smooth = pick([undefined, true, false, 1, 0, 'yes', ''])
      if (smooth !== undefined) t.smooth = smooth
      const groupby = pick([undefined, ['g'], ['g', 'h'], 'h'])
      if (groupby !== undefined) t.groupby = groupby
      if (r() < 0.3) t.as = 'stack'
      const spec = { data: [{ name: 'src', values: rows, transform: [t] }, { name: 'sig', values: [{}], transform: [{ type: 'formula', as: 's', expr: '[db.start, db.stop, db.step]' }] }] }
      let want: string
      try { want = show(await viaVega(spec)) } catch (e) { want = 'THROW ' + (e as Error).message }
      let got: string
      try { got = show(viaAster(spec)) } catch (e) { got = 'THROW ' + (e as Error).message }
      if (got !== want) bad.push(`#${seed} ${JSON.stringify(t)} ${JSON.stringify(rows)}\n  vega ${want}\n  aster ${got}`)
    }
    expect(bad, `${bad.length} differ:\n${bad.slice(0, 4).join('\n')}`).toEqual([])
  })

  it('200 generated pies', { timeout: 120_000 }, async () => {
    const bad: string[] = []
    for (let seed = 1; seed <= 200; seed++) {
      const r = stream(seed + 1000)
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
      const rows = values(r, 1 + Math.floor(r() * 8)).map((x) => (x === undefined ? {} : { v: x }))
      const t: Obj = { type: 'pie', ...(r() < 0.8 ? { field: 'v' } : {}) }
      const start = pick([undefined, 0, '', null, 1, '1', 0.5])
      const end = pick([undefined, 0, '', null, 3, '3', 6.283185307179586])
      if (start !== undefined) t.startAngle = start
      if (end !== undefined) t.endAngle = end
      if (r() < 0.4) t.sort = pick([true, 1, false])
      const spec = { data: [{ name: 'src', values: rows, transform: [t] }] }
      let want: string
      try { want = show(await viaVega(spec)) } catch (e) { want = 'THROW ' + (e as Error).message }
      let got: string
      try { got = show(viaAster(spec)) } catch (e) { got = 'THROW ' + (e as Error).message }
      if (got !== want) bad.push(`#${seed} ${JSON.stringify(t)} ${JSON.stringify(rows)}\n  vega ${want}\n  aster ${got}`)
    }
    expect(bad, `${bad.length} differ:\n${bad.slice(0, 4).join('\n')}`).toEqual([])
  })
})
