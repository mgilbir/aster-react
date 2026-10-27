import { describe, expect, it } from 'vitest'
import { buildHitIndex } from './hit.js'
import { evaluateChart } from './runtime.js'
import { compileChart } from './compiler.js'
import type { SceneRoot } from './types.js'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

describe('buildHitIndex', () => {
  it('resolves rect marks by containment', () => {
    const scene = {
      width: 100,
      height: 100,
      items: [{
        marktype: 'rect',
        items: [
          { x: 0, y: 0, width: 40, height: 40, fill: '#4c78a8', datum: { x: 'a' } },
          { x: 50, y: 0, width: 40, height: 40, fill: '#e45756', datum: { x: 'b' } },
        ],
      }],
    } as unknown as SceneRoot
    const index = buildHitIndex(scene)
    expect(index.query(20, 20)?.item.datum).toEqual({ x: 'a' })
    expect(index.query(70, 20)?.item.datum).toEqual({ x: 'b' })
    expect(index.query(45, 20)).toBeNull()
    expect(index.query(-5, 5)).toBeNull()
  })

  it('picks a group item where its painted box is -- the fill inside it, the stroke along it -- and no mark inside is hit (vega\'s group pick), but never as a data mark', () => {
    const cell = (x: number, extra: Record<string, unknown>): Record<string, unknown> => ({
      marktype: 'group', role: 'scope', _scope: true, x, y: 0, width: 50, height: 50, datum: { c: 'cell' }, ...extra,
      items: [{ marktype: 'symbol', items: [{ x: 25, y: 25, size: 100, fill: '#4c78a8', datum: { v: 1 } }] }],
    })
    const scene = { width: 180, height: 60, items: [cell(0, { stroke: '#ddd' }), cell(60, {}), cell(120, { fill: '#eee', interactive: false }), cell(180, { fill: '#eee' })] } as unknown as SceneRoot
    const index = buildHitIndex(scene)
    // a cell with a stroke and no fill: the stroke along its edge (half a stroke width outside the box too), not the inside
    expect(index.query(0.2, 25)?.marktype).toBe('group')
    expect(index.query(0.2, 25)?.item).toBe(scene.items[0])
    expect(index.query(50.4, 25)?.item).toBe(scene.items[0])
    expect(index.query(51, 25)).toBeNull()
    expect(index.query(5, 5)).toBeNull()
    // of the one with neither: nothing; of a non-interactive one: nothing
    expect(index.query(65, 5)).toBeNull()
    expect(index.query(125, 5)).toBeNull()
    // a cell with a fill: its whole box
    expect(index.query(185, 5)?.item).toBe(scene.items[3])
    // a mark inside the cell is picked over the cell
    expect(index.query(25, 25)?.item.datum).toEqual({ v: 1 })
    // the cell is no data mark (a tooltip or a click handler must not take it for one), and it is no indexed mark item
    expect(index.queryMark(0.2, 25)).toBeNull()
    expect(index.queryMark(185, 5)).toBeNull()
    expect(index.size()).toBe(4)
  })

  it('does not pick a mark that is not interactive, nor the guide parts that are not (their SVG containers say pointer-events none)', () => {
    const scene = {
      width: 100, height: 100,
      items: [
        { marktype: 'symbol', interactive: false, items: [{ x: 10, y: 10, size: 100, fill: '#4c78a8', datum: { v: 'inert' } }] },
        { marktype: 'symbol', items: [{ x: 50, y: 10, size: 100, fill: '#4c78a8', datum: { v: 'live' } }] },
        { marktype: 'group', role: 'axis', partMeta: { label: { interactive: false }, tick: { interactive: true } }, items: [
          { _part: 'label', text: 'a', x: 10, y: 60, fill: '#000', fontSize: 10 },
          { _part: 'tick', shape: 'circle', radius: 3, x: 50, y: 60 },
        ] },
      ],
    } as unknown as SceneRoot
    const index = buildHitIndex(scene)
    // pick(): vega's event.item. It looks through what is not interactive and finds the interactive guide parts
    expect(index.pick(10, 10)).toBeNull()
    expect(index.pick(50, 10)?.item.datum).toEqual({ v: 'live' })
    expect(index.pick(10, 60)).toBeNull()
    expect(index.pick(50, 60)?.item._part).toBe('tick')
    // queryMark() (tooltips, point selection) never reports an inert mark, as the svg's pointer-events: none; query() still paints them
    expect(index.queryMark(10, 10)).toBeNull()
    expect(index.queryMark(50, 10)?.item.datum).toEqual({ v: 'live' })
    expect(index.query(10, 10)?.item.datum).toEqual({ v: 'inert' })
  })

  it('picks a rect along its stroke -- half a stroke width outside its box -- and a rect with no fill only there', () => {
    const scene = {
      width: 200, height: 100,
      items: [{
        marktype: 'rect',
        items: [
          { x: 10, y: 10, width: 40, height: 40, fill: '#333', stroke: '#fff', strokeWidth: 4, datum: { r: 'filled' } },
          { x: 100, y: 10, width: 40, height: 40, stroke: '#000', strokeWidth: 4, datum: { r: 'hollow' } },
        ],
      }],
    } as unknown as SceneRoot
    const index = buildHitIndex(scene)
    // the fill and 2px of stroke outside the box, but no further
    expect(index.query(30, 30)?.item.datum).toEqual({ r: 'filled' })
    expect(index.query(8.5, 30)?.item.datum).toEqual({ r: 'filled' })
    expect(index.query(7.5, 30)).toBeNull()
    expect(index.query(52.5, 30)).toBeNull()
    expect(index.query(51.5, 30)?.item.datum).toEqual({ r: 'filled' })
    // no fill: the stroke ring only, not the inside
    expect(index.query(101, 30)?.item.datum).toEqual({ r: 'hollow' })
    expect(index.query(120, 30)).toBeNull()
    expect(index.query(98.5, 30)?.item.datum).toEqual({ r: 'hollow' })
    expect(index.query(97.5, 30)).toBeNull()
  })

  it('resolves symbols within radius + slack', () => {
    const scene = {
      width: 100,
      height: 100,
      items: [{
        marktype: 'symbol',
        items: [
          { x: 50, y: 50, size: 100, fill: '#4c78a8', datum: { v: 1 } },
        ],
      }],
    } as unknown as SceneRoot
    const index = buildHitIndex(scene)
    expect(index.query(50, 50)?.item.datum).toEqual({ v: 1 })
    // r = sqrt(100)/2 = 5; + strokeWidth/2 + 2 = 7.5
    expect(index.query(56, 50)?.item.datum).toEqual({ v: 1 })
    expect(index.query(60, 50)).toBeNull()
  })

  it('resolves rules by distance to the segment', () => {
    const scene = {
      width: 100,
      height: 100,
      items: [{
        marktype: 'rule',
        items: [{ x: 0, y: 50, x2: 100, y2: 50, stroke: '#888', datum: { axis: 'y' } }],
      }],
    } as unknown as SceneRoot
    const index = buildHitIndex(scene)
    expect(index.query(50, 51)?.item.datum).toEqual({ axis: 'y' })
    expect(index.query(50, 60)).toBeNull()
  })

  it('respects paint order on overlap (rects paint in item order: the last item is on top)', () => {
    const scene = {
      width: 100,
      height: 100,
      items: [{
        marktype: 'rect',
        items: [
          { x: 0, y: 0, width: 40, height: 40, fill: '#4c78a8', datum: { n: 1 } },
          { x: 10, y: 10, width: 40, height: 40, fill: '#e45756', datum: { n: 2 } },
        ],
      }],
    } as unknown as SceneRoot
    const index = buildHitIndex(scene)
    // Every renderer paints rect items in item (data) order, like vega: the last one lands on top.
    expect(index.query(20, 20)?.item.datum).toEqual({ n: 2 })
    expect(index.query(45, 45)?.item.datum).toEqual({ n: 2 })
    expect(index.query(5, 5)?.item.datum).toEqual({ n: 1 })
  })

  it('skips unpainted rect items', () => {
    const scene = {
      width: 100,
      height: 100,
      items: [{ marktype: 'rect', items: [{ x: 0, y: 0, width: 10, height: 10 }] }],
    } as unknown as SceneRoot
    const index = buildHitIndex(scene)
    expect(index.size()).toBe(0)
    expect(index.query(5, 5)).toBeNull()
  })

  it('grid and linear modes agree across the vega corpus', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../conformance/corpus')
    let names: string[]
    try {
      names = readdirSync(dir).filter((f) => f.endsWith('.vg.json'))
    } catch {
      names = []
    }
    expect(names.length).toBeGreaterThan(250)
    let checked = 0
    let hitCount = 0
    for (const name of names) {
      const doc = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      const spec = doc.spec ?? doc
      let scene: SceneRoot
      try {
        scene = evaluateChart(compileChart(spec), {})
      } catch {
        continue
      }
      const index = buildHitIndex(scene)
      if (index.size() === 0) continue
      checked++
      // probe a deterministic lattice; both code paths must agree exactly
      for (let i = 0; i < 12; i++) {
        const x = ((i * 37) % Math.max(1, scene.width)) + 0.5
        const y = ((i * 53) % Math.max(1, scene.height)) + 0.5
        // force each mode: rebuild with a huge cell (linear) vs default (grid)
        const linear = buildHitIndex(scene, 1e9).query(x, y)
        const auto = index.query(x, y)
        const linKey = linear ? JSON.stringify(linear.item.datum ?? linear.marktype) : 'null'
        const autoKey = auto ? JSON.stringify(auto.item.datum ?? auto.marktype) : 'null'
        expect(autoKey).toBe(linKey)
        if (auto != null) hitCount++
      }
    }
    expect(checked).toBeGreaterThan(100)
    expect(hitCount).toBeGreaterThan(50)
  })
})
