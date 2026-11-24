/**
 * (The comparisons of `geometry-vs-vega.test.ts`, shared with scratch drivers that list every difference.)
 *
 * Mark geometry against real vega (vega-scenegraph 5.2.1 in the pinned vega 6.3.1), in this process: the bounds of every item and
 * every mark, the size and origin of the view they decide, and `intersect()`. The reference is vega's own code on the same input,
 * never another copy of Aster's: so a defect Aster's modules share with each other is a difference here.
 *
 * - Hand-built items of every mark type (`genItem`): vega's mark `bound` against Aster's `itemBounds`, bit for bit, edges that are
 *   not numbers included (vega's arithmetic on a channel that is a string leaves strings in its box, and so must Aster's).
 * - Generated specs (`genGeometrySpec`) through vega's View and Aster's evaluator: the bounds vega's bounds pass leaves on every item,
 *   every mark and every group item against Aster's, the view's size and origin (autosize reads the bounds), and `intersect()` over
 *   boxes of every size by every filter, vega's expression function on vega's scenegraph against Aster's on Aster's scene. Items are
 *   named by their place (`geometry-keys.ts`).
 *
 * Without a canvas, vega's `intersect` takes an arc's, a path's or a shape's bounds for its outline, and so does Aster's: their
 * outlines against a box are compared in Chromium (`pnpm conformance:geometry`), with the pick.
 */
import * as vega from 'vega'
import { compileChart } from '../../core/src/compiler.js'
import { evaluateChart } from '../../core/src/evaluate.js'
import { renderSceneToSvg } from '../../core/src/render.js'
import { Bounds, boundGroupItem, boundTypedMark, itemBounds, multiMarkBounds } from '../../core/src/bounds.js'
import { sceneIntersect } from '../../core/src/scene-intersect.js'
import type { SceneGroup, SceneItem, SceneRoot } from '../../core/src/types.js'
import { MARK_TYPES, genGeometrySpec, genItem, rng } from './geometry-specs.js'
import { asterPlaces, boxText, nameOf, sameBox, vegaPlaces, type AsterNode, type VegaNode } from './geometry-keys.js'

type Spec = Record<string, unknown>
type Box = { x1: number; y1: number; x2: number; y2: number }
export const V = vega as unknown as {
  Marks: Record<string, { bound(b: unknown, item: unknown): Box }>
  Bounds: new () => Box & { set(a: number, b: number, c: number, d: number): unknown }
  View: new (rt: unknown, o: unknown) => VegaView
  SVGStringRenderer: new () => { initialize(el: null, w: number, h: number, origin: [number, number]): { render(root: unknown): unknown } }
  parse(spec: unknown): unknown
  expressionFunction(name: string): (this: unknown, ...a: unknown[]) => VegaNode[]
}
interface VegaView { runAsync(): Promise<unknown>; scenegraph(): { root: VegaNode }; finalize(): void }

/**
 * What vega's renderer cannot draw, where vega's view throws: the one class the generated specs reach (a trail point of negative
 * width: d3-path's `arc` refuses a negative radius). Aster draws these (ARCHITECTURE.md, "Deviations from Vega": oracle crashes are
 * not reproduced); a vega failure of any other kind fails the test.
 */
const VEGA_CRASHES = [/^negative radius: /]

const silent = (errors: string[]): object => ({
  level() { return this }, error(...a: unknown[]) { errors.push(a.map(String).join(' ')); return this }, warn() { return this }, info() { return this }, debug() { return this },
})

/**
 * vega's view of `spec`, run, and the frame its renderer would draw it in (the size of the document and the translate of its
 * content: vega-view render-size.js). Its SVG is rendered once, synchronously, to find what vega's renderer cannot draw.
 */
async function vegaView(spec: Spec): Promise<{ view: VegaView; frame: string } | { crash: string }> {
  const errors: string[] = []
  const view = new V.View(V.parse(structuredClone(spec)), { renderer: 'none', logger: silent(errors) })
  let renderer: { _ready?: Promise<unknown> } | undefined
  try {
    await view.runAsync()
    if (errors.length) throw new Error(errors[0])
    const v = view as unknown as { _viewWidth: number; _viewHeight: number; _origin: [number, number]; padding(): { left: number; right: number; top: number; bottom: number } }
    const p = v.padding()
    const w = Math.max(0, v._viewWidth + p.left + p.right)
    const h = Math.max(0, v._viewHeight + p.top + p.bottom)
    const origin: [number, number] = [p.left + v._origin[0], p.top + v._origin[1]]
    // (an image loaded later draws the scene again: its failure is the renderer's too)
    const r = new V.SVGStringRenderer().initialize(null, w, h, origin) as unknown as { render(root: unknown): unknown; _ready?: Promise<unknown> }
    renderer = r
    r.render(view.scenegraph().root)
    if (renderer._ready) await renderer._ready
    return { view, frame: `${w}x${h} at ${origin[0]},${origin[1]}` }
  } catch (e) {
    // (the redraw an image load schedules fails the same way: the failure is recorded once, here)
    renderer?._ready?.catch(() => undefined)
    view.finalize()
    return { crash: (e as Error).message }
  }
}

