// @vitest-environment jsdom
/**
 * An append costs what was appended, not what was left alone: the DOM patcher's dense symbol chunks and the canvas append
 * path prove an engine-made items array unchanged from its `__editGen` stamp instead of reading every unchanged item's
 * `__gen` (the reads are counted), and the output stays the old implementation's.
 */
import { describe, expect, it } from 'vitest'
import { createChartStream } from './stream.js'
import { patchSceneDom, sceneToDomDesc } from './dom.js'
import { renderSceneToDomElement as legacyDomElement, sceneToDomDesc as legacyDomDesc } from './legacy-dom.testlib.js'
import { renderSceneToCanvasAppend, snapshotCanvasScene } from './canvas.js'
import { renderSceneToCanvasAppend as legacyAppend, snapshotCanvasScene as legacySnapshot } from './legacy-canvas.testlib.js'
import { loggingContext } from './geometry-differential.testlib.js'
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'

const rows = (n: number, from = 0): Array<{ x: number; y: number }> =>
  Array.from({ length: n }, (_, i) => ({ x: ((from + i) % 997) / 997, y: (((from + i) * 7) % 100) / 10 }))

const symbols = (data: string, fill: string): Record<string, unknown> => ({
  type: 'symbol', from: { data },
  encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 8 }, fill: { value: fill } } },
})
const spec = (marks: Array<Record<string, unknown>>, data: string[]): Record<string, unknown> => ({
  width: 400, height: 300, padding: 0, autosize: 'none',
  data: data.map((name) => ({ name, values: [] })),
  scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 400] }, { name: 'y', type: 'linear', domain: [0, 10], range: [300, 0] }],
  marks,
})

/** Counts the reads of `__gen` on every item there is now; returns the counter. */
function countGenReads(items: readonly SceneItem[]): { n: number } {
  const counter = { n: 0 }
  for (const it of items) {
    const value = it.__gen
    Object.defineProperty(it, '__gen', { get: () => { counter.n++; return value }, configurable: true, enumerable: true })
  }
  return counter
}

/** Counts the reads of `key` on every item there is now. */
function countReads(items: readonly SceneItem[], key: string): { n: number } {
  const counter = { n: 0 }
  for (const it of items) {
    const value = (it as Record<string, unknown>)[key]
    Object.defineProperty(it, key, { get: () => { counter.n++; return value }, configurable: true, enumerable: true })
  }
  return counter
}

const markOf = (scene: SceneRoot, i: number): SceneGroup => scene.items[i] as SceneGroup

