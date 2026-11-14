// @vitest-environment jsdom
/**
 * What is derived from a scene and kept with the engine's nodes (scene-registry.ts) -- the parent links `event.item` reads, whether
 * an item has a cursor, the accessible tree's boxes -- is what the scene itself says, scene after scene.
 *
 * A chart is taken through signal writes, in-place appends (the engine pushes onto its own items array, and the group that held it
 * becomes a snapshot) and edits; after each step the scene the chain of evaluations made and a fresh evaluation of the same input
 * (whose nodes are all new, so nothing is kept) are asked the same questions, which must get the same answers: what an event's item
 * says of itself and the groups around it at every point of a grid, the cursor check, and the accessible tree with and without
 * summaries. A hand-built scene, written between two questions, is answered from what it holds then.
 */
import { describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { renderSceneToSvg } from './index.js'
import { buildA11yTree } from './a11y.js'
import { buildHitIndex } from './hit.js'
import { bindSceneSignals, sceneHasCursor } from './signals.js'
import type { RuntimeInput, SceneGroup, SceneRoot, VgSpec } from './types.js'

type Row = Record<string, unknown>

const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ k: 'abc'[i % 3], x: i, y: ((i * 37) % 23) / 23 }))

/** What an event's item says: its mark, the mark's group chain, and the datum of each. */
const ITEM_INFO = "item() && item().mark ? [item().mark.marktype, item().mark.name, item().mark.role, item().datum ? item().datum.x : null, item().mark.group ? item().mark.group.datum : null, item().mark.group && item().mark.group.mark && item().mark.group.mark.group ? item().mark.group.mark.group.mark.name : null] : null"

const SPEC: VgSpec = {
  width: 240, height: 160, padding: 4, autosize: 'none',
  signals: [
    { name: 'hv', value: 5 },
    { name: 'info', value: null, on: [{ events: 'pointermove', update: ITEM_INFO }] },
    { name: 'cur', value: 'default', bind: { input: 'select', options: ['default', 'pointer'] } },
  ],
  data: [{ name: 't', values: rows(30) }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 40], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 1], range: 'height' },
  ],
  axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left' }],
  marks: [
    {
      type: 'group', name: 'cells', from: { facet: { name: 'f', data: 't', groupby: 'k' } },
      encode: { enter: { x: { value: 0 }, width: { signal: 'width' }, height: { signal: 'height' } } },
      marks: [
        { type: 'line', name: 'ln', from: { data: 'f' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, stroke: { value: 'steelblue' }, strokeWidth: { value: 6 } } } },
        { type: 'symbol', name: 'pt', from: { data: 'f' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 200 } }, update: { fill: { signal: "datum.x < hv ? 'red' : 'blue'" } } } },
      ],
    },
    // (a top-level mark over the dataset: an append pushes onto its items array in place)
    { type: 'symbol', name: 'top', from: { data: 't' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { value: 150 }, size: { value: 120 }, fill: { value: 'green' }, cursor: { value: 'crosshair' } } } },
    { type: 'rect', name: 'band', encode: { update: { x: { scale: 'x', signal: 'hv' }, width: { value: 10 }, y: { value: 0 }, height: { value: 40 }, fill: { value: 'orange' }, cursor: { signal: 'cur' } } } },
  ],
} as unknown as VgSpec

/** Ask a scene everything: the item info at each point of a grid, the cursor check, the accessible trees. */
function ask(scene: SceneRoot): unknown {
  const host = document.createElement('div')
  host.innerHTML = renderSceneToSvg(scene)
  document.body.appendChild(host)
  const svg = host.querySelector('svg') as SVGSVGElement
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: scene.width, bottom: scene.height, width: scene.width, height: scene.height } as DOMRect)
  const index = buildHitIndex(scene)
  const seen: unknown[] = []
  const binding = bindSceneSignals(svg, scene, { ...((scene as unknown as { signalParams?: Row }).signalParams ?? {}) }, { onSignal: (name, value) => { if (name === 'info') seen.push(value) } }, { pick: (x, y) => index.pick(x, y) })
  const at: unknown[] = []
  for (let x = 2; x < scene.width; x += 7) {
    for (let y = 2; y < scene.height; y += 9) {
      seen.length = 0
      svg.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }))
      at.push(seen.length ? seen[seen.length - 1] : '-')
    }
  }
  binding.release()
  host.remove()
  return { at, cursor: sceneHasCursor(scene), a11y: buildA11yTree(scene), summary: buildA11yTree(scene, new Map(), { summaryThreshold: 2 }) }
}

describe('what is kept with the engine nodes is what the scene says', () => {
  it('through signal writes, appends and edits', () => {
    const chart = compileChart(SPEC)
    let t = rows(30)
    const steps: Array<[string, RuntimeInput]> = [['first', { data: { t } }]]
    for (const hv of [8, 8, 20, 3]) steps.push([`hv ${hv}`, { data: { t }, signals: { hv } }])
    steps.push(['cur pointer', { data: { t }, signals: { hv: 3, cur: 'pointer' } }])
    for (let k = 0; k < 3; k++) {
      const before = t.length
      t = [...t, { k: 'abc'[k], x: 30 + k * 3, y: 0.5 }]
      steps.push([`append ${k}`, { data: { t }, dataChanges: { t: [] }, dataPulse: { t: { changed: [], appendOnly: true, baseLength: before } }, signals: { hv: 3, cur: 'pointer' } } as RuntimeInput])
    }
    t = t.map((r, i) => (i === 4 ? { ...r, y: 0.95 } : r))
    steps.push(['edit', { data: { t }, dataChanges: { t: [4] }, signals: { hv: 12 } }])
    steps.push(['cur default', { data: { t }, dataChanges: { t: [] }, signals: { hv: 12, cur: 'default' } }])
    const answered: Array<{ what: string; scene: SceneRoot; answer: unknown }> = []
    for (const [what, input] of steps) {
      const scene = evaluateChart(chart, input)
      const fresh = evaluateChart(compileChart(SPEC), { ...input, dataChanges: undefined, dataPulse: undefined } as RuntimeInput)
      const answer = ask(scene)
      expect(answer, what).toEqual(ask(fresh))
      answered.push({ what, scene, answer })
    }
    // (every scene before still says what it said: what is kept with its nodes was not overwritten by a later scene's)
    for (const { what, scene, answer } of answered) expect(ask(scene), `${what}, asked again`).toEqual(answer)
  })

  it('a hand-built scene is answered from what it holds when asked', () => {
    const leaf = { x: 10, y: 10, width: 20, height: 20, fill: 'red', datum: { v: 1 } }
    const mark = { marktype: 'rect', role: 'mark', items: [leaf] } as unknown as SceneGroup
    const scene = { width: 100, height: 100, items: [mark] } as unknown as SceneRoot
    expect(sceneHasCursor(scene)).toBe(false)
    const box = (s: SceneRoot): unknown => buildA11yTree(s, new Map(), { summaryThreshold: 0 }).nodes.map((n) => [n.x, n.y, n.width, n.height])
    const before = box(scene)
    // (written in place: a host's own scene is its to change)
    ;(leaf as Row).x = 50
    ;(leaf as Row).cursor = 'pointer'
    const scene2 = { ...scene }
    expect(box(scene2)).not.toEqual(before)
    expect(sceneHasCursor(scene2)).toBe(true)
  })
})
