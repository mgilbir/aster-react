/**
 * A dataset pipeline step whose inputs did not change is not run again.
 *
 * A chart is evaluated again for a new size, a new signal value, new data: the React mount alone evaluates every dataset twice (the
 * spec's size, then the measured container's). A step reads its input rows, the signals its parameters mention, the random source
 * and the id counter (step-reuse.ts); when none of them moved, the rows it made are the rows it would make. What this file pins:
 *
 *  - the engine keeps exactly those steps (and runs the ones that read what moved), so the saving is real;
 *  - keeping them changes nothing anyone can see: datasets, signals, ids and the scene are the ones a chart that never kept a step
 *    makes, over generated charts that mix steps reading the size, steps reading signals, steps that publish signals, ids and
 *    steps that draw random numbers (the reference is a chart evaluated one-shot, which has nothing to keep, fed the same inputs
 *    from a source in the same state).
 */
import { describe, it, expect } from 'vitest'
import './addon-transforms.js'
import { compileChart } from './compiler.js'
import { datasetsOfScene, evaluateChart, evaluateChartPending } from './runtime.js'
import { createChartSession } from './session.js'
import { reuse, runsOf, stepCounts } from './step-reuse.js'
import { genSpec, made, mulberry32, pick, rowsOf, usable, type Row } from './dataset-reuse.testkit.js'
import type { RuntimeInput, SceneRoot, VgSpec } from './types.js'

const counted = <T,>(run: () => T): { out: T; ran: number; reused: number } => {
  const before = { ...stepCounts }
  const out = run()
  return { out, ran: stepCounts.ran - before.ran, reused: stepCounts.reused - before.reused }
}

describe('a re-evaluation keeps the steps whose inputs did not change', () => {
  const rows = rowsOf(60)
  const spec = {
    width: 200, height: 100, autosize: 'none',
    signals: [{ name: 'k', value: 3 }, { name: 'other', value: 1 }],
    data: [{
      name: 't',
      transform: [
        { type: 'bin', field: 'x', extent: [0, 13], step: 2, as: ['b0', 'b1'] },
        { type: 'filter', expr: 'datum.v > k' },
        { type: 'formula', as: 'w', expr: 'datum.x * width' },
        { type: 'formula', as: 'w2', expr: 'datum.w + 1' },
        { type: 'aggregate', groupby: ['b0'], fields: ['w2'], ops: ['sum'], as: ['s'] },
      ],
    }],
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'b0' }, y: { field: 's' } } } }],
  } as unknown as VgSpec

  it('a resize runs the steps that read the size, and the ones after them; the others are kept', () => {
    const session = createChartSession()
    session.evaluate(spec, { data: { t: rows }, width: 200, height: 100 })
    const { ran, reused } = counted(() => session.evaluate(spec, { data: { t: rows }, width: 300, height: 100 }))
    expect(reused).toBe(2) // bin, filter
    expect(ran).toBe(3) // formula w (reads width), formula w2 and aggregate (read its rows)
  })

  it('a signal change runs only the steps that read it, and the ones after them', () => {
    const session = createChartSession()
    session.evaluate(spec, { data: { t: rows }, signals: { k: 3 } })
    const unrelated = counted(() => session.evaluate(spec, { data: { t: rows }, signals: { k: 3, other: 2 } }))
    expect(unrelated.ran).toBe(0)
    expect(unrelated.reused).toBe(5)
    const read = counted(() => session.evaluate(spec, { data: { t: rows }, signals: { k: 4, other: 2 } }))
    expect(read.reused).toBe(1) // bin
    expect(read.ran).toBe(4)
  })

  it('rows that are equal but are a new array keep them too', () => {
    const session = createChartSession()
    session.evaluate(spec, { data: { t: rows } })
    const { ran, reused } = counted(() => session.evaluate(spec, { data: { t: rows.map((r) => ({ ...r })) }, width: 250 }))
    expect(reused).toBe(2)
    expect(ran).toBe(3)
  })

  it('other rows keep nothing', () => {
    const session = createChartSession()
    session.evaluate(spec, { data: { t: rows } })
    const { reused } = counted(() => session.evaluate(spec, { data: { t: rows.slice(1) }, width: 250 }))
    expect(reused).toBe(0)
  })

  it('what a kept step made is what a one-shot evaluation makes', () => {
    const session = createChartSession()
    session.evaluate(spec, { data: { t: rows } })
    const kept = session.evaluate(spec, { data: { t: rows }, width: 320 })
    const fresh = evaluateChart(compileChart(spec), { data: { t: rows }, width: 320 })
    expect(made(kept)).toBe(made(fresh))
  })
})

