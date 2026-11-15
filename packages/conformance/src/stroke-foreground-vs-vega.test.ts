// @vitest-environment jsdom
/**
 * `strokeForeground` on every kind of group item: a group mark's item, an axis's, a legend's, a legend entry's and a title's box.
 * vega-scenegraph (marks/group.js) fills the box before what the item holds and, with `strokeForeground`, strokes it after
 * (`path.foreground` in the SVG; on a canvas, after the contents); its pick tests that front stroke before the contents. Compared with
 * real vega in the same process:
 * - the SVG, through the string renderer and the DOM descriptors (strict canonical form);
 * - the canvas: vega's own group drawing on a recording context, every box paint as its device-space path and style, in order with
 *   the contents (a run of the contents' paints standing as one step);
 * - the pick: vega's canvas pick on the same recording context against Aster's canvas hit index, at a grid of points over the box;
 * - the bounds: the size of the view (vega's autosize reads the bounds) with the item stroked in front.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart, renderSceneToSvg } from '@aster-charts/core'
import { renderSceneToDomElement } from '@aster-charts/core/dom'
import { renderSceneToCanvas } from '@aster-charts/core/canvas'
import { buildHitIndex } from '@aster-charts/core/hit'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { recorder, vegaDraw, type Painted } from './canvas-recorder.js'

type Spec = Record<string, unknown>
const V = (value: unknown): { value: unknown } => ({ value })

const SCALES = [
  { name: 'x', type: 'linear', domain: [0, 10], range: 'width' },
  { name: 'c', type: 'ordinal', domain: ['a', 'b'], range: ['red', 'blue'] },
]
const KINDS = ['group mark', 'axis', 'legend', 'legend entries', 'title'] as const
type Kind = (typeof KINDS)[number]

/** The chart with `update` as the encode of the group item of `kind` (and every part of it interactive when `interactive`). */
function chart(kind: Kind, update: Spec, interactive = false, extra: Spec = {}): Spec {
  // (sized to what it holds, so every guide is inside the view: nothing is picked outside it)
  const base = { width: 140, height: 90, padding: 5, autosize: 'pad', scales: SCALES, ...extra }
  const I = interactive ? { interactive: true } : {}
  // (square symbols: their outline is straight, so a pick on it is exact)
  const symbols = { update: { shape: V('square'), size: V(100) }, ...I }
  switch (kind) {
    case 'group mark':
      return {
        ...base,
        marks: [{
          type: 'group', name: 'g',
          encode: { update: { x: V(20), y: V(15), width: V(60), height: V(40), ...update } },
          // (what it holds crosses its edge: the stroke in front covers it there, the stroke behind does not)
          marks: [{ type: 'rect', name: 'inner', ...(interactive ? {} : { interactive: false }), encode: { update: { x: V(-6), y: V(10), width: V(80), height: V(12), fill: V('tomato') } } }],
        }],
      }
    case 'axis':
      return { ...base, axes: [{ orient: 'bottom', scale: 'x', encode: { axis: { update, ...I }, ticks: I, domain: I } }] }
    case 'legend':
      return { ...base, legends: [{ fill: 'c', encode: { legend: { update, ...I }, symbols } }] }
    case 'legend entries':
      return { ...base, legends: [{ fill: 'c', encode: { entries: { update, ...I }, symbols } }] }
    case 'title':
      return { ...base, title: { text: 'Title', encode: { group: { update, ...I } } } }
  }
}

