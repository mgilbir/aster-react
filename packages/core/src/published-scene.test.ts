// @vitest-environment jsdom
/**
 * A scene the engine returned never changes afterwards (scene-registry.ts): the evaluations after it keep its nodes and write into
 * none of them, and the renderers and indexes that read it leave it as it was. What is derived from a node of it (its hit entries,
 * its accessible box, the items it holds, its cursor) is kept with the node on the strength of this.
 *
 * Each sequence runs a chart through the ways a host changes it -- signal writes (a pointer-driven one, a bound one), a selection
 * store, data replaced, rows edited with `dataChanges`, rows appended (the engine's in-place append), a stream's pushes -- and after
 * every step reads the new scene the way <Chart> does (SVG, the DOM patch, the canvas, the hit index, the accessible tree, the
 * item index and the cursor check). Every scene returned so far must still deep-equal the snapshot taken when it was returned.
 */
import { describe, expect, it } from 'vitest'
import { createChartSession } from './session.js'
import { createChartStream } from './stream.js'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { renderSceneToSvg } from './index.js'
import { buildA11yTree } from './a11y.js'
import { buildHitIndex } from './hit.js'
import { renderSceneToCanvas } from './canvas.js'
import { patchSceneDom, renderSceneToDomElement } from './dom.js'
import { sceneHasCursor } from './signals.js'
import { isEngineNode } from './scene-registry.js'
import './addon-transforms.js'
import type { RuntimeInput, SceneGroup, SceneNode, SceneRoot, VgSpec } from './types.js'

type Row = Record<string, unknown>

/** What a renderer leaves on an item for itself (the DOM descriptor, a canvas gradient's id): a cache, not the scene's content. */
const RENDERER_CACHES = new Set(['__domDesc', '__gradId'])

/** Every object a snapshot met, by a number of its own: a node replaced by an equal one is a change too (what is kept with a node is keyed by it). */
const IDS = new WeakMap<object, number>()
let nextId = 0
const idOf = (o: object): number => { let id = IDS.get(o); if (id === undefined) IDS.set(o, (id = ++nextId)); return id }

function snapshot(v: unknown, seen = new Map<object, string>(), path = 'scene'): unknown {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && Number.isNaN(v)) return '[NaN]'
    if (typeof v === 'function') return '[fn]'
    return v
  }
  if (seen.has(v)) return `[ref ${seen.get(v)}]`
  seen.set(v, path)
  // (a Map or a Set is read by its entries: a write into one is a write into the scene)
  if (v instanceof Map) return { '#': idOf(v), map: [...v.entries()].map(([k, x], i) => [snapshot(k, seen, `${path}.k${i}`), snapshot(x, seen, `${path}.v${i}`)]) }
  if (v instanceof Set) return { '#': idOf(v), set: [...v.values()].map((x, i) => snapshot(x, seen, `${path}.${i}`)) }
  if (Array.isArray(v)) return v.map((x, i) => snapshot(x, seen, `${path}.${i}`))
  const out: Record<string, unknown> = { '#': idOf(v) }
  for (const k of Object.keys(v)) {
    if (RENDERER_CACHES.has(k)) continue
    out[k] = snapshot((v as Row)[k], seen, `${path}.${k}`)
  }
  return out
}

function noopContext(): CanvasRenderingContext2D {
  const f = (): void => {}
  return new Proxy({ canvas: { width: 300, height: 300 }, createLinearGradient: () => ({ addColorStop: f }), createRadialGradient: () => ({ addColorStop: f }), measureText: () => ({ width: 10 }) } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : f),
    set: (t, k, v) => { t[k as string] = v; return true },
  }) as unknown as CanvasRenderingContext2D
}