describe('the engine keeps a step only for rows it can tell are the ones it made it from', () => {
  const spec = {
    width: 100, height: 100, autosize: 'none',
    data: [{ name: 't', transform: [{ type: 'bin', field: 'x', extent: [0, 13], step: 2, as: ['b0', 'b1'] }, { type: 'filter', expr: 'datum.v > 2' }] }],
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'b0' } } } }],
  } as unknown as VgSpec
  const first = rowsOf(30)
  const second = rowsOf(30).map((r) => ({ ...r, x: ((r.x as number) + 1) % 13 }))
  const evaluate = (chart: ReturnType<typeof compileChart>, rows: Row[], input: RuntimeInput, unchanged?: Map<string, unknown>): { scene: SceneRoot; reused: number } => {
    const before = stepCounts.reused
    const pending = evaluateChartPending(chart, { data: { t: rows }, ...input }, unchanged)
    pending.commit()
    return { scene: pending.scene, reused: stepCounts.reused - before }
  }

  it('rows it was told are the ones it was given before are kept', () => {
    const chart = compileChart(spec)
    evaluate(chart, first, {})
    expect(evaluate(chart, first.map((r) => ({ ...r })), {}, new Map([['t', first]])).reused).toBe(2)
  })
  it('without being told, nothing is kept: the rows may have been written to', () => {
    const chart = compileChart(spec)
    evaluate(chart, first, {})
    expect(evaluate(chart, first, {}).reused).toBe(0)
  })
  it('rows it was told are the ones of some other evaluation are not', () => {
    const chart = compileChart(spec)
    evaluate(chart, first, {})
    const { scene, reused } = evaluate(chart, second, {}, new Map([['t', second]]))
    expect(reused).toBe(0)
    expect(made(scene)).toBe(made(evaluateChart(compileChart(spec), { data: { t: second } })))
  })
  it('a dataset named as changed is not kept, whatever it was told', () => {
    const chart = compileChart(spec)
    evaluate(chart, first, {})
    expect(evaluate(chart, first, { changedDatasets: ['t'] }, new Map([['t', first]])).reused).toBe(0)
  })
})

describe("a group scope's dataset is kept with the rows it was made from", () => {
  const spec = {
    width: 100, height: 100, autosize: 'none',
    signals: [{ name: 'k', value: 3 }],
    data: [{ name: 't', transform: [{ type: 'formula', as: 'w', expr: 'datum.x * 2' }] }],
    marks: [{
      type: 'group',
      data: [{ name: 'g', source: 't', transform: [{ type: 'filter', expr: 'datum.v > k' }, { type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] }] }],
      marks: [{ type: 'symbol', from: { data: 'g' }, encode: { update: { x: { field: 's' } } } }],
    }],
  } as unknown as VgSpec
  const rows: Row[] = rowsOf(30)

  it('a resize keeps it, a change of a signal it mentions does not', () => {
    const session = createChartSession()
    session.evaluate(spec, { data: { t: rows } })
    const resized = counted(() => session.evaluate(spec, { data: { t: rows }, width: 150 }))
    expect(resized.ran).toBe(0) // the formula reads nothing that moved, so the group's two steps read the rows they read before
    expect(resized.reused).toBe(3)
    const signal = counted(() => session.evaluate(spec, { data: { t: rows }, width: 150, signals: { k: 5 } }))
    expect(signal.reused).toBe(1) // the formula
    expect(signal.ran).toBe(2)
    expect(made(signal.out)).toBe(made(evaluateChart(compileChart(spec), { data: { t: rows }, width: 150, signals: { k: 5 } })))
  })

  it('rows that were changed in place are not the rows it was made from', () => {
    const live = rows.map((r) => ({ ...r }))
    const chart = compileChart(spec)
    evaluateChartPending(chart, { data: { t: live } }, undefined).commit()
    live.length = 0
    for (const r of rows) live.push({ ...r, v: ((r.v as number) + 4) % 11 })
    const pending = evaluateChartPending(chart, { data: { t: live }, dataChanges: { t: live.map((_, i) => i) } })
    pending.commit()
    expect(made(pending.scene)).toBe(made(evaluateChart(compileChart(spec), { data: { t: live } })))
  })
})

