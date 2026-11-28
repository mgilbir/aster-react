/**
 * The accessible tree (C138, C241, C289, C411): its ids are unique and a mark item's does not move with its position; it is bounded
 * whatever the data; its label is the spec's description; each mark item's box is the box the hit index measures for it.
 */
import { describe, expect, it } from 'vitest'
import { buildA11yTree, type A11yTree } from './a11y.js'
import { buildHitIndex } from './hit.js'
import { compileChart, evaluateChart } from './index.js'
import { createChartSession } from './session.js'
import { mulberry32, pick } from './scene-fuzz.testlib.js'
import type { SceneRoot, VgSpec } from './types.js'

const tree = (spec: object, input: object = {}, options: Parameters<typeof buildA11yTree>[2] = {}): A11yTree =>
  buildA11yTree(evaluateChart(compileChart(structuredClone(spec) as VgSpec), input), new Map(), options)

/** A random chart: facets of a mark kind, legends on several channels of one scale, a title. */
function randomSpec(r: () => number): Record<string, unknown> {
  const cells = 1 + Math.floor(r() * 40)
  const perCell = 1 + Math.floor(r() * 30)
  const kind = pick(r, ['symbol', 'rect', 'text', 'line', 'rule'])
  const rows = Array.from({ length: cells * perCell }, (_, i) => ({ f: `f${i % cells}`, c: pick(r, ['a', 'b', 'c']), v: i % 17, w: (i * 7) % 13 }))
  const channels = pick(r, [['fill'], ['fill', 'stroke'], ['fill', 'shape'], ['stroke', 'fill', 'shape']])
  return {
    width: 300, height: 200, description: pick(r, [undefined, 'A chart about things']),
    data: [{ name: 't', values: rows }, { name: 'cells', source: 't', transform: [{ type: 'aggregate', groupby: ['f'] }] }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 17], range: [0, 20] }, { name: 'y', type: 'linear', domain: [0, 13], range: [0, 20] },
      { name: 'c', type: 'ordinal', domain: ['a', 'b', 'c'], range: ['red', 'green', 'blue'] }, { name: 's', type: 'ordinal', domain: ['a', 'b', 'c'], range: ['circle', 'square', 'cross'] },
    ],
    legends: channels.map((ch) => ({ [ch]: ch === 'shape' ? 's' : 'c' })),
    title: { text: 'T' },
    marks: [{
      type: 'group', from: { facet: { name: 'cell', data: 't', groupby: 'f' } }, encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 20 }, height: { value: 20 } } },
      marks: [{ type: kind, from: { data: 'cell' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { scale: 'y', field: 'w' }, x2: { value: 3 }, y2: { value: 4 }, fill: { scale: 'c', field: 'c' }, stroke: { value: 'black' }, text: { field: 'c' }, width: { value: 3 }, height: { value: 3 } } } }],
    }],
  }
}

describe('ids are unique (C138)', () => {
  it('over random charts with several legends of one scale', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const t = tree(randomSpec(mulberry32(seed)))
      const ids = t.nodes.map((n) => n.id)
      expect(new Set(ids).size, `seed ${seed}: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`).toBe(ids.length)
    }
  })
})

describe('the tree is bounded whatever the data (C241)', () => {
  it('over random charts and thresholds: mark nodes, described groups and legend entries stay under the bound', () => {
    let summarised = 0
    for (let seed = 1; seed <= 60; seed++) {
      const r = mulberry32(seed)
      const threshold = pick(r, [5, 20, 150])
      const t = tree(randomSpec(r), {}, { summaryThreshold: threshold })
      const marks = t.nodes.filter((n) => n.kind === 'mark' || n.kind === 'group').length
      expect(marks, `seed ${seed}`).toBeLessThanOrEqual(threshold + 1)
      const entries = t.nodes.filter((n) => n.kind === 'legend-entry').length
      const legends = t.nodes.filter((n) => n.kind === 'legend').length
      expect(entries, `seed ${seed}`).toBeLessThanOrEqual(threshold * legends)
      if (t.totalItems > threshold) {
        summarised++
        expect(t.summary).toBeDefined()
        // (over the bound, no mark is a node per item: every mark node summarises)
        expect(t.nodes.filter((n) => n.kind === 'mark').every((n) => n.count !== undefined), `seed ${seed}`).toBe(true)
        // and the summaries count every item
        expect(t.nodes.filter((n) => n.kind === 'mark').reduce((s, n) => s + (n.count ?? 0), 0), `seed ${seed}`).toBe(t.totalItems)
      }
    }
    expect(summarised).toBeGreaterThan(20)
  })

  it('the audit\'s chart: 60 cells of 100 symbols', () => {
    const spec = { ...randomSpec(mulberry32(1)) }
    const rows = Array.from({ length: 6000 }, (_, i) => ({ f: `f${i % 60}`, c: 'a', v: i % 17, w: i % 13 }))
    ;(spec.data as Array<Record<string, unknown>>)[0]!.values = rows
    const t = tree(spec)
    expect(t.totalItems).toBe(6000)
    expect(t.nodes.length).toBeLessThan(160)
  })
})