/** Read a scene as <Chart> does after each evaluation. */
function readAll(scene: SceneRoot, svg: Element): void {
  renderSceneToSvg(scene)
  patchSceneDom(svg, scene)
  renderSceneToCanvas(scene, noopContext(), { dpr: 2 })
  const index = buildHitIndex(scene)
  for (let x = 0; x < scene.width; x += 23) for (let y = 0; y < scene.height; y += 29) { index.query(x, y); index.pick(x, y); index.tooltip(x, y); index.queryMark(x, y) }
  buildA11yTree(scene)
  buildA11yTree(scene, new Map(), { summaryThreshold: 3 })
  sceneHasCursor(scene)
}

class Recorder {
  readonly scenes: Array<{ scene: SceneRoot; snap: string; what: string }> = []
  private svg: Element | null = null
  take(scene: SceneRoot | null | undefined, what: string): void {
    if (!scene) throw new Error(`${what}: no scene`)
    if (!this.scenes.some((s) => s.scene === scene)) this.scenes.push({ scene, snap: JSON.stringify(snapshot(scene)), what })
    if (this.svg === null) { this.svg = renderSceneToDomElement(scene, document); document.body.appendChild(this.svg) }
    readAll(scene, this.svg)
    this.check(what)
  }
  check(after: string): void {
    for (const s of this.scenes) expect(JSON.stringify(snapshot(s.scene)), `the scene of "${s.what}", after "${after}"`).toBe(s.snap)
  }
}

const rows = (n: number, seed = 1): Row[] => Array.from({ length: n }, (_, i) => ({ k: 'abc'[i % 3], x: i, y: ((i * 37 + seed * 11) % 23) / 23, censored: i % 5 === 0 }))

/** A facet of a line and an area per category, a rule over a filtered dataset, and a pointer-driven tooltip rect: the survival chart's shape. */
const FACET_HOVER: VgSpec = {
  width: 300, height: 200, padding: 5, autosize: 'none',
  signals: [{ name: 'hoverX', value: null, on: [{ events: 'pointermove', update: "clamp(invert('x', x()), 0, 40)" }] }, { name: 'w', value: 2, bind: { input: 'range', min: 1, max: 5 } }],
  data: [
    { name: 'table', values: rows(40) },
    { name: 'censored', source: 'table', transform: [{ type: 'filter', expr: 'datum.censored' }] },
    { name: 'atX', source: 'table', transform: [{ type: 'filter', expr: 'hoverX != null && datum.x <= hoverX' }, { type: 'aggregate', groupby: ['k'], fields: ['x'], ops: ['argmax'], as: ['last'] }] },
  ],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 40], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 1], range: 'height' },
    { name: 'c', type: 'ordinal', domain: { data: 'table', field: 'k' }, range: 'category' },
  ],
  axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left', grid: true }],
  marks: [
    {
      type: 'group', from: { facet: { name: 'one', data: 'table', groupby: 'k' } },
      marks: [
        { type: 'area', from: { data: 'one' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, y2: { value: 200 }, fill: { scale: 'c', field: 'k' }, fillOpacity: { value: 0.2 }, interpolate: { value: 'step-after' } } } },
        { type: 'line', from: { data: 'one' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, stroke: { scale: 'c', field: 'k' }, interpolate: { value: 'step-after' } }, update: { strokeWidth: { signal: 'w' } } } },
      ],
    },
    { type: 'rule', from: { data: 'censored' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y', offset: -4 }, y2: { scale: 'y', field: 'y', offset: 4 }, stroke: { scale: 'c', field: 'k' }, cursor: { value: 'pointer' } } } },
    { type: 'symbol', from: { data: 'atX' }, encode: { update: { x: { scale: 'x', field: 'last.x' }, y: { scale: 'y', field: 'last.y' }, fill: { scale: 'c', field: 'k' }, tooltip: { signal: "format(datum.last.y, '.2f')" } } } },
    { type: 'rect', encode: { enter: { x: { value: 0 }, x2: { signal: 'width' }, y: { value: 0 }, y2: { signal: 'height' }, fill: { value: 'transparent' } }, update: { tooltip: { signal: "hoverX == null ? null : 'Day ' + round(hoverX)" } } } },
  ],
} as unknown as VgSpec

