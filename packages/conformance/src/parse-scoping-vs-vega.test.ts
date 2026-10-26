// @vitest-environment jsdom
/**
 * vega-parser's data-set scoping, replayed against the pinned oracle.
 *
 * `Scope.addData` throws `Duplicate data set name: "<name>"` for a name the SAME scope already owns
 * (`hasOwnProperty(this.data, name)`); a nested scope inherits the names of its parents without owning
 * them, so a nested group may shadow. Every kind of thing vega registers as a data set is exercised here
 * against every other kind, in the placements that matter (same scope, parent and child, sibling groups,
 * a facet's own scope, a group that is parsed without a scope of its own): the data sets, derived data
 * sets, every named mark, a facet's name, the root's own `root`, and every guide (axis, legend, title) with
 * each of the marks it is made of. The oracle decides what is refused; nothing here is hand-listed.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
import '@aster/core/transforms'
import { compileChart, renderSpec, SpecParseError } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

/** What one scope of a spec holds (the top-level spec and every group mark are one). */
interface Scope {
  data: Spec[]
  scales: Spec[]
  axes: Spec[]
  marks: Spec[]
  legends: Spec[]
  title?: Spec
  [k: string]: unknown
}
const newScope = (): Scope => ({ data: [], scales: [], axes: [], marks: [], legends: [] })

let uid = 0
/** A declaration of one data-set name `n` in a scope, by one of the ways vega registers a data set. */
interface Kind {
  label: string
  /** at most one per scope (a title, the facet name of a group) */
  single?: boolean
  put(sc: Scope, n: string): void
}
const axisScale = (sc: Scope): string => {
  const name = `as${++uid}`
  sc.scales.push({ name, type: 'linear', domain: [0, 1], range: [0, 10] })
  return name
}
const bandScale = (sc: Scope): string => {
  const name = `bs${++uid}`
  sc.scales.push({ name, type: 'band', domain: ['a', 'b'], range: [0, 10] })
  return name
}
const colorScale = (sc: Scope, type: string, range: unknown[] = ['red', 'green', 'blue']): string => {
  const name = `cs${++uid}`
  sc.scales.push({ name, type, domain: type === 'threshold' ? [3, 6] : type === 'ordinal' ? ['a', 'b', 'c'] : [0, 9], range })
  return name
}
const axis = (encodeKey: string, extra: Spec = {}): Kind['put'] => (sc, n) => {
  sc.axes.push({ scale: axisScale(sc), orient: 'left', ...extra, encode: { [encodeKey]: { name: n } } })
}

