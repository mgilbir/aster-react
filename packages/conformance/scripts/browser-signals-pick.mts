/**
 * The pointer phase of the signal-event gate (`browser-signals.mts`): which item a pointer position resolves to.
 *
 * Every scene is mounted four times in one Chromium page: in real vega with its SVG renderer, in real vega with its canvas
 * renderer, and in Aster on each (`renderSceneToDomElement` / `renderSceneToCanvas` + `bindSceneSignals`, given the scene hit
 * index's `pick` as `<Chart>` gives it, and on the canvas the canvas's events). A pointer event is delivered at the same point
 * of each, as the browser delivers it (to the element its own hit test, `elementFromPoint`, finds there; to a canvas, whose
 * handler picks), and three things are read:
 *
 *   - vega's `event.item`, through a signal every scene declares (`item()` on `pointermove`: the mark, the item's datum id) --
 *     the SVG renderer resolves it with the browser's own hit test (`elementFromPoint`), the canvas renderer with vega's pick;
 *   - the value vega's tooltip handler was last called with (vega-view `handleTooltip`: a line, an area, a trail resolved to
 *     one of its items; `item.tooltip || null`);
 *   - Aster's: the same signal through its event loop, and `buildHitIndex(scene).tooltip(x, y)` -- the call `<Chart>` makes
 *     for its tooltips -- with vega's `|| null`.
 *
 * Where vega's two renderers agree, Aster must agree with them. Where they do not (the browser tests an SVG text by its
 * glyphs, vega's canvas pick by the text's box...), vega has no single answer and Aster must give one of the two: those points
 * are counted and reported. Aster's two renderers share one hit index, so its canvas gives the SVG renderer's answer where that
 * is the one the index gives; those points are counted apart (`canvasAsSvg`) and capped by the caller, so the count can only
 * fall (a scene about what only vega's scenegraph knows, a group's bounds, takes the canvas renderer's
 * answer there). A point within a quarter of a pixel of an edge, where vega's own answer changes, is decided by the
 * geometry its renderers approximate (Skia flattens a stroke's offset curves and arcs): Aster's answer there must be what vega
 * answers a quarter of a pixel away, and such points are counted and capped (`maxEdge`). The scenes are generated (seeded): overlapping marks of every type with
 * every kind of paint (filled, stroked, both, `transparent`, neither), strokes of several widths, caps and joins, rounded
 * corners, rotations, marks without `from`, marks that are not interactive, groups with a fill, a stroke, a clip and a
 * foreground stroke holding marks of their own, falsy tooltips; plus fixed scenes for the item kinds that have no data row of
 * their own (a mark without `from` over data marks, facet cells, interactive axis labels, legend entries, a title), and the
 * dense scatter of the chart-bench study (10,000 overlapping circles in a 900 x 600 chart) at the point where Aster used to
 * report a circle whose edge is 0.19 px away from the pointer.
 *
 * Environment: PICK_DEBUG=1 prints every edge answer and the SVG target of every difference (diagnostics only: the verdict is
 * the same with or without it).
 */
import type { Browser } from 'playwright'

type Spec = Record<string, unknown>
/**
 * `oracle: 'canvas'`: where vega's renderers disagree, Aster must give the canvas renderer's answer -- for a scene about what only
 * vega-scenegraph's pick knows (a group's bounds: the browser's hit test of the SVG has no notion of them).
 */
export interface PickScene { name: string; spec: Spec; points: Array<[number, number]>; oracle?: 'canvas' }

/** The signal every scene declares: vega's `event.item` as text (its mark, and its datum's id). */
export const PICKED_SIGNAL = {
  name: 'picked',
  value: 'none',
  on: [{
    events: 'pointermove',
    update: "item().mark ? item().mark.marktype + '|' + (item().mark.name || item().mark.role) + '|' + (isObject(item().datum) ? (item().datum.id != null ? item().datum.id : (item().datum.label != null ? 'L' + item().datum.label : 'o')) : 'u') : 'none'",
  }],
}

