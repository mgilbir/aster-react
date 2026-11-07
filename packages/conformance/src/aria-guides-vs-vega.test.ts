// @vitest-environment jsdom
/**
 * ARIA of every guide and mark over the parameter space, against real Vega (same process, vega's SVG renderer).
 *
 * vega-scenegraph writes role / aria-roledescription / aria-label / aria-hidden on every mark container and on every item.
 * The strict canonicalizer compares them as the document's STRUCTURE (normalize.ts N-structure). This file generates the
 * specs -- axes (any subset of the parts they draw, with and without a description), legends of each kind, titles with and
 * without a subtitle, marks of every type with item descriptions, `aria: false` at the mark, the guide and the config,
 * `ariaRole` / `ariaRoleDescription` / `description` encodings on the guide's group and its parts -- and holds the string
 * renderer and the DOM renderer to vega's document for each. The matrix is not vacuous: each family must really produce
 * ARIA in vega's document (see the last block).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { buildA11yTree, compileChart, evaluateChart, renderSceneToSvg } from '@aster-charts/core'
import { renderSceneToDomElement } from '@aster-charts/core/dom'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracle(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(spec as never), { renderer: 'none', logLevel: 0 })
  try { await view.runAsync(); return await view.toSVG() } finally { view.finalize() }
}
function aster(spec: Spec): { string: string; dom: string } {
  const scene = evaluateChart(compileChart(spec as never))
  return { string: renderSceneToSvg(scene), dom: new XMLSerializer().serializeToString(renderSceneToDomElement(scene, document) as unknown as Node)
    .replace(/ xmlns:ns\d+="http:\/\/www\.w3\.org\/1999\/xlink"/g, '').replace(/ ns\d+:href=/g, ' xlink:href=') }
}

const DATA = [{ name: 't', values: [{ k: 'a', v: 3, g: 'p', d: 'first' }, { k: 'b', v: 9, g: 'q', d: null }, { k: 'c', v: 6, g: 'p', d: '' }] }]
const SCALES = [
  { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.1 },
  { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height', nice: true },
  { name: 'cat', type: 'ordinal', domain: { data: 't', field: 'g' }, range: 'category' },
  { name: 'seq', type: 'linear', domain: { data: 't', field: 'v' }, range: ['#eee', '#06c'] },
  { name: 'q', type: 'quantize', domain: [0, 9], range: ['#eee', '#9bd', '#06c'] },
  { name: 'sz', type: 'linear', domain: { data: 't', field: 'v' }, range: [20, 200] },
  { name: 'tm', type: 'time', domain: [0, 86400000 * 30], range: 'width' },
  { name: 'lg', type: 'log', domain: [1, 1000], range: 'height' },
]
const chart = (more: Spec): Spec => ({ width: 160, height: 90, padding: 8, autosize: 'pad', data: [...DATA, { name: 'e', values: [] }], scales: SCALES, marks: [], ...more })

// ------------------------------------------------------------------ small deterministic generator
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
const maybe = (r: () => number, p = 0.5): boolean => r() < p

const DESCRIPTIONS = [undefined, undefined, 'my guide', '', 'quote " & <b>'] as const
const ARIAS = [undefined, undefined, false, true, 0, null] as const

/** An ARIA encode block for a guide group / part: description, role and role description as values or expressions. */
function ariaEncode(r: () => number, noDatum = false): Spec | undefined {
  if (maybe(r, 0.6)) return undefined
  const u: Spec = {}
  if (maybe(r)) u.description = pick(r, [{ value: 'enc desc' }, { value: '' }, { value: null }, ...(noDatum ? [] : [{ signal: 'datum.text' }]), { signal: '"n" + 1' }])
  if (maybe(r, 0.4)) u.ariaRole = pick(r, [{ value: 'img' }, { value: '' }, { value: 'region' }])
  if (maybe(r, 0.4)) u.ariaRoleDescription = pick(r, [{ value: 'custom' }, { value: '' }, { value: 7 }])
  if (maybe(r, 0.25)) u.aria = pick(r, [{ value: false }, { value: true }, { value: 0 }, { value: null }])
  return Object.keys(u).length ? { update: u } : undefined
}