const KINDS: Kind[] = [
  { label: 'data', put: (sc, n) => { sc.data.push({ name: n, values: [{ a: 1 }] }) } },
  { label: 'derived data', put: (sc, n) => { sc.data.push({ name: n, source: 'src' }) } },
  { label: 'rect mark', put: (sc, n) => { sc.marks.push({ type: 'rect', name: n }) } },
  { label: 'symbol mark from data', put: (sc, n) => { sc.marks.push({ type: 'symbol', name: n, from: { data: 'src' } }) } },
  { label: 'group mark', put: (sc, n) => { sc.marks.push({ type: 'group', name: n }) } },
  { label: 'axis', put: axis('axis') },
  { label: 'axis grid', put: axis('grid', { grid: true }) },
  { label: 'axis ticks', put: axis('ticks') },
  { label: 'axis labels', put: axis('labels') },
  { label: 'axis domain', put: axis('domain') },
  { label: 'axis title', put: axis('title', { title: 'T' }) },
  { label: 'axis title (a title the axis does not have)', put: axis('title') },
  { label: 'axis grid (grid off)', put: axis('grid') },
  { label: 'axis ticks (ticks off)', put: axis('ticks', { ticks: false }) },
  { label: 'axis labels (labels off)', put: axis('labels', { labels: false }) },
  { label: 'axis domain (domain off)', put: axis('domain', { domain: false }) },
  { label: 'axis on a band scale', put: (sc, n) => { sc.axes.push({ scale: bandScale(sc), orient: 'bottom', encode: { ticks: { name: n } } }) } },
  { label: 'legend', put: (sc, n) => { sc.legends.push({ fill: colorScale(sc, 'ordinal'), encode: { legend: { name: n } } }) } },
  { label: 'legend title', put: (sc, n) => { sc.legends.push({ fill: colorScale(sc, 'ordinal'), title: 'L', encode: { title: { name: n } } }) } },
  { label: 'legend title (no title)', put: (sc, n) => { sc.legends.push({ fill: colorScale(sc, 'ordinal'), encode: { title: { name: n } } }) } },
  { label: 'legend entries', put: (sc, n) => { sc.legends.push({ fill: colorScale(sc, 'ordinal'), encode: { entries: { name: n } } }) } },
  { label: 'legend symbols', put: (sc, n) => { sc.legends.push({ fill: colorScale(sc, 'ordinal'), encode: { symbols: { name: n } } }) } },
  { label: 'legend labels (symbol legend)', put: (sc, n) => { sc.legends.push({ fill: colorScale(sc, 'ordinal'), encode: { labels: { name: n } } }) } },
  { label: 'legend gradient', put: (sc, n) => { sc.legends.push({ fill: colorScale(sc, 'linear', ['white', 'black']), encode: { gradient: { name: n } } }) } },
  { label: 'legend labels (gradient legend)', put: (sc, n) => { sc.legends.push({ fill: colorScale(sc, 'linear', ['white', 'black']), encode: { labels: { name: n } } }) } },
  { label: 'legend gradient (discrete legend)', put: (sc, n) => { sc.legends.push({ fill: colorScale(sc, 'quantize'), encode: { gradient: { name: n } } }) } },
  { label: 'legend labels (discrete legend)', put: (sc, n) => { sc.legends.push({ fill: colorScale(sc, 'threshold'), encode: { labels: { name: n } } }) } },
  { label: 'chart title group', single: true, put: (sc, n) => { sc.title = { text: 'T', ...(sc.title as Spec | undefined), encode: { ...((sc.title as Spec | undefined)?.encode as Spec | undefined), group: { name: n } } } } },
  { label: 'chart title text', single: true, put: (sc, n) => { sc.title = { text: 'T', ...(sc.title as Spec | undefined), encode: { ...((sc.title as Spec | undefined)?.encode as Spec | undefined), title: { name: n } } } } },
  { label: 'chart title text (the deprecated spec.name)', single: true, put: (sc, n) => { sc.title = { text: 'T', name: n } } },
  { label: 'chart subtitle', single: true, put: (sc, n) => { sc.title = { text: 'T', subtitle: 'S', encode: { subtitle: { name: n } } } } },
]

/** a group mark holding `sc`, as a mark of its parent */
const groupOf = (sc: Scope, extra: Spec = {}): Spec => ({ type: 'group', ...extra, ...compact(sc) })
function compact(sc: Scope): Spec {
  const out: Spec = {}
  for (const [k, v] of Object.entries(sc)) if (Array.isArray(v) ? v.length : v !== undefined) out[k] = v
  return out
}
const specOf = (top: Scope): Spec => ({
  width: 60, height: 40, padding: 2, autosize: 'none',
  ...compact({ ...top, data: [{ name: 'src', values: [{ a: 1 }, { a: 2 }] }, ...top.data] }),
})

/** The outcome of parsing (and, when it parses, rendering) a spec by vega. */
async function oracle(spec: Spec): Promise<{ error: string } | { svg: string }> {
  const log = console.error
  console.error = () => {}
  try {
    const rt = vega.parse(spec as never)
    const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(rt, { renderer: 'none', logLevel: 0 })
    try { await view.runAsync(); return { svg: await view.toSVG() } } finally { view.finalize() }
  } catch (e) {
    return { error: (e as Error).message }
  } finally {
    console.error = log
  }
}
function engine(spec: Spec): { error: string; name: string } | { svg: string } {
  try { return { svg: renderSpec(spec as never, { logger: { error: () => {}, warn: () => {} } }) } } catch (e) {
    return { error: (e as Error).message, name: (e as Error).name }
  }
}

/** `vega.parse` alone: the parser's refusals (the whole matrix is about those; drawing is compared by `agree`). */
function parses(spec: Spec): { error: string } | { ok: true } {
  try { vega.parse(spec as never); return { ok: true } } catch (e) { return { error: (e as Error).message } }
}
function agreeOnParsing(spec: Spec, what: string): 'refused' | 'accepted' {
  const want = parses(spec)
  if ('error' in want) {
    let got: unknown
    try { compileChart(spec as never) } catch (e) { got = e }
    expect(got, `${what}: vega refuses with ${want.error}`).toBeInstanceOf(SpecParseError)
    expect((got as Error).message, what).toBe(want.error)
    return 'refused'
  }
  expect(() => compileChart(spec as never), `${what}: vega accepts it`).not.toThrow()
  return 'accepted'
}