// ---- generated scenes ---------------------------------------------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x9e3779b9) >>> 0
    let t = a ^ (a >>> 16)
    t = Math.imul(t, 0x21f0aaad)
    t ^= t >>> 15
    t = Math.imul(t, 0x735a2d97)
    t ^= t >>> 15
    return (t >>> 0) / 4294967296
  }
}

const IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='
const V = (value: unknown): { value: unknown } => ({ value })
const F = (field: string): { field: string } => ({ field })

export function genPickScene(seed: number, W = 300, H = 220): PickScene {
  const R = rng(seed)
  const num = (a: number, b: number): number => a + (b - a) * R()
  const int = (n: number): number => Math.floor(R() * n)
  const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length)]!
  const chance = (p: number): boolean => R() < p
  const data: Spec[] = []
  const projections: Spec[] = []
  /** Where top-level items are anchored (svg coordinates): half the points fall near them, where the edges are. */
  const anchors: Array<[number, number]> = []

  /** The paint of an item: any of the kinds the pick treats differently. */
  const paint = (strokeOnly = false): Spec => {
    const out: Spec = {}
    const fill = strokeOnly ? null : pick(['#4c78a8', '#f58518', 'transparent', null, '#54a24b'] as const)
    const stroke = pick(['#222', 'transparent', null, null, '#e45756'] as const)
    if (fill) out.fill = V(fill)
    if (stroke || strokeOnly) {
      out.stroke = V(stroke ?? '#222')
      out.strokeWidth = V(pick([0.5, 1, 2, 3.5, 6, 9]))
      if (chance(0.3)) out.strokeCap = V(pick(['butt', 'round', 'square']))
      if (chance(0.3)) out.strokeJoin = V(pick(['miter', 'round', 'bevel']))
    }
    if (chance(0.15)) out.opacity = V(pick([0, 0.4]))
    return out
  }
  const tooltipOf = (name: string): Spec => {
    const r = R()
    if (r < 0.65) return { tooltip: { signal: `'${name}:' + datum.id` } }
    if (r < 0.75) return { tooltip: V(pick([0, '', false])) }
    return {}
  }

  const leaf = (name: string, inGroup: boolean): Spec => {
    const type = pick(['symbol', 'symbol', 'rect', 'rect', 'rule', 'text', 'arc', 'path', 'line', 'area', 'trail', 'image', 'shape'] as const)
    const w = inGroup ? 120 : W
    const h = inGroup ? 90 : H
    const n = 1 + int(5)
    const rows: Spec[] = []
    for (let k = 0; k < n; k++) rows.push({ id: `${name}_${k}`, x: num(-10, w + 10), y: num(-10, h + 10), a: num(0, 360), s: num(0, 1) })
    if (!inGroup) for (const r of rows) anchors.push([10 + (r.x as number), 10 + (r.y as number)])
    if (type === 'line' || type === 'area' || type === 'trail') rows.sort((p, q) => (p.x as number) - (q.x as number))
    const fromLess = type !== 'line' && type !== 'area' && type !== 'trail' && type !== 'shape' && chance(0.15)
    const update: Spec = { x: F('x'), y: F('y'), ...paint(type === 'rule' || type === 'line'), ...tooltipOf(name) }
    const mark: Spec = { type, name, encode: { update } }
    if (!fromLess) {
      data.push({ name: `d_${name}`, values: rows })
      mark.from = { data: `d_${name}` }
    } else {
      // a mark without `from`: one item, whose datum is vega's `{}`
      update.x = V(rows[0]!.x)
      update.y = V(rows[0]!.y)
      if (update.tooltip) update.tooltip = V(`${name}:solo`)
    }
    if (chance(0.12)) mark.interactive = false
    switch (type) {
      case 'symbol':
        update.size = fromLess ? V(num(30, 1600)) : { signal: '30 + datum.s * 1500' }
        update.shape = V(pick(['circle', 'circle', 'square', 'diamond', 'triangle-up', 'cross', 'wedge', 'stroke']))
        if (chance(0.3)) update.angle = F('a')
        break
      case 'rect':
        if (chance(0.5)) Object.assign(update, { width: V(num(-30, 80)), height: V(num(-30, 60)) })
        else Object.assign(update, { x2: { signal: 'datum.x + 40 - datum.s * 70' }, y2: { signal: 'datum.y + 30 - datum.s * 50' } })
        if (chance(0.25)) update.cornerRadius = V(num(0, 12))
        break
      case 'rule':
        Object.assign(update, { x2: { signal: 'datum.x + 80 * cos(datum.a)' }, y2: { signal: 'datum.y + 80 * sin(datum.a)' } })
        break
      case 'text':
        Object.assign(update, { text: { signal: "'Text ' + datum.id" }, fontSize: V(num(8, 22)), align: V(pick(['left', 'center', 'right'])), baseline: V(pick(['alphabetic', 'top', 'middle', 'bottom'])) })
        if (chance(0.4)) update.angle = F('a')
        if (!update.fill) update.fill = V('#333')
        break
      case 'arc':
        Object.assign(update, { innerRadius: V(num(0, 20)), outerRadius: V(num(20, 60)), startAngle: V(num(0, 3)), endAngle: V(num(3, 6.3)) })
        if (chance(0.3)) update.padAngle = V(num(0, 0.3))
        if (chance(0.3)) update.cornerRadius = V(num(0, 6))
        break
      case 'path':
        update.path = V(pick(['M0,0L60,10L40,70L-10,50Z', 'M0,0C40,-40 80,40 120,0L120,40L0,40Z', 'M0,0L50,0L50,50L0,50ZM15,15L35,15L35,35L15,35Z', 'M0,0L70,30L0,60', 'M0,0Q40,80 80,0']))
        if (chance(0.3)) update.angle = F('a')
        break
      case 'line':
        update.interpolate = V(pick(['linear', 'monotone', 'step', 'basis']))
        if (chance(0.25)) update.defined = { signal: 'datum.s > 0.2' }
        break
      case 'area':
        if (chance(0.5)) update.y2 = V(num(0, h))
        else { update.orient = V('horizontal'); update.x2 = V(num(0, w)) }
        update.interpolate = V(pick(['linear', 'monotone', 'step']))
        if (!update.fill) update.fill = V('#bab0ac')
        break
      case 'trail':
        update.size = { signal: '2 + datum.s * 14' }
        if (!update.fill) update.fill = V('#9467bd')
        break
      case 'image':
        Object.assign(update, { url: V(IMG), width: V(num(10, 60)), height: V(num(10, 50)), aspect: V(false), align: V(pick(['left', 'center', 'right'])), baseline: V(pick(['top', 'middle', 'bottom'])) })
        break
      case 'shape': {
        // a geoshape: polygons through an identity projection
        const geo = rows.map((r) => {
          const x = r.x as number, y = r.y as number, s = 15 + (r.s as number) * 40
          return { ...r, geo: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[x, y], [x + s, y + s * 0.3], [x + s * 0.6, y + s], [x, y]]] } } }
        })
        data[data.length - 1] = { name: `d_${name}`, values: geo }
        if (!projections.length) projections.push({ name: 'proj', type: 'identity' })
        mark.transform = [{ type: 'geoshape', projection: 'proj', field: 'geo' }]
        delete update.x
        delete update.y
        break
      }
    }
    return mark
  }

  const marks: Spec[] = []
  const nMarks = 3 + int(5)
  for (let m = 0; m < nMarks; m++) {
    const name = `m${m}`
    if (chance(0.18)) {
      // a group: its box (a fill, a stroke, both, or neither), a clip, a foreground stroke, a rounded corner; marks inside
      const rows = [{ id: `${name}_g0`, x: num(0, W - 120), y: num(0, H - 90) }, { id: `${name}_g1`, x: num(0, W - 120), y: num(0, H - 90) }].slice(0, 1 + int(2))
      data.push({ name: `d_${name}`, values: rows })
      const update: Spec = { x: F('x'), y: F('y'), width: V(num(40, 120)), height: V(num(30, 90)), ...paint(), ...tooltipOf(name) }
      if (chance(0.4)) update.clip = V(true)
      if (chance(0.3)) update.strokeForeground = V(true)
      if (chance(0.2)) update.cornerRadius = V(num(0, 10))
      // (a group whose box is left out of its bounds: vega picks it only as far as what it holds reaches)
      if (chance(0.3)) update.noBound = V(true)
      const inner = [leaf(`${name}i0`, true), ...(chance(0.5) ? [leaf(`${name}i1`, true)] : [])]
      marks.push({ type: 'group', name, from: { data: `d_${name}` }, encode: { update }, marks: inner })
    } else {
      marks.push(leaf(name, false))
    }
  }
  const points: Array<[number, number]> = []
  for (let i = 0; i < 60; i++) points.push([int(W + 20), int(H + 20)])
  for (let i = 0; i < 90 && anchors.length; i++) {
    const [ax, ay] = pick(anchors)
    // (on the view: a browser delivers no pointer event to a view from a point outside it)
    points.push([Math.min(W + 19, Math.max(0, Math.round(ax + num(-25, 25)))), Math.min(H + 19, Math.max(0, Math.round(ay + num(-25, 25))))])
  }
  return {
    name: `gen-${seed}`,
    spec: { width: W, height: H, padding: 10, autosize: 'none', signals: [PICKED_SIGNAL], data, ...(projections.length ? { projections } : {}), marks },
    points,
  }
}