function axisSpec(r: () => number): Spec {
  const scale = pick(r, ['x', 'y', 'tm', 'lg'])
  const ax: Spec = { scale, orient: scale === 'x' || scale === 'tm' ? pick(r, ['bottom', 'top']) : pick(r, ['left', 'right']) }
  // any subset of the parts the axis draws (including none)
  for (const part of ['domain', 'ticks', 'labels'] as const) if (maybe(r, 0.45)) ax[part] = false
  if (maybe(r, 0.3)) ax.grid = true
  if (maybe(r, 0.4)) ax.title = pick(r, ['Axis title', ['two', 'lines']])
  const d = pick(r, DESCRIPTIONS); if (d !== undefined) ax.description = d
  const a = pick(r, ARIAS); if (a !== undefined) ax.aria = a
  const enc: Spec = {}
  for (const part of ['axis', 'labels', 'ticks', 'domain', 'title', 'grid']) { const e = ariaEncode(r); if (e && maybe(r, 0.5)) enc[part] = e }
  if (Object.keys(enc).length) ax.encode = enc
  return ax
}
function legendSpec(r: () => number): Spec {
  const lg: Spec = pick(r, [{ fill: 'cat' }, { fill: 'seq' }, { fill: 'q' }, { size: 'sz' }, { size: 'sz', fill: 'cat' }, { stroke: 'cat', type: 'symbol' }, { fill: 'seq', type: 'gradient', orient: 'top', direction: 'horizontal' }])
  if (maybe(r, 0.4)) lg.title = 'Legend title'
  const d = pick(r, DESCRIPTIONS); if (d !== undefined) lg.description = d
  const a = pick(r, ARIAS); if (a !== undefined) lg.aria = a
  const enc: Spec = {}
  for (const part of ['legend', 'entries', 'labels', 'symbols', 'title', 'gradient', 'title']) { const e = ariaEncode(r); if (e && maybe(r, 0.4)) enc[part] = e }
  if (Object.keys(enc).length) lg.encode = enc
  return lg
}
function titleSpec(r: () => number): Spec | string {
  const t: Spec = { text: pick(r, ['A chart', ['l1', 'l2'], '']) }
  if (maybe(r, 0.4)) t.subtitle = pick(r, ['about things', ['s1', 's2'], ''])
  const d = pick(r, DESCRIPTIONS); if (d !== undefined) t.description = d
  const a = pick(r, ARIAS); if (a !== undefined) t.aria = a
  const enc: Spec = {}
  for (const part of ['title', 'subtitle', 'group']) { const e = ariaEncode(r); if (e && maybe(r, 0.4)) enc[part] = e }
  if (Object.keys(enc).length) t.encode = enc
  return t
}
function markSpec(r: () => number): Spec {
  const type = pick(r, ['rect', 'symbol', 'text', 'line', 'area', 'rule', 'arc', 'path', 'trail', 'group'])
  const update: Spec = { x: { scale: 'x', field: 'k' }, y: { scale: 'y', field: 'v' }, width: { value: 10 }, height: { value: 10 }, fill: { value: 'tomato' }, stroke: { value: '#333' }, text: { field: 'k' }, x2: { value: 150 }, y2: { value: 80 }, outerRadius: { value: 10 } }
  if (maybe(r, 0.5)) update.description = pick(r, [{ value: 'lit' }, { field: 'd' }, { signal: 'datum.v > 4 ? "big" : null' }, { value: 0 }, { value: '' }])
  if (maybe(r, 0.3)) update.aria = pick(r, [{ value: false }, { value: true }, { signal: 'datum.v > 4' }, { value: 0 }, { value: null }])
  if (maybe(r, 0.3)) update.ariaRole = pick(r, [{ value: 'img' }, { field: 'g' }, { value: '' }])
  if (maybe(r, 0.3)) update.ariaRoleDescription = pick(r, [{ value: 'thing' }, { field: 'g' }, { value: '' }])
  const m: Spec = { type, from: { data: 't' }, encode: { update } }
  if (type === 'group') m.marks = [{ type: 'rect', encode: { update: { width: { value: 5 }, height: { value: 5 }, description: { value: 'inner' } } } }]
  const d = pick(r, DESCRIPTIONS); if (d !== undefined) m.description = d
  const a = pick(r, ARIAS); if (a !== undefined) m.aria = a
  // (the role a spec gives a mark. A guide's own roles on a DATA mark are read by vega's ARIA as the guide's. Not generated: a
  // guide role on a GROUP mark, and `frame` / `scope` on a data mark -- vega then draws the chart's guides differently (a layout
  // matter that has no ARIA in it), and Aster does not follow; see the report of this change)
  const roles = type === 'group' ? ['mark', 'custom'] : ['mark', 'axis', 'legend', 'title', 'axis-label', 'legend-entry', 'title-text', 'title-subtitle', 'legend-label', 'custom']
  if (maybe(r, 0.2)) m.role = pick(r, roles)
  if (maybe(r, 0.15)) m.interactive = false
  return m
}
function configSpec(r: () => number): Spec | undefined {
  if (maybe(r, 0.6)) return undefined
  const cfg: Spec = {}
  for (const k of ['axis', 'legend', 'title', 'axisX', 'axisY', 'axisBand', 'legendcfg', 'mark', 'rect', 'text', 'group', 'style']) {
    if (!maybe(r, 0.45)) continue
    const c: Spec = {}
    const a = pick(r, [false, true, undefined] as const); if (a !== undefined) c.aria = a
    const d = pick(r, [undefined, 'cfg desc'] as const); if (d !== undefined) c.description = d
    if (maybe(r, 0.2)) c.ariaRole = 'img'
    if (k === 'style') { if (Object.keys(c).length) cfg.style = { cell: c, 'guide-label': c, 'guide-title': c, 'group-title': c } }
    else if (Object.keys(c).length) cfg[k === 'legendcfg' ? 'legend' : k] = c
  }
  return Object.keys(cfg).length ? cfg : undefined
}