/** A guide's group item has no size of its own to paint: it is given one (a group mark's has its own). */
const SIZED = { width: V(40), height: V(20) }
const VARIANTS: Array<[string, Spec]> = [
  ['a 2 px stroke', { fill: V('gold'), stroke: V('teal'), strokeWidth: V(2) }],
  ['a 1 px stroke (offset half a pixel)', { fill: V('gold'), stroke: V('teal'), strokeWidth: V(1) }],
  ['a 5 px stroke, no fill', { stroke: V('teal'), strokeWidth: V(5) }],
  ['a 4 px stroke with corners, half opaque', { fill: V('gold'), stroke: V('teal'), strokeWidth: V(4), cornerRadius: V(3), opacity: V(0.5) }],
  ['a dashed stroke and a stroke opacity', { fill: V('gold'), stroke: V('teal'), strokeWidth: V(3), strokeDash: V([4, 2]), strokeOpacity: V(0.7) }],
]
const FOREGROUND: Array<[string, Spec]> = [['stroked in front', { strokeForeground: V(true) }], ['stroked behind', { strokeForeground: V(false) }], ['stroked in front by a signal', { strokeForeground: { signal: 'front' } }]]
const SIGNALS = { signals: [{ name: 'front', value: true }] }

function update(kind: Kind, variant: Spec, fg: Spec): Spec {
  return { ...variant, ...fg, ...(kind === 'group mark' ? {} : SIZED) }
}

type VegaView = { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void; scenegraph(): { root: VItem } }
interface VItem { x?: number; y?: number; width?: number; height?: number; datum?: { index?: number }; marktype?: string; mark: { marktype: string; role: string; name?: string }; items?: VItem[] }

async function withVega<T>(spec: Spec, fn: (view: VegaView) => Promise<T> | T): Promise<T> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => VegaView }).View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  try { await view.runAsync(); return await fn(view) } finally { view.finalize() }
}

async function svgDifferences(spec: Spec): Promise<{ string: string[]; dom: string[] }> {
  const want = canonicalizeSvg(await withVega(spec, (v) => v.toSVG()))
  const scene = evaluateChart(compileChart(structuredClone(spec) as never))
  // (jsdom's serializer invents a prefix for the xlink namespace: the same attribute)
  const dom = new XMLSerializer().serializeToString(renderSceneToDomElement(scene, document) as unknown as Node)
    .replace(/ xmlns:ns\d+="http:\/\/www\.w3\.org\/1999\/xlink"/g, '').replace(/ ns\d+:href=/g, ' xlink:href=')
  return { string: diffCanonical(want, canonicalizeSvg(renderSceneToSvg(scene))), dom: diffCanonical(want, canonicalizeSvg(dom)) }
}

