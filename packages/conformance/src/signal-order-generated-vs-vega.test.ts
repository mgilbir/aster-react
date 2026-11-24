/**
 * The order in which a view's signals, datasets and scales settle, against real vega (audit T2, order kind): generated views
 * whose signals read scales and data that read signals in turn, declared in a shuffled order, and the same views evaluated by
 * the engine. The signal values and every dataset's rows must be vega's.
 *
 * - chains (C23): `d1` -> scale `x1` over it -> signal `s1 = domain('x1')[1]` -> `d2` reads `s1` (a formula, a filter or a
 *   sequence) -> scale `x2` -> ... at depths 1..8;
 * - inits (C25): a signal's `init` reads a signal that reads data, a scale, or an `extent` a transform publishes, directly or through
 *   another signal, declared before or after it;
 * - self-reading updates and cycles (C113): `a = a + k` evaluates once; a cycle of reactive reads throws vega's message, a cycle
 *   through a `react: false` reader does not.
 *
 *   ASTER_ORDER_SEEDS=200   seeds per family (default 40)
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, datasetsOfScene, evaluateChart } from '@aster-charts/core'

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
const shuffle = <T,>(r: Rnd, xs: T[]): T[] => {
  for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [xs[i], xs[j]] = [xs[j]!, xs[i]!] }
  return xs
}

interface Case { spec: Spec; signals: string[]; data: string[] }

function chain(r: Rnd): Case {
  const depth = 1 + Math.floor(r() * 8)
  const data: Spec[] = [{ name: 'd1', values: [{ v: 1 }, { v: 2 }, { v: 3 }] }]
  const scales: Spec[] = []
  const signals: Spec[] = []
  for (let k = 1; k <= depth; k++) {
    scales.push({ name: `x${k}`, type: 'linear', zero: false, nice: false, domain: { data: `d${k}`, field: 'v' }, range: [0, 100] })
    signals.push({ name: `s${k}`, ...(r() < 0.3 ? { value: 100 } : {}), update: pick(r, [`domain('x${k}')[1]`, `domain('x${k}')[1] + 1`, `length(data('d${k}')) + domain('x${k}')[0]`]) })
    const form = pick(r, ['formula', 'filter', 'sequence'])
    const transform = form === 'formula' ? [{ type: 'formula', as: 'v', expr: `datum.v + s${k}` }]
      : form === 'filter' ? [{ type: 'filter', expr: `datum.v <= s${k}` }]
        : [{ type: 'sequence', start: 0, stop: { signal: `s${k} % 7 + 1` }, as: 'v' }]
    data.push(form === 'sequence' ? { name: `d${k + 1}`, transform } : { name: `d${k + 1}`, source: `d${k}`, transform })
  }
  return {
    spec: { width: 100, height: 40, autosize: 'none', signals: shuffle(r, signals), data: shuffle(r, data), scales, marks: [] },
    signals: signals.map((s) => s.name as string),
    data: data.map((d) => d.name as string),
  }
}

function inits(r: Rnd): Case {
  const base = pick(r, [
    { signals: [{ name: 'a', update: "length(data('t'))" }], extra: {} },
    { signals: [{ name: 'a', update: "domain('x')[1]" }], extra: {} },
    { signals: [{ name: 'a', update: 'ext[1]' }], extra: { extent: true } },
  ])
  const via = r() < 0.5
  const reader = { name: 'i', init: pick(r, [via ? 'b * 2' : 'a * 2', via ? "'n=' + b" : "'n=' + a", via ? 'b + 1' : 'a + 1']) }
  const mid = via ? [{ name: 'b', update: 'a + 0' }] : []
  const signals = shuffle(r, [...base.signals, ...mid, reader] as Spec[])
  const t: Spec = { name: 't', values: [{ v: 1 }, { v: 2 }, { v: 3 }], ...(base.extra.extent ? { transform: [{ type: 'extent', field: 'v', signal: 'ext' }] } : {}) }
  // (and, half the time, a dataset that reads the init's value: it runs after the init, which runs after what it reads --
  // vega/serpentine-timeline's `sDomain`)
  const readsInit = r() < 0.5 ? [{ name: 'u', source: 't', transform: [{ type: 'formula', as: 'w', expr: "datum.v + '/' + i + '/' + i.length" }] }] : []
  return {
    spec: { width: 100, height: 40, autosize: 'none', signals, data: [t, ...readsInit], scales: [{ name: 'x', type: 'linear', zero: false, nice: false, domain: { data: 't', field: 'v' }, range: [0, 10] }], marks: [] },
    signals: signals.map((s) => s.name as string),
    data: ['t', ...readsInit.map((d) => d.name)],
  }
}

function selfAndCycles(r: Rnd): Case {
  const n = 2 + Math.floor(r() * 3)
  const names = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i))
  const signals: Spec[] = names.map((name, i) => {
    const reads = names.filter((m, j) => j !== i && r() < 0.4)
    const self = r() < 0.4 ? [name] : []
    const terms = [...reads, ...self]
    return { name, value: i + 1, ...(terms.length ? { update: `${terms.join(' + ')} + 1` } : {}), ...(r() < 0.2 ? { react: false } : {}) }
  })
  return { spec: { width: 50, height: 20, autosize: 'none', signals, marks: [] }, signals: names, data: [] }
}

const FAMILIES: ReadonlyArray<readonly [string, (r: Rnd) => Case]> = [['chains', chain], ['inits', inits], ['self-reading updates and cycles', selfAndCycles]]

const norm = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? `[${x}]` : x === undefined ? '[undefined]' : x))
const rowsOf = (rows: readonly unknown[] | undefined | null): unknown[] => (rows ?? []).map((row) => ({ ...(row as object) }))

async function vegaResult(c: Case): Promise<string> {
  type View = { runAsync(): Promise<unknown>; signal(n: string): unknown; data(n: string): unknown[]; finalize(): void }
  let view: View | undefined
  try {
    let errors = 0
    const logger = { level() { return logger }, error() { errors++; return logger }, warn() { return logger }, info() { return logger }, debug() { return logger } }
    const made = new vega.View(vega.parse(structuredClone(c.spec) as never), { renderer: 'none', logger } as never) as unknown as View
    view = made
    await made.runAsync()
    return norm({ signals: c.signals.map((n) => made.signal(n)), data: c.data.map((n) => rowsOf(made.data(n))), errors: errors > 0 })
  } catch (e) {
    return `threw ${(e as Error).message}`
  } finally {
    view?.finalize()
  }
}

function asterResult(c: Case): string {
  try {
    let errors = 0
    const scene = evaluateChart(compileChart(structuredClone(c.spec) as never), { logger: { error() { errors++ }, warn() {}, info() {}, debug() {} } as never })
    const params = (scene as unknown as { signalParams: Record<string, unknown> }).signalParams
    const ds = datasetsOfScene(scene)
    // (and whether the run logged an error: an operator run before what it reads fails where vega's does not)
    return norm({ signals: c.signals.map((n) => params[n]), data: c.data.map((n) => rowsOf(ds.get(n))), errors: errors > 0 })
  } catch (e) {
    return `threw ${(e as Error).message}`
  }
}

const SEEDS = Number(process.env.ASTER_ORDER_SEEDS ?? 40)

describe('signals, datasets and scales settle in vega\'s order (generated, vs real vega)', () => {
  for (const [family, gen] of FAMILIES) {
    it(family, async () => {
      const diffs: string[] = []
      let threw = 0
      for (let seed = 1; seed <= SEEDS; seed++) {
        const c = gen(mulberry32(seed * 104729 + family.length))
        const want = await vegaResult(c)
        if (want.startsWith('threw')) threw++
        const got = asterResult(c)
        if (got !== want) diffs.push(`seed ${seed}: vega ${want.slice(0, 160)} | aster ${got.slice(0, 160)}`)
      }
      expect(diffs).toEqual([])
      // (the cycles family must reach both outcomes: some views vega refuses, most it runs)
      if (family.startsWith('self')) { expect(threw).toBeGreaterThan(0); expect(threw).toBeLessThan(SEEDS) }
    })
  }
})