function generated(seed: number): Spec {
  const r = rng(seed)
  const more: Spec = {}
  const axes = Array.from({ length: Math.floor(r() * 3) }, () => axisSpec(r))
  if (axes.length) more.axes = axes
  const legends = Array.from({ length: Math.floor(r() * 2.5) }, () => legendSpec(r))
  if (legends.length) more.legends = legends
  if (maybe(r, 0.6)) more.title = titleSpec(r)
  const marks = Array.from({ length: Math.floor(r() * 3) }, () => markSpec(r))
  if (marks.length) more.marks = marks
  const cfg = configSpec(r); if (cfg) more.config = cfg
  // the root group's own aria channels: the view's `encode`, `config.group` (in configSpec) and a style
  if (maybe(r, 0.25)) { const e = ariaEncode(r, true); if (e) more.encode = e }
  if (maybe(r, 0.2)) more.style = 'cell'
  return chart(more)
}

async function judge(spec: Spec, what: string): Promise<void> {
  const want = canonicalizeSvg(await oracle(spec))
  const got = aster(spec)
  expect(diffCanonical(want, canonicalizeSvg(got.string)), `string: ${what}`).toEqual([])
  expect(diffCanonical(want, canonicalizeSvg(got.dom)), `dom: ${what}`).toEqual([])
}

/** Judge only the document's structure (the ARIA): for a chart whose geometry or paint vega draws in a way that has its own gate. */
async function judgeStructure(spec: Spec, what: string): Promise<void> {
  const want = canonicalizeSvg(await oracle(spec))
  const got = aster(spec)
  for (const [kind, svg] of [['string', got.string], ['dom', got.dom]] as const) {
    expect(diffCanonical(want, canonicalizeSvg(svg)).filter((x) => x.startsWith('structure:')), `${kind}: ${what}`).toEqual([])
  }
}

/** Judge many specs and report every divergence (the spec's JSON included), not just the first. */
async function judgeAll(specs: Array<[string, Spec]>): Promise<void> {
  const bad: string[] = []
  for (const [what] of specs.slice(0,0)) void what
  for (const [what, spec] of specs) {
    const want = canonicalizeSvg(await oracle(spec))
    const got = aster(spec)
    // (the document's STRUCTURE is the ARIA; geometry and paint have their own gates)
    const structural = (a: string): string[] => diffCanonical(want, canonicalizeSvg(a)).filter((x) => x.startsWith('structure:'))
    const d = [...structural(got.string).map((x) => `string ${x}`), ...structural(got.dom).map((x) => `dom ${x}`)]
    if (d.length) bad.push(`${what}: ${d.slice(0, 6).join(' | ')}\n${JSON.stringify(spec, (k, v) => (k === 'data' || k === 'scales' ? undefined : v))}`)
  }
  expect(bad, `${bad.length} of ${specs.length} diverge`).toEqual([])
}