// ---- fixed scenes: the items that have no data row of their own --------------------------------------------------

const grid = (W: number, H: number, step: number, off = 3): Array<[number, number]> => {
  const out: Array<[number, number]> = []
  for (let y = off; y < H; y += step) for (let x = off; x < W; x += step) out.push([x, y])
  return out
}

const fixedScenes = (): PickScene[] => {
  const base = { width: 260, height: 180, padding: 10, autosize: 'none' }
  const rows = [{ id: 'a', k: 'p', x: 30.3, y: 40.7 }, { id: 'b', k: 'q', x: 120.6, y: 90.2 }, { id: 'c', k: 'p', x: 200.1, y: 140.9 }]
  return [
    {
      // a transparent full-plot rect without `from` carrying a tooltip, over data marks (the chart-bench survival chart's hover
      // target), and a second one, under the marks, with none
      name: 'fixed-from-less-overlay',
      spec: {
        ...base, signals: [PICKED_SIGNAL], data: [{ name: 't', values: rows }],
        marks: [
          { type: 'rect', name: 'under', encode: { update: { x: V(0), y: V(0), x2: { signal: 'width' }, y2: { signal: 'height' }, fill: V('#eee') } } },
          { type: 'symbol', name: 'dots', from: { data: 't' }, encode: { update: { x: F('x'), y: F('y'), size: V(900), fill: V('steelblue'), tooltip: { signal: "'dot ' + datum.id" } } } },
          { type: 'rect', name: 'over', encode: { update: { x: V(100.5), y: V(0), x2: { signal: 'width' }, y2: { signal: 'height / 2' }, fill: V('transparent'), tooltip: { signal: "'over ' + toString(datum)" } } } },
        ],
      },
      points: grid(280, 200, 5),
    },
    {
      // facet cells (group items whose datum is the facet tuple) with a fill and a tooltip, holding marks with their own
      name: 'fixed-facet-cells',
      spec: {
        ...base, signals: [PICKED_SIGNAL], data: [{ name: 't', values: rows }],
        marks: [{
          type: 'group', name: 'cell', from: { facet: { data: 't', name: 'f', groupby: 'k' } },
          encode: { update: { x: { signal: "datum.k === 'p' ? 10.5 : 135.5" }, y: V(10.5), width: V(110), height: V(150), fill: V('#f4f4f4'), stroke: V('#999'), tooltip: { signal: "'cell ' + datum.k + ' ' + datum.count" } } },
          marks: [
            { type: 'rect', name: 'bar', from: { data: 'f' }, encode: { update: { x: { signal: 'datum.x / 3' }, width: V(25), y: { signal: 'datum.y / 2' }, height: V(40), fill: V('#4c78a8'), tooltip: { signal: "'bar ' + datum.id" } } } },
            { type: 'text', name: 'label', encode: { update: { x: V(55), y: V(140), text: V('no from'), align: V('center'), tooltip: V('cell label') } } },
          ],
        }],
      },
      points: grid(280, 200, 4),
    },
    {
      // guides: an axis whose labels and ticks are interactive and carry tooltips, one whose labels carry tooltips but are not
      // interactive, a legend with interactive entries, symbols and labels, and an interactive title
      name: 'fixed-guides',
      spec: {
        ...base, height: 140, padding: { left: 40, top: 30, right: 90, bottom: 40 }, signals: [PICKED_SIGNAL], data: [{ name: 't', values: rows }],
        title: { text: 'Hover title', encode: { title: { interactive: true, update: { tooltip: V('the title') } } } },
        scales: [
          { name: 'x', type: 'linear', domain: [0, 220], range: 'width' },
          { name: 'y', type: 'linear', domain: [0, 160], range: 'height' },
          { name: 'c', type: 'ordinal', domain: { data: 't', field: 'id' }, range: 'category' },
        ],
        axes: [
          { scale: 'x', orient: 'bottom', title: 'X axis', encode: { labels: { interactive: true, update: { tooltip: { signal: "'label ' + datum.label" } } }, ticks: { interactive: true, update: { strokeWidth: V(4), tooltip: { signal: "'tick ' + datum.value" } } }, title: { interactive: true, update: { tooltip: V('axis title') } } } },
          { scale: 'y', orient: 'left', encode: { labels: { update: { tooltip: { signal: "'inert ' + datum.label" } } } } },
        ],
        legends: [{ fill: 'c', title: 'Legend', encode: { entries: { interactive: true, update: { fill: V('transparent'), tooltip: { signal: "'entry ' + datum.index" } } }, symbols: { interactive: true, update: { tooltip: { signal: "'symbol ' + datum.value" } } }, labels: { interactive: true, update: { tooltip: { signal: "'legend label ' + datum.label" } } } } }],
        marks: [{ type: 'symbol', name: 'dots', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: V(300), fill: { scale: 'c', field: 'id' }, tooltip: { signal: "'dot ' + datum.id" } } } }],
      },
      points: grid(390, 210, 3, 1),
    },
    {
      // group items whose box is left out of their bounds (`noBound`): vega looks for such an item, and for what it holds, only
      // within the bounds of what it holds; clipped as well, it has no bounds and nothing in it is picked
      name: 'fixed-nobound',
      spec: {
        ...base, signals: [PICKED_SIGNAL], data: [{ name: 't', values: rows }],
        marks: [
          { type: 'rect', name: 'under', encode: { update: { x: V(0), y: V(0), x2: { signal: 'width' }, y2: { signal: 'height' }, fill: V('#eee'), tooltip: V('under') } } },
          ...[[10.5, false], [135.5, true]].map(([x, clip]) => ({
            type: 'group', name: clip ? 'clipped' : 'open',
            encode: { update: { x: V(x), y: V(10.5), width: V(110), height: V(150), fill: V('#f4f4f4'), stroke: V('#999'), strokeWidth: V(3), noBound: V(true), clip: V(clip), tooltip: V(clip ? 'clipped group' : 'open group') } },
            marks: [{ type: 'symbol', name: clip ? 'inClipped' : 'inOpen', encode: { update: { x: V(30), y: V(40), size: V(900), fill: V('#4c78a8'), tooltip: V('symbol') } } }],
          })),
        ],
      },
      points: grid(280, 200, 4),
      oracle: 'canvas',
    },
    {
      // a line, an area and a trail: vega's tooltip handler resolves each to one of its items
      name: 'fixed-multi',
      spec: {
        ...base, signals: [PICKED_SIGNAL], data: [{ name: 't', values: rows }],
        marks: [
          { type: 'area', name: 'band', from: { data: 't' }, encode: { update: { x: F('x'), y: F('y'), y2: V(170), fill: V('#ddd'), tooltip: { signal: "'area ' + datum.id" } } } },
          { type: 'line', name: 'curve', from: { data: 't' }, encode: { update: { x: F('x'), y: { signal: 'datum.y - 20' }, stroke: V('#333'), strokeWidth: V(6), tooltip: { signal: "'line ' + datum.id" } } } },
          { type: 'trail', name: 'worm', from: { data: 't' }, encode: { update: { x: F('x'), y: { signal: 'datum.y + 20' }, size: V(10), fill: V('#9467bd'), tooltip: { signal: "'trail ' + datum.id" } } } },
        ],
      },
      points: grid(280, 200, 3),
    },
  ]
}