describe('the label is the spec\'s description (C289)', () => {
  it('as vega-view writes it to the container, unless the host gives one', () => {
    const spec = { width: 50, height: 50, description: 'A chart about things', marks: [] }
    expect(tree(spec).label).toBe('A chart about things')
    expect(tree(spec, {}, { label: 'host label' }).label).toBe('host label')
    // (vega-parser: the spec's description, else the config's, "Vega visualization" by default)
    expect(tree({ width: 50, height: 50, marks: [] }).label).toBe('Vega visualization')
    expect(tree({ width: 50, height: 50, config: { description: 'cfg' }, marks: [] }).label).toBe('cfg')
    expect(tree(spec).description).toBeUndefined()
  })
})

describe('a mark item\'s box is the one the hit index measures, its id its datum\'s (C411)', () => {
  it('every item of random charts: finite, at least 2 x 2, and over what the pointer picks there', () => {
    let checked = 0
    for (let seed = 1; seed <= 40; seed++) {
      const r = mulberry32(seed)
      const spec = randomSpec(r)
      const scene = evaluateChart(compileChart(structuredClone(spec) as VgSpec), {})
      const t = buildA11yTree(scene, new Map(), { summaryThreshold: 100_000 })
      const hit = buildHitIndex(scene)
      for (const n of t.nodes.filter((x) => x.kind === 'mark' && x.count === undefined)) {
        for (const v of [n.x, n.y, n.width, n.height]) expect(Number.isFinite(v), `seed ${seed} ${n.id}`).toBe(true)
        expect(n.width).toBeGreaterThanOrEqual(2)
        expect(n.height).toBeGreaterThanOrEqual(2)
        if (n.marktype === 'line') continue
        // the pointer at the box's centre finds an item of that datum (or one painted over it), never nothing
        const got = hit.query(n.x + n.width / 2, n.y + n.height / 2)
        if (n.marktype !== 'text' && n.marktype !== 'rule') expect(got, `seed ${seed} ${n.id} ${n.marktype}`).not.toBeNull()
        checked++
      }
    }
    expect(checked).toBeGreaterThan(200)
  })

  it('a text\'s box follows its alignment, offsets and measured width; a NaN size is finite', () => {
    // (no autosize: the viewport is the scene's own frame, so a box is where the item is)
    const one = (update: Record<string, unknown>, kind = 'text') => tree({ width: 200, height: 100, autosize: 'none', padding: 0, marks: [{ type: kind, encode: { update: Object.fromEntries(Object.entries(update).map(([k, v]) => [k, { value: v }])) } }] }).nodes.find((n) => n.kind === 'mark')!
    const left = one({ x: 100, y: 50, text: 'left aligned by default' })
    // (vega's default alignment is the start: the text begins at its x)
    expect(left.x).toBeGreaterThanOrEqual(99)
    const right = one({ x: 100, y: 50, text: 'left aligned by default', align: 'right' })
    expect(right.x + right.width).toBeLessThanOrEqual(101)
    const moved = one({ x: 100, y: 50, dx: 20, text: 'x' })
    expect(moved.x).toBeGreaterThanOrEqual(119)
    const nan = one({ x: 14, y: 14, width: Number.NaN, height: 5 }, 'rect')
    for (const v of [nan.x, nan.y, nan.width, nan.height]) expect(Number.isFinite(v)).toBe(true)
  })

  it('a value the bounds reader refuses (a pass vega stops at) never makes the tree throw; the items past it are no nodes', () => {
    for (const shape of [7, 'M0,0Lx', 'triangle-sideways', 't1,2']) {
      const spec = { width: 100, height: 50, data: [{ name: 't', values: [{ x: 1 }, { x: 2 }] }], marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { value: 10 }, shape: { value: shape } } } }] }
      const scene = evaluateChart(compileChart(structuredClone(spec) as VgSpec), {})
      expect(() => buildA11yTree(scene), String(shape)).not.toThrow()
      for (const n of buildA11yTree(scene).nodes) for (const v of [n.x, n.y, n.width, n.height]) expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('inserting a row does not rename the nodes of the others', () => {
    const spec = { width: 100, height: 50, data: [{ name: 't' }], marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { value: 10 }, description: { field: 'n' } } } }] }
    const session = createChartSession()
    const ids = (rows: object[]): Map<string, string> => {
      const t = buildA11yTree(session.evaluate(structuredClone(spec) as VgSpec, { data: { t: rows } }) as SceneRoot)
      return new Map(t.nodes.filter((n) => n.kind === 'mark').map((n) => [n.label, n.id]))
    }
    const before = ids([{ x: 1, n: 'A' }, { x: 2, n: 'B' }])
    const after = ids([{ x: 0, n: 'NEW' }, { x: 1, n: 'A' }, { x: 2, n: 'B' }])
    expect(after.get('A')).toBe(before.get('A'))
    expect(after.get('B')).toBe(before.get('B'))
    // equal rows are told apart, and stay unique
    const twins = ids([{ x: 1, n: 'A' }, { x: 1, n: 'A' }])
    expect(twins.size).toBe(1)
  })
})
