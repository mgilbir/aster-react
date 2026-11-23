// @vitest-environment node
/**
 * `intersect(box, ...)` over nested groups, against vega-scenegraph's own `intersect` on the same spec.
 *
 * vega visits a group mark only if its bounds meet the box, and only then moves the box into the group's frame
 * (`box.translate(-x, -y)` ... `box.translate(x, y)`). That pair is not an exact inverse for a large x, so a walk that moves
 * the box into EVERY group, whether or not the group can hold a hit, leaves the box a few ulps off and loses the hits of the
 * siblings drawn after it (a group at x = 1e300 followed by a rect that the box covers: vega finds the rect, the unguarded
 * walk found nothing). The cases: groups at every magnitude (zero, ordinary, 2^53 and beyond, +-1e300, infinite, NaN), in
 * both mark orders, alone and nested inside another group at another magnitude, with boxes that meet the group and boxes
 * that miss it; the hits are compared by the fill each rect was given.
 *
 * A group's x of +-Infinity or NaN is written into the evaluated scene after the fact: the evaluator reads a group's non-finite
 * x or y as 0 (runtime.ts `buildGroupItem`), where vega keeps it (`translate(Infinity,0)`) -- a separate difference in the
 * group's geometry, not in the walk this file is about, so the walk is given the scene vega's spec describes.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { sceneIntersect } from '../../core/src/scene-intersect.js'

type Obj = Record<string, unknown>
/** A number as an encode entry; infinities are written as expressions (a spec is JSON, and a bare Infinity is not a value there). */
const num = (v: number): Obj => (v === Infinity ? { signal: '1/0' } : v === -Infinity ? { signal: '-1/0' } : { value: v })
const rect = (x: number, y: number, w: number, h: number, fill: string, name?: string): Obj => ({
  type: 'rect', ...(name ? { name } : {}),
  encode: { enter: { x: { value: x }, y: { value: y }, width: { value: w }, height: { value: h }, fill: { value: fill } } },
})
const group = (gx: number, gy: number, fill: string, marks: Obj[], w = 10, h = 10, name = 'g'): Obj => ({
  type: 'group', name,
  encode: { enter: { x: num(gx), y: num(gy), width: { value: w }, height: { value: h } } },
  marks: [rect(0, 0, 5, 5, fill), ...marks],
})

const MAGNITUDES = [0, 7, -30, 1e15, 2 ** 53, 1e16, 1e17, -1e17, 1e300, -1e300, 1.7976931348623157e308, Infinity, -Infinity, NaN]
const BOXES: number[][][] = [[[5, 5], [40, 40]], [[0, 0], [100, 100]], [[200, 200], [300, 300]], [[-5, -5], [2, 2]], [[8, 8], [12, 12]]]

function fillsOf(items: unknown[]): string[] {
  return items.map((i) => String((i as Obj).fill)).sort()
}

/** The spec for the engine under test, with every non-finite group x written as 0 (see the header), and those x per group name. */
function asterSpec(marks: Obj[], patches: Map<string, number>): Obj[] {
  const copy = structuredClone(marks)
  const visit = (ms: Obj[]): void => {
    for (const m of ms) {
      if (m.type !== 'group') continue
      const x = ((m.encode as Obj).enter as Obj).x as Obj
      if (typeof x.value === 'number' && !Number.isFinite(x.value)) { patches.set(String(m.name), x.value); x.value = 0 }
      else if (typeof x.signal === 'string') { patches.set(String(m.name), x.signal === '1/0' ? Infinity : -Infinity); x.value = 0; delete x.signal }
      visit((m.marks ?? []) as Obj[])
    }
  }
  visit(copy)
  return copy
}
function patchScene(node: Obj, patches: Map<string, number>): void {
  if (node.marktype === 'group' && typeof node.name === 'string' && patches.has(node.name)) node.x = patches.get(node.name)
  for (const c of (node.items ?? []) as Obj[]) if (c && typeof c === 'object') patchScene(c, patches)
}

async function both(marks: Obj[], box: number[][]): Promise<{ aster: string[]; vega: string[] }> {
  const spec = { width: 100, height: 100, padding: 0, autosize: 'none', marks }
  const patches = new Map<string, number>()
  const scene = evaluateChart(compileChart({ ...spec, marks: asterSpec(marks, patches) } as never), {}) as unknown as Obj
  patchScene(scene, patches)
  const aster = fillsOf(sceneIntersect(scene as never, box, null, null))
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  await view.runAsync()
  const bounds = new vega.Bounds().set(box[0]![0]!, box[0]![1]!, box[1]![0]!, box[1]![1]!)
  const got = fillsOf((vega as unknown as { intersect(scene: unknown, b: unknown): unknown[] }).intersect(view.scenegraph().root, bounds))
  view.finalize()
  return { aster, vega: got }
}

describe('intersect() over groups at any x, as vega-scenegraph walks them', () => {
  for (const gx of MAGNITUDES) {
    for (const groupFirst of [true, false]) {
      it(`group x=${gx}, ${groupFirst ? 'before' : 'after'} the sibling rect: the same hits for every box`, async () => {
        const g = group(gx, 0, '#0000ff', [])
        const sib = rect(10, 10, 20, 20, '#ff0000')
        const marks = groupFirst ? [g, sib] : [sib, g]
        for (const box of BOXES) {
          const { aster, vega: v } = await both(structuredClone(marks), box)
          expect(aster, `box ${JSON.stringify(box)}`).toEqual(v)
        }
      })
    }
  }

  it('groups nested in groups, at every pair of magnitudes, and a sibling after each', async () => {
    for (const outer of MAGNITUDES) {
      for (const inner of MAGNITUDES) {
        const marks = [
          group(outer, 0, '#00ff00', [group(inner, 0, '#0000ff', [rect(1, 1, 3, 3, '#ffff00')], 10, 10, 'inner')], 20, 20, 'outer'),
          rect(10, 10, 20, 20, '#ff0000'),
        ]
        for (const box of BOXES.slice(0, 3)) {
          const { aster, vega: v } = await both(structuredClone(marks), box)
          expect(aster, `outer ${outer} inner ${inner} box ${JSON.stringify(box)}`).toEqual(v)
        }
      }
    }
  })
})
