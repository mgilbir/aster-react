// @vitest-environment jsdom
/**
 * Binding a scene's event loop reads no leaf of a mark: the scopes it looks for are group items' (a facet cell's, a group mark's), and
 * a leaf mark's items hold none. The chart-bench survival chart re-binds on every pointer move, and the walk read all 12,000 of its
 * line and area points each time (6 ms of a 60-move sweep in Chromium).
 */
import { describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { renderSceneToDomElement } from './dom.js'
import { bindSceneSignals } from './signals.js'
import type { SceneGroup, SceneNode, SceneRoot, VgSpec } from './types.js'

const SPEC = {
  width: 300, height: 200, autosize: 'none',
  signals: [
    { name: 'hoverX', value: null, on: [{ events: 'pointermove', update: "invert('x', x())" }] },
    { name: 'k', value: 0, on: [{ events: 'click', update: 'k + 1' }] },
  ],
  data: [{ name: 't', values: Array.from({ length: 400 }, (_, i) => ({ g: `s${i % 4}`, x: i % 100, y: (i * 7) % 13 })) }],
  scales: [{ name: 'x', type: 'linear', domain: [0, 100], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 13], range: 'height' }],
  marks: [
    {
      type: 'group', from: { facet: { name: 'one', data: 't', groupby: 'g' } },
      signals: [{ name: 'local', value: 1, on: [{ events: 'dblclick', update: 'local + 1' }] }],
      marks: [{ type: 'line', from: { data: 'one' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' } } } }],
    },
    { type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' } } } },
  ],
} as unknown as VgSpec

/** The scene with every leaf mark's items read through a counter (each element read once counts once). */
function counted(scene: SceneRoot): { scene: SceneRoot; reads: () => number } {
  let reads = 0
  const visit = (n: SceneNode): void => {
    const g = n as SceneGroup
    if (!Array.isArray(g.items)) return
    if (g.role === 'mark' && g.marktype !== 'group') {
      g.items = new Proxy(g.items, { get: (t, k, r) => { if (typeof k === 'string' && /^\d+$/.test(k)) reads++; return Reflect.get(t, k, r) } })
      return
    }
    for (const c of g.items) visit(c as SceneNode)
  }
  for (const g of scene.items) visit(g)
  return { scene, reads: () => reads }
}

describe('binding the event loop reads no leaf of a mark', () => {
  it('binds the scoped signals of the facet cells without reading their points', () => {
    const scene = evaluateChart(compileChart(SPEC), {})
    const el = renderSceneToDomElement(scene, document)
    document.body.appendChild(el)
    const { reads } = counted(scene)
    const seen: string[] = []
    const binding = bindSceneSignals(el, scene, {}, { onSignal: (name) => { seen.push(name) } })
    expect(reads()).toBe(0)
    // (the binding works: the view's handler answers its event; scoped signals are held by group-scope.test.ts)
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }))
    expect(seen).toContain('k')
    binding.release()
    el.remove()
  })
})
