/**
 * A signal that holds an item's `datum` (what an `update: "datum"` handler puts there: vega/reorderable-matrix's `src`) is the
 * row's tuple: `datum === src` is true for that row's items -- in an encode test, in another mark drawn from the same dataset, and
 * in a dataset transform -- after the evaluation that follows, as in vega, where every one of them is the very tuple object (C68).
 *
 * Generated: a dataset with inline values and a pipeline of transforms that write onto their rows in vega (formula, window,
 * timeunit-free arithmetic, joinaggregate, collect, filter), two marks over it, the comparison in an encode test of either mark or
 * in a formula of the pipeline, and the item whose datum the signal is given. The engine is given the datum of its own previous
 * scene; vega, the datum of its own scenegraph. Fills and positions of every item must be vega's.
 *
 *   ASTER_DATUM_SEEDS=200   (default 40)
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'

type Spec = Record<string, unknown>
type Rnd = () => number

function mulberry32(seed: number): Rnd {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T,>(r: Rnd, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!

const STEPS: ReadonlyArray<Record<string, unknown>> = [
  { type: 'formula', as: 'w', expr: 'datum.v * 2' },
  { type: 'window', sort: { field: 'v' }, ops: ['row_number'], as: ['rank'] },
  { type: 'joinaggregate', fields: ['v'], ops: ['sum'], as: ['total'] },
  { type: 'collect', sort: { field: 'k' } },
  { type: 'filter', expr: 'datum.v >= 0' },
]

interface Case { spec: Spec; mark: string; index: number }

function gen(r: Rnd): Case {
  const n = 2 + Math.floor(r() * 4)
  const values = Array.from({ length: n }, (_, i) => ({ k: String.fromCharCode(97 + i), v: Math.floor(r() * 9) }))
  const transform = STEPS.filter(() => r() < 0.4).map((t) => ({ ...t }))
  const where = pick(r, ['encode', 'other-mark', 'formula'])
  if (where === 'formula') transform.push({ type: 'formula', as: 'hit', expr: 'datum === src ? 1 : 0' })
  const test = where === 'formula' ? 'datum.hit === 1' : 'datum === src'
  const mark = (name: string, y: number, compares: boolean): Spec => ({
    type: 'rect', name, from: { data: 't' },
    encode: { update: {
      x: { signal: 'datum.v * 10' }, y: { value: y }, width: { value: 8 }, height: { value: 8 },
      fill: compares ? [{ test, value: 'steelblue' }, { value: 'black' }] : { value: 'gray' },
    } },
  })
  const clicked = pick(r, ['a', 'b'])
  return {
    spec: {
      width: 120, height: 40, padding: 0, autosize: 'none',
      signals: [{ name: 'src', value: {} }],
      data: [{ name: 't', values, transform }],
      marks: [mark('a', 0, where !== 'other-mark'), mark('b', 20, where !== 'encode')],
    },
    mark: clicked,
    index: Math.floor(r() * n),
  }
}

const find = (n: unknown, name: string): { items: Array<Record<string, unknown>> } | undefined => {
  if (n === null || typeof n !== 'object') return undefined
  if ((n as { name?: unknown }).name === name && (n as { marktype?: unknown }).marktype === 'rect') return n as never
  for (const c of ((n as { items?: unknown[] }).items ?? [])) { const f = find(c, name); if (f) return f }
  return undefined
}
const picture = (root: unknown): string => ['a', 'b'].map((m) => (find(root, m)?.items ?? []).map((it) => `${it.fill}@${it.x}`).join(' ')).join(' | ')

async function vegaPicture(c: Case): Promise<string> {
  const view = new vega.View(vega.parse(structuredClone(c.spec) as never), { renderer: 'none' }) as unknown as {
    runAsync(): Promise<unknown>; signal(n: string, v: unknown): unknown; scenegraph(): { root: unknown }; finalize(): void
  }
  try {
    await view.runAsync()
    const datum = find(view.scenegraph().root, c.mark)!.items[c.index]!.datum
    view.signal('src', datum)
    await view.runAsync()
    return picture(view.scenegraph().root)
  } finally { view.finalize() }
}

function asterPicture(c: Case): string {
  const chart = compileChart(structuredClone(c.spec) as never)
  const first = evaluateChart(chart, {})
  const datum = find(first, c.mark)!.items[c.index]!.datum
  return picture(evaluateChart(chart, { signals: { src: datum } }))
}

const SEEDS = Number(process.env.ASTER_DATUM_SEEDS ?? 40)

describe('a signal holding an item datum is that row\'s tuple (generated, vs real vega)', () => {
  it('datum === src in encode tests, other marks and dataset formulas', async () => {
    const diffs: string[] = []
    let hits = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const c = gen(mulberry32(seed * 7907))
      const want = await vegaPicture(c)
      if (want.includes('steelblue')) hits++
      const got = asterPicture(c)
      if (got !== want) diffs.push(`seed ${seed}: vega ${want} | aster ${got}`)
    }
    expect(diffs).toEqual([])
    // (the generated cases reach the identity: vega paints the row it was handed)
    expect(hits).toBeGreaterThan(SEEDS / 2)
  })
})
