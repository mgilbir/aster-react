// @vitest-environment jsdom
/**
 * A host binds the event loop again for every scene it shows (`<Chart>` on every pointer move of a signal-driven chart). What a
 * binding compiles is a function of the view's spec alone, so a binding on the same element for the same chart takes the
 * expressions the last one compiled (the binding shell, signals.ts), and they run against the scene the new binding was given:
 *  - binding again compiles no expression again, the view's or a group scope's;
 *  - the handlers of the new binding read the new scene (its scales, datasets, signal values) and edit its datasets;
 *  - a binding made while another is still live on the element compiles its own, and the live one keeps reading its scene;
 *  - released, the element keeps nothing: the next binding compiles again.
 */
import { describe, expect, it, vi } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { installAllParts } from './install-parts.testlib.js'
import { renderSceneToDomElement } from './dom.js'
import { bindSceneSignals } from './signals.js'
import type { SceneRoot, VgSpec } from './types.js'

const compiles = vi.hoisted(() => ({ n: 0 }))
vi.mock('./expression.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./expression.js')>()
  return { ...real, compileExpr: (...args: Parameters<typeof real.compileExpr>) => { compiles.n++; return real.compileExpr(...args) } }
})

const SPEC = {
  width: 100, height: 100, autosize: 'none',
  signals: [
    { name: 'span', value: 100 },
    // the scale and the dataset the handler reads are the scene's: both differ between the two scenes below
    { name: 'at', value: null, on: [{ events: 'click', update: "[invert('x', x()), length(data('t')), span]" }] },
    { name: 'edits', value: 0, on: [{ events: 'dblclick', update: "modify('t', {v: 99}) + edits + 1" }] },
  ],
  data: [{ name: 't', values: [{ v: 1 }, { v: 2 }], transform: [{ type: 'filter', expr: 'datum.v <= span' }] }],
  scales: [{ name: 'x', type: 'linear', domain: [0, { signal: 'span' }], range: 'width' }],
  marks: [{
    type: 'group',
    signals: [{ name: 'local', value: 0, on: [{ events: 'window:resize', update: 'local + span' }] }],
    marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, width: { value: 100 }, y: { value: 0 }, height: { value: 100 } } } }],
  }],
} as unknown as VgSpec

installAllParts()
const chart = compileChart(SPEC)
const sceneAt = (span: number): SceneRoot => evaluateChart(chart, { signals: { span } })

function click(el: Element, type = 'click'): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 50, clientY: 50 }))
}

describe('a binding again on the same element for the same chart', () => {
  it('compiles nothing again, and runs against the scene it was given', () => {
    const first = sceneAt(100)
    const el = renderSceneToDomElement(first, document)
    document.body.appendChild(el)
    const seen: Record<string, unknown> = {}
    const hooks = { onSignal: (name: string, value: unknown) => { seen[name] = value } }
    const b1 = bindSceneSignals(el, first, { span: 100 }, hooks)
    click(el)
    expect(seen.at).toEqual([50, 2, 100])
    b1.detach()

    const second = sceneAt(1)
    const before = compiles.n
    const b2 = bindSceneSignals(el, second, { span: 1 }, hooks)
    expect(compiles.n).toBe(before)
    click(el)
    // the new scene's scale (domain [0, 1]), its dataset (one row passes `datum.v <= 1`) and its signal value
    expect(seen.at).toEqual([0.5, 1, 1])
    // a group scope's handler too: its signal starts from this scene's value (0), plus this scene's `span`
    window.dispatchEvent(new Event('resize'))
    expect(Object.entries(seen).filter(([k]) => k.endsWith(':local')).map(([, v]) => v)).toEqual([1])
    // a dataset edit goes to the dataset of this binding's scene
    const edited: unknown[][] = []
    b2.detach()
    const b3 = bindSceneSignals(el, second, { span: 1 }, { ...hooks, onData: (_name, rows) => { edited.push(rows) } })
    click(el, 'dblclick')
    expect(edited.at(-1)).toEqual([{ v: 1 }, { v: 2 }, { v: 99 }])
    expect(compiles.n).toBe(before)
    b3.release()

    // released: nothing is kept, the next binding compiles again
    const b4 = bindSceneSignals(el, second, { span: 1 }, hooks)
    expect(compiles.n).toBeGreaterThan(before)
    b4.release()
    el.remove()
  })

  it('a binding made while another is live compiles its own, and the live one keeps reading its own scene', () => {
    const first = sceneAt(100)
    const el = renderSceneToDomElement(first, document)
    document.body.appendChild(el)
    const a: Record<string, unknown> = {}
    const b: Record<string, unknown> = {}
    const live = bindSceneSignals(el, first, { span: 100 }, { onSignal: (n, v) => { a[n] = v } })
    const second = sceneAt(1)
    const before = compiles.n
    const other = bindSceneSignals(el, second, { span: 1 }, { onSignal: (n, v) => { b[n] = v } })
    expect(compiles.n).toBeGreaterThan(before)
    click(el)
    expect(a.at).toEqual([50, 2, 100])
    expect(b.at).toEqual([0.5, 1, 1])
    live.release()
    other.release()
    el.remove()
  })
})
