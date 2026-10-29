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
