/**
 * Reuse under `limits` (docs/LIMITS.md, "Kept results under `limits`"; audit C277). A write to a signal only a rule reads keeps the
 * symbol items of a scatter by identity (signal-scoped reuse), with or without `limits`: a scale or a top-level mark kept under limits
 * is charged what making it charged, so the evaluation counts what a fresh one counts.
 *
 * And that is what makes it safe: generated sequences of signal writes over charts whose kept marks spend `maxGeneratedBytes` (a text
 * built by `pad`), under budgets around what an evaluation spends, are accepted or refused by the session exactly as a fresh
 * evaluation of the same input is.
 */
import { describe, expect, it } from 'vitest'
import { createChartSession } from './session.js'
import type { RuntimeInput, VgSpec } from './types.js'

const rows = Array.from({ length: 2000 }, (_, i) => ({ x: i % 97, y: (i * 17) % 100 }))
const spec = {
  width: 400, height: 300, signals: [{ name: 'h', value: 0 }], data: [{ name: 't' }],
  scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' }, { name: 'y', type: 'linear', domain: { data: 't', field: 'y' }, range: 'height' }],
  marks: [
    { type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' } } } },
    { type: 'rule', encode: { update: { x: { signal: 'h' }, y: { value: 0 }, y2: { signal: 'height' } } } },
  ],
} as unknown as VgSpec

/** How many of the writes of the signal `h` kept the first symbol item the evaluation before made. */
function keptOfWrites(extra: RuntimeInput): number {
  const session = createChartSession()
  const input = (h: number): RuntimeInput => ({ data: { t: rows }, signals: { h }, ...extra })
  const firstSymbol = (scene: ReturnType<typeof session.evaluate>): unknown => (scene.items[0] as { items: unknown[] }).items[0]
  let prev = session.evaluate(spec, input(0))
  let kept = 0
  for (let h = 1; h <= 5; h++) {
    const scene = session.evaluate(spec, input(h))
    if (firstSymbol(scene) === firstSymbol(prev)) kept++
    prev = scene
  }
  return kept
}

describe('reuse under limits', () => {
  it('without limits a write to a signal only a rule reads keeps the symbol items by identity', () => {
    expect(keptOfWrites({})).toBe(5)
  })

  it('under limits (here a generous maxTimeMs) the same writes keep them too', () => {
    expect(keptOfWrites({ limits: { maxTimeMs: 60_000 } })).toBe(5)
  })

  it('a mark made under other limits is made again (its single budgets were checked against other values)', () => {
    const session = createChartSession()
    const firstSymbol = (scene: ReturnType<typeof session.evaluate>): unknown => (scene.items[0] as { items: unknown[] }).items[0]
    const a = session.evaluate(spec, { data: { t: rows }, signals: { h: 0 }, limits: { maxTimeMs: 60_000 } })
    const b = session.evaluate(spec, { data: { t: rows }, signals: { h: 1 }, limits: { maxTimeMs: 60_000, maxItems: 100_000 } })
    expect(firstSymbol(b)).not.toBe(firstSymbol(a))
    const c = session.evaluate(spec, { data: { t: rows }, signals: { h: 2 }, limits: { maxItems: 100_000, maxTimeMs: 60_000 } })
    expect(firstSymbol(c)).toBe(firstSymbol(b))
  })
})

describe('a result kept under limits is charged what making it charged (C277)', () => {
  type Rnd = () => number
  const mulberry32 = (seed: number): Rnd => {
    let a = seed | 0
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const int = (r: Rnd, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1))
  /** Two text marks that build strings (`pad`): `a` reads nothing that changes, `b` reads the signal `h`. */
  const chart = (n: number, la: number): VgSpec => ({
    width: 200, height: 100, signals: [{ name: 'h', value: 0 }], data: [{ name: 't', values: Array.from({ length: n }, (_, i) => ({ i })) }],
    scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'i' }, range: 'width' }],
    marks: [
      { type: 'text', name: 'a', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'i' }, text: { signal: `pad('a', ${la})` } } } },
      { type: 'text', name: 'b', encode: { update: { x: { value: 1 }, text: { signal: "pad('b', h)" } } } },
    ],
  }) as unknown as VgSpec
  const outcome = (f: () => unknown): string => { try { f(); return 'ok' } catch (e) { return (e as Error).name === 'AsterLimitError' ? 'refused' : `threw ${(e as Error).message}` } }

  it('generated writes and budgets: the session accepts and refuses as a fresh evaluation does', () => {
    const diffs: string[] = []
    let refused = 0
    let accepted = 0
    for (let seed = 1; seed <= 120; seed++) {
      const r = mulberry32(seed)
      const n = int(r, 2, 6)
      const la = int(r, 5, 40)
      const s = chart(n, la)
      const budget = int(r, n * la, n * la + 120)
      const limits = { maxGeneratedBytes: budget }
      const session = createChartSession()
      for (let step = 0; step < 6; step++) {
        const h = int(r, 0, 150)
        const input: RuntimeInput = { signals: { h }, limits }
        const fresh = outcome(() => createChartSession().evaluate(s, input))
        const kept = outcome(() => session.evaluate(s, input))
        if (fresh !== kept) diffs.push(`seed ${seed} step ${step} h=${h} budget=${budget}: fresh ${fresh}, session ${kept}`)
        if (fresh === 'refused') refused++
        else accepted++
      }
    }
    expect(diffs.slice(0, 5)).toEqual([])
    // (not vacuous: both outcomes occur)
    expect(refused).toBeGreaterThan(50)
    expect(accepted).toBeGreaterThan(50)
  })
})