const BOX_STYLE = /^(gold|teal|#ffd700|#008080)$/i
/** The paints in order: a box's with its path, a run of anything else as one step (what the item holds). */
function sequence(painted: Painted[]): string[] {
  const out: string[] = []
  for (const p of painted) {
    if (BOX_STYLE.test(p.style) && p.op !== 'text') out.push(`${p.op} ${p.style} ${p.path}`)
    else if (out[out.length - 1] !== '…') out.push('…')
  }
  return out
}

/** Where vega's renderer puts the scene (its padding and the shift autosize makes) and the size of the view, from its SVG. */
async function frameOf(view: VegaView): Promise<{ ox: number; oy: number; w: number; h: number }> {
  const svg = await view.toSVG()
  const [, w, h] = /<svg[^>]*?\swidth="([^"]+)"[^>]*?\sheight="([^"]+)"/.exec(svg)!
  const [, ox, oy] = /<g[^>]*transform="translate\(([^,]+),([^)]+)\)"/.exec(svg)!
  return { ox: +ox!, oy: +oy!, w: +w!, h: +h! }
}

async function vegaCanvas(spec: Spec): Promise<string[]> {
  return withVega(spec, async (view) => {
    const { ctx, painted } = recorder()
    const { ox, oy } = await frameOf(view)
    ;(ctx as unknown as { translate(x: number, y: number): void }).translate(ox, oy)
    vegaDraw((vega as unknown as { Marks: Parameters<typeof vegaDraw>[0] }).Marks, ctx, (view.scenegraph() as unknown as { root: unknown }).root)
    return sequence(painted)
  })
}

function asterCanvas(spec: Spec): string[] {
  const { ctx, painted } = recorder()
  renderSceneToCanvas(evaluateChart(compileChart(structuredClone(spec) as never), {}), ctx)
  return sequence(painted)
}

/** What vega's pick finds, named as its role says (an entry, a symbol, a label: with the entry's index). */
function vegaKey(item: VItem | null): string {
  if (!item) return 'nothing'
  const role = item.mark.role
  if (item.mark.name) return `${item.mark.marktype}:${item.mark.name}`
  if (role === 'scope' || role === 'legend-symbol' || role === 'legend-label') return `${role === 'scope' ? 'entry' : role}:${item.datum?.index}`
  if (role === 'mark') return `${item.mark.marktype}:${item.mark.name}`
  return role
}

function asterKey(hit: { item: unknown; marktype?: string; kind?: string } | null): string {
  if (!hit) return 'nothing'
  // (the specs hold one named mark of each: the group mark \`g\`, the rect mark \`inner\` in it)
  if (hit.kind === 'group') return 'group:g'
  if (hit.kind === 'mark' && hit.marktype === 'rect') return 'rect:inner'
  const it = hit.item as { _part?: string; role?: string; datum?: { index?: number } }
  if (it._part === 'entry') return `entry:${it.datum?.index}`
  if (it._part === 'symbol') return `legend-symbol:${it.datum?.index}`
  if (it._part === 'label') return `legend-label:${it.datum?.index}`
  // (an axis's parts, as vega's roles name them)
  const AXIS_PARTS: Record<string, string> = { tick: 'axis-tick', domain: 'axis-domain', grid: 'axis-grid', label: 'axis-label', title: 'axis-title' }
  if (it._part !== undefined && AXIS_PARTS[it._part]) return AXIS_PARTS[it._part]!
  if (it.role === 'legend' || it.role === 'axis') return it.role
  if (hit.marktype === 'group' && it.role === 'title') return 'title'
  return `${hit.marktype}:${it.role}`
}

const GROUP_ROLE: Record<Kind, string> = { 'group mark': 'scope', axis: 'axis', legend: 'legend', 'legend entries': 'scope', title: 'title' }

/** The boxes (in view coordinates) of vega's group items of `kind`. */
function vegaBoxes(root: VItem, kind: Kind): Array<{ x: number; y: number; w: number; h: number }> {
  const out: Array<{ x: number; y: number; w: number; h: number }> = []
  const walk = (mark: VItem, ox: number, oy: number): void => {
    for (const it of mark.items ?? []) {
      const x = ox + (it.x ?? 0), y = oy + (it.y ?? 0)
      if (mark.marktype === 'group') {
        const m = mark as unknown as { role?: string; name?: string }
        if (kind === 'group mark' ? m.name === 'g' : m.role === GROUP_ROLE[kind] && m.name === undefined) out.push({ x, y, w: it.width ?? 0, h: it.height ?? 0 })
        for (const m of it.items ?? []) walk(m, x, y)
      }
    }
  }
  walk(root, 0, 0)
  return out
}

/** vega's canvas pick and Aster's canvas index at a grid of points over each box (none on an edge of the stroke, none at a corner). */
async function pickDifferences(spec: Spec, kind: Kind, sw: number): Promise<{ points: number; differ: string[] }> {
  const scene = evaluateChart(compileChart(structuredClone(spec) as never), {})
  const index = buildHitIndex(scene, undefined, { renderer: 'canvas' })
  return withVega(spec, async (view) => {
    const { ctx } = recorder()
    // (the renderer leaves the context moved to the scene's origin: vega's pick reads the paths it builds there)
    const frame = await frameOf(view)
    ;(ctx as unknown as { translate(x: number, y: number): void }).translate(frame.ox, frame.oy)
    const Marks = (vega as unknown as { Marks: Record<string, { pick(this: unknown, c: unknown, s: unknown, x: number, y: number, gx: number, gy: number): VItem | null }> }).Marks
    const handler = { pick(this: unknown, s: VItem, x: number, y: number, gx: number, gy: number): VItem | null { return Marks[s.marktype!]!.pick.call(handler, ctx, s, x, y, gx, gy) } }
    const root = (view.scenegraph() as unknown as { root: VItem }).root
    const boxes = vegaBoxes(root, kind)
    if (!boxes.length) throw new Error(`no ${kind} box in vega's scene`)
    const differ: string[] = []
    let points = 0
    const reach = sw / 2 + 1
    for (const box of boxes) {
      const b = { ...box, x: box.x + frame.ox, y: box.y + frame.oy }
      for (let px = Math.floor(b.x - reach - 1); px <= b.x + b.w + reach + 1; px++) {
        for (let py = Math.floor(b.y - reach - 1); py <= b.y + b.h + reach + 1; py++) {
          for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.6]] as const) {
            const x = px + fx, y = py + fy
            // (a join is drawn by the canvas's stroker, which the recording context does not imitate)
            const nearX = Math.min(Math.abs(x - b.x), Math.abs(x - b.x - b.w)) < reach + 3
            const nearY = Math.min(Math.abs(y - b.y), Math.abs(y - b.y - b.h)) < reach + 3
            if (nearX && nearY) continue
            // (a pointer is only ever over the view)
            if (x < 0 || y < 0 || x >= frame.w || y >= frame.h) continue
            points++
            const want = vegaKey(handler.pick(root, x, y, x - frame.ox, y - frame.oy))
            const got = asterKey(index.pick(x, y) as never)
            if (want !== got) differ.push(`vega ${want}, aster ${got} at (${x.toFixed(1)}, ${y.toFixed(1)})`)
          }
        }
      }
    }
    return { points, differ }
  })
}