// ---- the dense scatter of the chart-bench study (its `scatterSpec` and `generateScatter`, heavy dataset: seed 4) --------------

function scatterScene(): PickScene {
  // splitmix32, as the study generates its data (heavy: seed 4, 10,000 points, 5 groups)
  const rand = rng(4)
  const gauss = (): number => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand())
  const groups = 5
  const palette = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c']
  const series = Array.from({ length: groups }, (_, g) => ({ id: `Group ${g + 1}`, points: [] as Array<{ x: number; y: number; size: number }> }))
  for (let i = 0; i < 10_000; i++) {
    const g = i % groups
    series[g]!.points.push({ x: 20 + g * 12 + gauss() * 8, y: 40 + g * 6 + gauss() * 10, size: 3 + Math.floor(rand() * 6) })
  }
  const rows = series.flatMap((s) => s.points.map((p, k) => ({ id: `${s.id}#${k}`, series: s.id, ...p })))
  const margin = { top: 20, right: 20, bottom: 44, left: 56 }
  const R2 = rng(99)
  const points: Array<[number, number]> = [[440, 290]]
  for (let i = 0; i < 1500; i++) points.push([Math.floor(margin.left + R2() * 824), Math.floor(margin.top + R2() * 536)])
  return {
    name: 'chart-bench-heavy-scatter',
    spec: {
      width: 824, height: 536, padding: margin, autosize: 'none', signals: [PICKED_SIGNAL],
      data: [{ name: 'table', values: rows }],
      scales: [
        { name: 'x', type: 'linear', domain: { data: 'table', field: 'x' }, range: 'width', nice: true, zero: false },
        { name: 'y', type: 'linear', domain: { data: 'table', field: 'y' }, range: 'height', nice: true, zero: false },
        { name: 'color', type: 'ordinal', domain: series.map((s) => s.id), range: palette },
      ],
      axes: [{ scale: 'x', orient: 'bottom', title: 'X' }, { scale: 'y', orient: 'left', title: 'Y', grid: true }],
      marks: [{
        type: 'symbol', from: { data: 'table' },
        encode: { enter: {
          x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { signal: 'PI * datum.size * datum.size' },
          fill: { scale: 'color', field: 'series' }, fillOpacity: V(0.7),
          tooltip: { signal: "{title: datum.series, id: datum.id, x: format(datum.x, '.1f'), y: format(datum.y, '.1f')}" },
        } },
      }],
    },
    points,
  }
}

