/**
 * The evaluation that keeps no state (`evaluateOnce`: what `renderSpec` and `getChartInfo` run) does not carry the incremental engine,
 * and makes what the evaluation that does (`evaluateChart`) makes of a chart evaluated for the first time -- the datasets, the signals
 * and the drawing -- over generated charts (steps that read the size, signals, publish signals, number rows, draw), sizes and signal
 * values. A call that needs the engine and finds it missing says so, and is never answered with a different evaluation.
 */
import { describe, it, expect } from 'vitest'
import './addon-transforms.js'
import { compileChart } from './compiler.js'
import { evaluateChartPending, evaluateOnce } from './runtime.js'
import { evaluateChart } from './evaluate.js'
import { genSpec, made, mulberry32, pick, rowsOf, usable } from './dataset-reuse.testkit.js'
import type { RuntimeInput } from './types.js'

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