describe('an append costs the appended items', () => {
  it('dense DOM chunks: no unchanged item is read, and the patched DOM is the one a full render of the scene makes', () => {
    const stream = createChartStream(spec([symbols('t', '#4c78a8')], ['t']) as never, { capacity: 8 })
    stream.push({ data: { t: rows(3000) } })
    let scene = stream.flush()!.scene
    // both implementations see the same history: the first scene, then each append (their chunk caches follow it)
    const o = { denseMarks: true }
    expect(JSON.stringify(sceneToDomDesc(scene, o))).toBe(JSON.stringify(legacyDomDesc(scene, o)))
    for (let k = 0; k < 6; k++) {
      stream.push({ append: { t: rows(1 + k, 3000 + k * 10) } })
      const prevItems = markOf(scene, 0).items as SceneItem[]
      const before = prevItems.slice()
      scene = stream.flush()!.scene
      const legacy = JSON.stringify(legacyDomDesc(scene, o))
      const reads = countGenReads(before)
      const desc = JSON.stringify(sceneToDomDesc(scene, o))
      expect(reads.n).toBe(0)
      expect(desc).toBe(legacy)
    }
    // and the DOM patch itself, append after append
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    document.body.appendChild(svg)
    // (each patch leaves the DOM a full render of the same scene makes: the chunks hold the same paths, in the same order)
    patchSceneDom(svg, scene, o)
    expect(svg.outerHTML).toBe(legacyDomElement(scene, document, o).outerHTML)
    for (let k = 0; k < 3; k++) {
      stream.push({ append: { t: rows(2 + k, 9000 + k * 10) } })
      scene = stream.flush()!.scene
      patchSceneDom(svg, scene, o)
      expect(svg.outerHTML, `append ${k}`).toBe(legacyDomElement(scene, document, o).outerHTML)
    }
    expect(svg.querySelectorAll('path').length).toBeGreaterThan(0)
  })

  it('dense DOM chunks: a row changed in place (anywhere in the chunks) is never taken for clean: the patched DOM is the full render, edit after edit', () => {
    // (the proof `chunkClean` makes without reading the items holds only while nothing in the array was replaced: an edit stamps
    // `__editGen`, and the chunk that holds the edited item must be built again -- an append alone never exercises that)
    const stream = createChartStream(spec([symbols('t', '#4c78a8')], ['t']) as never, { capacity: 8 })
    const base = rows(3000)
    stream.push({ data: { t: base } })
    let scene = stream.flush()!.scene
    const o = { denseMarks: true }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    document.body.appendChild(svg)
    patchSceneDom(svg, scene, o)
    const current = base.map((r) => ({ ...r }))
    // the first chunk, one in the middle, the last chunk, and the appended tail, in turn
    for (const [k, at] of [0, 1, 1337, 2999, 2990].entries()) {
      current[at] = { x: ((at * 31 + k) % 997) / 997, y: ((at + k * 13) % 100) / 10 }
      stream.push({ data: { t: current.map((r) => ({ ...r })) } })
      scene = stream.flush()!.scene
      patchSceneDom(svg, scene, o)
      expect(svg.outerHTML, `edit of row ${at}`).toBe(legacyDomElement(scene, document, o).outerHTML)
      // an append after an edit: the edited chunk was rebuilt, the untouched ones may be proved clean
      const more = rows(2 + k, 5000 + k * 10)
      current.push(...more)
      stream.push({ append: { t: more } })
      scene = stream.flush()!.scene
      patchSceneDom(svg, scene, o)
      expect(svg.outerHTML, `append after the edit of row ${at}`).toBe(legacyDomElement(scene, document, o).outerHTML)
    }
  })

  it('dense DOM chunks: an item that carries no generation is never taken for clean (a host-made edit of the scene is drawn)', () => {
    const stream = createChartStream(spec([symbols('t', '#4c78a8')], ['t']) as never, { capacity: 8 })
    stream.push({ data: { t: rows(3000) } })
    let scene = stream.flush()!.scene
    const o = { denseMarks: true }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    document.body.appendChild(svg)
    // an item whose generation is gone (a scene a host rebuilt or edited by hand), in the middle of the second chunk
    const victim = (markOf(scene, 0).items as SceneItem[])[300]!
    delete (victim as { __gen?: number }).__gen
    patchSceneDom(svg, scene, o)
    expect(svg.outerHTML).toBe(legacyDomElement(scene, document, o).outerHTML)
    for (let k = 0; k < 3; k++) {
      // the host changes the item in place; the engine appends rows and the scene is patched again
      victim.fill = k % 2 === 0 ? '#e45756' : '#54a24b'
      stream.push({ append: { t: rows(2, 7000 + k * 10) } })
      scene = stream.flush()!.scene
      expect(markOf(scene, 0).items).toContain(victim)
      patchSceneDom(svg, scene, o)
      expect(svg.outerHTML, `append ${k}`).toBe(legacyDomElement(scene, document, o).outerHTML)
      expect(svg.outerHTML, `append ${k}: the changed paint is drawn`).toContain(k % 2 === 0 ? '#e45756' : '#54a24b')
    }
  })

  it('per-item symbols (not batched): no unchanged item is read, the patch appends only the new elements, the DOM matches the old implementation', () => {
    const stream = createChartStream(spec([symbols('t', '#4c78a8')], ['t']) as never, { capacity: 8 })
    stream.push({ data: { t: rows(400) } })
    let scene = stream.flush()!.scene
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    document.body.appendChild(svg)
    patchSceneDom(svg, scene)
    for (let k = 0; k < 6; k++) {
      stream.push({ append: { t: rows(1 + k, 400 + k * 10) } })
      const before = (markOf(scene, 0).items as SceneItem[]).slice()
      scene = stream.flush()!.scene
      const legacy = JSON.stringify(legacyDomDesc(scene, {}))
      const reads = countGenReads(before)
      const xReads = countReads(before, 'x')
      // (the elements already there must stay the very same nodes: an append adds, it does not rebuild)
      const kept = [...svg.querySelectorAll('path')]
      patchSceneDom(svg, scene)
      expect(reads.n).toBe(0)
      expect(xReads.n).toBe(0)
      expect(kept.every((el) => el.isConnected)).toBe(true)
      expect(JSON.stringify(sceneToDomDesc(scene, {}))).toBe(legacy)
    }
    expect(svg.outerHTML).toBe(legacyDomElement(scene, document).outerHTML)
  })

  it('per-item symbols: a row changed in place, or an item without a generation edited by a host, is drawn after the next append', () => {
    const stream = createChartStream(spec([symbols('t', '#4c78a8')], ['t']) as never, { capacity: 8 })
    const current = rows(400)
    stream.push({ data: { t: current.map((r) => ({ ...r })) } })
    let scene = stream.flush()!.scene
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    document.body.appendChild(svg)
    patchSceneDom(svg, scene)
    // (the engine edits a row in place: the array is advanced, the items before and after the edit are the ones it had)
    for (const [k, at] of [3, 399, 150].entries()) {
      current[at] = { x: ((at * 17 + k) % 997) / 997, y: ((at + k * 7) % 100) / 10 }
      stream.push({ data: { t: current.map((r) => ({ ...r })) } })
      scene = stream.flush()!.scene
      patchSceneDom(svg, scene)
      expect(svg.outerHTML, `edit of row ${at}`).toBe(legacyDomElement(scene, document).outerHTML)
      const more = rows(2, 900 + k * 5)
      current.push(...more)
      stream.push({ append: { t: more } })
      scene = stream.flush()!.scene
      patchSceneDom(svg, scene)
      expect(svg.outerHTML, `append after the edit of row ${at}`).toBe(legacyDomElement(scene, document).outerHTML)
    }
    // an item with no generation (a scene a host edited by hand) is never taken for clean
    const victim = (markOf(scene, 0).items as SceneItem[])[40]!
    delete (victim as { __gen?: number }).__gen
    patchSceneDom(svg, scene)
    for (let k = 0; k < 3; k++) {
      victim.fill = k % 2 === 0 ? '#e45756' : '#54a24b'
      stream.push({ append: { t: rows(2, 1500 + k * 10) } })
      scene = stream.flush()!.scene
      patchSceneDom(svg, scene)
      expect(svg.outerHTML, `append ${k}`).toBe(legacyDomElement(scene, document).outerHTML)
      expect(svg.outerHTML).toContain(k % 2 === 0 ? '#e45756' : '#54a24b')
    }
  })

  it('canvas append: a mark left alone is not read, and the calls match the old implementation\'s append (a pixel-level equality with a full repaint is the canvas gates\')', () => {
    const stream = createChartStream(spec([symbols('a', '#f58518'), symbols('t', '#4c78a8')], ['a', 't']) as never, { capacity: 8 })
    stream.push({ data: { a: rows(2000, 50000), t: rows(500) } })
    let scene = stream.flush()!.scene
    for (let k = 0; k < 4; k++) {
      const prev = scene
      const legacySnap = legacySnapshot(prev)
      const snap = snapshotCanvasScene(prev)
      const reads = countGenReads(markOf(prev, 0).items as SceneItem[])
      stream.push({ append: { t: rows(3, 600 + k * 3) } })
      scene = stream.flush()!.scene
      expect(markOf(scene, 0)).toBe(markOf(prev, 0))
      const a = loggingContext()
      const b = loggingContext()
      const okOld = legacyAppend(legacySnap, scene, a.ctx)
      reads.n = 0
      const okNew = renderSceneToCanvasAppend(snap, scene, b.ctx)
      expect(okNew).toBe(okOld)
      expect(okNew).toBe(true)
      expect(reads.n).toBe(0)
      expect(b.log).toEqual(a.log)
    }
  })
})
