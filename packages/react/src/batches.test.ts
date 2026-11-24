/**
 * The producer queue's batch fold has the effect of applying its batches one by one (C492 kept it, and made it linear).
 *
 * Differential, generated: random sequences of snapshots, appends, signal and size changes over two datasets are pushed into one
 * core stream one batch at a time, and folded into one batch pushed into another; both streams must hold the same rows, signals
 * and size after the flush. Then the cost: folding n one-row appends is linear in n (each append is copied once).
 */
import { describe, expect, it } from 'vitest'
import { createChartStream, datasetsOfScene, type StreamBatch, type VgSpec } from '@aster-charts/core'
import { createBatchFold } from './batches'

const spec = {
  width: 100, height: 50, padding: 0, autosize: 'none',
  signals: [{ name: 'a', value: 0 }, { name: 'b', value: 0 }],
  data: [{ name: 't', values: [{ v: -1 }] }, { name: 'u', values: [] }],
  marks: [
    { type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'v' }, y: { signal: 'a + b' } } } },
    { type: 'symbol', from: { data: 'u' }, encode: { update: { x: { field: 'v' }, y: { signal: 'width' } } } },
  ],
} as unknown as VgSpec

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function batches(seed: number): StreamBatch[] {
  const r = rng(seed)
  let v = 0
  const rows = (n: number): Array<{ v: number }> => Array.from({ length: n }, () => ({ v: v++ }))
  const out: StreamBatch[] = []
  const n = 1 + Math.floor(r() * 8)
  for (let i = 0; i < n; i++) {
    const b: StreamBatch = {}
    const ds = r() < 0.5 ? 't' : 'u'
    const k = r()
    if (k < 0.4) b.append = { [ds]: rows(Math.floor(r() * 4)) }
    else if (k < 0.6) b.data = { [ds]: rows(Math.floor(r() * 4)) }
    else if (k < 0.7) { b.data = { [ds]: rows(2) }; b.append = { [ds]: rows(1) } }
    if (r() < 0.3) b.signals = { [r() < 0.5 ? 'a' : 'b']: Math.floor(r() * 10) }
    if (r() < 0.2) b.width = 100 + Math.floor(r() * 50)
    out.push(b)
  }
  return out
}

const stateOf = (scene: Parameters<typeof datasetsOfScene>[0]): unknown => ({
  t: datasetsOfScene(scene).get('t')?.map((d) => (d as { v: number }).v),
  u: datasetsOfScene(scene).get('u')?.map((d) => (d as { v: number }).v),
  y: scene.items.map((m) => ((m as { items: Array<{ y?: number; x?: number }> }).items).map((i) => i.y)),
})

describe('createBatchFold: one folded batch has the effect of its batches applied one by one', () => {
  it.each(Array.from({ length: 60 }, (_, i) => i + 1))('seed %i', (seed) => {
    const list = batches(seed)
    const oneByOne = createChartStream(spec, { capacity: 64, policy: 'drop-newest' })
    for (const b of list) expect(oneByOne.push(b)).toBe(true)
    oneByOne.flush()
    const fold = createBatchFold<StreamBatch>()
    for (const b of list) {
      const expected = fold.rowsWith(b)
      fold.add(b)
      expect(fold.rows()).toBe(expected)
    }
    const folded = createChartStream(spec, { capacity: 64, policy: 'drop-newest' })
    folded.push(fold.take()!)
    folded.flush()
    expect(stateOf(folded.scene()!)).toEqual(stateOf(oneByOne.scene()!))
  })

  it('folding is linear: 16x the appends cost at most ~16x (with slack), not 256x', () => {
    const time = (n: number): number => {
      const fold = createBatchFold<StreamBatch>()
      const t0 = performance.now()
      for (let i = 0; i < n; i++) fold.add({ append: { t: [{ v: i }] } })
      const out = fold.take()!
      expect(out.append!.t).toHaveLength(n)
      return performance.now() - t0
    }
    time(5_000) // warm up
    const small = Math.max(time(10_000), 1)
    const large = time(160_000)
    // quadratic growth would be 256x; linear is 16x. 64x leaves room for a loaded machine and GC.
    expect(large / small).toBeLessThan(64)
  })
})