describe('a step that publishes a signal publishes it again when it is kept', () => {
  const spec = {
    width: 100, height: 100, autosize: 'none',
    signals: [{ name: 'k', value: 0 }, { name: 'half', update: 'ext[1] / 2' }],
    data: [
      { name: 't', transform: [{ type: 'extent', field: 'x', signal: 'ext' }, { type: 'formula', as: 'y', expr: 'datum.x + width' }] },
      { name: 'u', source: 't', transform: [{ type: 'bin', field: 'x', extent: { signal: 'ext' }, maxbins: 4, signal: 'binned', as: ['b0', 'b1'] }, { type: 'filter', expr: 'datum.x <= half' }] },
    ],
    marks: [{ type: 'symbol', from: { data: 'u' }, encode: { update: { x: { field: 'b0' }, y: { signal: 'half' } } } }],
  } as unknown as VgSpec
  const rows = rowsOf(40)

  it('the signal, what is computed from it and what reads it are the ones a one-shot evaluation has', () => {
    const session = createChartSession()
    session.evaluate(spec, { data: { t: rows } })
    const { out, reused } = counted(() => session.evaluate(spec, { data: { t: rows }, width: 150 }))
    expect(reused).toBeGreaterThan(0)
    const fresh = evaluateChart(compileChart(spec), { data: { t: rows }, width: 150 })
    const signals = (s: SceneRoot): Record<string, unknown> => (s as unknown as { signalParams: Record<string, unknown> }).signalParams
    expect(signals(out).ext).toEqual([0, 12])
    expect(signals(out).half).toBe(6)
    expect(signals(out).binned).toEqual(signals(fresh).binned)
    expect(made(out)).toBe(made(fresh))
  })
})

describe('ids', () => {
  const spec = {
    width: 100, height: 100, autosize: 'none',
    signals: [{ name: 'k', value: 2 }],
    data: [
      { name: 't', transform: [{ type: 'identifier', as: 'id' }, { type: 'filter', expr: 'datum.v > k' }] },
      { name: 'u', source: 't', transform: [{ type: 'formula', as: 'f', expr: 'datum.x + k' }, { type: 'identifier', as: 'uid' }] },
    ],
    marks: [{ type: 'symbol', from: { data: 'u' }, encode: { update: { x: { field: 'uid' } } } }],
  } as unknown as VgSpec
  const rows = rowsOf(30)
  const idsOf = (s: SceneRoot): unknown => {
    const d = datasetsOfScene(s)
    return { t: (d.get('t') ?? []).map((r) => (r as Row).id), u: (d.get('u') ?? []).map((r) => (r as Row).uid) }
  }

  it('an unrelated change keeps both identifier steps and every id', () => {
    const session = createChartSession()
    const first = session.evaluate(spec, { data: { t: rows } })
    const { out, ran } = counted(() => session.evaluate(spec, { data: { t: rows }, width: 140 }))
    expect(ran).toBe(0)
    expect(idsOf(out)).toEqual(idsOf(first))
  })

  it('a change that moves rows numbers them as a one-shot evaluation that carried the ids would', () => {
    const session = createChartSession()
    const direct = compileChart(spec)
    const states = [{ k: 2 }, { k: 2 }, { k: 6 }, { k: 2 }, { k: 4 }]
    for (const signals of states) {
      const a = session.evaluate(spec, { data: { t: rows }, signals })
      const b = evaluateChart(direct, { data: { t: rows }, signals })
      expect(made(a)).toBe(made(b))
    }
  })
})

