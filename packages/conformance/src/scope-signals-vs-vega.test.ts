// @vitest-environment jsdom
/**
 * A group mark's own signals, evaluated for every group item, against real vega (C483).
 *
 * Each group item has its own set of signals; vega ranks them as the view's (an operator after the ones it reads, a cycle refused), so
 * a derived signal declared before the signal it reads, a chain, a fan of readers and an `init` that reads a derived signal all
 * settle in one pass. Generated: random acyclic reads over 2-12 signals declared in a shuffled order, with `value`, `init` and
 * `update` signals, reads of the view's signals and of `parent`, over 1-4 group items (a facet's cells and a data-driven mark's);
 * and cycles, which vega logs and leaves the group items empty for. The text each cell draws holds every signal's value.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { forEngines } from './engines.js'

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

/** One view: a group mark with its own signals over `cells` group items, drawing every signal's value in a text. */
function scoped(r: Rnd, cyclic: boolean): { id: string; spec: Spec } {
  const n = 2 + Math.floor(r() * 11)
  const names = Array.from({ length: n }, (_, i) => `s${i}`)
  // a read goes to a signal of a lower rank only: acyclic (a cycle is added on purpose below)
  const order = shuffle(r, names.map((_, i) => i))
  const rankOf = new Map(order.map((idx, rank) => [idx, rank]))
  const reads = (i: number): string[] => names.filter((_, j) => rankOf.get(j)! < rankOf.get(i)! && r() < 0.5)
  const outer = (): string[] => (r() < 0.4 ? ['k'] : r() < 0.3 ? ['parent.i'] : [])
  const defs: Spec[] = names.map((name, i) => {
    const terms = [...reads(i), ...outer()]
    const kind = r()
    if (kind < 0.15 || (!terms.length && kind < 0.5)) return { name, value: i + 10 }
    const expr = terms.length ? `${terms.join(' + ')} + ${i + 1}` : `${i + 1}`
    return kind < 0.3 ? { name, init: expr } : { name, update: expr }
  })
  if (cyclic) {
    const [a, b] = [pick(r, names), pick(r, names)]
    const at = defs.findIndex((d) => d.name === a)
    defs[at] = { name: a, update: `${b} + 1` }
    const bt = defs.findIndex((d) => d.name === b)
    if (a !== b) defs[bt] = { name: b, update: `${a} + 1` }
  }
  const facet = r() < 0.5
  const rows = Array.from({ length: 1 + Math.floor(r() * 4) }, (_, i) => ({ i, g: String.fromCharCode(97 + i) }))
  const text = { type: 'text', encode: { update: { x: { value: 2 }, y: { value: 12 }, text: { signal: `join([${names.join(', ')}], ',')` } } } }
  const group = {
    type: 'group', name: 'cell',
    from: facet ? { facet: { data: 't', name: 'f', groupby: 'g' } } : { data: 't' },
    signals: shuffle(r, defs),
    encode: { update: { x: { signal: 'datum.i * 40 + 0' }, y: { value: 0 }, width: { value: 38 }, height: { value: 30 } } },
    marks: [text],
  }
  // (a facet cell's datum is its key and its rows: the cell's own `i` is the first row's)
  if (facet) (group.encode.update as Spec).x = { signal: 'datum.g === "a" ? 0 : datum.g === "b" ? 40 : datum.g === "c" ? 80 : 120' }
  return {
    id: `${n} signals, ${facet ? 'facet' : 'data'}${cyclic ? ', cyclic' : ''}`,
    spec: { width: 170, height: 40, padding: 2, autosize: 'none', signals: [{ name: 'k', value: 100 }], data: [{ name: 't', values: rows }], marks: [group] },
  }
}

async function vegaSvg(spec: Spec): Promise<string> {
  const log = console.error
  console.error = () => {}
  try {
    const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
    try { await view.runAsync(); return await view.toSVG() } finally { view.finalize() }
  } catch (e) {
    return `threw ${(e as Error).message}`
  } finally {
    console.error = log
  }
}
function asterSvg(spec: Spec): string {
  const log = console.error
  console.error = () => {}
  try { return renderSpec(spec as never) } catch (e) { return `threw ${(e as Error).message}` } finally { console.error = log }
}

describe('a group mark\'s signals settle in vega\'s order (generated, vs real vega)', () => {
  it('acyclic reads in any declaration order: the same document, every cell', async () => {
    const bad: string[] = []
    for (let seed = 1; seed <= 150; seed++) {
      const c = scoped(mulberry32(seed * 7919), false)
      const [o, a] = await forEngines(c.spec, async (vs, as) => [await vegaSvg(vs), asterSvg(as)] as const)
      if (o.startsWith('threw') || a.startsWith('threw')) { if (o !== a) bad.push(`${c.id} seed ${seed}: vega ${o.slice(0, 100)} | aster ${a.slice(0, 100)}`); continue }
      const d = diffCanonical(canonicalizeSvg(o), canonicalizeSvg(a))
      if (d.length) bad.push(`${c.id} seed ${seed}: ${d[0]}`)
    }
    expect(bad).toEqual([])
  }, 120_000)

  it('a cycle of reads stops the pass at the group item, with nothing in it, as vega\'s subflow does', async () => {
    let refused = 0
    const bad: string[] = []
    for (let seed = 1; seed <= 40; seed++) {
      const c = scoped(mulberry32(seed * 104729), true)
      const [o, a] = await forEngines(c.spec, async (vs, as) => [await vegaSvg(vs), asterSvg(as)] as const)
      // (a cycle is logged and the group items are empty: no text of any cell)
      if (!o.startsWith('threw') && !/<text/.test(o)) refused++
      if (o.startsWith('threw') || a.startsWith('threw')) { if (o !== a) bad.push(`${c.id} seed ${seed}: vega ${o.slice(0, 100)} | aster ${a.slice(0, 100)}`) } else {
        const d = diffCanonical(canonicalizeSvg(o), canonicalizeSvg(a))
        if (d.length) bad.push(`${c.id} seed ${seed}: ${d[0]}`)
      }
    }
    expect(bad).toEqual([])
    // (not vacuous: most of the views are cycles, whose group items vega leaves empty)
    expect(refused).toBeGreaterThan(10)
  }, 120_000)
})