async function agree(spec: Spec, what: string, drawing = true): Promise<'refused' | 'accepted'> {
  const want = await oracle(spec)
  const got = engine(spec)
  if ('error' in want) {
    expect(got, `${what}: vega refuses with ${want.error}`).toHaveProperty('error')
    expect((got as { error: string }).error, what).toBe(want.error)
    expect((got as { name: string }).name, what).toBe('SpecParseError')
    expect(() => compileChart(spec as never), what).toThrow(SpecParseError)
    return 'refused'
  }
  expect(got, `${what}: vega accepts it`).toHaveProperty('svg')
  if (drawing) expect(diffCanonical(canonicalizeSvg((got as { svg: string }).svg), canonicalizeSvg(want.svg)), what).toEqual([])
  return 'accepted'
}

type Placement = { label: string; build: (a: Kind, b: Kind, n: string) => Spec }
const PLACEMENTS: Placement[] = [
  { label: 'both in the top scope', build: (a, b, n) => { const t = newScope(); a.put(t, n); b.put(t, n); return specOf(t) } },
  { label: 'both in one group', build: (a, b, n) => { const g = newScope(); a.put(g, n); b.put(g, n); const t = newScope(); t.marks.push(groupOf(g)); return specOf(t) } },
  { label: 'the parent has one, its group the other', build: (a, b, n) => { const g = newScope(); b.put(g, n); const t = newScope(); a.put(t, n); t.marks.push(groupOf(g)); return specOf(t) } },
  { label: 'the group has one, the parent declares the other after it', build: (a, b, n) => { const g = newScope(); a.put(g, n); const t = newScope(); t.marks.push(groupOf(g)); b.put(t, n); return specOf(t) } },
  { label: 'one in each of two sibling groups', build: (a, b, n) => { const g1 = newScope(), g2 = newScope(); a.put(g1, n); b.put(g2, n); const t = newScope(); t.marks.push(groupOf(g1), groupOf(g2)); return specOf(t) } },
  { label: 'both in a faceted group (the facet owns the name `n` itself)', build: (a, b, n) => { const g = newScope(); a.put(g, n); b.put(g, n); const t = newScope(); t.marks.push(groupOf(g, { from: { facet: { name: 'f', data: 'src', groupby: 'a' } } })); return specOf(t) } },
  { label: 'the same two in a group that has a guide role (parsed in its parent scope)', build: (a, b, n) => { const g = newScope(); a.put(g, n); const t = newScope(); t.marks.push(groupOf(g, { role: 'axis-like' })); b.put(t, n); return specOf(t) } },
]

describe('Duplicate data set name: every kind of data set against every other, in every placement', () => {
  const counts = { refused: 0, accepted: 0 }
  const all: Array<[string, Spec]> = []
  for (const p of PLACEMENTS) {
    for (const a of KINDS) {
      for (const b of KINDS) {
        if (a.single && b.single && a !== b) continue
        all.push([`${p.label}: ${a.label} + ${b.label}`, p.build(a, b, 'n')])
      }
    }
  }
  it(`replays ${all.length} specs`, async () => {
    for (const [what, spec] of all) counts[agreeOnParsing(spec, what)]++
    // not vacuous: a good share of the matrix is refused and a good share accepted (shadowing, siblings, ...)
    expect(counts.refused).toBeGreaterThan(200)
    expect(counts.accepted).toBeGreaterThan(200)
  }, 600_000)
})