describe('a step that draws does not draw again when it is kept', () => {
  const spec = {
    width: 100, height: 100, autosize: 'none',
    signals: [{ name: 'k', value: 1 }],
    data: [{
      name: 't',
      transform: [
        { type: 'formula', as: 'r', expr: 'random()' },
        { type: 'formula', as: 'n', expr: 'sampleNormal(0, 1)' },
        { type: 'formula', as: 'w', expr: 'datum.r * width' },
        { type: 'filter', expr: 'datum.v >= k' },
      ],
    }],
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'w' }, y: { field: 'n' } } } }],
  } as unknown as VgSpec
  const rows = rowsOf(30)
  const source = (): (() => number) => mulberry32(5)

  it('a resize draws nothing, and the numbers are the ones the first evaluation drew', () => {
    const random = source()
    const session = createChartSession()
    const first = session.evaluate(spec, { data: { t: rows }, random, width: 100 })
    const after = counted(() => session.evaluate(spec, { data: { t: rows }, random, width: 180 }))
    expect(after.reused).toBe(2) // the two that draw
    const drawn = (s: SceneRoot): unknown => (datasetsOfScene(s).get('t') ?? []).map((r) => [(r as Row).r, (r as Row).n])
    expect(drawn(after.out)).toEqual(drawn(first))
  })

  it('a source of another identity is not the source the numbers came from', () => {
    const session = createChartSession()
    session.evaluate(spec, { data: { t: rows }, random: source(), width: 100 })
    const { reused } = counted(() => session.evaluate(spec, { data: { t: rows }, random: source(), width: 180 }))
    expect(reused).toBe(0)
  })

  it('with no injected source nothing that could draw is kept', () => {
    const session = createChartSession()
    session.evaluate(spec, { data: { t: rows }, width: 100 })
    const { reused } = counted(() => session.evaluate(spec, { data: { t: rows }, width: 180 }))
    expect(reused).toBe(0)
  })
})

