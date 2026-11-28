/**
 * The scene differential compares what is inside group marks too (audit C62): every planted difference below, made in Aster's
 * scene of a spec whose marks sit inside a group mark or a facet, is reported, and the items it compares are counted.
 */
import { describe, expect, it } from 'vitest'
import type { SceneNode, SceneRoot } from '@aster-charts/core'
import { sceneDiff } from './scene-diff.js'

type Spec = Record<string, unknown>
const base = { width: 200, height: 100, padding: 5, autosize: 'none' }
const rect = (fill: string, x: number, extra: Spec = {}): Spec => ({ type: 'rect', encode: { update: { x: { value: x }, y: { value: 0 }, width: { value: 60 }, height: { value: 40 }, fill: { value: fill } } }, ...extra })
const symbol = (x: number): Spec => ({ type: 'symbol', encode: { update: { x: { value: x }, y: { value: 50 }, size: { value: 80 }, fill: { value: 'green' } } } })
const rows = [{ k: 'a', v: 10 }, { k: 'b', v: 50 }, { k: 'c', v: 90 }]

const SPECS: Record<string, Spec> = {
  'top-level marks': { ...base, marks: [rect('red', 0), symbol(30)] },
  'marks inside a group mark': { ...base, marks: [{ type: 'group', encode: { update: { x: { value: 5 } } }, marks: [rect('red', 0), symbol(30)] }] },
  'a facet of 3 cells': {
    ...base, data: [{ name: 't', values: rows }],
    marks: [{ type: 'group', from: { facet: { name: 'f', data: 't', groupby: 'k' } }, encode: { update: { x: { field: 'v' } } }, marks: [{ type: 'rect', from: { data: 'f' }, encode: { update: { x: { value: 0 }, y: { field: 'v' }, width: { value: 5 }, height: { value: 5 }, fill: { value: 'red' } } } }, symbol(3)] }],
  },
  'a group inside a group': { ...base, marks: [{ type: 'group', marks: [{ type: 'group', encode: { update: { x: { value: 7 } } }, marks: [rect('red', 0), symbol(30)] }] }] },
}

/** Every leaf item of Aster's scene, depth first, with the mark node that holds it. */
function leaves(scene: SceneRoot): Array<{ item: Record<string, unknown>; mark: { marktype?: string; items?: SceneNode[] } }> {
  const out: Array<{ item: Record<string, unknown>; mark: { marktype?: string; items?: SceneNode[] } }> = []
  const walk = (nodes: readonly SceneNode[]): void => {
    for (const n of nodes) {
      const g = n as unknown as { marktype?: string; items?: SceneNode[]; _bg?: boolean }
      if (g.marktype && g.marktype !== 'group' && Array.isArray(g.items)) for (const it of g.items) out.push({ item: it as unknown as Record<string, unknown>, mark: g })
      else if (Array.isArray(g.items)) walk(g.items)
    }
  }
  walk(scene.items)
  return out
}

const PLANTS: Array<[string, (scene: SceneRoot) => void]> = [
  ['a moved item', (scene) => { (leaves(scene).at(-1)!.item as { x: number }).x += 7 }],
  ['a recoloured item', (scene) => { leaves(scene).at(-1)!.item.fill = 'purple' }],
  ['a channel only Aster has (zindex)', (scene) => { leaves(scene).at(-1)!.item.zindex = 3 }],
  ['a dropped item', (scene) => { const { mark } = leaves(scene).at(-1)!; mark.items = mark.items!.slice(0, -1) }],
  ['two marks of different types painted in the other order', (scene) => {
    const walk = (nodes: SceneNode[]): boolean => {
      const i = nodes.findIndex((n) => (n as { marktype?: string }).marktype === 'rect')
      const j = nodes.findIndex((n) => (n as { marktype?: string }).marktype === 'symbol')
      if (i >= 0 && j >= 0) { [nodes[i], nodes[j]] = [nodes[j]!, nodes[i]!]; return true }
      return nodes.some((n) => Array.isArray((n as { items?: SceneNode[] }).items) && walk((n as { items: SceneNode[] }).items))
    }
    walk(scene.items as SceneNode[])
  }],
  ['a mark Aster lacks', (scene) => {
    const walk = (nodes: SceneNode[]): boolean => {
      const j = nodes.findIndex((n) => (n as { marktype?: string }).marktype === 'symbol')
      if (j >= 0) { nodes.splice(j, 1); return true }
      return nodes.some((n) => Array.isArray((n as { items?: SceneNode[] }).items) && walk((n as { items: SceneNode[] }).items))
    }
    walk(scene.items as SceneNode[])
  }],
]

describe('scene-diff compares marks at every depth (C62)', () => {
  for (const [name, spec] of Object.entries(SPECS)) {
    it(`${name}: agrees, and compares every item vega drew`, async () => {
      const r = await sceneDiff(structuredClone(spec))
      expect(r.diffs).toEqual([])
      expect(r.oracleItems).toBeGreaterThan(0)
      expect(r.items).toBe(r.oracleItems)
      expect(r.attributes).toBeGreaterThan(r.items)
    })
    for (const [plant, adjust] of PLANTS) {
      it(`${name}: ${plant} is reported`, async () => {
        const r = await sceneDiff(structuredClone(spec), adjust)
        expect(r.diffs.length, plant).toBeGreaterThan(0)
      })
    }
  }

  it('a scale only one side of a group item has is reported', async () => {
    const spec = { ...base, marks: [{ type: 'group', scales: [{ name: 'inner', type: 'linear', domain: [0, 1], range: [0, 10] }], marks: [rect('red', 0)] }] }
    const r = await sceneDiff(structuredClone(spec), (scene) => {
      const g = scene.items.find((n) => (n as { marktype?: string }).marktype === 'group') as unknown as { __scales?: unknown[] }
      g.__scales = []
    })
    expect(r.diffs.join('\n')).toMatch(/scale inner: missing in ours/)
  })
})
