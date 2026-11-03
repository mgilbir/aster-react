/**
 * The evaluation that keeps no state (`evaluateOnce`: what `renderSpec` and `getChartInfo` run) does not carry the incremental engine,
 * and makes what the evaluation that does (`evaluateChart`) makes of a chart evaluated for the first time -- the datasets, the signals
 * and the drawing -- over generated charts (steps that read the size, signals, publish signals, number rows, draw), sizes and signal
 * values. A call that needs the engine and finds it missing says so, and is never answered with a different evaluation.
 */
import { describe, it, expect, vi } from 'vitest'
import './addon-transforms.js'
import { compileChart } from './compiler.js'
import { evaluateOnce } from './runtime.js'
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

describe('the incremental engine is registered by the entries that re-evaluate', () => {
  it('without it, an evaluation that keeps state says what to import, and one that keeps none runs', async () => {
    vi.resetModules()
    const runtime = await import('./runtime.js')
    const { compileChart: compile } = await import('./compiler.js')
    const chart = compile({ width: 50, height: 50, data: [{ name: 't', values: [{ a: 1 }] }], marks: [] })
    expect(() => runtime.evaluateChartPending(chart, {})).toThrow(/incremental engine is not registered.*evaluateChart/s)
    expect(() => runtime.evaluateChart(chart, {})).toThrow(/incremental engine is not registered/)
    expect(runtime.evaluateOnce(chart, {}).width).toBeGreaterThan(0)
    // the registration module hands it over, and the same chart then evaluates
    await import('./incremental-register.js')
    expect(runtime.evaluateChart(chart, {}).width).toBeGreaterThan(0)
  })

  it('a session registers it, and so does the public evaluateChart', async () => {
    for (const entry of ['./session.js', './evaluate.js']) {
      vi.resetModules()
      const runtime = await import('./runtime.js')
      await import(entry)
      const chart = (await import('./compiler.js')).compileChart({ width: 50, height: 50, data: [{ name: 't', values: [{ a: 1 }] }], marks: [] })
      expect(() => runtime.evaluateChart(chart, {}), entry).not.toThrow()
    }
  })
})