describe('consecutive steps that add fields run as one, and the engine that updates them cannot tell', () => {
  const rows: Row[] = rowsOf(30)
  /**
   * The updates the incremental engine takes over for: a row less (the first update after the rows were made keeps the steps
   * the rows were made by as they were), a row changed, a row more.
   */
  const updates: Row[][] = [
    rows,
    rows.filter((_, i) => i !== 5),
    rows.map((r, i) => (i === 3 ? { ...r, x: 12, v: 9 } : r)),
    [...rows, { id: 90, g: 1, x: 40, v: 3 }],
    rows.slice(2),
  ]
  const same = (transform: unknown[], draws = false): void => {
    const spec = {
      width: 100, height: 100, autosize: 'none', signals: [{ name: 'k', value: 1 }],
      data: [{ name: 't', transform }, { name: 'u', source: 't', transform: [{ type: 'formula', as: 'w', expr: 'datum.k' }] }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' } } } }],
    } as unknown as VgSpec
    const a = createChartSession()
    const b = createChartSession()
    const srcA = mulberry32(3)
    const srcB = mulberry32(3)
    for (const [i, data] of updates.entries()) {
      const got = made(a.evaluate(spec, { data: { t: data }, ...(draws ? { random: srcA } : {}) }))
      reuse.on = false
      try { expect(got, `update ${i}`).toBe(made(b.evaluate(spec, { data: { t: data }, ...(draws ? { random: srcB } : {}) }))) } finally { reuse.on = true }
    }
  }

  it('a step reads a field that a later step of the run writes', () => {
    same([{ type: 'formula', as: 'p', expr: 'datum.x + 1' }, { type: 'bin', field: 'p', maxbins: 4, as: ['b0', 'b1'] }, { type: 'formula', as: 'p', expr: 'datum.b0 * 2' }])
  })
  it('a step reads a field that the rows came with and a later step of the run writes', () => {
    same([{ type: 'formula', as: 'y', expr: 'datum.v + 1' }, { type: 'bin', field: 'x', maxbins: 4, as: ['b0', 'b1'] }, { type: 'formula', as: 'x', expr: 'datum.v' }, { type: 'formula', as: 'f', expr: 'datum.b0 + datum.x' }])
  })
  it('a step reads the field it writes', () => {
    same([{ type: 'formula', as: 'y', expr: 'datum.v + 1' }, { type: 'bin', field: 'x', maxbins: 4, as: ['x', 'x1'] }, { type: 'formula', as: 'z', expr: 'datum.x + datum.y' }])
  })
  it('two steps write the same field', () => {
    same([{ type: 'formula', as: 'a', expr: 'datum.x' }, { type: 'bin', field: 'v', maxbins: 4, as: ['b0', 'b1'] }, { type: 'formula', as: 'a', expr: 'datum.b0 + datum.a' }])
  })
  it('a global step, then a step that draws: the rows that stay keep their numbers', () => {
    same([{ type: 'bin', field: 'x', maxbins: 4, as: ['b0', 'b1'] }, { type: 'formula', as: 'f', expr: 'datum.b0 + 1' }, { type: 'formula', as: 'r', expr: 'random()' }], true)
  })
  it('a run of steps is one run, and a step that publishes or draws ends it', () => {
    const t = (...fs: unknown[]): never => compileChart({ data: [{ name: 't', values: [], transform: fs }] } as never).data[0]!.transform as never
    expect(runsOf(t({ type: 'formula', as: 'a', expr: 'datum.x' }, { type: 'formula', as: 'b', expr: 'datum.a + 1' }, { type: 'bin', field: 'b', maxbins: 3, as: ['c0', 'c1'] }))).toEqual([2, 2, 2])
    expect(runsOf(t({ type: 'formula', as: 'a', expr: 'datum.x' }, { type: 'bin', field: 'a', maxbins: 3, signal: 'bi', as: ['c0', 'c1'] }, { type: 'formula', as: 'b', expr: 'datum.a' }))).toEqual([0, 1, 2])
    expect(runsOf(t({ type: 'formula', as: 'a', expr: 'random()' }, { type: 'formula', as: 'b', expr: 'datum.x' }))).toEqual([0, 1])
    expect(runsOf(t({ type: 'formula', as: 'a', expr: 'datum.x' }, { type: 'filter', expr: 'datum.a > 1' }, { type: 'formula', as: 'b', expr: 'datum.a' }))).toEqual([0, 1, 2])
    expect(runsOf(t({ type: 'formula', as: 'a', expr: 'datum.x' }, { type: 'formula', as: 'b', expr: 'length(datum)' }))).toEqual([0, 1])
  })
})

type Data = 'same' | 'fresh' | 'append' | 'modify' | 'remove'
interface Visit { width: number; measured: boolean; sigA: number; sigB: number; thr: number; data: Data; source: number }

describe('generated charts, walked through sizes, signal values and data', () => {
  const rows: Row[] = rowsOf(36)
  const others: Row[] = rowsOf(20).map((r) => ({ ...r, x: (r.x as number) + 1 }))
  const seeds = Number(process.env.ASTER_REUSE_SEEDS ?? 300)
  const only = process.env.ASTER_REUSE_SEED ? Number(process.env.ASTER_REUSE_SEED) : undefined

  /** The rows after a visit's change to them: the same array, copies of its rows, a row more, a row changed, or a row less. */
  const changed = (rs: Row[], how: Data, at: number): Row[] => {
    switch (how) {
      case 'fresh': return rs.map((x) => ({ ...x }))
      case 'append': return [...rs, { id: 100 + at, g: at % 4, x: (at * 3) % 13, v: (at * 7) % 11 }]
      case 'modify': return rs.map((x, i) => (i === at % rs.length ? { ...x, v: ((x.v as number) + 3) % 11 } : x))
      case 'remove': return rs.filter((_, i) => i !== at % rs.length)
      default: return rs
    }
  }

  const walk = (seed: number): { checked: number; kept: number } => {
    const g = genSpec(seed)
    if (!usable(g, rows)) return { checked: 0, kept: 0 }
    const r = mulberry32(seed ^ 0x9e3779b9)
    const visits: Visit[] = []
    const pool = { width: [200, 260, 320], sigA: [3, 4, 5], sigB: [1, 2, 3], thr: [2, 5] }
    // (a visit changes the size and the signals, or the data and nothing else: the incremental engine only takes over from a run
    // made under the same size and signals)
    for (let i = 0, n = 4 + Math.floor(r() * 6); i < n; i++) {
      const was = visits[visits.length - 1]
      if (was !== undefined && r() < 0.5) visits.push({ ...was, data: pick(r, ['append', 'modify', 'remove', 'fresh'] as const), source: was.source })
      else {
        visits.push({
          width: pick(r, pool.width), measured: r() < 0.3, sigA: pick(r, pool.sigA), sigB: pick(r, pool.sigB), thr: pick(r, pool.thr),
          data: pick(r, ['same', 'same', 'fresh'] as const), source: r() < 0.2 ? 1 : 0,
        })
      }
    }
    // The reference is a second session evaluated without keeping a step or running steps as one (the engine as it was). Both worlds
    // draw from sources of the same seeds, and a source is switched in the same visits.
    const sources = (): Array<() => number> => [mulberry32(seed + 1), mulberry32(seed + 2)]
    const sourcesA = sources()
    const sourcesB = sources()
    const session = createChartSession()
    const reference = createChartSession()
    let kept = 0
    let checked = 0
    let t = rows
    let u = others
    for (const [i, v] of visits.entries()) {
      t = changed(t, v.data, i)
      u = changed(u, v.data, i + 1)
      const input = (random: () => number): RuntimeInput => ({
        data: { t, d1: u, d2: u },
        ...(v.measured ? { measuredSize: { width: v.width, height: 100 } } : { width: v.width }),
        signals: { sigA: v.sigA, sigB: v.sigB, thr: v.thr },
        ...(g.draws ? { random } : {}),
      })
      const got = counted(() => { try { return made(session.evaluate(g.spec, input(sourcesA[v.source]!))) } catch (e) { return `error: ${(e as Error).message}` } })
      let want: string
      reuse.on = false
      try { want = made(reference.evaluate(g.spec, input(sourcesB[v.source]!))) } catch (e) { want = `error: ${(e as Error).message}` } finally { reuse.on = true }
      if (got.out !== want) throw new Error(`seed ${seed}, visit ${i} ${JSON.stringify(v)}: the kept steps changed the output\n${g.text}\n${got.out.slice(0, 400)}\n${want.slice(0, 400)}`)
      kept += got.reused
      checked++
    }
    return { checked, kept }
  }

  it(`${only ?? seeds} seeds: what is made with kept steps is what is made without`, { timeout: 300_000 }, () => {
    let checked = 0
    let kept = 0
    for (const seed of only !== undefined ? [only] : Array.from({ length: seeds }, (_, i) => i + 1)) {
      const w = walk(seed)
      checked += w.checked
      kept += w.kept
    }
    expect(checked).toBeGreaterThan(seeds)
    // (the generator makes charts that keep steps: a sweep that kept none would prove nothing)
    expect(kept).toBeGreaterThan(seeds)
  })
})