describe('an axis that draws nothing', () => {
  const empty = { scale: 'y', orient: 'left', domain: false, ticks: false, labels: false }
  const cases: Array<[string, Spec]> = [
    ['no description: no ARIA', empty],
    ['a description: the guide is still a graphics-symbol', { ...empty, description: 'axis for x' }],
    ['an empty description', { ...empty, description: '' }],
    ['aria: false', { ...empty, description: 'x', aria: false }],
    ['a description from the group encode', { ...empty, encode: { axis: { update: { description: { value: 'enc' } } } } }],
    ['a role from the group encode, no description', { ...empty, encode: { axis: { update: { ariaRole: { value: 'img' } } } } }],
    ['a title only', { ...empty, title: 'T' }],
    ['a title only, with a description', { ...empty, title: 'T', description: 'd' }],
    ['a discrete scale', { ...empty, scale: 'x', orient: 'bottom', description: 'discrete' }],
  ]
  for (const [what, ax] of cases) it(what, async () => { await judge(chart({ axes: [ax] }), what) })
})

describe('empty guides and empty marks', () => {
  const row = { x: { value: 5 }, y: { value: 5 }, width: { value: 9 }, height: { value: 9 } }
  const cases: Array<[string, Spec]> = [
    ['an axis with no tick values', chart({ axes: [{ scale: 'y', orient: 'left', values: [], title: 'T' }] })],
    ['an axis with no tick values, described', chart({ axes: [{ scale: 'y', orient: 'left', values: [], ticks: false, domain: false, labels: false, description: 'd' }] })],
    ['a legend of an empty domain', chart({ scales: [...SCALES, { name: 'none', type: 'ordinal', domain: [], range: 'category' }], legends: [{ fill: 'none' }] })],
    ['a legend of an empty domain, described', chart({ scales: [...SCALES, { name: 'none', type: 'ordinal', domain: [], range: 'category' }], legends: [{ fill: 'none', description: 'nothing', title: 'T' }] })],
    ['a mark of no items, described', chart({ marks: [{ type: 'rect', from: { data: 'e' }, description: 'no rows', encode: { update: row } }] })],
    ['a mark of no items, undescribed', chart({ marks: [{ type: 'rect', from: { data: 'e' }, encode: { update: { ...row, description: { value: 'x' } } } }] })],
    ['a data mark with a guide role and no items, described', chart({ marks: [{ type: 'rect', role: 'title-text', description: 'd', from: { data: 'e' }, encode: { update: row } }] })],
    ['a data mark with a guide role and no items, undescribed', chart({ marks: [{ type: 'rect', role: 'title-text', from: { data: 'e' }, encode: { update: row } }] })],
    ['a data mark with a guide role: the caption of the first item', chart({ marks: [{ type: 'text', role: 'title-subtitle', from: { data: 't' }, encode: { update: { ...row, text: { field: 'k' } } } }] })],
    ['a data mark with a guide role: the description of the first item only', chart({ marks: [{ type: 'rect', role: 'axis', from: { data: 't' }, encode: { update: { ...row, description: { field: 'd' } } } }] })],
    ['a data mark with a guide role: a first item without a description', chart({ marks: [{ type: 'rect', role: 'legend', from: { data: 't' }, encode: { update: { ...row, description: { signal: 'datum.v > 4 ? "late" : null' } } } }] })],
    ['a mark with an empty description has no label', chart({ marks: [{ type: 'rect', from: { data: 't' }, description: '', encode: { update: row } }] })],
    ['a guide property that is null is the config\'s', chart({
      config: { axis: { aria: false }, legend: { aria: false, description: 'cfg' }, title: { aria: false } },
      axes: [{ scale: 'y', orient: 'left', aria: null, description: null }], legends: [{ fill: 'cat', aria: null, description: null }], title: { text: 'T', aria: null },
    })],
    ...(['text', 'line', 'area', 'rect', 'symbol', 'rule'] as const).map((type): [string, Spec] => [`a ${type} mark with a role of its own takes none of the mark defaults`, chart({
      marks: [{ type, role: 'custom', from: { data: 't' }, encode: { update: { ...row, x2: { value: 40 }, y2: { value: 40 }, ...(type === 'text' ? { text: { field: 'k' } } : {}) } } }],
    })]),
    ['a title of no text', chart({ title: { text: '', description: 'd' } })],
    ['a title with only a subtitle', chart({ title: { text: '', subtitle: 'sub' } })],
    ['a described title with aria: false', chart({ title: { text: 'T', description: 'd', aria: false } })],
    ['the root group described, then hidden', chart({ axes: [{ scale: 'y', orient: 'left' }], encode: { update: { description: { value: 'root' }, aria: { value: false } } } })],
    ['config.group on the root, config.mark on a data mark and not on a group mark', chart({
      config: { group: { description: 'cfg root', fill: '#eef' }, mark: { description: 'cfg mark', fill: '#fee' } },
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: row } }, { type: 'group', from: { data: 't' }, encode: { update: row } }, { type: 'rect', role: 'custom', from: { data: 't' }, encode: { update: row } }],
    })],
  ]
  for (const [what, spec] of cases) it(what, async () => { await (what.startsWith('a data mark with a guide role') ? judgeStructure : judge)(spec, what) })
})