export function pickScenes(generated: number): PickScene[] {
  return [...fixedScenes(), scatterScene(), ...Array.from({ length: generated }, (_, i) => genPickScene(1000 + i))]
}

// ---- the page --------------------------------------------------------------------------------------------------------

/** The page script: mounts a scene in vega (svg, canvas) and in Aster, and reads what each says about the pointer. */
export const PICK_ENTRY = `
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { renderSceneToDomElement } from '@aster-charts/core/dom'
import { renderSceneToCanvas, createCanvasEvents } from '@aster-charts/core/canvas'
import { buildHitIndex } from '@aster-charts/core/hit'
import { bindSceneSignals } from '@aster-charts/core/signals'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'

const quiet = { level() { return this }, error() { return this }, warn() { return this }, info() { return this }, debug() { return this } }
const holders = ['vs', 'vc', 'as', 'ac'].map((id, i) => {
  const d = document.createElement('div')
  d.id = id
  d.style.cssText = 'position:absolute;top:10px;left:' + (10 + i * 960) + 'px'
  document.body.appendChild(d)
  return d
})
const origins = holders.map((h) => [parseFloat(h.style.left), 10])
const norm = (v) => (v === undefined || v === null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v))
const tips = [null, null]
let state = null
window.__mountPick = async (spec) => {
  if (state) { state.views.forEach((v) => v.finalize()); state.binding.release(); state.canvasBinding.release(); state.events.release(); holders.forEach((h) => h.replaceChildren()) }
  tips[0] = tips[1] = null
  const views = []
  for (const [i, renderer] of [[0, 'svg'], [1, 'canvas']]) {
    const view = new vega.View(vega.parse(structuredClone(spec)), {
      renderer, container: holders[i], hover: false, logger: quiet,
      tooltip: (handler, event, item, value) => { tips[i] = norm(value) },
    })
    await view.runAsync()
    views.push(view)
  }
  const scene = evaluateChart(compileChart(structuredClone(spec)))
  const svg = renderSceneToDomElement(scene)
  holders[2].appendChild(svg)
  const store = {}
  const hit = buildHitIndex(scene)
  const binding = bindSceneSignals(svg, scene, store, { logger: quiet }, { pick: (x, y) => hit.pick(x, y) })
  // Aster's canvas, as <Chart renderer="canvas"> paints and binds it
  const ac = document.createElement('canvas')
  ac.width = Math.max(1, Math.round(scene.width)); ac.height = Math.max(1, Math.round(scene.height))
  ac.style.width = scene.width + 'px'; ac.style.height = scene.height + 'px'
  renderSceneToCanvas(scene, ac.getContext('2d'), { dpr: 1 })
  holders[3].appendChild(ac)
  const canvasStore = {}
  const events = createCanvasEvents(ac)
  // (the index <Chart renderer="canvas"> builds: it picks as vega's canvas renderer picks)
  const hitc = buildHitIndex(scene, undefined, { renderer: 'canvas' })
  const canvasBinding = bindSceneSignals(ac, scene, canvasStore, { logger: quiet }, { pick: (x, y) => hitc.pick(x, y), events })
  state = { views, binding, hit, hitc, store, canvas: holders[1].querySelector('canvas'), ac, canvasBinding, canvasStore, events }
}
// A pointermove at (x, y) of each mount, as the browser delivers it: to the element its own hit test finds there (vega's SVG
// handler reads the item off that element; Aster's loop resolves it through the hit index), and to vega's canvas (whose
// handler picks the item itself). The tooltip a move over an element without one leaves is what the SVG's pointerout of the
// element before had made of it: hidden.
const move = (target, cx, cy) => target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, pointerType: 'mouse', isPrimary: true, view: window }))
const readAt = async (x, y) => {
  const [[sx, sy], [cx, cy], [ax, ay], [kx, ky]] = origins
  tips[0] = null
  const el = document.elementFromPoint(sx + x, sy + y)
  if (el) move(el, sx + x, sy + y)
  move(state.canvas, cx + x, cy + y)
  const ael = document.elementFromPoint(ax + x, ay + y)
  if (ael) move(ael, ax + x, ay + y)
  move(state.ac, kx + x, ky + y)
  for (const v of state.views) await v.runAsync()
  const t = state.hit.tooltip(x, y)
  const tip = norm((t ? t.item.tooltip : null) || null)
  const tc = state.hitc.tooltip(x, y)
  return {
    vs: { picked: state.views[0].signal('picked'), tip: tips[0] },
    vc: { picked: state.views[1].signal('picked'), tip: tips[1] },
    as: { picked: Object.hasOwn(state.store, 'picked') ? state.store.picked : 'none', tip },
    ac: { picked: Object.hasOwn(state.canvasStore, 'picked') ? state.canvasStore.picked : 'none', tip: norm((tc ? tc.item.tooltip : null) || null) },
  }
}
// What vega answers a quarter of a pixel around (x, y), in eight directions: where its answer changes that close, the point is
// on an edge, and the geometry of its renderers (Skia flattens a stroke's offset curves, an arc...) decides it.
window.__around = async (x, y) => {
  const out = []
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4
    out.push(await readAt(x + 0.25 * Math.cos(a), y + 0.25 * Math.sin(a)))
  }
  return out
}
window.__readPoints = async (points) => {
  const out = []
  for (const [x, y] of points) {
    const el = document.elementFromPoint(origins[0][0] + x, origins[0][1] + y)
    out.push({ at: el ? el.tagName + '.' + (el.getAttribute('class') || '') + (el.__data__ ? '' : '(no item)') : 'nothing', ...(await readAt(x, y)) })
  }
  return out
}
`

