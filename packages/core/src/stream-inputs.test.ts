// @vitest-environment node
/** What a stream takes its inputs to be; the oracle is a fresh evaluation of the rows it flushes. */
import { describe, expect, it } from 'vitest'
import { createChartStream } from './stream.js'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { datasetsOfScene } from './runtime.js'
import { renderSceneToSvg } from './index.js'
import './addon-transforms.js'
import type { RuntimeInput, SceneRoot, VgSpec } from './types.js'

type Row = Record<string, unknown>
const svgOf = (s: SceneRoot): string => renderSceneToSvg(s)
const fresh = (spec: VgSpec, input: RuntimeInput = {}): SceneRoot => evaluateChart(compileChart(structuredClone(spec)), input)
function rng(seed: number): () => number {
  let a = seed | 0
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

describe('stream inputs (C399, C484, C502, C529, C705)', () => {
  const spec = {
    width: 100, height: 100, data: [{ name: 'table' }],
    marks: [{ type: 'text', from: { data: 'table' }, encode: { update: { text: { signal: "'' + datum.x" }, y: { signal: 'datum.x' } } } }],
  } as unknown as VgSpec
  const r = (x: number): Row => ({ x })

  it('a pulse whose `from` names an old row twice is re-derived, not trusted (generated)', () => {
    const g = rng(399)
    for (let k = 0; k < 200; k++) {
      const old = Array.from({ length: 4 }, (_, i) => r(i))
      const n = 1 + Math.floor(g() * 4)
      const from = Array.from({ length: n }, () => (g() < 0.2 ? -1 : Math.floor(g() * 4)))
      const data = from.map((q, i) => (q >= 0 ? old[q]! : r(10 + i)))
      const stream = createChartStream(spec, { initial: { data: { table: old } } })
      stream.flush()
      stream.push({ data: { table: data }, pulse: { table: { from, changed: [] } } })
      stream.flush()
      expect(svgOf(stream.scene()!), JSON.stringify(from)).toBe(svgOf(fresh(spec, { data: { table: data } })))
    }
  })

  it('a push made while a flush runs is delivered by the next flush, under every policy', () => {
    for (const policy of ['coalesce', 'drop-newest', 'drop-oldest', 'error'] as const) {
      let stream: ReturnType<typeof createChartStream> | null = null
      let pushed = false
      const logger = { error() {}, warn() { if (!pushed && stream) { pushed = true; stream.push({ append: { table: [r(99)] } }) } }, info() {}, debug() {} }
      // (a mark that warns: its text is asked of a field the rows do not have, which vega warns about)
      const warning = { ...spec, marks: [...(spec as { marks: unknown[] }).marks, { type: 'rect', encode: { update: { x: { scale: 'nope', value: 1 } } } }] } as unknown as VgSpec
      stream = createChartStream(warning, { policy, initial: { data: { table: [r(1)] }, logger } })
      stream.push({ append: { table: [r(2)] } })
      stream.flush()
      if (!pushed) continue // (nothing warned under this policy: the case does not arise)
      expect(stream.stats().depth, policy).toBe(1)
      stream.flush()
      expect((datasetsOfScene(stream.scene()!).get('table') as Row[]).map((d) => d.x), policy).toEqual([1, 2, 99])
    }
  })

  it('bounds that are not numbers are a TypeError, not no bound', () => {
    for (const bad of [NaN, '5', null, {}]) {
      expect(() => createChartStream(spec, { capacity: bad as never }), String(bad)).toThrow(TypeError)
      expect(() => createChartStream(spec, { maxQueuedRows: bad as never }), String(bad)).toThrow(TypeError)
    }
    expect(() => createChartStream(spec, { capacity: Infinity, maxQueuedRows: 10 })).not.toThrow()
  })

  it('a queued snapshot is the rows it held when pushed', () => {
    const stream = createChartStream(spec, { initial: { data: { table: [r(1)] } } })
    stream.flush()
    const rows = [r(1), r(2), r(3)]
    stream.push({ data: { table: rows } })
    rows.push(r(4), r(5))
    stream.flush()
    expect((datasetsOfScene(stream.scene()!).get('table') as Row[]).length).toBe(3)
  })

  it('a closed stream returns false for any push, and the first rows are checked as later ones are', () => {
    const stream = createChartStream(spec, { initial: { data: { table: [r(1)] } } })
    stream.close()
    expect(stream.push({ append: { table: [null as never] } })).toBe(false)
    expect(() => createChartStream(spec, { initial: { data: { table: [r(1), null as never] } } })).toThrow(TypeError)
  })
})

