/**
 * The evaluation that keeps no state (`evaluateOnce`: what `renderSpec` and `getChartInfo` run) does not carry the incremental engine,
 * and makes what the evaluation that does (`evaluateChart`) makes of a chart evaluated for the first time -- the datasets, the signals
 * and the drawing -- over generated charts (steps that read the size, signals, publish signals, number rows, draw), sizes and signal
 * values. A call that needs the engine and finds it missing says so, and is never answered with a different evaluation.
 */
import { describe, it, expect } from 'vitest'
import './addon-transforms.js'
import { compileChart } from './compiler.js'
import { datasetsOfScene, evaluateChartPending, evaluateOnce } from './runtime.js'
import { evaluateChart } from './evaluate.js'
import { genSpec, made, mulberry32, pick, rowsOf, usable } from './dataset-reuse.testkit.js'
import type { RuntimeInput, VgSpec } from './types.js'

describe('an evaluation that keeps no state is the first evaluation of one that does', () => {
  const rows = rowsOf(36)
  const others = rowsOf(20).map((r) => ({ ...r, x: (r.x as number) + 1 }))
  const seeds = Number(process.env.ASTER_ONCE_SEEDS ?? 300)

  it(`${seeds} generated charts, each at several sizes and signal values`, { timeout: 300_000 }, () => {
    let checked = 0
    for (let seed = 1; seed <= seeds; seed++) {
      const g = genSpec(seed)
      if (!usable(g, rows)) continue
      const r = mulberry32(seed ^ 0x51ed270b)
      for (let i = 0; i < 4; i++) {
        const v = { width: pick(r, [200, 260, 320]), measured: r() < 0.3, sigA: pick(r, [3, 4, 5]), sigB: pick(r, [1, 2, 3]), thr: pick(r, [2, 5]) }
        const input = (random: () => number): RuntimeInput => ({
          data: { t: rows, d1: others, d2: others },
          ...(v.measured ? { measuredSize: { width: v.width, height: 100 } } : { width: v.width }),
          signals: { sigA: v.sigA, sigB: v.sigB, thr: v.thr },
          ...(g.draws ? { random } : {}),
        })
        const once = (): string => { try { return made(evaluateOnce(compileChart(g.spec), input(mulberry32(seed + i)))) } catch (e) { return `error: ${(e as Error).message}` } }
        const kept = (): string => { try { return made(evaluateChart(compileChart(g.spec), input(mulberry32(seed + i)))) } catch (e) { return `error: ${(e as Error).message}` } }
        const a = once()
        const b = kept()
        if (a !== b) throw new Error(`seed ${seed}, ${JSON.stringify(v)}: the evaluation that keeps no state made something else\n${g.text}\n${a.slice(0, 400)}\n${b.slice(0, 400)}`)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(seeds)
  })
})

/** Specs whose datasets live in group scopes: sources shared with the view, facets, nested scopes, signals of a scope. */
function genScoped(seed: number): { spec: VgSpec; written: string[] } {
  const r = mulberry32(seed)
  const written: string[] = []
  const step = (i: number, scope: string): Record<string, unknown> => {
    const as = `w${scope}${i}`
    written.push(as)
    return pick(r, [
      { type: 'formula', as, expr: `datum.v * ${1 + Math.floor(r() * 3)}` },
      { type: 'formula', as, expr: 'datum.x + sigA' },
      { type: 'filter', expr: `datum.v >= ${Math.floor(r() * 4)}` },
      { type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: [as] },
      { type: 'identifier', as },
      { type: 'collect', sort: { field: 'v' } },
    ])
  }
  const chain = (scope: string): Array<Record<string, unknown>> => Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => step(i, scope))
  const child = (data: string): Record<string, unknown> => ({ type: 'symbol', from: { data }, encode: { update: { x: { field: 'x' }, y: { field: 'v' } } } })
  const marks: unknown[] = [
    // a group whose dataset is made from the view's (shared source rows), then a mark over the view's dataset itself
    { type: 'group', data: [{ name: 'gd', source: 't', transform: chain('a') }], marks: [child('gd')] },
    child('t'),
  ]
  if (r() < 0.7) marks.push({
    type: 'group', from: { facet: { name: 'fc', data: 't', groupby: 'g' } },
    data: [{ name: 'fd', source: 'fc', transform: chain('b') }],
    marks: [child('fd'), { type: 'group', data: [{ name: 'nd', source: 'fd', transform: chain('c') }], marks: [child('nd')] }],
  })
  if (r() < 0.5) marks.push({
    type: 'group', signals: [{ name: 'sc', value: 2 }], data: [{ name: 'sd', source: ['t', 'u'], transform: [{ type: 'formula', as: 'sc2', expr: 'datum.v + sc' }, ...chain('d')] }],
    marks: [child('sd')],
  })
  written.push('sc2')
  const spec = {
    width: 200, height: 100, autosize: 'none',
    signals: [{ name: 'sigA', value: 3 }],
    data: [{ name: 't', values: [] }, { name: 'u', values: [] }],
    marks,
  } as unknown as VgSpec
  return { spec, written }
}

describe('datasets of group scopes: shared sources, facets and nested scopes', () => {
  const rows = rowsOf(30)
  const others = rowsOf(12).map((x) => ({ ...x, x: (x.x as number) + 2 }))
  const seeds = Number(process.env.ASTER_ONCE_SCOPED ?? 200)

  it(`${seeds} generated charts: evaluateOnce is evaluateChart, and no pipeline of a scope writes into the rows of its source`, { timeout: 300_000 }, () => {
    let checked = 0
    let withScopes = 0
    for (let seed = 1; seed <= seeds; seed++) {
      const { spec, written } = genScoped(seed)
      for (const width of [200, 260]) {
        const input = (): RuntimeInput => ({ data: { t: rows, u: others }, width, random: mulberry32(seed) })
        let a: string
        let b: string
        let once
        try { once = evaluateOnce(compileChart(spec), input()); a = made(once) } catch (e) { a = `error: ${(e as Error).message}` }
        let kept
        try { kept = evaluateChart(compileChart(spec), input()); b = made(kept) } catch (e) { b = `error: ${(e as Error).message}` }
        if (a !== b) throw new Error(`seed ${seed}, width ${width}: the evaluation that keeps no state made something else\n${JSON.stringify(spec)}\n${a.slice(0, 300)}\n${b.slice(0, 300)}`)
        for (const scene of [once, kept]) {
          if (scene === undefined) continue
          // (the view's own datasets hold the rows they were given: a group's formula writes onto its own copies)
          for (const [name, ds] of datasetsOfScene(scene)) {
            if (name !== 't' && name !== 'u') continue
            for (const row of ds ?? []) for (const f of written) if (f in (row as object)) throw new Error(`seed ${seed}: dataset ${name} holds ${f}, written by the pipeline of a group scope`)
          }
          withScopes++
        }
        checked++
      }
    }
    expect(checked).toBe(seeds * 2)
    expect(withScopes).toBeGreaterThan(seeds)
  })
})

describe('an evaluation that keeps state is handed the incremental engine', () => {
  const chart = (): ReturnType<typeof compileChart> => compileChart({ width: 50, height: 50, data: [{ name: 't', values: [{ a: 1 }] }], marks: [] })

  it('without one it does not run, and says what it needs', () => {
    expect(() => evaluateChartPending(undefined as never, chart(), {})).toThrow(/needs the incremental engine/)
    expect(() => evaluateChartPending({} as never, chart(), {})).toThrow(/needs the incremental engine/)
  })

  it('the public evaluateChart and a session are handed it: a second evaluation takes a pulse', () => {
    const c = compileChart({ width: 50, height: 50, data: [{ name: 't', transform: [{ type: 'filter', expr: 'datum.a >= 0' }] }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'a' }, y: { value: 5 } } } }] })
    const rows = [{ a: 1 }, { a: 2 }]
    const first = evaluateChart(c, { data: { t: rows } })
    const second = evaluateChart(c, { data: { t: [...rows, { a: 3 }] }, dataPulse: { t: { appendOnly: true, baseLength: 2, changed: [] } } })
    const item = (s: typeof first): unknown => (s.items.find((g) => g.marktype === 'symbol') as { items: unknown[] }).items[0]
    expect(item(second)).toBe(item(first))
  })
})