describe('strokeForeground on group items vs vega', () => {
  for (const kind of KINDS) {
    for (const [variantName, variant] of VARIANTS) {
      for (const [fgName, fg] of FOREGROUND) {
        const spec = chart(kind, update(kind, variant, fg), false, SIGNALS)
        it(`${kind}, ${variantName}, ${fgName}: SVG (string and DOM)`, async () => {
          expect(await svgDifferences(spec)).toEqual({ string: [], dom: [] })
        })
        it(`${kind}, ${variantName}, ${fgName}: canvas`, async () => {
          const want = await vegaCanvas(spec)
          expect(want.some((s) => s.startsWith('stroke'))).toBe(true) // not vacuous
          expect(asterCanvas(spec)).toEqual(want)
        })
        it(`${kind}, ${variantName}, ${fgName}: the pick, every part interactive`, async () => {
          const sw = Number((variant.strokeWidth as { value: number }).value)
          const { points, differ } = await pickDifferences(chart(kind, update(kind, variant, fg), true, SIGNALS), kind, sw)
          expect(points).toBeGreaterThan(50) // not vacuous
          // (each kind of difference once, with the first point it was seen at, and how often)
          const kinds = new Map<string, number>()
          for (const d of differ) { const k = d.replace(/ at .*/, ''); kinds.set(k, (kinds.get(k) ?? 0) + 1) }
          expect([...kinds].map(([k, c]) => `${k}: ${c} points, first ${differ.find((d) => d.startsWith(k + ' at'))!.replace(/.* at /, 'at ')}`)).toEqual([])
        })
      }
    }
    it(`${kind}: the bounds of an item stroked in front size the view as vega's do`, async () => {
      for (const sw of [1, 3, 9]) {
        const spec = chart(kind, update(kind, { fill: V('gold'), stroke: V('teal'), strokeWidth: V(sw), strokeForeground: V(true) }, {}), false, { autosize: 'pad', padding: 0 })
        const size = (svg: string): string => /<svg[^>]*?\swidth="([^"]+)"[^>]*?\sheight="([^"]+)"/.exec(svg)!.slice(1).join(' x ')
        const want = size(await withVega(spec, (v) => v.toSVG()))
        expect(size(renderSceneToSvg(evaluateChart(compileChart(structuredClone(spec) as never))))).toBe(want)
      }
    })
  }
})