/** The view's size and the translate of its content, from Aster's SVG document. */
const frameOf = (svg: string): string => {
  const size = /<svg[^>]*?\swidth="([^"]+)"[^>]*?\sheight="([^"]+)"/.exec(svg)
  const origin = /<g[^>]*transform="translate\(([^)]+)\)"/.exec(svg)
  return `${size?.[1]}x${size?.[2]} at ${origin?.[1]}`
}

export interface Counts { specs: number; crashes: number; items: number; marks: number; groups: number; boxes: number; hits: number; refused: number }

/** The bounds Aster gives what vega names `place` in its scene, as vega's bounds pass leaves them. */
function asterBoundsOf(place: string, node: AsterNode, A: Map<string, AsterNode>, scene: SceneRoot, vegaNode: VegaNode): Box {
  const isMark = vegaNode.marktype !== undefined
  if (!isMark) {
    const type = vegaNode.mark!.marktype!
    if (type === 'group') return boundGroupItem(new Bounds(), node as unknown as SceneGroup)
    if (type === 'line' || type === 'area' || type === 'trail') {
      // (each item of a line, an area or a trail holds a copy of its mark's bounds)
      const mark = A.get(place.slice(0, place.lastIndexOf('[')))!
      // (each item of a line, an area or a trail holds a copy of its mark's bounds, taken before the mark's clip cuts the mark's own)
      return new Bounds().union(multiMarkBounds(mark as unknown as SceneGroup))
    }
    return itemBounds(new Bounds(), type, node as unknown as SceneItem)
  }
  let b: Bounds
  if (node.marktype === 'group') {
    b = new Bounds()
    for (const g of node.items ?? []) b.union(boundGroupItem(new Bounds(), g as unknown as SceneGroup))
  } else if (node.marktype === 'line' || node.marktype === 'area' || node.marktype === 'trail') b = multiMarkBounds(node as unknown as SceneGroup)
  else b = boundTypedMark(new Bounds(), node as unknown as SceneGroup)
  return clipped(place, b, A, scene, vegaNode)
}

/** vega's `boundClip`: a mark that clips has its bounds cut to the frame of the group around it, as that group's width and height are. */
function clipped(place: string, b: Bounds, A: Map<string, AsterNode>, scene: SceneRoot, vegaMark: VegaNode): Bounds {
  if (!vegaMark.clip) return b
  const parent = place.slice(0, place.lastIndexOf('/'))
  const group = parent ? (A.get(parent) as { width?: number; height?: number }) : { width: scene.plotWidth, height: scene.plotHeight }
  return b.intersect(new Bounds().set(0, 0, group.width as number, group.height as number))
}

export async function compareSpec(seed: number, counts: Counts, diffs: string[]): Promise<void> {
  const { spec } = genGeometrySpec(seed)
  // `intersect()` through vega's own expression function, on its scenegraph (vega-functions' `intersect`)
  const vegaIntersect = V.expressionFunction('intersect')
  const ran = await vegaView(spec)
  if ('crash' in ran) {
    if (!VEGA_CRASHES.some((re) => re.test(ran.crash))) diffs.push(`seed ${seed}: vega failed with an error no deviation lists: ${ran.crash}`)
    else {
      counts.crashes++
      // (Aster draws it, or fails with vega's error: anything else is a difference)
      try { renderSceneToSvg(evaluateChart(compileChart(structuredClone(spec) as never), {})) } catch (e) {
        if ((e as Error).message !== ran.crash) diffs.push(`seed ${seed}: vega failed with "${ran.crash}", Aster with "${(e as Error).message}"`)
      }
    }
    return
  }
  const { view, frame } = ran
  try {
    const scene = evaluateChart(compileChart(structuredClone(spec) as never), {})
    counts.specs++
    const root = view.scenegraph().root
    const vplaces = vegaPlaces(root.items![0]!)
    const { places: aplaces, unknown } = asterPlaces(scene as unknown as { items: unknown[] })
    for (const u of unknown) diffs.push(`seed ${seed}: a node of Aster's scene with no place: ${u}`)
    for (const [place, v] of vplaces) {
      const a = aplaces.get(place)
      if (a === undefined) { diffs.push(`seed ${seed} ${place}: in vega's scene, not in Aster's`); continue }
      if (v.marktype !== undefined && (v.items?.length ?? 0) !== (a.items?.length ?? 0)) { diffs.push(`seed ${seed} ${place}: ${v.items?.length} items in vega's, ${a.items?.length} in Aster's`); continue }
      const got = asterBoundsOf(place, a, aplaces, scene, v)
      if (v.marktype !== undefined) counts.marks++
      else if (v.mark!.marktype === 'group') counts.groups++
      else counts.items++
      if (!sameBox(v.bounds!, got)) diffs.push(`seed ${seed} ${place} (${v.marktype ?? v.mark!.marktype}${v.marktype ? ' mark' : ''}): vega ${boxText(v.bounds!)} aster ${boxText(got)}`)
    }
    for (const place of aplaces.keys()) if (!vplaces.has(place)) diffs.push(`seed ${seed} ${place}: in Aster's scene, not in vega's`)
    const have = frameOf(renderSceneToSvg(scene))
    if (frame !== have) diffs.push(`seed ${seed}: the view is ${frame} in vega, ${have} in Aster`)

    // intersect(): boxes from a point to a box over the view, by every filter, over the whole scene and from each group item
    // (the root group item is vega's root.items[0]; Aster's `intersect` stands a fresh object in for it, holding the scene's marks)
    const vname = nameOf(vplaces as Map<string, object>)
    vname.set(root.items![0]!, '(root)')
    const aname = nameOf(aplaces as Map<string, object>)
    const anameOf = (it: Record<string, unknown>): string | undefined => aname.get(it) ?? (it.items === scene.items ? '(root)' : undefined)
    const R = rng(seed * 7 + 3)
    const names = [...vplaces.keys()].filter((p) => (vplaces.get(p)!.marktype ?? '') !== '').map((p) => vplaces.get(p)!.name!)
    const filters: Array<Record<string, unknown> | null> = [null, { marktype: 'group' }, ...MARK_TYPES.filter(() => R() < 0.3).map((t) => ({ marktype: t })), ...names.filter(() => R() < 0.4).map((n) => ({ markname: n }))]
    for (let k = 0; k < 10; k++) {
      const x = R() * 330 - 15, y = R() * 230 - 15
      const w = [0, 2, 20, 80, 200][Math.floor(R() * 5)]!, h = [0, 2, 20, 80, 200][Math.floor(R() * 5)]!
      const box = R() < 0.2 ? [[x + w, y + h], [x, y]] : [[x, y], [x + w, y + h]]
      for (const opt of filters) {
        {
          counts.boxes++
          let want: string
          try {
            want = vegaIntersect.call({ context: { dataflow: view } }, box, opt, undefined).map((it) => vname.get(it) ?? `(vega: ${it.mark?.marktype} ${it.mark?.name})`).join(' ')
          } catch (e) { want = `throws ${(e as Error).message}` }
          let got: string
          try {
            got = sceneIntersect(scene, box, opt, undefined).map((it) => anameOf(it as Record<string, unknown>) ?? `(aster: an item with no place)`).join(' ')
          } catch (e) {
            // (a region of more lattice points than the built-in ceiling allows is refused, where vega walks them all or never ends:
            // a safety deviation, LIMITS.md; vega without a canvas answers it by the bounds, so it is not a difference here)
            if ((e as { name?: string }).name === 'AsterLimitError' && /intersect\(\) lattice tests/.test((e as Error).message)) { counts.refused++; continue }
            got = `throws ${(e as Error).message}`
          }
          if (want !== '' && !want.startsWith('throws')) counts.hits++
          // (an arc's, a path's or a shape's outline against the box is a canvas's question: vega without one -- here -- answers it
          // with the item's bounds, a superset of the outline's answer, which Aster gives. Those items are compared in Chromium
          // (`pnpm conformance:geometry`); here Aster's must be among vega's, in vega's order, and every other item exactly)
          const outlined = (name: string): boolean => /^(arc|path|shape)$/.test(vplaces.get(name)?.mark?.marktype ?? '')
          const wantList = want.startsWith('throws') ? null : want.split(' ').filter(Boolean)
          const gotList = got.startsWith('throws') ? null : got.split(' ').filter(Boolean)
          const same = wantList === null || gotList === null ? want === got
            : wantList.filter((n) => !outlined(n)).join(' ') === gotList.filter((n) => !outlined(n)).join(' ')
              && gotList.filter(outlined).every((n) => wantList.includes(n))
              && gotList.join(' ') === wantList.filter((n) => !outlined(n) || gotList.includes(n)).join(' ')
          if (!same) diffs.push(`seed ${seed}: intersect(${JSON.stringify(box)}, ${JSON.stringify(opt)}): vega [${want}] aster [${got}]`)
        }
      }
    }
  } finally {
    view.finalize()
  }
}

