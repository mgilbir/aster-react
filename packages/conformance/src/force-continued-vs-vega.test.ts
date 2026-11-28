// @vitest-environment jsdom
/**
 * A static `force` layout of a view that goes on, against vega (C73: the gallery's force-directed-layout pins and drags a node with
 * `on: [{trigger: "fix", modify: "node", values: ...}]`).
 *
 * vega's force transform keeps its simulation and its nodes: a pulse that reaches it runs the simulation again (alpha 1, its
 * iterations, from the positions and velocities the nodes have) only when its parameters changed or `restart` holds while the
 * pulse changed something; any other pulse -- a node pinned with `fx` / `fy` -- leaves the layout where it was. A node pinned
 * is set to its pin by the first tick, not when the simulation runs again. Aster evaluates the view again for each change, passing
 * the scene it continues (`retainFrom`, as <Chart> does) and the writes the loop recorded; its nodes start from the layout it had.
 * Generated: graphs of 5-12 nodes, forces, iterations, steps that pin a node, drag it (restart), release it, change a force's
 * parameter, and pin another.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { renderSceneToDomElement } from '@aster-charts/core/dom'
import { bindSceneSignals, type SignalBinding } from '@aster-charts/core/signals'
import '@aster-charts/core/transforms'

type Spec = Record<string, unknown>
type Item = Record<string, unknown>
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!(); document.body.innerHTML = '' })

function stream(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Step = { kind: 'pin'; node: number } | { kind: 'drag'; x: number; y: number } | { kind: 'release' } | { kind: 'charge'; value: number } | { kind: 'toggle-static' }

function forceCase(seed: number): { spec: Spec; steps: Step[] } {
  const r = stream(seed * 977 + 13)
  const n = 5 + Math.floor(r() * 8)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const nodes = Array.from({ length: n }, (_, i) => ({ name: `n${i}`, group: i % 3 }))
  const links = Array.from({ length: n + Math.floor(r() * n) }, () => ({ source: Math.floor(r() * n), target: Math.floor(r() * n) })).filter((l) => l.source !== l.target)
  const forces: Spec[] = [{ force: 'center', x: { signal: 'cx' }, y: { signal: 'cy' } }, { force: 'collide', radius: { signal: 'nodeRadius' } }, { force: 'nbody', strength: { signal: 'nodeCharge' } }]
  forces.push({ force: 'link', links: 'link-data', distance: { signal: 'linkDistance' } })
  const spec: Spec = {
    width: 300, height: 240, padding: 0, autosize: 'none',
    signals: [
      { name: 'cx', update: 'width / 2' }, { name: 'cy', update: 'height / 2' },
      { name: 'nodeRadius', value: 8 }, { name: 'nodeCharge', value: -30 }, { name: 'linkDistance', value: 30 },
      { name: 'static', value: true },
      { name: 'fix', value: false },
      { name: 'node', value: null },
      { name: 'restart', value: false, on: [{ events: { signal: 'fix' }, update: 'fix && fix.length' }] },
    ],
    data: [{ name: 'node-data', values: nodes }, { name: 'link-data', values: links }],
    scales: [{ name: 'color', type: 'ordinal', domain: [0, 1, 2], range: { scheme: 'category10' } }],
    marks: [
      {
        type: 'symbol', name: 'nodes', zindex: 1, from: { data: 'node-data' },
        on: [
          { trigger: 'fix', modify: 'node', values: 'fix === true ? {fx: node.x, fy: node.y} : {fx: fix[0], fy: fix[1]}' },
          { trigger: '!fix', modify: 'node', values: '{fx: null, fy: null}' },
        ],
        encode: { enter: { fill: { scale: 'color', field: 'group' }, stroke: { value: 'white' } }, update: { size: { signal: '2 * nodeRadius * nodeRadius' } } },
        transform: [{ type: 'force', iterations: 40 + Math.floor(r() * 100), restart: { signal: 'restart' }, static: { signal: 'static' }, signal: 'force', forces }],
      },
      { type: 'path', from: { data: 'link-data' }, interactive: false, encode: { update: { stroke: { value: '#ccc' } } }, transform: [{ type: 'linkpath', require: { signal: 'force' }, shape: 'line', sourceX: 'datum.source.x', sourceY: 'datum.source.y', targetX: 'datum.target.x', targetY: 'datum.target.y' }] },
    ],
  }
  const steps: Step[] = []
  let pinned = false
  for (let k = 0; k < 7; k++) {
    const u = r()
    if (!pinned) { steps.push({ kind: 'pin', node: Math.floor(r() * n) }); pinned = true } else if (u < 0.45) steps.push({ kind: 'drag', x: Math.round(r() * 280), y: Math.round(r() * 220) })
    else if (u < 0.65) { steps.push({ kind: 'release' }); pinned = false } else if (u < 0.9) steps.push({ kind: 'charge', value: pick([-10, -60, -90]) })
    else steps.push({ kind: 'toggle-static' })
  }
  return { spec, steps }
}

const nodesOf = (root: unknown): Item[] => {
  const walk = (n: any): Item[] | null => {
    if (n?.marktype === 'symbol' && n?.name === 'nodes') return n.items
    for (const c of n?.items ?? []) { const f = walk(c); if (f) return f }
    return null
  }
  return walk(root) ?? []
}
const positions = (items: Item[]): string => JSON.stringify(items.map((it) => [it.x, it.y]))

function asterHost(spec: Spec): { set: (name: string, value: unknown) => void; items: () => Item[] } {
  const chart = compileChart(structuredClone(spec) as never)
  const host = document.createElement('div')
  document.body.appendChild(host)
  let store: Record<string, unknown> = {}
  const data: Record<string, unknown[]> = {}
  let binding: SignalBinding | null = null
  let scene = evaluateChart(chart)
  let dirty = false
  const render = (): void => {
    binding?.detach()
    scene = evaluateChart(chart, { signals: store, data, retainFrom: scene })
    host.innerHTML = ''
    const svg = renderSceneToDomElement(scene) as SVGSVGElement
    host.appendChild(svg)
    dirty = false
    binding = bindSceneSignals(svg, scene, store, { onSignal: () => { dirty = true }, onEncode: (all) => { store = { ...all }; dirty = true } }, { owner: host, data })
  }
  render()
  cleanups.push(() => binding?.release())
  return {
    set: (name, value) => { binding!.setSignal(name, value); if (dirty) render() },
    items: () => nodesOf(scene),
  }
}

async function vegaHost(spec: Spec): Promise<{ set: (name: string, value: unknown) => Promise<void>; items: () => Item[] }> {
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  cleanups.push(() => view.finalize())
  await view.runAsync()
  return {
    set: async (name, value) => { view.signal(name, value); await view.runAsync() },
    items: () => nodesOf((view.scenegraph() as unknown as { root: unknown }).root),
  }
}

describe('a static force layout that a view goes on with is vega\'s (C73)', () => {
  it('pins, drags, releases and parameter changes: the same positions after every step', async () => {
    const bad: string[] = []
    let moved = 0
    let reran = 0
    for (let seed = 1; seed <= 60; seed++) {
      const c = forceCase(seed)
      const a = asterHost(c.spec)
      const v = await vegaHost(c.spec)
      let last = positions(v.items())
      if (last !== positions(a.items())) { bad.push(`seed ${seed} start`); continue }
      for (const [k, step] of c.steps.entries()) {
        const both = async (name: string, value: unknown): Promise<void> => { a.set(name, structuredClone(value)); await v.set(name, structuredClone(value)) }
        if (step.kind === 'pin') { a.set('node', a.items()[step.node]); await v.set('node', v.items()[step.node]); await both('fix', true) }
        else if (step.kind === 'drag') await both('fix', [step.x, step.y])
        else if (step.kind === 'release') await both('fix', false)
        else if (step.kind === 'charge') await both('nodeCharge', step.value)
        else await both('static', true)
        const want = positions(v.items())
        const got = positions(a.items())
        if (want !== got) { bad.push(`seed ${seed} step ${k} ${JSON.stringify(step)}: vega ${want.slice(0, 120)} aster ${got.slice(0, 120)}`); break }
        if (want !== last) reran++
        last = want
        if (step.kind === 'drag') moved++
      }
      while (cleanups.length) cleanups.pop()!()
      document.body.innerHTML = ''
    }
    expect(bad).toEqual([])
    // (not vacuous: layouts are run again, by drags and by parameter changes, and pins alone change nothing)
    expect(reran).toBeGreaterThan(30)
    expect(moved).toBeGreaterThan(15)
  }, 240_000)
})