/** A layered Vega-Lite-shaped chart with a nearest point selection whose store sets a rule's opacity (the VL survival shape), compiled by hand. */
const SELECTION: VgSpec = {
  width: 200, height: 150, autosize: 'none',
  signals: [{ name: 'unit', value: {} }],
  data: [{ name: 'hover_store' }, { name: 'source', values: rows(30) }],
  scales: [{ name: 'x', type: 'linear', domain: { data: 'source', field: 'x' }, range: 'width' }, { name: 'y', type: 'linear', domain: [0, 1], range: 'height' }],
  marks: [
    { name: 'pts', type: 'symbol', from: { data: 'source' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, tooltip: { signal: "{x: format(datum.x, ''), y: format(datum.y, '.3f')}" }, opacity: [{ test: '!length(data("hover_store")) || vlSelectionTest("hover_store", datum)', value: 1 }, { value: 0.2 }] } } },
    { name: 'vor', type: 'path', from: { data: 'pts' }, encode: { update: { fill: { value: 'transparent' }, strokeWidth: { value: 0.35 }, stroke: { value: 'transparent' }, isVoronoi: { value: true } } }, transform: [{ type: 'voronoi', x: { expr: 'datum.datum.x || 0' }, y: { expr: 'datum.datum.y || 0' }, size: [{ signal: 'width' }, { signal: 'height' }] }] },
  ],
} as unknown as VgSpec

const store = (x: number | null): Row[] => (x === null ? [] : [{ unit: '', fields: [{ type: 'E', field: 'x' }], values: [x] }])

