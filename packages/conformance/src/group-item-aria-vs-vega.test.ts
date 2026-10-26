// @vitest-environment jsdom
/**
 * Item-level ARIA on GROUP items, against real Vega.
 *
 * vega-scenegraph writes an item's `description`, `aria`, `ariaRole` and `ariaRoleDescription` (the `ariaItemAttributes`
 * of util/aria.js) on the element of EVERY item, a group mark's item `<g transform>` included -- the mark's own container
 * carries the mark-level `description` / `aria`, which are a different thing and stay as they were. Each case runs
 * through real vega, the string renderer, the DOM renderer and the accessible tree: the strict canonicalizer judges the
 * documents (structure includes `role`, `aria-*`), and the tree must name exactly the group items vega describes.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { buildA11yTree, compileChart, evaluateChart, renderSpec } from '@aster/core'
import { renderSceneToDomElement } from '@aster/core/dom'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { parseSvg, type XmlEl } from './svg-parse.js'

type Spec = Record<string, unknown>

async function oracleSvg(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(spec as never), { renderer: 'none' })
  try { await view.runAsync(); return await view.toSVG() } finally { view.finalize() }
}
const domSvg = (spec: Spec): string => new XMLSerializer().serializeToString(renderSceneToDomElement(evaluateChart(compileChart(spec as never)), document) as unknown as Node)
  .replace(/ xmlns:ns\d+="http:\/\/www\.w3\.org\/1999\/xlink"/g, '').replace(/ ns\d+:href=/g, ' xlink:href=')

const ROWS = [
  { k: 'a', v: 28, d: 'first', r: 'img', rd: 'a picture', on: true },
  { k: 'b', v: 55, d: null, r: null, rd: '', on: false },
  { k: 'c', v: 10, d: '', r: '', rd: null, on: 0 },
  { k: 'd', v: 91, d: 42, r: 'region', rd: 'a region', on: 'yes' },
]
const inner = { type: 'rect', encode: { update: { x: { value: 2 }, y: { value: 2 }, width: { value: 6 }, height: { value: 6 }, fill: { value: 'tomato' } } } }
const chart = (update: Spec, mark: Spec = {}): Spec => ({
  width: 160, height: 90, padding: 5, autosize: 'none',
  data: [{ name: 't', values: ROWS }],
  marks: [{
    type: 'group', from: { data: 't' },
    encode: { update: { x: { field: 'v' }, y: { value: 5 }, width: { value: 14 }, height: { value: 14 }, stroke: { value: '#999' }, ...update } },
    marks: [inner], ...mark,
  }],
})

const DESCRIPTIONS: Array<[string, unknown]> = [
  ['none', undefined],
  ['a literal', { value: 'lit' }],
  ['a field with null and empty values', { field: 'd' }],
  ['an expression that is null for some items', { signal: 'datum.v > 20 ? "big " + datum.k : null' }],
  ['the number zero', { value: 0 }],
  ['an object', { signal: '{a: 1}' }],
  ['a list', { signal: '[1, 2]' }],
]
const ARIAS: Array<[string, unknown]> = [
  ['unset', undefined],
  ['false', { value: false }],
  ['true', { value: true }],
  ['falsy but not false (0)', { value: 0 }],
  ['null', { value: null }],
  ['per item', { field: 'on' }],
  ['an expression', { signal: 'datum.v > 20' }],
]
const ROLES: Array<[string, unknown]> = [['unset', undefined], ['a literal', { value: 'img' }], ['a field', { field: 'r' }], ['empty', { value: '' }]]
const ROLEDESCS: Array<[string, unknown]> = [['unset', undefined], ['a literal', { value: 'my group' }], ['a field', { field: 'rd' }], ['a number', { value: 7 }]]

const channel = (name: string, v: unknown): Spec => (v === undefined ? {} : { [name]: v })

describe('a group item carries its own aria-label / role / aria-roledescription / aria-hidden', () => {
  const cases: Array<[string, Spec]> = []
  for (const [dn, d] of DESCRIPTIONS) {
    for (const [an, a] of ARIAS) {
      for (const [rn, r] of ROLES) {
        for (const [sn, s] of ROLEDESCS) {
          // the full product is 784 charts: keep each channel's variants against the others' defaults, plus pairs
          const set = [d !== undefined, a !== undefined, r !== undefined, s !== undefined].filter(Boolean).length
          if (set > 2 && !(dn === 'a field with null and empty values' && rn === 'a field' && sn === 'a field')) continue
          cases.push([`description ${dn}; aria ${an}; role ${rn}; roledescription ${sn}`,
            chart({ ...channel('description', d), ...channel('aria', a), ...channel('ariaRole', r), ...channel('ariaRoleDescription', s) })])
        }
      }
    }
  }
  it(`${cases.length} charts: the string renderer, the DOM renderer and vega agree`, async () => {
    for (const [what, spec] of cases) {
      const want = canonicalizeSvg(await oracleSvg(spec))
      expect(diffCanonical(want, canonicalizeSvg(renderSpec(spec as never))), `string: ${what}`).toEqual([])
      expect(diffCanonical(want, canonicalizeSvg(domSvg(spec))), `dom: ${what}`).toEqual([])
    }
  }, 300_000)

  it('the matrix is not vacuous: items vega describes, hides, and leaves bare all occur', async () => {
    const svg = await oracleSvg(chart({ description: { field: 'd' }, aria: { signal: 'datum.v > 20' } }))
    const items = [...svg.matchAll(/<g (?:aria-hidden="true"|aria-label="[^"]*"|role="[^"]*")[^>]*transform=/g)].length
    expect(items).toBeGreaterThan(1)
    expect(svg).toContain('aria-hidden="true" transform')
    expect(svg).toMatch(/aria-label="first" role="graphics-object" aria-roledescription="group mark" transform/)
  })
})

describe('the same on every kind of group mark', () => {
  const update = { description: { field: 'd' }, ariaRole: { field: 'r' }, ariaRoleDescription: { field: 'rd' }, aria: { signal: 'datum.k !== "d"' } }
  const specs: Array<[string, Spec]> = [
    ['a group mark with a data source', chart(update)],
    ['no data source (one item)', chart({ x: { value: 3 }, description: { value: 'solo' }, ariaRole: { value: 'img' } }, { from: undefined })],
    ['a faceted group', {
      width: 160, height: 90, padding: 5, autosize: 'none', data: [{ name: 't', values: ROWS }],
      marks: [{ type: 'group', from: { facet: { name: 'f', data: 't', groupby: 'k' } }, encode: { update: { x: { signal: 'datum.k === "a" ? 0 : 40' }, y: { value: 3 }, width: { value: 30 }, height: { value: 30 }, stroke: { value: '#999' }, description: { signal: 'datum.k + " panel"' } } }, marks: [inner] }],
    }],
    ['a clipped group item', chart({ ...update, clip: { value: true } })],
    ['with the mark-level description and aria as well', chart(update, { description: 'the whole mark', aria: true })],
    ['with a mark-level aria: false', chart(update, { aria: false })],
    ['nested group marks (inner and outer items both describe themselves)', {
      width: 160, height: 90, padding: 5, autosize: 'none', data: [{ name: 't', values: ROWS }],
      marks: [{
        type: 'group', from: { data: 't' },
        encode: { update: { x: { field: 'v' }, y: { value: 5 }, width: { value: 20 }, height: { value: 30 }, description: { field: 'k', mult: 1 }, ariaRole: { value: 'region' } } },
        marks: [{ type: 'group', encode: { update: { x: { value: 2 }, y: { value: 2 }, width: { value: 10 }, height: { value: 10 }, description: { value: 'inner' }, aria: { signal: 'parent.v > 20' } } }, marks: [inner] }],
      }],
    }],
    ['guides inside a described group (the guides keep their own captions)', {
      width: 160, height: 90, padding: 5, autosize: 'none', data: [{ name: 't', values: ROWS }],
      marks: [{
        type: 'group', from: { data: 't' },
        encode: { update: { x: { field: 'v' }, y: { value: 5 }, width: { value: 14 }, height: { value: 40 }, description: { field: 'k', mult: 1 } } },
        scales: [{ name: 'y', type: 'linear', domain: [0, 1], range: 'height' }],
        axes: [{ orient: 'left', scale: 'y', tickCount: 2 }],
        marks: [inner],
      }],
    }],
  ]
  for (const [what, spec] of specs) {
    it(what, async () => {
      const want = canonicalizeSvg(await oracleSvg(spec))
      expect(diffCanonical(want, canonicalizeSvg(renderSpec(spec as never)))).toEqual([])
      expect(diffCanonical(want, canonicalizeSvg(domSvg(spec)))).toEqual([])
    })
  }
})

describe('the accessible tree names the group items vega describes, and nothing inside a hidden one', () => {
  /** (label, role, roledescription) of every group-item element of the oracle's document that describes itself, in order. */
  function described(svg: string): Array<[string, string, string]> {
    const out: Array<[string, string, string]> = []
    const walk = (el: XmlEl, hidden: boolean): void => {
      const isItem = el.tag === 'g' && el.attrs['transform'] !== undefined && el.attrs['class'] === undefined
      const hides = el.attrs['aria-hidden'] === 'true'
      if (isItem && !hidden && !hides && el.attrs['aria-label'] !== undefined && el.attrs['role'] !== undefined) {
        // (a group ITEM: its parent container is a group mark; leaves of the inner rect mark have no `transform` on a <g>)
        out.push([el.attrs['aria-label'], el.attrs['role'], el.attrs['aria-roledescription'] ?? ''])
      }
      for (const c of el.children) if (typeof c !== 'string') walk(c, hidden || hides)
    }
    walk(parseSvg(svg), false)
    return out
  }
  const spec = chart({ description: { field: 'k', mult: 1 }, ariaRole: { value: 'region' }, ariaRoleDescription: { value: 'tile' }, aria: { signal: 'datum.v !== 55' } })
  it('every described, visible group item is a node with its label, role and role description', async () => {
    const want = described(await oracleSvg(spec))
    expect(want.length).toBeGreaterThan(1)
    const tree = buildA11yTree(evaluateChart(compileChart(spec as never)))
    const got = tree.nodes.filter((n) => n.kind === 'group').map((n) => [n.label, n.role, n.roleDescription])
    expect(got).toEqual(want)
  })
  it('an item hidden with aria: false has no node, and neither has anything inside it', async () => {
    const hidden = chart({ description: { value: 'x' }, aria: { value: false } })
    expect(described(await oracleSvg(hidden))).toEqual([])
    const tree = buildA11yTree(evaluateChart(compileChart(hidden as never)))
    expect(tree.nodes).toEqual([])
  })
  it('an item without a description is no node of its own, and its content still is', () => {
    const bare = chart({})
    const tree = buildA11yTree(evaluateChart(compileChart(bare as never)))
    expect(tree.nodes.filter((n) => n.kind === 'group')).toEqual([])
    expect(tree.nodes.filter((n) => n.kind === 'mark').length).toBe(ROWS.length)
  })
})
