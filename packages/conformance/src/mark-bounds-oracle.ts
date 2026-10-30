/**
 * Scenegraph bounds against real vega, for the differential tests: the bounds vega's Bound pass leaves on every item of every
 * typed mark (and on the mark itself, which is what a line, area or trail item shares), against the bounds the engine measures
 * for the same mark of its own scene.
 */
import * as vega from 'vega'
import { compileChart, evaluateChart, type SceneGroup, type SceneItem } from '@aster/core'
import { Bounds, boundGroupItem, boundTypedMark } from '../../core/src/bounds.js'

type Box = [number, number, number, number]
interface VegaNode { marktype?: string; role?: string; items?: VegaNode[]; bounds?: { x1: number; y1: number; x2: number; y2: number } }

const boxOf = (b: { x1: number; y1: number; x2: number; y2: number }): Box => [b.x1, b.y1, b.x2, b.y2]
const same = (a: number, b: number, tol: number): boolean => a === b || (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b))
const fmt = (b: Box): string => `[${b.map((v) => Number(v.toPrecision(12))).join(', ')}]`

export interface BoundsReport { diffs: string[]; marks: number; items: number }

function typedMarks(node: VegaNode | SceneGroup, out: Array<VegaNode | SceneGroup>): void {
  const n = node as VegaNode
  if (n.marktype && n.role === 'mark') out.push(node)
  for (const c of n.items ?? []) typedMarks(c as VegaNode, out)
}

/** Vega's bounds against the engine's, mark by mark and item by item, over every typed mark of the spec (guides excluded). */
export async function compareBounds(spec: Record<string, unknown>, tol = 1e-9): Promise<BoundsReport & { viewSize: [number, number] }> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<unknown>; scenegraph(): { root: VegaNode }; finalize(): void; width(): number; height(): number } }).View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  const diffs: string[] = []
  let marks = 0
  let items = 0
  try {
    await view.runAsync()
    const theirs: VegaNode[] = []
    typedMarks(view.scenegraph().root, theirs as never)
    const scene = evaluateChart(compileChart(structuredClone(spec) as never), {})
    const ours: SceneGroup[] = []
    typedMarks(scene as unknown as SceneGroup, ours as never)
    if (theirs.length !== ours.length) return { diffs: [`${theirs.length} vega marks, ${ours.length} engine`], marks, items, viewSize: [0, 0] }
    theirs.forEach((vm, mi) => {
      const om = ours[mi]!
      marks++
      const label = `${vm.marktype}#${mi}`
      if (vm.marktype === 'group') {
        // (a group item's bounds hold its children's, its frame and its stroke)
        const vgroups = vm.items ?? []
        const ogroups = (om.items ?? []) as unknown as SceneGroup[]
        if (vgroups.length !== ogroups.length) { diffs.push(`${label}: ${vgroups.length} vega items, ${ogroups.length} engine`); return }
        vgroups.forEach((vit, ii) => {
          items++
          const g = boundGroupItem(new Bounds(), ogroups[ii]!)
          const got: Box = [g.x1, g.y1, g.x2, g.y2]
          const want = boxOf(vit.bounds!)
          if (want.some((v, i) => !same(v, got[i]!, tol))) diffs.push(`${label} item ${ii}: vega ${fmt(want)} engine ${fmt(got)}`)
        })
        return
      }
      const shared = vm.marktype === 'line' || vm.marktype === 'area' || vm.marktype === 'trail'
      const mine = boundTypedMark(new Bounds(), om)
      const mineBox: Box = [mine.x1, mine.y1, mine.x2, mine.y2]
      const vitems = vm.items ?? []
      const oitems = (om.items ?? []) as SceneItem[]
      if (vitems.length !== oitems.length) { diffs.push(`${label}: ${vitems.length} vega items, ${oitems.length} engine`); return }
      if (vitems.length && vitems[0]!.bounds) {
        const markBox = vitems.reduce<Box | null>((acc, it) => {
          const b = it.bounds ? boxOf(it.bounds) : null
          if (!b) return acc
          return acc ? [Math.min(acc[0], b[0]), Math.min(acc[1], b[1]), Math.max(acc[2], b[2]), Math.max(acc[3], b[3])] : b
        }, null)!
        if (markBox.some((v, i) => !same(v, mineBox[i]!, tol))) diffs.push(`${label}: mark bounds vega ${fmt(markBox)} engine ${fmt(mineBox)}`)
      }
      if (vm.marktype === 'text') {
        // (the channels a polar text item is placed by stay on the item, as encoded)
        vitems.forEach((vit, ii) => {
          for (const k of ['x', 'y', 'radius', 'theta']) {
            const w = (vit as unknown as Record<string, unknown>)[k]
            const g = (oitems[ii] as Record<string, unknown>)[k]
            if (!(w === g || (typeof w === 'number' && typeof g === 'number' && same(w, g, tol)))) diffs.push(`${label} item ${ii}: ${k} vega ${String(w)} engine ${String(g)}`)
          }
        })
      }
      if (shared) return
      vitems.forEach((vit, ii) => {
        items++
        const b = new Bounds()
        boundTypedMark(b, { marktype: om.marktype, items: [oitems[ii]!] } as unknown as SceneGroup)
        const got: Box = [b.x1, b.y1, b.x2, b.y2]
        if (!vit.bounds) return
        const want = boxOf(vit.bounds)
        if (want.some((v, i) => !same(v, got[i]!, tol))) diffs.push(`${label} item ${ii}: vega ${fmt(want)} engine ${fmt(got)}`)
      })
    })
    return { diffs, marks, items, viewSize: [view.width(), view.height()] }
  } finally {
    view.finalize()
  }
}