describe('a scene the engine returned never changes afterwards', () => {
  it('through signal writes, a bound signal and data changes (a session)', () => {
    const rec = new Recorder()
    const s = createChartSession()
    let t = rows(40)
    rec.take(s.evaluate(FACET_HOVER, { data: { table: t } }), 'first')
    for (const [i, hv] of [3.5, 7, 7, 12.25, null, 30].entries()) rec.take(s.evaluate(FACET_HOVER, { data: { table: t }, signals: { hoverX: hv } }), `hoverX ${hv} (${i})`)
    rec.take(s.evaluate(FACET_HOVER, { data: { table: t }, signals: { hoverX: 30, w: 4 } }), 'w 4')
    t = [...t, { k: 'b', x: 41, y: 0.5, censored: true }]
    rec.take(s.evaluate(FACET_HOVER, { data: { table: t }, signals: { hoverX: 30, w: 4 } }), 'a row appended')
    t = t.map((r, i) => (i === 7 ? { ...r, y: 0.9 } : r))
    rec.take(s.change({ data: { table: t }, dataChanges: { table: [7] }, signals: { hoverX: 20, w: 4 } }), 'a row edited (dataChanges)')
    t = t.filter((_, i) => i !== 3)
    rec.take(s.evaluate(FACET_HOVER, { data: { table: t }, signals: { hoverX: 20, w: 1 } }), 'a row removed')
    expect(rec.scenes.length).toBeGreaterThan(8)
    // (the nodes of every scene are recorded as the engine's)
    for (const { scene } of rec.scenes) for (const g of scene.items) expect(isEngineNode(g)).toBe(true)
  })

  it('through selection store writes', () => {
    const rec = new Recorder()
    const s = createChartSession()
    const src = rows(30)
    for (const x of [null, 3, 4, 4, 10, null, 29]) rec.take(s.evaluate(SELECTION, { data: { source: src, hover_store: store(x) } }), `store ${x}`)
  })

  it('through in-place appends and edits (dataChanges on the same chart)', () => {
    const rec = new Recorder()
    const chart = compileChart(FACET_HOVER)
    let t = rows(40)
    rec.take(evaluateChart(chart, { data: { table: t } }), 'first')
    for (let k = 0; k < 4; k++) {
      const before = t.length
      t = [...t, { k: 'abc'[k % 3], x: 40 + k, y: 0.3, censored: k % 2 === 0 }]
      const input: RuntimeInput = { data: { table: t }, dataChanges: { table: [] }, dataPulse: { table: { changed: [], appendOnly: true, baseLength: before } } } as RuntimeInput
      rec.take(evaluateChart(chart, input), `append ${k}`)
    }
    t = t.map((r, i) => (i === 2 ? { ...r, y: 0.01 } : r))
    rec.take(evaluateChart(chart, { data: { table: t }, dataChanges: { table: [2] } }), 'edit')
  })

  it('through a stream (appends, snapshots, signals)', () => {
    const rec = new Recorder()
    const stream = createChartStream(FACET_HOVER, { initial: { data: { table: rows(40) } } })
    stream.push({ signals: { hoverX: 5 } })
    rec.take(stream.flush()!.scene, 'first')
    for (let k = 0; k < 4; k++) {
      stream.push({ append: { table: [{ k: 'abc'[k % 3], x: 40 + k, y: 0.4, censored: false }] } })
      rec.take(stream.flush()!.scene, `append ${k}`)
      stream.push({ signals: { hoverX: 10 + k } })
      rec.take(stream.flush()!.scene, `signal ${k}`)
    }
    stream.push({ data: { table: rows(35, 2) } })
    rec.take(stream.flush()!.scene, 'snapshot')
    stream.close()
  })

  it('when a kept group mark moves in the content (a group mark before it gains items)', () => {
    const rec = new Recorder()
    const spec = {
      width: 300, height: 200, autosize: 'none',
      data: [{ name: 'u', values: [{ c: 'p' }] }, { name: 't', values: rows(12) }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 12], range: [0, 90] }],
      marks: [
        // (cells that look like the kept mark's: their boxes are equal by value to the kept cells' boxes)
        { type: 'group', from: { facet: { name: 'uu', data: 'u', groupby: 'c' } }, encode: { update: { width: { value: 90 }, height: { value: 90 }, stroke: { value: 'grey' } } } },
        { type: 'group', from: { facet: { name: 'part', data: 't', groupby: 'k' } }, encode: { update: { x: { signal: "indexof(['a','b','c'], datum.k) * 100" }, width: { value: 90 }, height: { value: 90 }, stroke: { value: 'grey' } } },
          marks: [{ type: 'symbol', from: { data: 'part' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { value: 10 } } } }] },
      ],
    } as unknown as VgSpec
    const s = createChartSession()
    const t = rows(12)
    let u: Row[] = [{ c: 'p' }]
    rec.take(s.evaluate(spec, { data: { u, t } }), 'first')
    for (const c of ['q', 'r', 's']) {
      u = [...u, { c }]
      rec.take(s.evaluate(spec, { data: { u, t } }), `u gains ${c}`)
    }
    u = u.slice(2)
    rec.take(s.evaluate(spec, { data: { u, t } }), 'u loses two')
  })

  it('a planted write into a kept node is caught', () => {
    const rec = new Recorder()
    const s = createChartSession()
    const t = rows(40)
    const first = s.evaluate(FACET_HOVER, { data: { table: t } })
    rec.take(first, 'first')
    const second = s.evaluate(FACET_HOVER, { data: { table: t }, signals: { hoverX: 3 } })
    // (an item the second scene kept from the first, written in place)
    const facet = second.items.find((g) => g.marktype === 'group' && (g as { markIndex?: unknown }).markIndex !== undefined) as SceneGroup
    const leaf = (facet.items as SceneNode[]).find((n) => (n as SceneGroup).role === 'mark') as SceneGroup
    ;(leaf.items![0] as Row).y = 1e6
    expect(() => rec.check('a write')).toThrow()
  })
})