interface Read { picked: string; tip: string | null }
type Mount = 'vs' | 'vc' | 'as' | 'ac'
export interface PickResult {
  scenes: number; points: number; agreed: number; ambiguous: number; edge: number; picked: number; tips: number; failures: string[]
  /** Answers of Aster's canvas that are vega's SVG renderer's where its canvas renderer answers otherwise. */
  canvasAsSvg: number
  canvasAsSvgSamples: string[]
}

/** Drive every scene's points through the four mounts in `pageUrl` (a page that loads PICK_ENTRY's bundle). */
export async function runPickPhase(browser: Browser, pageUrl: string, scenes: PickScene[]): Promise<PickResult> {
  const context = await browser.newContext({ viewport: { width: 3860, height: 640 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)))
  const out: PickResult = { scenes: 0, points: 0, agreed: 0, ambiguous: 0, edge: 0, picked: 0, tips: 0, failures: [], canvasAsSvg: 0, canvasAsSvgSamples: [] }
  try {
    await page.goto(pageUrl)
    await page.waitForFunction(() => '__mountPick' in window, null, { timeout: 30_000 })
    for (const sc of scenes) {
      await page.evaluate((spec) => (window as unknown as { __mountPick: (s: unknown) => Promise<void> }).__mountPick(spec), sc.spec)
      out.scenes++
      const reads = await page.evaluate((pts) => (window as unknown as { __readPoints: (p: unknown) => Promise<Array<Record<Mount, Read> & { at: string }>> }).__readPoints(pts), sc.points)
      const failures: string[] = []
      for (const [i, r] of reads.entries()) {
        const [x, y] = sc.points[i]!
        out.points++
        let ok = true
        let around: Array<Record<Mount, Read>> | undefined
        for (const key of ['picked', 'tip'] as const) {
          const svg = r.vs[key], canvas = r.vc[key]
          if (svg !== canvas) out.ambiguous++
          // Aster's svg: vega's answer, or either of its renderers' where they differ; Aster's canvas: vega's canvas renderer's
          for (const [mine, oracle] of [['as', sc.oracle ?? 'either'], ['ac', 'canvas']] as const) {
            const aster = r[mine][key]
            if (svg === canvas ? aster === svg : aster === canvas || (oracle !== 'canvas' && aster === svg)) continue
            // (the shared hit index's answer is the svg renderer's here: counted, capped by the caller)
            if (mine === 'ac' && svg !== canvas && aster === svg && sc.oracle !== 'canvas') {
              out.canvasAsSvg++
              if (out.canvasAsSvgSamples.length < 8) out.canvasAsSvgSamples.push(`${sc.name} (${x},${y}) ${key}: vega svg=${svg} canvas=${canvas}`)
              continue
            }
            // Aster's answer is what vega answers a quarter of a pixel away: the point is on an edge (counted, and capped below)
            around ??= await page.evaluate(([px, py]) => (window as unknown as { __around: (x: number, y: number) => Promise<Array<Record<Mount, Read>>> }).__around(px!, py!), [x, y])
            if (around.some((a) => (oracle !== 'canvas' && a.vs[key] === aster) || a.vc[key] === aster)) {
              out.edge++
              if (process.env.PICK_DEBUG) console.log(`  edge ${sc.name} (${x},${y}) ${key} ${mine}: vega svg=${svg} canvas=${canvas} aster=${aster}`)
              continue
            }
            ok = false
            failures.push(`(${x},${y}) ${key} ${mine === 'as' ? 'svg' : 'canvas'}: vega${svg === canvas ? '' : ` svg=${svg} canvas`}=${canvas} aster=${aster}${process.env.PICK_DEBUG ? ` [svg target ${r.at}]` : ''}`)
          }
        }
        if (ok) out.agreed++
        if (r.vs.picked !== 'none') out.picked++
        if (r.vs.tip !== null) out.tips++
      }
      if (failures.length) out.failures.push(`${sc.name}: ${failures.length} point(s) differ: ${failures.slice(0, 4).join('; ')}`)
    }
    if (pageErrors.length) out.failures.push(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
  } finally {
    await context.close()
  }
  return out
}
