/**
 * An `identifier` after a filter numbers rows as their source rows (a source row keeps its number while it lives, whether the filter
 * lets it through or not: vega's tuples), and a pulse through the pipeline numbers them so too: rows appended to a stream run from the
 * rows the run before made, following only the source rows of the rows added (`applyPipelineWithPulse` in incremental-engine.ts).
 *
 * The reference is the incremental-oracle rule for ids: the same chart evaluated through the same states with no hint of what changed.
 * Each append is also checked to have taken the pulse (the rows that were there are the rows they were) without following the source
 * row of every row.
 */
import { describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { createChartStream } from './stream.js'
import { datasetsOfScene } from './runtime.js'
import { sourcesFollowed } from './incremental-engine.js'
import type { VgSpec } from './types.js'

type Row = Record<string, unknown>

function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const spec = (): VgSpec => ({
  width: 100, height: 50, autosize: 'none',
  signals: [{ name: 'cut', value: 30 }],
  data: [
    { name: 't', values: [] },
    { name: 'a', source: 't', transform: [
      { type: 'formula', as: 'w', expr: 'datum.v * 2' },
      { type: 'filter', expr: 'datum.v >= cut' },
      { type: 'filter', expr: 'datum.v % 7 != 0' },
      { type: 'identifier', as: 'id' },
    ] },
    { name: 'b', values: [], transform: [{ type: 'identifier', as: 'id' }] },
  ],
  marks: ['a', 'b'].map((name) => ({ type: 'symbol', from: { data: name }, encode: { update: { x: { field: 'id' } } } })),
} as unknown as VgSpec)

type Op = { append?: Row[]; append2?: Row[]; snapshot?: Row[]; cut?: number }

describe('identifier after a filter, through a pulse', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`numbers rows as a run with no hint does, and appends take the pulse (seed ${seed})`, () => {
      const rnd = mulberry32(seed)
      const row = (): Row => ({ v: Math.floor(rnd() * 100) })
      let t: Row[] = Array.from({ length: 400 }, row)
      let b: Row[] = [{ w: 0 }]
      const ops: Op[] = []
      for (let i = 0; i < 40; i++) {
        const r = rnd()
        if (r < 0.55) ops.push({ append: Array.from({ length: 1 + Math.floor(rnd() * 5) }, row) })
        else if (r < 0.65) ops.push({ append2: [{ w: i + 1 }] })
        else if (r < 0.8) ops.push({ cut: Math.floor(rnd() * 80) })
        else ops.push({ snapshot: [] })
      }
      const stream = createChartStream(spec(), { capacity: 8 })
      const ref = compileChart(spec())
      let cut = 30
      stream.push({ data: { t, b } })
      let scene = stream.flush()!.scene
      evaluateChart(ref, { data: { t, b }, signals: { cut } })
      for (const [i, op] of ops.entries()) {
        const before = [...(datasetsOfScene(scene).get('a') ?? [])] as Row[]
        const followed = sourcesFollowed.all
        if (op.append) { stream.push({ append: { t: op.append } }); t = [...t, ...op.append] }
        if (op.append2) { stream.push({ append: { b: op.append2 } }); b = [...b, ...op.append2] }
        if (op.cut !== undefined) { cut = op.cut; stream.push({ signals: { cut } }) }
        if (op.snapshot) {
          // (a row removed from the middle, one changed where it stands: a pulse with a mapping)
          const at = Math.floor(rnd() * t.length)
          t = t.filter((_, j) => j !== at).map((r, j) => (j === at ? { v: (r.v as number) + 1 } : r))
          stream.push({ data: { t } })
        }
        scene = stream.flush()!.scene
        const want = evaluateChart(ref, { data: { t, b }, signals: { cut } })
        for (const name of ['a', 'b']) {
          const got = (datasetsOfScene(scene).get(name) ?? []) as Row[]
          const exp = (datasetsOfScene(want).get(name) ?? []) as Row[]
          expect(got.map((r) => `${r.v ?? r.w}:${r.id}`), `op ${i}: ids of ${name}`).toEqual(exp.map((r) => `${r.v ?? r.w}:${r.id}`))
        }
        if (op.append) {
          const now = datasetsOfScene(scene).get('a') as Row[]
          expect(before.every((r, j) => now[j] === r), `op ${i}: the rows of a that were there are kept`).toBe(true)
          expect(sourcesFollowed.all - followed, `op ${i}: an append follows the source rows of the rows added only`).toBe(0)
        }
        if (op.snapshot) expect(sourcesFollowed.all - followed, `op ${i}: a mapping follows every row`).toBeGreaterThan(0)
      }
    })
  }
})
