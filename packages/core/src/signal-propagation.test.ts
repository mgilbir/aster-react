import { describe, expect, it } from 'vitest'
import { follow, node, Propagation, type SignalNode } from './signal-propagation.js'

/** a graph of named nodes; each logs its name when it runs. `edges` are [source, target] pairs, `made` the order they are made in */
function graph(made: string[], edges: Array<[string, string]>, behaviour: Record<string, () => boolean | void> = {}) {
  const log: string[] = []
  const errors: unknown[] = []
  const p = new Propagation((e) => errors.push(e))
  const nodes = new Map<string, SignalNode>()
  for (const name of made) nodes.set(name, p.add(node(name, () => { log.push(name); return behaviour[name]?.() })))
  for (const [s, t] of edges) follow(nodes.get(s)!, nodes.get(t)!)
  for (const [s, t] of edges) p.connect(nodes.get(t)!, [nodes.get(s)!])
  return { p, n: (name: string) => nodes.get(name)!, log, errors }
}

describe('signal propagation', () => {
  it('runs a node once per propagation however many of its sources changed', () => {
    const g = graph(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']])
    g.p.evaluate(() => g.p.touch(g.n('a')))
    expect(g.log).toEqual(['a', 'b', 'c', 'd'])
  })

  it('a node touched after it has run in the propagation does not run again', () => {
    let touched = false
    const g = graph(['a', 'b'], [['a', 'b']], { b: () => { if (!touched) { touched = true; g.p.touch(g.n('a')) } } })
    g.p.evaluate(() => g.p.touch(g.n('a')))
    expect(g.log).toEqual(['a', 'b'])
    expect(g.p.clock).toBe(1)
  })

  it('a node made before one it reads runs after it', () => {
    const g = graph(['reader', 'x', 'source'], [['source', 'reader'], ['source', 'x']])
    g.p.evaluate(() => g.p.touch(g.n('source')))
    expect(g.log).toEqual(['source', 'reader', 'x'])
    expect(g.n('reader').order).toBeGreaterThan(g.n('source').order)
  })

  it('a node that says it is unchanged does not queue its targets, unless it is forced', () => {
    const g = graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']], { b: () => false })
    g.p.evaluate(() => g.p.touch(g.n('a')))
    expect(g.log).toEqual(['a', 'b'])
    // (a forced node's `run` still decides what it assigns; the host reads `forced` to answer true)
    const h = graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']])
    h.n('b').forced = true
    h.p.evaluate(() => h.p.touch(h.n('a')))
    expect(h.log).toEqual(['a', 'b', 'c'])
  })

  it('a node a handler assigned does not run its own update, and its targets do', () => {
    const g = graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']])
    g.p.evaluate(() => g.p.touch(g.n('b'), true))
    expect(g.log).toEqual(['c'])
    g.p.evaluate(() => g.p.touch(g.n('b')))
    expect(g.log).toEqual(['c', 'b', 'c'])
  })

  it('nodes of equal order (the handlers of one source) run in the order they were queued', () => {
    const g = graph(['a'], [])
    for (const i of [1, 2, 3, 4, 5]) {
      const h = node(`h${i}`, () => { g.log.push(`h${i}`) })
      follow(g.n('a'), h)
      h.order = g.n('a').order
    }
    g.p.evaluate(() => g.p.touch(g.n('a')))
    expect(g.log).toEqual(['a', 'h1', 'h2', 'h3', 'h4', 'h5'])
  })

  it('a node queued in the midst of a propagation runs next if it is ordered before the rest, whatever has run', () => {
    const g = graph(['early', 'a', 'late'], [['a', 'late']], { a: () => { g.p.touch(g.n('early')) } })
    g.p.evaluate(() => g.p.touch(g.n('a')))
    expect(g.log).toEqual(['a', 'early', 'late'])
  })

  it('a cycle that comes back to the node being placed is an error', () => {
    const p = new Propagation(() => undefined)
    const a = p.add(node('a'))
    const b = p.add(node('b'))
    follow(a, b)
    follow(b, a)
    expect(() => p.connect(a, [b])).toThrow('Cycle detected in dataflow graph.')
  })

  it('callbacks run after the propagation, highest priority first; an error abandons the rest, and them', () => {
    const g = graph(['a'], [])
    const order: string[] = []
    g.p.evaluate(() => {
      g.p.touch(g.n('a'))
      g.p.runAfter(() => order.push('low'), 0)
      g.p.runAfter(() => order.push('high'), 1)
    })
    expect(order).toEqual(['high', 'low'])

    const bad = graph(['a', 'b'], [['a', 'b']], { a: () => { throw new Error('boom') } })
    bad.p.evaluate(() => { bad.p.touch(bad.n('a')); bad.p.runAfter(() => order.push('never')) })
    expect(bad.log).toEqual(['a'])
    expect(order).not.toContain('never')
    expect(bad.errors).toHaveLength(1)
  })
})

describe('connect places nodes as vega-dataflow rerank does, in linear time (C144)', () => {
  /** vega-dataflow's rerank, as written there: every path from the node, no visited set (exponential in a lattice). */
  function vegaOrder(nodes: Array<{ id: number; rank: number; targets: number[] }>, edges: Array<[number, number]>): number[] {
    let made = nodes.length
    const byId = new Map(nodes.map((n) => [n.id, n]))
    for (const [s, t] of edges) {
      const src = byId.get(s)!, tgt = byId.get(t)!
      if (!src.targets.includes(t)) src.targets.push(t)
      if (src.rank > tgt.rank) {
        const queue = [tgt]
        while (queue.length) {
          const cur = queue.pop()!
          cur.rank = ++made
          for (let i = cur.targets.length; --i >= 0;) {
            const q = byId.get(cur.targets[i]!)!
            if (q === tgt) throw new Error('Cycle detected in dataflow graph.')
            queue.push(q)
          }
        }
      }
    }
    return [...nodes].sort((a, b) => a.rank - b.rank).map((n) => n.id)
  }

  it('gives the order vega gives, on generated graphs built edge by edge (and refuses the same cycles)', () => {
    let seed = 11
    const rand = (n: number): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n }
    for (let trial = 0; trial < 400; trial++) {
      const count = 3 + rand(9)
      const edges: Array<[number, number]> = []
      for (let e = rand(count * 2); e > 0; e--) edges.push([rand(count), rand(count)])
      const ref = Array.from({ length: count }, (_, id) => ({ id, rank: id + 1, targets: [] as number[] }))
      let want: number[] | string
      try { want = vegaOrder(ref, edges.filter(([a, b]) => a !== b)) } catch (e) { want = (e as Error).message }
      const flow = new Propagation(() => {})
      const ns = Array.from({ length: count }, (_, id) => flow.add(node(String(id))))
      let got: number[] | string
      try {
        for (const [a, b] of edges) {
          if (a === b) continue
          follow(ns[a]!, ns[b]!)
          flow.connect(ns[b]!, [ns[a]!])
        }
        got = [...ns].sort((x, y) => x.order - y.order).map((n) => Number(n.name))
      } catch (e) { got = (e as Error).message }
      expect(got, JSON.stringify(edges)).toEqual(want)
    }
  })

  it('places a lattice of diamonds at once (vega walks every path of it)', () => {
    const flow = new Propagation(() => {})
    const layers = Array.from({ length: 30 }, (_, l) => Array.from({ length: 12 }, (_, i) => flow.add(node(`${l}_${i}`))))
    const t0 = performance.now()
    // each node reads every node of the layer declared after it, connected from the first layer down: every connect reorders all
    // that already reads it (the paths through the layers above multiply: 12^l)
    for (let l = 0; l + 1 < layers.length; l++) {
      for (const n of layers[l]!) for (const m of layers[l + 1]!) { follow(m, n); flow.connect(n, [m]) }
    }
    expect(performance.now() - t0).toBeLessThan(2000)
    for (let l = 0; l + 1 < layers.length; l++) for (const n of layers[l]!) for (const m of layers[l + 1]!) expect(m.order).toBeLessThan(n.order)
  })
})