describe('generated guides and marks carry the ARIA vega writes', () => {
  const N = 600
  for (let chunk = 0; chunk < N; chunk += 100) {
    it(`seeds ${chunk}..${chunk + 99}`, async () => {
      await judgeAll(Array.from({ length: 100 }, (_, i): [string, Spec] => [`seed ${chunk + i}`, generated(chunk + i)]))
    }, 300_000)
  }
})

describe('the matrix is not vacuous', () => {
  it('each family occurs in vega\'s documents with the ARIA the comparison judges', async () => {
    const seen = { axis: 0, legend: 0, title: 0, subtitle: 0, hidden: 0, mark: 0, item: 0, noparts: 0 }
    for (let seed = 0; seed < 600; seed++) {
      const svg = await oracle(generated(seed))
      seen.axis += +/role-axis[^>]*role="graphics-symbol" aria-roledescription="axis"/.test(svg)
      seen.legend += +/aria-roledescription="legend"/.test(svg)
      seen.title += +/aria-roledescription="title"/.test(svg)
      seen.subtitle += +/aria-roledescription="subtitle"/.test(svg)
      seen.hidden += +/aria-hidden="true"/.test(svg)
      seen.mark += +/aria-roledescription="[a-z]+ mark container"/.test(svg)
      seen.item += +/aria-roledescription="[a-z]+ mark"/.test(svg)
      seen.noparts += +/class="mark-group role-axis"[^>]*role="graphics-symbol"[^>]*><g[^>]*><path[^>]*><\/path><\/g>/.test(svg)
    }
    for (const [k, v] of Object.entries(seen)) if (k !== 'noparts') expect(v, k).toBeGreaterThan(20)
  }, 300_000)
})

describe('the accessible tree follows the root group item as it does any group item', () => {
  const withRoot = (update: Spec): Spec => chart({ axes: [{ scale: 'y', orient: 'left' }], title: 'T', encode: { update } })
  it('a root group item with aria: false hides the whole chart', async () => {
    const spec = withRoot({ aria: { value: false } })
    expect(canonicalizeSvg(await oracle(spec)).structure.some((l) => /^g hidden=true$/.test(l.trim()))).toBe(true)
    expect(buildA11yTree(evaluateChart(compileChart(spec as never))).nodes).toEqual([])
  })
  it('a described root group item is a node of its own, ahead of the content', () => {
    const tree = buildA11yTree(evaluateChart(compileChart(withRoot({ description: { value: 'the chart' }, ariaRole: { value: 'img' }, ariaRoleDescription: { value: 'plot' } }) as never)))
    expect(tree.nodes[0]).toMatchObject({ kind: 'group', label: 'the chart', role: 'img', roleDescription: 'plot' })
    expect(tree.nodes.length).toBeGreaterThan(1)
  })
})