describe('Duplicate data set name: names vega gives its own data sets', () => {
  const t = (f: (t: Scope) => void): Spec => { const s = newScope(); f(s); return specOf(s) }
  const cases: Array<[string, Spec]> = [
    ['a data set named root (the view registers `root` after parsing the spec)', t((s) => s.data.push({ name: 'root', values: [] }))],
    ['a mark named root', t((s) => s.marks.push({ type: 'rect', name: 'root' }))],
    ['a legend named root', t((s) => s.legends.push({ fill: colorScale(s, 'ordinal'), encode: { legend: { name: 'root' } } }))],
    ['a nested group data set named root is the nested scope\'s own', t((s) => s.marks.push({ type: 'group', data: [{ name: 'root', values: [] }] }))],
    ['a mark named like the data set src', t((s) => s.marks.push({ type: 'rect', name: 'src' }))],
    ['the symbols of a symbol legend named value (the entries are faceted over `value`)', t((s) => s.legends.push({ fill: colorScale(s, 'ordinal'), encode: { symbols: { name: 'value' } } }))],
    ['the labels of a symbol legend named value', t((s) => s.legends.push({ fill: colorScale(s, 'ordinal'), encode: { labels: { name: 'value' } } }))],
    ['the labels of a gradient legend named value (no facet there)', t((s) => s.legends.push({ fill: colorScale(s, 'linear', ['white', 'black']), encode: { labels: { name: 'value' } } }))],
    ['the entries of a symbol legend named value (the group sits outside the facet)', t((s) => s.legends.push({ fill: colorScale(s, 'ordinal'), encode: { entries: { name: 'value' } } }))],
    ['a data set named value in the legend\'s scope', t((s) => { s.data.push({ name: 'value', values: [] }); s.legends.push({ fill: colorScale(s, 'ordinal'), encode: { symbols: { name: 'value' } } }) })],
    ['two unnamed data sets (both are keyed "undefined")', t((s) => { s.data.push({ values: [] }, { values: [] }) })],
    ['two data sets named by the same number', t((s) => { s.data.push({ name: 1, values: [] }, { name: 1, values: [] }) })],
    ['a number and its string spelling', t((s) => { s.data.push({ name: 1, values: [] }, { name: '1', values: [] }) })],
    ['an empty name', t((s) => { s.data.push({ name: '', values: [] }, { name: '', values: [] }) })],
    ['a mark named by 0 and a mark named by "0"', t((s) => { s.marks.push({ type: 'rect', name: 0 }, { type: 'rect', name: '0' }) })],
    ['a facet name that collides with a data set of the faceted group', (() => {
      const g = newScope(); g.data.push({ name: 'f', values: [] })
      const s = newScope(); s.marks.push(groupOf(g, { from: { facet: { name: 'f', data: 'src', groupby: 'a' } } })); return specOf(s)
    })()],
    ['a facet name equal to the data set it facets (the group owns it, the parent has it)', (() => {
      const s = newScope(); s.marks.push({ type: 'group', from: { facet: { name: 'src', data: 'src', groupby: 'a' } } }); return specOf(s)
    })()],
    ['a data set declared twice at the top while a group declares it once', (() => {
      const g = newScope(); g.data.push({ name: 'x', values: [] })
      const s = newScope(); s.data.push({ name: 'x', values: [] }, { name: 'x', values: [] }); s.marks.push(groupOf(g)); return specOf(s)
    })()],
    ['the second duplicate wins the race against a missing data set (data comes first in vega-parser\'s order)', (() => {
      const s = newScope(); s.data.push({ name: 'x', values: [] }, { name: 'x', values: [] }); s.marks.push({ type: 'rect', from: { data: 'nope' } }); return specOf(s)
    })()],
    ['a missing data set in a mark wins over a duplicate guide declared later (marks precede legends)', (() => {
      const s = newScope(); s.marks.push({ type: 'rect', from: { data: 'nope' } }); s.legends.push({ fill: colorScale(s, 'ordinal'), encode: { legend: { name: 'q' } } }, { fill: colorScale(s, 'ordinal'), encode: { legend: { name: 'q' } } }); return specOf(s)
    })()],
    ['a duplicate axis name wins over a missing data set in a mark (axes precede marks)', (() => {
      const s = newScope(); axis('axis')(s, 'q'); axis('axis')(s, 'q'); s.marks.push({ type: 'rect', from: { data: 'nope' } }); return specOf(s)
    })()],
  ]
  for (const [what, spec] of cases) {
    // (the outcome, and for a refusal the message: the pictures of guides with user-named marks are compared in the guide suites)
    it(what, async () => { await agree(spec, what, false) })
  }

  it('names that are Object.prototype members crash vega itself (annotating the data sets reads `data[name]`): not reproduced, the chart is drawn', async () => {
    const spec = t((s) => { s.data.push({ name: 'toString', values: [] }, { name: 'hasOwnProperty', values: [] }); s.marks.push({ type: 'rect' }) })
    const want = await oracle(spec)
    expect(want).toEqual({ error: expect.stringMatching(/is not a function/) })
    expect(engine(spec)).toHaveProperty('svg')
  })
})
